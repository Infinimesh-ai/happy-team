import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { TeamRole } from "@prisma/client";
import { type Fastify } from "@/app/api/types";

let app: Fastify;
let db: typeof import("@/storage/db").db;
let pgliteDir: string;

async function postJson(url: string, body: unknown, token?: string) {
    return app.inject({
        method: "POST",
        url,
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: JSON.stringify(body),
    });
}

async function patchJson(url: string, body: unknown, token: string) {
    return app.inject({
        method: "PATCH",
        url,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
        },
        payload: JSON.stringify(body),
    });
}

describe("team routes", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-team-routes-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "team-routes-test-master-secret";

        const { runMigrations } = await import("@/standalone");
        await runMigrations({
            pgliteDir,
            migrationsDir: path.join(process.cwd(), "prisma", "migrations"),
        });

        ({ db } = await import("@/storage/db"));
        const { initEncrypt } = await import("@/modules/encrypt");
        const { auth } = await import("@/app/auth/auth");
        const { enableAuthentication } = await import("@/app/api/utils/enableAuthentication");
        const { teamRoutes } = await import("@/team/routes");
        const { createTeamUser } = await import("@/team/teamUsers");

        await db.$connect();
        await initEncrypt();
        await auth.init();
        await createTeamUser({
            email: "admin@example.com",
            password: "AdminPass123",
            role: TeamRole.ADMIN,
        });

        const rawApp = fastify({ logger: false });
        rawApp.setValidatorCompiler(validatorCompiler);
        rawApp.setSerializerCompiler(serializerCompiler);
        app = rawApp.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        enableAuthentication(app);
        teamRoutes(app);
        await rawApp.ready();
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        if (pgliteDir) {
            await rm(pgliteDir, { recursive: true, force: true });
        }
    });

    it("logs in, manages members, changes password, disables old sessions, and audits actions", async () => {
        const adminLogin = await postJson("/v1/team/auth/login", {
            email: "ADMIN@example.com",
            password: "AdminPass123",
        });
        expect(adminLogin.statusCode).toBe(200);
        const adminBody = adminLogin.json<{
            happyToken: string;
            secretKey: string;
            role: TeamRole;
            mustChangePassword: boolean;
        }>();
        expect(adminBody.role).toBe(TeamRole.ADMIN);
        expect(Buffer.from(adminBody.secretKey, "base64url")).toHaveLength(32);

        const createMember = await postJson("/v1/team/admin/users", {
            email: "member@example.com",
            role: "MEMBER",
        }, adminBody.happyToken);
        expect(createMember.statusCode).toBe(201);
        const createMemberBody = createMember.json<{
            user: { id: string; email: string; accountId: string };
            initialPassword: string;
        }>();
        expect(createMemberBody.user.email).toBe("member@example.com");
        expect(createMemberBody.initialPassword.length).toBeGreaterThanOrEqual(10);

        const memberLogin = await postJson("/v1/team/auth/login", {
            email: "member@example.com",
            password: createMemberBody.initialPassword,
        });
        expect(memberLogin.statusCode).toBe(200);
        const memberBody = memberLogin.json<{ happyToken: string; secretKey: string; mustChangePassword: boolean }>();
        expect(memberBody.mustChangePassword).toBe(true);
        expect(Buffer.from(memberBody.secretKey, "base64url")).toHaveLength(32);

        const enrollToken = await postJson("/v1/team/admin/enroll-token", {
            targetUserId: createMemberBody.user.id,
            agents: [],
        }, adminBody.happyToken);
        expect(enrollToken.statusCode).toBe(201);
        const enrollTokenBody = enrollToken.json<{ token: string; manualCommand: string }>();
        expect(enrollTokenBody.token).toMatch(/^hte_/);
        expect(enrollTokenBody.manualCommand).toContain("enroll --server");

        const enroll = await postJson("/v1/team/enroll", {
            token: enrollTokenBody.token,
        });
        expect(enroll.statusCode).toBe(200);
        const enrollBody = enroll.json<{ secretKey: string }>();
        expect(Buffer.from(enrollBody.secretKey, "base64url")).toHaveLength(32);

        const reusedEnroll = await postJson("/v1/team/enroll", {
            token: enrollTokenBody.token,
        });
        expect(reusedEnroll.statusCode).toBe(400);

        const credential = await postJson("/v1/team/admin/ssh-credentials", {
            ownerUserId: createMemberBody.user.id,
            label: "devbox",
            host: "127.0.0.1",
            port: 22,
            username: "member",
            authType: "PASSWORD",
            password: "ssh-secret-password",
            deleteAfterUse: true,
        }, adminBody.happyToken);
        expect(credential.statusCode).toBe(201);
        const credentialBody = credential.json<{ credential: { id: string; host: string; authType: string; deleteAfterUse: boolean } }>();
        expect(credentialBody.credential.host).toBe("127.0.0.1");
        expect(credentialBody.credential.authType).toBe("PASSWORD");
        expect(credentialBody.credential.deleteAfterUse).toBe(true);
        expect(JSON.stringify(credentialBody)).not.toContain("ssh-secret-password");

        const storedCredential = await db.sshCredential.findUnique({ where: { id: credentialBody.credential.id } });
        expect(storedCredential).toBeTruthy();
        expect(JSON.stringify(storedCredential)).not.toContain("ssh-secret-password");

        const credentialsList = await app.inject({
            method: "GET",
            url: "/v1/team/admin/ssh-credentials",
            headers: { authorization: `Bearer ${adminBody.happyToken}` },
        });
        expect(credentialsList.statusCode).toBe(200);
        expect(JSON.stringify(credentialsList.json())).not.toContain("ssh-secret-password");

        const deleteCredential = await app.inject({
            method: "DELETE",
            url: `/v1/team/admin/ssh-credentials/${credentialBody.credential.id}`,
            headers: { authorization: `Bearer ${adminBody.happyToken}` },
        });
        expect(deleteCredential.statusCode).toBe(200);

        const machines = await app.inject({
            method: "GET",
            url: "/v1/team/admin/machines",
            headers: { authorization: `Bearer ${adminBody.happyToken}` },
        });
        expect(machines.statusCode).toBe(200);
        expect(machines.json<{ machines: unknown[] }>().machines).toEqual([]);

        const changed = await postJson("/v1/team/auth/change-password", {
            oldPassword: createMemberBody.initialPassword,
            newPassword: "MemberPass123",
        }, memberBody.happyToken);
        expect(changed.statusCode).toBe(200);

        const changedLogin = await postJson("/v1/team/auth/login", {
            email: "member@example.com",
            password: "MemberPass123",
        });
        expect(changedLogin.statusCode).toBe(200);
        const changedBody = changedLogin.json<{ happyToken: string; mustChangePassword: boolean }>();
        expect(changedBody.mustChangePassword).toBe(false);

        const disable = await patchJson(`/v1/team/admin/users/${createMemberBody.user.id}`, {
            status: "DISABLED",
        }, adminBody.happyToken);
        expect(disable.statusCode).toBe(200);

        const disabledLogin = await postJson("/v1/team/auth/login", {
            email: "member@example.com",
            password: "MemberPass123",
        });
        expect(disabledLogin.statusCode).toBe(403);

        const oldSession = await app.inject({
            method: "GET",
            url: "/v1/team/me",
            headers: { authorization: `Bearer ${changedBody.happyToken}` },
        });
        expect(oldSession.statusCode).toBe(403);

        const audit = await app.inject({
            method: "GET",
            url: "/v1/team/admin/audit?limit=100",
            headers: { authorization: `Bearer ${adminBody.happyToken}` },
        });
        expect(audit.statusCode).toBe(200);
        const actions = audit.json<{ logs: Array<{ action: string }> }>().logs.map((log) => log.action);
        expect(actions).toContain("login");
        expect(actions).toContain("create_user");
        expect(actions).toContain("create_enroll_token");
        expect(actions).toContain("enroll");
        expect(actions).toContain("create_ssh_credential");
        expect(actions).toContain("delete_ssh_credential");
        expect(actions).toContain("change_password");
        expect(actions).toContain("disable_user");
    });

    it("redacts provisioning secrets before persisting logs", async () => {
        const { redactProvisionText } = await import("@/team/provision/runner");
        const redacted = redactProvisionText("token hte_secret password ssh-secret api sk-secret", [
            "hte_secret",
            "ssh-secret",
            "sk-secret",
        ]);
        expect(redacted).toBe("token [redacted] password [redacted] api [redacted]");
    });
});
