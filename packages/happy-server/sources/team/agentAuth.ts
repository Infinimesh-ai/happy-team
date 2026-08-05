import { AgentAuthMode, TeamAgentAuthUpdateStatus, TeamUserStatus, type Machine, type TeamUser } from "@prisma/client";
import { callRegisteredRpcMethod } from "@/app/api/socket/rpcHandler";
import { getSocketServer } from "@/app/api/socket";
import { db } from "@/storage/db";
import { decodeBase64, encodeBase64, encryptRpcPayload, decryptRpcPayload, resolveMachineEncryption } from "@/team/machineRpc";

const TEAM_AGENT_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"] as const;
type TeamAgentEnvKey = typeof TEAM_AGENT_ENV_KEYS[number];

export type TeamAgentAuthSyncResult = {
    totalMachines: number;
    applied: number;
    pending: number;
    failed: number;
    machines: Array<{
        machineId: string;
        status: TeamAgentAuthUpdateStatus;
        error?: string;
    }>;
};

export type TeamAgentAuthStatus = TeamAgentAuthSyncResult & {
    machines: Array<TeamAgentAuthSyncResult["machines"][number] & {
        claudeAuthMode: AgentAuthMode;
        codexAuthMode: AgentAuthMode;
        active: boolean;
        activeAt: number;
        appliedAt: string | null;
        updatedAt: string | null;
    }>;
};

export class TeamAgentAuthConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TeamAgentAuthConfigError";
    }
}

export async function getAgentAuthStatusForUser(teamUser: TeamUser): Promise<TeamAgentAuthStatus> {
    const machines = await db.machine.findMany({
        where: { accountId: teamUser.accountId },
        orderBy: { lastActiveAt: "desc" },
    });
    const updates = machines.length === 0
        ? []
        : await db.teamAgentAuthUpdate.findMany({
            where: {
                teamUserId: teamUser.id,
                machineId: { in: machines.map((machine) => machine.id) },
            },
        });
    const updatesByMachine = new Map(updates.map((update) => [update.machineId, update]));
    const rows: TeamAgentAuthStatus["machines"] = machines.map((machine) => {
        const update = updatesByMachine.get(machine.id);
        return {
            machineId: machine.id,
            status: update?.status ?? TeamAgentAuthUpdateStatus.PENDING,
            ...(update?.error ? { error: update.error } : {}),
            claudeAuthMode: update?.claudeAuthMode ?? teamUser.claudeAuthMode,
            codexAuthMode: update?.codexAuthMode ?? teamUser.codexAuthMode,
            active: machine.active,
            activeAt: machine.lastActiveAt.getTime(),
            appliedAt: update?.appliedAt?.toISOString() ?? null,
            updatedAt: update?.updatedAt?.toISOString() ?? null,
        };
    });

    return {
        totalMachines: rows.length,
        applied: rows.filter((row) => row.status === TeamAgentAuthUpdateStatus.APPLIED).length,
        pending: rows.filter((row) => row.status === TeamAgentAuthUpdateStatus.PENDING).length,
        failed: rows.filter((row) => row.status === TeamAgentAuthUpdateStatus.FAILED).length,
        machines: rows,
    };
}

export async function queueAgentAuthSyncForUser(teamUser: TeamUser): Promise<TeamAgentAuthSyncResult> {
    const machines = await db.machine.findMany({
        where: { accountId: teamUser.accountId },
        orderBy: { lastActiveAt: "desc" },
    });
    const results: TeamAgentAuthSyncResult["machines"] = [];

    for (const machine of machines) {
        await db.teamAgentAuthUpdate.upsert({
            where: {
                teamUserId_machineId: {
                    teamUserId: teamUser.id,
                    machineId: machine.id,
                },
            },
            create: {
                teamUserId: teamUser.id,
                machineId: machine.id,
                status: TeamAgentAuthUpdateStatus.PENDING,
                claudeAuthMode: teamUser.claudeAuthMode,
                codexAuthMode: teamUser.codexAuthMode,
            },
            update: {
                status: TeamAgentAuthUpdateStatus.PENDING,
                claudeAuthMode: teamUser.claudeAuthMode,
                codexAuthMode: teamUser.codexAuthMode,
                error: null,
                appliedAt: null,
            },
        });

        results.push(await applyAgentAuthToMachine(teamUser, machine));
    }

    return summarizeSyncResult(results, machines.length);
}

export async function applyPendingAgentAuthForMachine(machineId: string): Promise<void> {
    const update = await db.teamAgentAuthUpdate.findFirst({
        where: {
            machineId,
            status: TeamAgentAuthUpdateStatus.PENDING,
        },
        include: { teamUser: true },
    });
    if (!update) {
        await bootstrapAgentAuthForMachine(machineId);
        return;
    }

    const machine = await db.machine.findFirst({
        where: {
            id: update.machineId,
            accountId: update.teamUser.accountId,
        },
    });
    if (!machine) {
        await db.teamAgentAuthUpdate.update({
            where: { id: update.id },
            data: {
                status: TeamAgentAuthUpdateStatus.FAILED,
                error: "Machine no longer exists",
            },
        });
        return;
    }

    await applyAgentAuthToMachine(update.teamUser, machine);
}

