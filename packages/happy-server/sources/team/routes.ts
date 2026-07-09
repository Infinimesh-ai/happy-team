import { AgentAuthMode, TeamRole, TeamUserStatus } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/app/auth/auth";
import { type Fastify } from "@/app/api/types";
import { db } from "@/storage/db";
import { writeTeamAudit } from "@/team/audit";
import { checkLoginRateLimit } from "@/team/rateLimit";
import { getActiveAdminTeamUser, getActiveTeamUser } from "@/team/status";
import { assertValidPassword, generateTemporaryPassword, hashPassword, normalizeEmail, verifyPassword } from "@/team/passwords";
import { buildTeamLoginResponse, createTeamUser, toSafeTeamUser } from "@/team/teamUsers";

const teamRoleSchema = z.enum([TeamRole.ADMIN, TeamRole.MEMBER]);
const teamStatusSchema = z.enum([TeamUserStatus.ACTIVE, TeamUserStatus.DISABLED]);
const agentAuthModeSchema = z.enum([AgentAuthMode.COMPANY_API, AgentAuthMode.PERSONAL_OAUTH]);

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
                },
            });
        }

        return reply.send({
            user: toSafeTeamUser(updated),
            temporaryPassword,
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
}
