import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { AgentAuthMode, TeamAgentAuthUpdateStatus, TeamRole } from "@prisma/client";
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
        process.env.TEAM_ANTHROPIC_API_KEY = "sk-ant-routes-test";
        process.env.TEAM_OPENAI_API_KEY = "sk-openai-routes-test";

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

    it("rejects Node artifacts whose binary header does not match the requested platform", async () => {
        const previousArtifactDir = process.env.TEAM_NODE_ARTIFACT_DIR;
        const artifactDir = await mkdtemp(path.join(tmpdir(), "happy-team-route-node-artifacts-"));
        try {
            process.env.TEAM_NODE_ARTIFACT_DIR = artifactDir;
            const nodePath = path.join(artifactDir, "darwin-arm64", "node");
            await mkdir(path.dirname(nodePath), { recursive: true });
            await writeFile(nodePath, elfHeader(0xb7));

            const response = await app.inject({
                method: "GET",
                url: "/v1/team/artifacts/node/darwin/arm64",
            });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toMatchObject({
                error: "Team Node artifact does not match requested platform",
                platform: "darwin",
                arch: "arm64",
                validationError: "Expected darwin/arm64, got linux/arm64",
                detectedPlatform: "linux",
                detectedArch: "arm64",
            });
        } finally {
            if (previousArtifactDir === undefined) {
                delete process.env.TEAM_NODE_ARTIFACT_DIR;
            } else {
                process.env.TEAM_NODE_ARTIFACT_DIR = previousArtifactDir;
            }
            await rm(artifactDir, { recursive: true, force: true });
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

        const adminPreflight = await app.inject({
            method: "GET",
            url: "/v1/team/admin/preflight",
            headers: { authorization: `Bearer ${adminBody.happyToken}` },
        });
        expect(adminPreflight.statusCode).toBe(200);
        const adminPreflightBody = adminPreflight.json<{
            status: "ok" | "warning" | "action_required";
            serverUrl: string;
            checks: Array<{ key: string; status: string; detail?: Record<string, unknown> }>;
        }>();
        expect(["ok", "warning", "action_required"]).toContain(adminPreflightBody.status);
        expect(adminPreflightBody.serverUrl).toBeTruthy();
        expect(adminPreflightBody.checks.map((check) => check.key)).toEqual(expect.arrayContaining([
            "handy_master_secret",
            "team_public_server_url",
            "team_cli_artifact",
            "node_artifact_linux_x64",
            "node_artifact_linux_arm64",
            "node_artifact_darwin_x64",
            "node_artifact_darwin_arm64",
            "claude_sdk_binary_linux_x64",
            "claude_sdk_binary_linux_arm64",
            "claude_sdk_binary_darwin_x64",
            "claude_sdk_binary_darwin_arm64",
            "codex_cli_binary_linux_x64",
            "codex_cli_binary_linux_arm64",
            "codex_cli_binary_darwin_x64",
            "codex_cli_binary_darwin_arm64",
            "team_anthropic_api_key",
            "team_openai_api_key",
        ]));
        const adminPreflightJson = JSON.stringify(adminPreflightBody);
        expect(adminPreflightJson).not.toContain("team-routes-test-master-secret");
        expect(adminPreflightJson).not.toContain("sk-ant-routes-test");
        expect(adminPreflightJson).not.toContain("sk-openai-routes-test");

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

        const memberPreflight = await app.inject({
            method: "GET",
            url: "/v1/team/admin/preflight",
            headers: { authorization: `Bearer ${memberBody.happyToken}` },
        });
        expect(memberPreflight.statusCode).toBe(403);

        const enrollToken = await postJson("/v1/team/admin/enroll-token", {
            targetUserId: createMemberBody.user.id,
            agents: [],
        }, adminBody.happyToken);
        expect(enrollToken.statusCode).toBe(201);
        const enrollTokenBody = enrollToken.json<{ token: string; manualCommand: string }>();
        expect(enrollTokenBody.token).toMatch(/^hte_/);
        expect(enrollTokenBody.manualCommand).toContain("enroll --server");
        expect(enrollTokenBody.manualCommand).toContain("PATH=\"$HOME/.happy-team/bin:$PATH\"; export PATH");

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

        await db.machine.create({
            data: {
                id: "team-route-machine",
                accountId: createMemberBody.user.accountId,
                metadata: "encrypted-metadata",
                active: false,
                lastActiveAt: new Date(0),
            },
        });

        const { applyPendingAgentAuthForMachine } = await import("@/team/agentAuth");
        await applyPendingAgentAuthForMachine("team-route-machine");
        const bootstrapAgentAuth = await db.teamAgentAuthUpdate.findUnique({
            where: {
                teamUserId_machineId: {
                    teamUserId: createMemberBody.user.id,
                    machineId: "team-route-machine",
                },
            },
        });
        expect(bootstrapAgentAuth?.status).toBe(TeamAgentAuthUpdateStatus.PENDING);
        expect(bootstrapAgentAuth?.claudeAuthMode).toBe(AgentAuthMode.COMPANY_API);
        expect(JSON.stringify(bootstrapAgentAuth)).not.toContain("sk-ant-routes-test");
        expect(JSON.stringify(bootstrapAgentAuth)).not.toContain("sk-openai-routes-test");

        const initialAgentAuthStatus = await app.inject({
            method: "GET",
            url: "/v1/team/me/agent-auth",
            headers: { authorization: `Bearer ${memberBody.happyToken}` },
        });
        expect(initialAgentAuthStatus.statusCode).toBe(200);
        expect(initialAgentAuthStatus.json()).toMatchObject({
            user: {
                claudeAuthMode: AgentAuthMode.COMPANY_API,
                codexAuthMode: AgentAuthMode.COMPANY_API,
            },
            agentAuthStatus: {
                totalMachines: 1,
                pending: 1,
                applied: 0,
                failed: 0,
                machines: [{
                    machineId: "team-route-machine",
                    status: TeamAgentAuthUpdateStatus.PENDING,
                    claudeAuthMode: AgentAuthMode.COMPANY_API,
                    codexAuthMode: AgentAuthMode.COMPANY_API,
                    active: false,
                }],
            },
        });
        expect(JSON.stringify(initialAgentAuthStatus.json())).not.toContain("sk-ant-routes-test");
        expect(JSON.stringify(initialAgentAuthStatus.json())).not.toContain("sk-openai-routes-test");

        const agentAuth = await patchJson("/v1/team/me/agent-auth", {
            claudeAuthMode: AgentAuthMode.PERSONAL_OAUTH,
            codexAuthMode: AgentAuthMode.COMPANY_API,
        }, memberBody.happyToken);
        expect(agentAuth.statusCode).toBe(200);
        const agentAuthBody = agentAuth.json<{
            user: { claudeAuthMode: AgentAuthMode; codexAuthMode: AgentAuthMode };
            agentAuthSync: { totalMachines: number; pending: number; applied: number; failed: number };
        }>();
        expect(agentAuthBody.user.claudeAuthMode).toBe(AgentAuthMode.PERSONAL_OAUTH);
        expect(agentAuthBody.agentAuthSync).toMatchObject({
            totalMachines: 1,
            pending: 1,
            applied: 0,
            failed: 0,
        });
        const queuedAgentAuth = await db.teamAgentAuthUpdate.findUnique({
            where: {
                teamUserId_machineId: {
                    teamUserId: createMemberBody.user.id,
                    machineId: "team-route-machine",
                },
            },
        });
        expect(queuedAgentAuth?.status).toBe(TeamAgentAuthUpdateStatus.PENDING);
        expect(queuedAgentAuth?.claudeAuthMode).toBe(AgentAuthMode.PERSONAL_OAUTH);
        expect(JSON.stringify(queuedAgentAuth)).not.toContain("sk-ant-routes-test");
        expect(JSON.stringify(queuedAgentAuth)).not.toContain("sk-openai-routes-test");

        const updatedAgentAuthStatus = await app.inject({
            method: "GET",
            url: "/v1/team/me/agent-auth",
            headers: { authorization: `Bearer ${memberBody.happyToken}` },
        });
        expect(updatedAgentAuthStatus.statusCode).toBe(200);
        expect(updatedAgentAuthStatus.json()).toMatchObject({
            user: {
                claudeAuthMode: AgentAuthMode.PERSONAL_OAUTH,
                codexAuthMode: AgentAuthMode.COMPANY_API,
            },
            agentAuthStatus: {
                totalMachines: 1,
                pending: 1,
                machines: [{
                    machineId: "team-route-machine",
                    status: TeamAgentAuthUpdateStatus.PENDING,
                    claudeAuthMode: AgentAuthMode.PERSONAL_OAUTH,
                    codexAuthMode: AgentAuthMode.COMPANY_API,
                }],
            },
        });
        expect(JSON.stringify(updatedAgentAuthStatus.json())).not.toContain("sk-ant-routes-test");
        expect(JSON.stringify(updatedAgentAuthStatus.json())).not.toContain("sk-openai-routes-test");

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

function elfHeader(machine: number): Buffer {
    const header = Buffer.alloc(64);
    header[0] = 0x7f;
    header[1] = 0x45;
    header[2] = 0x4c;
    header[3] = 0x46;
    header[4] = 2;
    header[5] = 1;
    header.writeUInt16LE(machine, 18);
    return header;
}
