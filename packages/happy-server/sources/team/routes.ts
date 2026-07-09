import { AgentAuthMode, ProvisionStatus, SshAuthType, TeamRole, TeamUserStatus } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/app/auth/auth";
import { type Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { getAgentAuthStatusForUser, queueAgentAuthSyncForUser } from "@/team/agentAuth";
import { getTeamPublicServerUrl, sendNodeArtifact, sendTeamCliArtifact } from "@/team/artifacts";
import { writeTeamAudit } from "@/team/audit";
import { consumeEnrollToken, createEnrollToken } from "@/team/enrollTokens";
import { getTeamDeploymentPreflight } from "@/team/preflight";
import { buildProvisionManualInstallCommand, enqueueProvisionJob, getProvisionQueueState } from "@/team/provision/runner";
import { checkLoginRateLimit } from "@/team/rateLimit";
import { getActiveAdminTeamUser, getActiveTeamUser } from "@/team/status";
import { assertValidPassword, generateTemporaryPassword, hashPassword, normalizeEmail, verifyPassword } from "@/team/passwords";
import { createSshCredential, deleteSshCredential, toSafeSshCredential } from "@/team/sshCredentials";
import { buildTeamLoginResponse, createTeamUser, toSafeTeamUser } from "@/team/teamUsers";

const teamRoleSchema = z.enum([TeamRole.ADMIN, TeamRole.MEMBER]);
const teamStatusSchema = z.enum([TeamUserStatus.ACTIVE, TeamUserStatus.DISABLED]);
const agentAuthModeSchema = z.enum([AgentAuthMode.COMPANY_API, AgentAuthMode.PERSONAL_OAUTH]);
const sshAuthTypeSchema = z.enum([SshAuthType.PASSWORD, SshAuthType.PRIVATE_KEY]);
const provisionAgentSchema = z.enum(["claude", "codex"]);

async function requireTeamUser(request: { userId: string }, reply: { code: (code: number) => { send: (body: unknown) => unknown } }) {
    const teamUser = await getActiveTeamUser(request.userId);
    if (!teamUser) {
        return { teamUser: null, response: reply.code(403).send({ error: "Team user required" }) };
    }
    return { teamUser, response: null };
}

async function requireAdmin(request: { userId: string }, reply: { code: (code: number) => { send: (body: unknown) => unknown } }) {
    const teamUser = await getActiveAdminTeamUser(request.userId);
    if (!teamUser) {
        return { teamUser: null, response: reply.code(403).send({ error: "Team admin required" }) };
    }
    return { teamUser, response: null };
}

export function teamRoutes(app: Fastify) {
    app.get("/v1/team/artifacts/cli.tgz", async (_request, reply) => {
        return sendTeamCliArtifact(reply);
    });

    app.get("/v1/team/artifacts/node/:platform/:arch", {
        schema: {
            params: z.object({
                platform: z.string().min(1),
                arch: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        return sendNodeArtifact(reply, request.params.platform, request.params.arch);
    });

    app.post("/v1/team/enroll", {
        schema: {
            body: z.object({
                token: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const consumed = await consumeEnrollToken(request.body.token);
        if (!consumed.ok) {
            return reply.code(consumed.statusCode).send({ error: consumed.error });
        }
        return reply.send({ secretKey: consumed.secretKey });
    });

    app.post("/v1/team/auth/login", {
        schema: {
            body: z.object({
                email: z.string().email(),
                password: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const email = normalizeEmail(request.body.email);
        const rateLimit = await checkLoginRateLimit(request.ip, email);
        if (!rateLimit.ok) {
            await writeTeamAudit({
                action: "login_failed",
                detail: { email, reason: "rate_limited" },
            });
            return reply
                .code(429)
                .header("Retry-After", String(rateLimit.retryAfterSeconds ?? 60))
                .send({ error: "Too many login attempts" });
        }

        const teamUser = await db.teamUser.findUnique({ where: { email } });
        const validPassword = teamUser ? await verifyPassword(teamUser.passwordHash, request.body.password) : false;
        if (!teamUser || !validPassword) {
            await writeTeamAudit({
                action: "login_failed",
                detail: { email, reason: "invalid_credentials" },
            });
            return reply.code(401).send({ error: "Invalid email or password" });
        }
        if (teamUser.status !== TeamUserStatus.ACTIVE) {
            await writeTeamAudit({
                actorId: teamUser.id,
                action: "login_failed",
                target: teamUser.id,
                detail: { email, reason: "disabled" },
            });
            return reply.code(403).send({ error: "User is disabled" });
        }

        await writeTeamAudit({
            actorId: teamUser.id,
            action: "login",
            target: teamUser.id,
            detail: { email },
        });
        return reply.send(await buildTeamLoginResponse(teamUser));
    });

    app.get("/v1/team/me", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser, response } = await requireTeamUser(request, reply);
        if (!teamUser) {
            return response;
        }
        return reply.send({ user: toSafeTeamUser(teamUser) });
    });

    app.get("/v1/team/auth/me", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser, response } = await requireTeamUser(request, reply);
        if (!teamUser) {
            return response;
        }
        return reply.send({ user: toSafeTeamUser(teamUser) });
    });

    app.get("/v1/team/me/agent-auth", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser, response } = await requireTeamUser(request, reply);
        if (!teamUser) {
            return response;
        }
        return reply.send({
            user: toSafeTeamUser(teamUser),
            agentAuthStatus: await getAgentAuthStatusForUser(teamUser),
        });
    });

    app.post("/v1/team/auth/change-password", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                oldPassword: z.string().min(1),
                newPassword: z.string().min(10),
            }),
        },
    }, async (request, reply) => {
        const { teamUser, response } = await requireTeamUser(request, reply);
        if (!teamUser) {
            return response;
        }
        const validPassword = await verifyPassword(teamUser.passwordHash, request.body.oldPassword);
        if (!validPassword) {
            await writeTeamAudit({
                actorId: teamUser.id,
                action: "change_password_failed",
                target: teamUser.id,
                detail: { reason: "invalid_old_password" },
            });
            return reply.code(401).send({ error: "Invalid current password" });
        }

        assertValidPassword(request.body.newPassword);
        const passwordHash = await hashPassword(request.body.newPassword);
        await db.teamUser.update({
            where: { id: teamUser.id },
            data: {
                passwordHash,
                mustChangePassword: false,
            },
        });
        auth.invalidateUserTokens(teamUser.accountId);
        await writeTeamAudit({
            actorId: teamUser.id,
            action: "change_password",
            target: teamUser.id,
        });
        return reply.send({ success: true });
    });

    app.patch("/v1/team/me/agent-auth", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                claudeAuthMode: agentAuthModeSchema.optional(),
                codexAuthMode: agentAuthModeSchema.optional(),
            }),
        },
    }, async (request, reply) => {
        const { teamUser, response } = await requireTeamUser(request, reply);
        if (!teamUser) {
            return response;
        }
        if (!request.body.claudeAuthMode && !request.body.codexAuthMode) {
            return reply.code(400).send({ error: "At least one auth mode is required" });
        }

        const updated = await db.teamUser.update({
            where: { id: teamUser.id },
            data: {
                ...(request.body.claudeAuthMode ? { claudeAuthMode: request.body.claudeAuthMode } : {}),
                ...(request.body.codexAuthMode ? { codexAuthMode: request.body.codexAuthMode } : {}),
            },
        });
        const agentAuthSync = await queueAgentAuthSyncForUser(updated);
        await writeTeamAudit({
            actorId: teamUser.id,
            action: "self_update_agent_auth_mode",
            target: updated.id,
            detail: {
                claudeAuthMode: updated.claudeAuthMode,
                codexAuthMode: updated.codexAuthMode,
                sync: {
                    totalMachines: agentAuthSync.totalMachines,
                    applied: agentAuthSync.applied,
                    pending: agentAuthSync.pending,
                    failed: agentAuthSync.failed,
                },
            },
        });
        return reply.send({ user: toSafeTeamUser(updated), agentAuthSync });
    });

    app.get("/v1/team/admin/users", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const users = await db.teamUser.findMany({
            orderBy: { createdAt: "asc" },
        });
        const machineCounts = await Promise.all(users.map((user) => db.machine.count({ where: { accountId: user.accountId } })));
        return reply.send({
            users: users.map((user, index) => toSafeTeamUser(user, machineCounts[index])),
        });
    });

    app.post("/v1/team/admin/users", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                email: z.string().email(),
                role: teamRoleSchema.optional(),
                password: z.string().min(10).optional(),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }

        const created = await createTeamUser({
            email: request.body.email,
            role: request.body.role ?? TeamRole.MEMBER,
            password: request.body.password,
            actorId: admin.id,
        });
        return reply.code(201).send(created);
    });

    app.patch("/v1/team/admin/users/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string().min(1),
            }),
            body: z.object({
                role: teamRoleSchema.optional(),
                status: teamStatusSchema.optional(),
                resetPassword: z.boolean().optional(),
                password: z.string().min(10).optional(),
                claudeAuthMode: agentAuthModeSchema.optional(),
                codexAuthMode: agentAuthModeSchema.optional(),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }

        const target = await db.teamUser.findUnique({ where: { id: request.params.id } });
        if (!target) {
            return reply.code(404).send({ error: "User not found" });
        }

        const data: {
            role?: TeamRole;
            status?: TeamUserStatus;
            passwordHash?: string;
            mustChangePassword?: boolean;
            claudeAuthMode?: AgentAuthMode;
            codexAuthMode?: AgentAuthMode;
        } = {};
        if (request.body.role) {
            data.role = request.body.role;
        }
        if (request.body.status) {
            data.status = request.body.status;
        }
        if (request.body.claudeAuthMode) {
            data.claudeAuthMode = request.body.claudeAuthMode;
        }
        if (request.body.codexAuthMode) {
            data.codexAuthMode = request.body.codexAuthMode;
        }

        let temporaryPassword: string | undefined;
        if (request.body.resetPassword || request.body.password) {
            temporaryPassword = request.body.password ?? generateTemporaryPassword();
            data.passwordHash = await hashPassword(temporaryPassword);
            data.mustChangePassword = true;
        }

        const updated = await db.teamUser.update({
            where: { id: target.id },
            data,
        });

        if (data.status === TeamUserStatus.DISABLED || data.passwordHash) {
            auth.invalidateUserTokens(updated.accountId);
        }

        const actions: string[] = [];
        if (data.status === TeamUserStatus.DISABLED) actions.push("disable_user");
        if (data.status === TeamUserStatus.ACTIVE && target.status !== TeamUserStatus.ACTIVE) actions.push("enable_user");
        if (data.passwordHash) actions.push("reset_password");
        if (data.role && data.role !== target.role) actions.push("update_role");
        if (data.claudeAuthMode || data.codexAuthMode) actions.push("update_agent_auth_mode");
        let agentAuthSync: Awaited<ReturnType<typeof queueAgentAuthSyncForUser>> | undefined;
        if (data.claudeAuthMode || data.codexAuthMode) {
            agentAuthSync = await queueAgentAuthSyncForUser(updated);
        }

        for (const action of actions) {
            await writeTeamAudit({
                actorId: admin.id,
                action,
                target: updated.id,
                detail: {
                    email: updated.email,
                    role: updated.role,
                    status: updated.status,
                    claudeAuthMode: updated.claudeAuthMode,
                    codexAuthMode: updated.codexAuthMode,
                    ...(action === "update_agent_auth_mode" && agentAuthSync ? {
                        sync: {
                            totalMachines: agentAuthSync.totalMachines,
                            applied: agentAuthSync.applied,
                            pending: agentAuthSync.pending,
                            failed: agentAuthSync.failed,
                        },
                    } : {}),
                },
            });
        }

        return reply.send({
            user: toSafeTeamUser(updated),
            temporaryPassword,
            agentAuthSync,
        });
    });

    app.get("/v1/team/admin/audit", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(50),
                cursor: z.string().optional(),
                action: z.string().optional(),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const logs = await db.teamAuditLog.findMany({
            where: {
                action: request.query.action,
            },
            orderBy: { createdAt: "desc" },
            take: request.query.limit,
            ...(request.query.cursor ? { cursor: { id: request.query.cursor }, skip: 1 } : {}),
        });
        return reply.send({
            logs: logs.map((log) => ({
                ...log,
                createdAt: log.createdAt.toISOString(),
            })),
            nextCursor: logs.length === request.query.limit ? logs[logs.length - 1]?.id : null,
        });
    });

    app.get("/v1/team/admin/preflight", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        return reply.send(await getTeamDeploymentPreflight(request));
    });

    app.post("/v1/team/admin/enroll-token", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                targetUserId: z.string().min(1),
                agents: z.array(provisionAgentSchema).default(["claude"]),
                ttlMinutes: z.number().int().min(1).max(60).optional(),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const target = await db.teamUser.findUnique({ where: { id: request.body.targetUserId } });
        if (!target || target.status !== TeamUserStatus.ACTIVE) {
            return reply.code(404).send({ error: "Active target user not found" });
        }

        const serverUrl = getTeamPublicServerUrl(request);
        const token = await createEnrollToken({
            targetUserId: target.id,
            actorId: admin.id,
            ttlMs: (request.body.ttlMinutes ?? 15) * 60 * 1000,
        });

        return reply.code(201).send({
            id: token.id,
            token: token.token,
            expiresAt: token.expiresAt.toISOString(),
            manualCommand: buildProvisionManualInstallCommand({
                serverUrl,
                token: token.token,
                agents: request.body.agents,
            }),
        });
    });

    app.get("/v1/team/admin/machines", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const users = await db.teamUser.findMany({
            orderBy: { email: "asc" },
            select: { id: true, email: true, accountId: true },
        });
        const userByAccount = new Map(users.map((user) => [user.accountId, user]));
        const machines = await db.machine.findMany({
            where: { accountId: { in: users.map((user) => user.accountId) } },
            orderBy: { lastActiveAt: "desc" },
        });
        return reply.send({
            machines: machines.map((machine) => {
                const owner = userByAccount.get(machine.accountId);
                return {
                    id: machine.id,
                    accountId: machine.accountId,
                    ownerUserId: owner?.id ?? null,
                    ownerEmail: owner?.email ?? null,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),
                    createdAt: machine.createdAt.toISOString(),
                    updatedAt: machine.updatedAt.toISOString(),
                };
            }),
        });
    });

    app.get("/v1/team/admin/ssh-credentials", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const credentials = await db.sshCredential.findMany({
            orderBy: { createdAt: "desc" },
        });
        return reply.send({ credentials: credentials.map(toSafeSshCredential) });
    });

    app.post("/v1/team/admin/ssh-credentials", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                ownerUserId: z.string().min(1),
                label: z.string().min(1).max(120),
                host: z.string().min(1).max(255),
                port: z.number().int().min(1).max(65535).default(22),
                username: z.string().min(1).max(128),
                authType: sshAuthTypeSchema,
                password: z.string().min(1).optional(),
                privateKey: z.string().min(1).optional(),
                passphrase: z.string().optional(),
                deleteAfterUse: z.boolean().default(false),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const owner = await db.teamUser.findUnique({ where: { id: request.body.ownerUserId } });
        if (!owner || owner.status !== TeamUserStatus.ACTIVE) {
            return reply.code(404).send({ error: "Active owner user not found" });
        }
        if (request.body.authType === SshAuthType.PASSWORD && !request.body.password) {
            return reply.code(400).send({ error: "password is required for PASSWORD auth" });
        }
        if (request.body.authType === SshAuthType.PRIVATE_KEY && !request.body.privateKey) {
            return reply.code(400).send({ error: "privateKey is required for PRIVATE_KEY auth" });
        }

        const credential = await createSshCredential({
            ownerUserId: owner.id,
            label: request.body.label,
            host: request.body.host,
            port: request.body.port,
            username: request.body.username,
            deleteAfterUse: request.body.deleteAfterUse,
            createdBy: admin.id,
            auth: request.body.authType === SshAuthType.PASSWORD
                ? { type: SshAuthType.PASSWORD, password: request.body.password! }
                : { type: SshAuthType.PRIVATE_KEY, privateKey: request.body.privateKey!, passphrase: request.body.passphrase },
        });

        return reply.code(201).send({ credential });
    });

    app.delete("/v1/team/admin/ssh-credentials/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const deleted = await deleteSshCredential(request.params.id, admin.id);
        if (!deleted) {
            return reply.code(404).send({ error: "SSH credential not found" });
        }
        return reply.send({ success: true });
    });

    app.get("/v1/team/admin/provision-jobs", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).default(50),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const jobs = await db.provisionJob.findMany({
            orderBy: { createdAt: "desc" },
            take: request.query.limit,
        });
        return reply.send({
            jobs: jobs.map(toSafeProvisionJob),
            queue: getProvisionQueueState(),
        });
    });

    app.get("/v1/team/admin/provision-jobs/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const job = await db.provisionJob.findUnique({ where: { id: request.params.id } });
        if (!job) {
            return reply.code(404).send({ error: "Provision job not found" });
        }
        return reply.send({ job: toSafeProvisionJob(job), queue: getProvisionQueueState() });
    });

    app.post("/v1/team/admin/provision-jobs/:id/retry", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string().min(1),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }

        const original = await db.provisionJob.findUnique({ where: { id: request.params.id } });
        if (!original) {
            return reply.code(404).send({ error: "Provision job not found" });
        }
        if (original.status !== ProvisionStatus.FAILED) {
            return reply.code(400).send({ error: "Only failed provision jobs can be retried" });
        }
        if (!original.credentialId) {
            return reply.code(400).send({ error: "Provision job does not have an SSH credential to retry" });
        }

        const [credential, target] = await Promise.all([
            db.sshCredential.findUnique({ where: { id: original.credentialId } }),
            db.teamUser.findUnique({ where: { id: original.targetUserId } }),
        ]);
        if (!credential) {
            return reply.code(400).send({ error: "Original SSH credential is no longer available" });
        }
        if (!target || target.status !== TeamUserStatus.ACTIVE) {
            return reply.code(404).send({ error: "Active target user not found" });
        }
        if (credential.ownerUserId !== target.id) {
            return reply.code(400).send({ error: "SSH credential owner must match target user" });
        }

        const serverUrl = getTeamPublicServerUrl(request);
        const token = await createEnrollToken({
            targetUserId: target.id,
            actorId: admin.id,
        });
        const manualCommand = buildProvisionManualInstallCommand({
            serverUrl,
            token: token.token,
            agents: original.agents,
        });
        const job = await db.provisionJob.create({
            data: {
                credentialId: credential.id,
                hostSnapshot: JSON.stringify({
                    host: credential.host,
                    port: credential.port,
                    username: credential.username,
                    authType: credential.authType,
                }),
                targetUserId: target.id,
                agents: original.agents,
                status: ProvisionStatus.PENDING,
                createdBy: admin.id,
            },
        });
        await writeTeamAudit({
            actorId: admin.id,
            action: "provision_retry_created",
            target: target.id,
            detail: { jobId: job.id, previousJobId: original.id, credentialId: credential.id, agents: original.agents },
        });

        enqueueProvisionJob(job.id, {
            enrollToken: token.token,
            serverUrl,
        });

        return reply.code(201).send({
            job: toSafeProvisionJob(job),
            enrollToken: {
                id: token.id,
                token: token.token,
                expiresAt: token.expiresAt.toISOString(),
            },
            manualCommand,
        });
    });

    app.post("/v1/team/admin/provision-jobs", {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                credentialId: z.string().min(1),
                targetUserId: z.string().min(1),
                agents: z.array(provisionAgentSchema).default(["claude"]),
            }),
        },
    }, async (request, reply) => {
        const { teamUser: admin, response } = await requireAdmin(request, reply);
        if (!admin) {
            return response;
        }
        const [credential, target] = await Promise.all([
            db.sshCredential.findUnique({ where: { id: request.body.credentialId } }),
            db.teamUser.findUnique({ where: { id: request.body.targetUserId } }),
        ]);
        if (!credential) {
            return reply.code(404).send({ error: "SSH credential not found" });
        }
        if (!target || target.status !== TeamUserStatus.ACTIVE) {
            return reply.code(404).send({ error: "Active target user not found" });
        }
        if (credential.ownerUserId !== target.id) {
            return reply.code(400).send({ error: "SSH credential owner must match target user" });
        }

        const serverUrl = getTeamPublicServerUrl(request);
        const token = await createEnrollToken({
            targetUserId: target.id,
            actorId: admin.id,
        });
        const manualCommand = buildProvisionManualInstallCommand({
            serverUrl,
            token: token.token,
            agents: request.body.agents,
        });
        const job = await db.provisionJob.create({
            data: {
                credentialId: credential.id,
                hostSnapshot: JSON.stringify({
                    host: credential.host,
                    port: credential.port,
                    username: credential.username,
                    authType: credential.authType,
                }),
                targetUserId: target.id,
                agents: request.body.agents,
                status: ProvisionStatus.PENDING,
                createdBy: admin.id,
            },
        });
        await writeTeamAudit({
            actorId: admin.id,
            action: "provision_created",
            target: target.id,
            detail: { jobId: job.id, credentialId: credential.id, agents: request.body.agents },
        });

        enqueueProvisionJob(job.id, {
            enrollToken: token.token,
            serverUrl,
        });

        return reply.code(201).send({
            job: toSafeProvisionJob(job),
            enrollToken: {
                id: token.id,
                token: token.token,
                expiresAt: token.expiresAt.toISOString(),
            },
            manualCommand,
        });
    });
}

function toSafeProvisionJob(job: {
    id: string;
    credentialId: string | null;
    hostSnapshot: string;
    targetUserId: string;
    agents: string[];
    status: ProvisionStatus;
    step: string | null;
    log: string;
    machineId: string | null;
    error: string | null;
    createdBy: string;
    createdAt: Date;
    finishedAt: Date | null;
}) {
    return {
        id: job.id,
        credentialId: job.credentialId,
        hostSnapshot: job.hostSnapshot,
        targetUserId: job.targetUserId,
        agents: job.agents,
        status: job.status,
        step: job.step,
        log: job.log,
        machineId: job.machineId,
        error: job.error,
        createdBy: job.createdBy,
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
    };
}
