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
let happyToken: string;
let mcpToken: string;
let accountId: string;

let rpcId = 0;

async function rpc(method: string, params?: unknown, options?: { token?: string; id?: number | null }) {
    const id = options?.id === null ? undefined : ++rpcId;
    return app.inject({
        method: "POST",
        url: "/v1/team/mcp",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options?.token ?? mcpToken}`,
        },
        payload: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }),
    });
}

function toolText(res: { json: () => unknown }): string {
    const body = res.json() as { result: { content: { text: string }[]; isError?: boolean } };
    return body.result.content[0].text;
}

describe("team mcp routes", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-mcp-routes-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "mcp-routes-test-master-secret";

        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });

        ({ db } = await import("@/storage/db"));
        const { initEncrypt } = await import("@/modules/encrypt");
        const { auth } = await import("@/app/auth/auth");
        const { enableAuthentication } = await import("@/app/api/utils/enableAuthentication");
        const { teamRoutes } = await import("@/team/routes");
        const { teamMcpRoutes } = await import("./routes");
        const { createTeamUser } = await import("@/team/teamUsers");

        await db.$connect();
        await initEncrypt();
        await auth.init();
        await createTeamUser({ email: "member@example.com", password: "MemberPass123", role: TeamRole.MEMBER });

        const rawApp = fastify({ logger: false });
        rawApp.setValidatorCompiler(validatorCompiler);
        rawApp.setSerializerCompiler(serializerCompiler);
        app = rawApp.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
        enableAuthentication(app);
        teamRoutes(app);
        teamMcpRoutes(app);
        await rawApp.ready();

        const login = await app.inject({
            method: "POST",
            url: "/v1/team/auth/login",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ email: "member@example.com", password: "MemberPass123" }),
        });
        happyToken = login.json<{ happyToken: string }>().happyToken;
        const member = await db.teamUser.findUniqueOrThrow({ where: { email: "member@example.com" } });
        accountId = member.accountId;

        await db.machine.create({
            data: { id: "mcp-routes-machine", accountId, metadata: "enc", active: true, lastActiveAt: new Date() },
        });

        const minted = await app.inject({
            method: "POST",
            url: "/v1/team/mcp/token",
            headers: { authorization: `Bearer ${happyToken}` },
        });
        expect(minted.statusCode).toBe(200);
        mcpToken = minted.json<{ token: string }>().token;
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it("rejects the MCP endpoint without a valid MCP token", async () => {
        const bad = await rpc("ping", undefined, { token: "not-a-token" });
        expect(bad.statusCode).toBe(401);
        // The account token is not an MCP token.
        const account = await rpc("ping", undefined, { token: happyToken });
        expect(account.statusCode).toBe(401);
    });

    it("initializes with tools capability", async () => {
        const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sparkclaw", version: "0.1" } });
        expect(res.statusCode).toBe(200);
        const result = res.json<{ result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } }>().result;
        expect(result.protocolVersion).toBe("2025-06-18");
        expect(result.serverInfo.name).toBe("happy-team-tasks");
        expect(result.capabilities.tools).toBeDefined();
    });

    it("acknowledges notifications with 202", async () => {
        const res = await rpc("notifications/initialized", undefined, { id: null });
        expect(res.statusCode).toBe(202);
    });

    it("lists the task tools with JSON schemas", async () => {
        const res = await rpc("tools/list");
        expect(res.statusCode).toBe(200);
        const tools = res.json<{ result: { tools: { name: string; inputSchema: { type: string } }[] } }>().result.tools;
        const names = tools.map((t) => t.name);
        for (const expected of ["list_machines", "list_templates", "list_tasks", "get_task", "get_task_plan", "create_task", "cancel_task", "approve_plan", "reject_plan"]) {
            expect(names).toContain(expected);
        }
        expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    });

    it("lists machines without decrypted metadata", async () => {
        const res = await rpc("tools/call", { name: "list_machines", arguments: {} });
        const parsed = JSON.parse(toolText(res)) as { machines: { id: string; active: boolean }[] };
        expect(parsed.machines.map((m) => m.id)).toContain("mcp-routes-machine");
        expect(toolText(res)).not.toContain("enc");
    });

    it("creates, lists and cancels a task through tools/call", async () => {
        const created = await rpc("tools/call", {
            name: "create_task",
            arguments: {
                machineId: "mcp-routes-machine",
                repoPath: "/home/member/project",
                templateId: "execute-only",
                title: "Add a health check",
                goalPrompt: "Add a /healthz endpoint",
                baseBranch: "main",
            },
        });
        expect(created.statusCode).toBe(200);
        const task = (JSON.parse(toolText(created)) as { task: { id: string; status: string } }).task;
        expect(task.status).toBe("PENDING");

        const listed = await rpc("tools/call", { name: "list_tasks", arguments: {} });
        expect(JSON.parse(toolText(listed)).tasks.some((t: { id: string }) => t.id === task.id)).toBe(true);

        const cancelled = await rpc("tools/call", { name: "cancel_task", arguments: { taskId: task.id } });
        expect(JSON.parse(toolText(cancelled)).task.status).toBe("CANCELLED");

        const audits = await db.teamAuditLog.findMany({ where: { action: "team.mcp.call" } });
        expect(audits.length).toBeGreaterThanOrEqual(2);
    });

    it("returns tool errors as isError content, not protocol errors", async () => {
        const res = await rpc("tools/call", { name: "get_task", arguments: { taskId: "missing" } });
        expect(res.statusCode).toBe(200);
        const body = res.json<{ result: { isError: boolean } }>();
        expect(body.result.isError).toBe(true);
    });

    it("rejects batches and unknown methods", async () => {
        const batch = await app.inject({
            method: "POST",
            url: "/v1/team/mcp",
            headers: { "content-type": "application/json", authorization: `Bearer ${mcpToken}` },
            payload: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
        });
        expect(batch.json<{ error: { code: number } }>().error.code).toBe(-32600);

        const unknown = await rpc("resources/list");
        expect(unknown.json<{ error: { code: number } }>().error.code).toBe(-32601);
    });

    it("revokes tokens when the password changes", async () => {
        const { db: database } = await import("@/storage/db");
        const member = await database.teamUser.findUniqueOrThrow({ where: { email: "member@example.com" } });
        await database.teamUser.update({ where: { id: member.id }, data: { passwordHash: "$argon2id$rotated" } });
        const res = await rpc("ping");
        expect(res.statusCode).toBe(401);
        await database.teamUser.update({ where: { id: member.id }, data: { passwordHash: member.passwordHash } });
        const ok = await rpc("ping");
        expect(ok.statusCode).toBe(200);
    });

    it("answers GET and DELETE with 405", async () => {
        const res = await app.inject({ method: "GET", url: "/v1/team/mcp" });
        expect(res.statusCode).toBe(405);
    });
});
