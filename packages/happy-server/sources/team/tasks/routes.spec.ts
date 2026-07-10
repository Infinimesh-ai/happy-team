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
let token: string;
let accountId: string;

async function inject(method: "GET" | "POST", url: string, body?: unknown) {
    return app.inject({
        method,
        url,
        headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            authorization: `Bearer ${token}`,
        },
        payload: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe("team task routes", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-task-routes-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "task-routes-test-master-secret";

        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });

        ({ db } = await import("@/storage/db"));
        const { initEncrypt } = await import("@/modules/encrypt");
        const { auth } = await import("@/app/auth/auth");
        const { enableAuthentication } = await import("@/app/api/utils/enableAuthentication");
        const { teamRoutes } = await import("@/team/routes");
        const { teamTaskRoutes } = await import("./routes");
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
        teamTaskRoutes(app);
        await rawApp.ready();

        const login = await app.inject({
            method: "POST",
            url: "/v1/team/auth/login",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ email: "member@example.com", password: "MemberPass123" }),
        });
        token = login.json<{ happyToken: string }>().happyToken;
        const member = await db.teamUser.findUniqueOrThrow({ where: { email: "member@example.com" } });
        accountId = member.accountId;

        await db.machine.create({
            data: { id: "task-routes-machine", accountId, metadata: "enc", active: true, lastActiveAt: new Date() },
        });
    });

    afterAll(async () => {
        await app?.close();
        await db?.$disconnect();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    const validBody = () => ({
        machineId: "task-routes-machine",
        repoPath: "/home/member/project",
        templateId: "execute-only",
        title: "Add a health check",
        goalPrompt: "Add a /healthz endpoint",
        baseBranch: "main",
    });

    it("lists templates including execute-only", async () => {
        const res = await inject("GET", "/v1/team/tasks/templates");
        expect(res.statusCode).toBe(200);
        const ids = res.json<{ templates: { id: string }[] }>().templates.map((t) => t.id);
        expect(ids).toContain("execute-only");
    });

    it("rejects unauthenticated requests", async () => {
        const res = await app.inject({ method: "GET", url: "/v1/team/tasks" });
        expect(res.statusCode).toBe(401);
    });

    it("creates a task in PENDING with a happy/ work branch", async () => {
        const res = await inject("POST", "/v1/team/tasks", validBody());
        expect(res.statusCode).toBe(201);
        const task = res.json<{ task: { id: string; status: string; workBranch: string; stageRuns: unknown[] } }>().task;
        expect(task.status).toBe("PENDING");
        expect(task.workBranch).toMatch(/^happy\/member\/add-a-health-check-[0-9a-f]{6}$/);
        expect(task.stageRuns).toEqual([]);
    });

    it("rejects an unknown template with 400", async () => {
        const res = await inject("POST", "/v1/team/tasks", { ...validBody(), templateId: "nope" });
        expect(res.statusCode).toBe(400);
    });

    it("rejects a machine that does not belong to the account with 404", async () => {
        const res = await inject("POST", "/v1/team/tasks", { ...validBody(), machineId: "someone-elses-machine" });
        expect(res.statusCode).toBe(404);
    });

    it("lists and fetches the created task", async () => {
        const created = await inject("POST", "/v1/team/tasks", validBody());
        const id = created.json<{ task: { id: string } }>().task.id;

        const list = await inject("GET", "/v1/team/tasks");
        expect(list.statusCode).toBe(200);
        expect(list.json<{ tasks: { id: string }[] }>().tasks.some((t) => t.id === id)).toBe(true);

        const detail = await inject("GET", `/v1/team/tasks/${id}`);
        expect(detail.statusCode).toBe(200);
        expect(detail.json<{ task: { id: string; goalPrompt: string; transitions: unknown[] } }>().task).toMatchObject({
            id,
            goalPrompt: "Add a /healthz endpoint",
            transitions: [],
        });
    });

    it("returns 404 for a task the user does not own / does not exist", async () => {
        const res = await inject("GET", "/v1/team/tasks/does-not-exist");
        expect(res.statusCode).toBe(404);
    });

    it("cancels a task and rejects a second cancel with 409", async () => {
        const created = await inject("POST", "/v1/team/tasks", validBody());
        const id = created.json<{ task: { id: string } }>().task.id;

        const cancel = await inject("POST", `/v1/team/tasks/${id}/cancel`);
        expect(cancel.statusCode).toBe(200);
        expect(cancel.json<{ task: { status: string } }>().task.status).toBe("CANCELLED");

        const again = await inject("POST", `/v1/team/tasks/${id}/cancel`);
        expect(again.statusCode).toBe(409);
    });
});
