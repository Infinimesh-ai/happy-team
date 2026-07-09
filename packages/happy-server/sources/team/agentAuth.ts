import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";
import { AgentAuthMode, TeamAgentAuthUpdateStatus, TeamUserStatus, type Machine, type TeamUser } from "@prisma/client";
import nacl from "tweetnacl";
import { callRegisteredRpcMethod } from "@/app/api/socket/rpcHandler";
import { getSocketServer } from "@/app/api/socket";
import { db } from "@/storage/db";
import { decryptManagedSecretKey } from "@/team/escrow";

const TEAM_AGENT_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"] as const;
type TeamAgentEnvKey = typeof TEAM_AGENT_ENV_KEYS[number];
type MachineEncryption = {
    key: Uint8Array;
    variant: "legacy" | "dataKey";
};

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

export class TeamAgentAuthConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TeamAgentAuthConfigError";
    }
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

function resolveMachineEncryption(teamUser: TeamUser, machine: Machine): MachineEncryption {
    const secret = decryptManagedSecretKey(teamUser.accountId, machineSafeBytes(teamUser.encSecretKey));
    if (!machine.dataEncryptionKey) {
        return { key: secret, variant: "legacy" };
    }

    const dataKey = decryptDataEncryptionKey(machineSafeBytes(machine.dataEncryptionKey), secret);
    if (!dataKey) {
        throw new Error("Unable to decrypt machine data key");
    }
    return { key: dataKey, variant: "dataKey" };
}

function machineSafeBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
}

function decryptDataEncryptionKey(bundle: Uint8Array, managedSecret: Uint8Array): Uint8Array | null {
    if (bundle[0] !== 0) {
        return null;
    }
    const keyPair = deriveContentBoxKeyPair(managedSecret);
    return decryptBox(bundle.slice(1), keyPair.secretKey);
}

function deriveContentBoxKeyPair(secret: Uint8Array): nacl.BoxKeyPair {
    const seed = deriveKey(secret, "Happy EnCoder", ["content"]);
    const hashedSeed = new Uint8Array(createHash("sha512").update(seed).digest());
    return nacl.box.keyPair.fromSecretKey(hashedSeed.slice(0, 32));
}

function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const root = hmacSha512(new TextEncoder().encode(`${usage} Master Seed`), master);
    let state = {
        key: root.slice(0, 32),
        chainCode: root.slice(32),
    };

    for (const index of path) {
        const data = new Uint8Array([0x00, ...new TextEncoder().encode(index)]);
        const derived = hmacSha512(state.chainCode, data);
        state = {
            key: derived.slice(0, 32),
            chainCode: derived.slice(32),
        };
    }

    return state.key;
}

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hmac = createHmac("sha512", key);
    hmac.update(data);
    return new Uint8Array(hmac.digest());
}

function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const ephemeralPublicKey = encryptedBundle.slice(0, nacl.box.publicKeyLength);
    const nonce = encryptedBundle.slice(nacl.box.publicKeyLength, nacl.box.publicKeyLength + nacl.box.nonceLength);
    const encrypted = encryptedBundle.slice(nacl.box.publicKeyLength + nacl.box.nonceLength);
    const decrypted = nacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    return decrypted ? new Uint8Array(decrypted) : null;
}

function encryptRpcPayload(encryption: MachineEncryption, data: unknown): Uint8Array {
    if (encryption.variant === "legacy") {
        return encryptLegacy(data, encryption.key);
    }
    return encryptWithDataKey(data, encryption.key);
}

function decryptRpcPayload(encryption: MachineEncryption, bundle: Uint8Array): any | null {
    if (encryption.variant === "legacy") {
        return decryptLegacy(bundle, encryption.key);
    }
    return decryptWithDataKey(bundle, encryption.key);
}

function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
    const encrypted = nacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const encrypted = data.slice(nacl.secretbox.nonceLength);
    const decrypted = nacl.secretbox.open(encrypted, nonce, secret);
    if (!decrypted) {
        return null;
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
}

function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    const encrypted = Buffer.concat([
        cipher.update(new TextEncoder().encode(JSON.stringify(data))),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const bundle = new Uint8Array(1 + nonce.length + encrypted.length + authTag.length);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(encrypted, 13);
    bundle.set(authTag, 13 + encrypted.length);
    return bundle;
}

function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
    if (bundle[0] !== 0 || bundle.length < 29) {
        return null;
    }
    const nonce = bundle.slice(1, 13);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    const authTag = bundle.slice(bundle.length - 16);
    try {
        const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

function encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function decodeBase64(base64: string): Uint8Array {
    return new Uint8Array(Buffer.from(base64, "base64"));
}
