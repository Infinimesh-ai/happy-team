import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskDaemonGateway } from "./taskDaemon";
import type { createTaskStateMachine as CreateFn } from "./taskStateMachine";

let db: typeof import("@/storage/db").db;
let createTaskStateMachine: typeof CreateFn;
let pgliteDir: string;
let taskSeq = 0;

/** Fully-working fake daemon; individual tests override single methods. */
function makeDaemon(overrides: Partial<TaskDaemonGateway> = {}): TaskDaemonGateway {
    return {
        prepareWorktree: async () => ({ worktreePath: "/tmp/wt", skillsCommit: null }),
        spawnStage: async () => ({ sessionId: `sess-${Math.random().toString(36).slice(2)}` }),
        checkArtifacts: async () => ({ missing: [] }),
        deliver: async () => ({ prUrl: "https://example.test/pr/1", platform: "github" }),
        ...overrides,
    };
}

async function createTask(overrides: Record<string, unknown> = {}): Promise<string> {
    taskSeq += 1;
    const task = await db.teamTask.create({
        data: {
            ownerUserId: "user-1",
            machineId: "machine-1",
            templateId: "execute-only",
            title: `task ${taskSeq}`,
            goalPrompt: "Do the thing",
            repoPath: "/repo",
            baseBranch: "main",
            workBranch: `happy/user/task-${taskSeq}`,
            ...overrides,
        },
    });
    return task.id;
}

describe("task state machine", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-task-sm-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "task-sm-test-master-secret";

        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });
        ({ db } = await import("@/storage/db"));
        ({ createTaskStateMachine } = await import("./taskStateMachine"));
        await db.$connect();
    });

    afterAll(async () => {
        await db?.$disconnect();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it("runs T1 execute-only from PENDING to SUCCEEDED with a PR url", async () => {
        const deliverCalls: unknown[] = [];
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ deliver: async (i) => { deliverCalls.push(i); return { prUrl: "https://pr/42", platform: "github" }; } }),
        });
        const taskId = await createTask();

        await sm.startTask(taskId);
        let task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("RUNNING");
        expect(task.currentStage).toBe("execute");
        expect(task.worktreePath).toBe("/tmp/wt");

        const stageRun = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId } });
        expect(stageRun.agent).toBe("claude");
        expect(stageRun.sessionId).toBeTruthy();
        expect(stageRun.status).toBe("RUNNING");

        await sm.handleStageExit({ taskId });
        task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
        expect(task.prUrl).toBe("https://pr/42");
        expect(task.currentStage).toBeNull();
        expect(task.finishedAt).not.toBeNull();
        expect(deliverCalls).toHaveLength(1);

        const finishedStage = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId } });
        expect(finishedStage.status).toBe("SUCCEEDED");

        const transitions = await db.teamTaskTransition.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
        expect(transitions.map((t) => [t.fromStage, t.toStage])).toEqual([[null, "execute"], ["execute", "deliver"]]);
        expect(transitions.every((t) => t.decision === "auto_approved")).toBe(true);
    });

    it("starting a non-PENDING task is a no-op (idempotent)", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const first = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        await sm.startTask(taskId); // second start must not re-prepare
        const second = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
        const stageRuns = await db.teamTaskStageRun.count({ where: { taskId } });
        expect(stageRuns).toBe(1);
    });

    it("fails the task when prepare-worktree throws", async () => {
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ prepareWorktree: async () => { throw new Error("fetch denied"); } }),
        });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        expect(task.error).toContain("fetch denied");
    });

    it("fails the task and the stage run when spawn throws", async () => {
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ spawnStage: async () => { throw new Error("no agent"); } }),
        });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        const stageRun = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId } });
        expect(stageRun.status).toBe("FAILED");
    });

    it("fails when the stage exits without the expected artifacts (no delivery)", async () => {
        let delivered = false;
        const sm = createTaskStateMachine({
            daemon: makeDaemon({
                checkArtifacts: async () => ({ missing: [".happy-task/pr.md"] }),
                deliver: async () => { delivered = true; return { prUrl: "x", platform: "github" }; },
            }),
        });
        const taskId = await createTask();
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        expect(task.error).toContain("pr.md");
        expect(delivered).toBe(false);
    });

    it("fails the task when delivery throws", async () => {
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ deliver: async () => { throw new Error("gh not authed"); } }),
        });
        const taskId = await createTask();
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        expect(task.error).toContain("gh not authed");
    });

    it("cancels a running task and closes its active stage run", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        await sm.cancelTask(taskId, "user-1");
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("CANCELLED");
        expect(task.currentStage).toBeNull();
        const stageRun = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId } });
        expect(stageRun.status).toBe("FAILED");
        // handleStageExit after cancel must not resurrect the task
        await sm.handleStageExit({ taskId });
        const after = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(after.status).toBe("CANCELLED");
    });

    it("times out a stalled stage via the timeout sweep", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        // sweeper with a clock 10s in the future and a 1s budget
        const future = createTaskStateMachine({
            daemon: makeDaemon(),
            now: () => new Date(Date.now() + 10_000),
            stageTimeoutMs: 1_000,
        });
        const timedOut = await future.sweepStageTimeouts();
        expect(timedOut).toContain(taskId);
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        expect(task.error).toContain("timed out");
    });
});