async function bootstrapAgentAuthForMachine(machineId: string): Promise<void> {
    const machine = await db.machine.findUnique({ where: { id: machineId } });
    if (!machine) {
        return;
    }

    const teamUser = await db.teamUser.findFirst({
        where: {
            accountId: machine.accountId,
            status: TeamUserStatus.ACTIVE,
        },
    });
    if (!teamUser) {
        return;
    }

    const existing = await db.teamAgentAuthUpdate.findUnique({
        where: {
            teamUserId_machineId: {
                teamUserId: teamUser.id,
                machineId: machine.id,
            },
        },
    });
    if (existing) {
        return;
    }

    await db.teamAgentAuthUpdate.create({
        data: {
            teamUserId: teamUser.id,
            machineId: machine.id,
            status: TeamAgentAuthUpdateStatus.PENDING,
            claudeAuthMode: teamUser.claudeAuthMode,
            codexAuthMode: teamUser.codexAuthMode,
        },
    });
    await applyAgentAuthToMachine(teamUser, machine);
}

function summarizeSyncResult(results: TeamAgentAuthSyncResult["machines"], totalMachines: number): TeamAgentAuthSyncResult {
    return {
        totalMachines,
        applied: results.filter((result) => result.status === TeamAgentAuthUpdateStatus.APPLIED).length,
        pending: results.filter((result) => result.status === TeamAgentAuthUpdateStatus.PENDING).length,
        failed: results.filter((result) => result.status === TeamAgentAuthUpdateStatus.FAILED).length,
        machines: results,
    };
}

async function applyAgentAuthToMachine(teamUser: TeamUser, machine: Machine): Promise<TeamAgentAuthSyncResult["machines"][number]> {
    const io = getSocketServer();
    if (!io) {
        return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.PENDING);
    }

    try {
        const env = buildTeamAgentEnv(teamUser);
        const encryption = resolveMachineEncryption(teamUser, machine);
        const method = `${machine.id}:team-apply-agent-env`;
        const encryptedParams = encodeBase64(encryptRpcPayload(encryption, {
            env,
            clearKeys: TEAM_AGENT_ENV_KEYS,
            restart: true,
        }));
        const rpc = await callRegisteredRpcMethod(io, teamUser.accountId, method, encryptedParams);
        if (!rpc.ok) {
            return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.PENDING, rpc.error);
        }
        if (typeof rpc.result !== "string") {
            return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.FAILED, "Invalid RPC response");
        }

        const response = decryptRpcPayload(encryption, decodeBase64(rpc.result));
        if (!response || typeof response !== "object") {
            return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.FAILED, "Unreadable RPC response");
        }
        if (typeof response.error === "string") {
            return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.FAILED, response.error);
        }

        return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.APPLIED);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to apply agent auth";
        return markAgentAuthUpdate(teamUser.id, machine.id, TeamAgentAuthUpdateStatus.FAILED, message);
    }
}

async function markAgentAuthUpdate(
    teamUserId: string,
    machineId: string,
    status: TeamAgentAuthUpdateStatus,
    error?: string,
): Promise<TeamAgentAuthSyncResult["machines"][number]> {
    await db.teamAgentAuthUpdate.update({
        where: {
            teamUserId_machineId: { teamUserId, machineId },
        },
        data: {
            status,
            error: error ? error.slice(0, 500) : null,
            appliedAt: status === TeamAgentAuthUpdateStatus.APPLIED ? new Date() : null,
        },
    });
    return {
        machineId,
        status,
        ...(error ? { error: error.slice(0, 500) } : {}),
    };
}

function buildTeamAgentEnv(teamUser: TeamUser): Partial<Record<TeamAgentEnvKey, string>> {
    const env: Partial<Record<TeamAgentEnvKey, string>> = {};

    if (teamUser.claudeAuthMode === AgentAuthMode.COMPANY_API) {
        const key = requireCompanySecret("TEAM_ANTHROPIC_API_KEY");
        env.ANTHROPIC_API_KEY = key;
        if (process.env.TEAM_ANTHROPIC_BASE_URL) {
            env.ANTHROPIC_BASE_URL = process.env.TEAM_ANTHROPIC_BASE_URL;
        }
    }

    if (teamUser.codexAuthMode === AgentAuthMode.COMPANY_API) {
        env.OPENAI_API_KEY = requireCompanySecret("TEAM_OPENAI_API_KEY");
    }

    return env;
}

function requireCompanySecret(name: "TEAM_ANTHROPIC_API_KEY" | "TEAM_OPENAI_API_KEY"): string {
    const value = process.env[name];
    if (!value) {
        throw new TeamAgentAuthConfigError(`${name} is not configured`);
    }
    return value;
}
