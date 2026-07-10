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
        writeArtifact: async () => {},
        readArtifact: async () => ({ content: null }),
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

    it("get_task_context returns the current task context", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const result = await sm.handleIntent({ taskId, stage: "execute", round: 0 }, { kind: "get_task_context" });
        expect(result.ok).toBe(true);
        expect(result.context).toMatchObject({ taskId, stage: "execute", round: 0, goalPrompt: "Do the thing" });
    });

    it("complete_stage drives completion (advances to deliver → SUCCEEDED)", async () => {
        let deliveries = 0;
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ deliver: async () => { deliveries += 1; return { prUrl: "https://pr/cs", platform: "github" }; } }),
        });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const result = await sm.handleIntent({ taskId, stage: "execute", round: 0 }, { kind: "complete_stage", summary: "done it" });
        expect(result.ok).toBe(true);

        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
        expect(task.prUrl).toBe("https://pr/cs");
        const stageRun = await db.teamTaskStageRun.findFirstOrThrow({ where: { taskId } });
        expect(stageRun.summary).toBe("done it");

        // A later session-exit must not deliver again (idempotent three-signal).
        await sm.handleStageExit({ taskId });
        expect(deliveries).toBe(1);
        // The agent's complete_stage intent is in the transition black box.
        const agentIntents = await db.teamTaskTransition.count({ where: { taskId, requestedBy: "agent" } });
        expect(agentIntents).toBeGreaterThanOrEqual(1);
    });

    it("report_blocker escalates the task", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const result = await sm.handleIntent({ taskId, stage: "execute", round: 0 }, { kind: "report_blocker", reason: "cannot reach the API" });
        expect(result.ok).toBe(true);
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("ESCALATED");
        const escalation = await db.teamTaskTransition.findFirst({ where: { taskId, decision: "escalated" } });
        expect(escalation?.reason).toBe("cannot reach the API");
    });

    it("rejects a stale token (wrong round) and records it", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        const result = await sm.handleIntent({ taskId, stage: "execute", round: 9 }, { kind: "complete_stage" });
        expect(result.ok).toBe(false);
        const rejected = await db.teamTaskTransition.findFirst({ where: { taskId, decision: "rejected" } });
        expect(rejected).not.toBeNull();
        // Task remains running (not advanced by a stale token).
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("RUNNING");
    });

    it("T2 supervised: plan → WAITING_APPROVAL → approve → execute → deliver", async () => {
        const events: string[] = [];
        const writes: unknown[] = [];
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ writeArtifact: async (i) => { writes.push(i); } }),
            notifier: { notify: async (e) => { events.push(e.type); } },
        });
        const taskId = await createTask({ templateId: "plan-execute" });

        await sm.startTask(taskId);
        expect((await db.teamTask.findUniqueOrThrow({ where: { id: taskId } })).currentStage).toBe("plan");

        // Plan session exits → supervised approval gate.
        await sm.handleStageExit({ taskId });
        let task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("WAITING_APPROVAL");
        expect(events).toContain("approval_needed");

        // Approve with an edited plan → written back, execute stage starts.
        await sm.approveTask(taskId, { editedPlan: "# edited plan\n", actorId: "user-1" });
        task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("RUNNING");
        expect(task.currentStage).toBe("execute");
        expect(writes).toHaveLength(1);

        // Execute session exits → deliver → SUCCEEDED.
        await sm.handleStageExit({ taskId });
        task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
        expect(task.prUrl).toBe("https://example.test/pr/1");

        const transitions = await db.teamTaskTransition.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
        expect(transitions.map((t) => t.decision)).toContain("user_approved");
    });

    it("T2 supervised: rejecting the plan fails the task", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask({ templateId: "plan-execute" });
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });
        await sm.rejectTask(taskId, "user-1");
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("FAILED");
        expect(task.error).toContain("rejected");
    });

    it("T2 autonomous: plan auto-advances to execute without approval", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask({ templateId: "plan-execute", mode: "AUTONOMOUS" });
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("RUNNING");
        expect(task.currentStage).toBe("execute");
    });

    it("three-signal fallback: advances on exit+artifacts even without complete_stage", async () => {
        // No complete_stage intent is ever sent — the session-exit + artifact
        // existence signals must still drive completion (plan §6 / C1 acceptance).
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask();
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
    });

    it("writes the full transition black box for a T2 supervised run", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon(), notifier: { notify: async () => {} } });
        const taskId = await createTask({ templateId: "plan-execute" });
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId });            // plan done → awaiting approval
        await sm.approveTask(taskId, { actorId: "user-1" }); // → execute
        await sm.handleStageExit({ taskId });            // execute done → deliver

        const rows = await db.teamTaskTransition.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } });
        expect(rows.map((r) => [r.fromStage, r.toStage, r.decision])).toEqual([
            [null, "plan", "auto_approved"],
            ["plan", "execute", "awaiting_approval"],
            ["plan", "execute", "user_approved"],
            ["execute", "deliver", "auto_approved"],
        ]);
    });

    it("T3 autonomous: plan → execute → verify(passed) → deliver", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask({ templateId: "plan-execute-verify", mode: "AUTONOMOUS" });
        await sm.startTask(taskId);                                        // plan
        await sm.handleStageExit({ taskId });                             // plan → execute (auto)
        expect((await db.teamTask.findUniqueOrThrow({ where: { id: taskId } })).currentStage).toBe("execute");
        await sm.handleStageExit({ taskId });                             // execute → verify
        expect((await db.teamTask.findUniqueOrThrow({ where: { id: taskId } })).currentStage).toBe("verify");
        await sm.handleIntent({ taskId, stage: "verify", round: 0 }, { kind: "complete_stage", verdict: "passed" });
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
        expect(task.prUrl).toBe("https://example.test/pr/1");
    });

    it("T3: a failed verdict reworks (round++) and can then pass", async () => {
        const sm = createTaskStateMachine({ daemon: makeDaemon() });
        const taskId = await createTask({ templateId: "plan-execute-verify", mode: "AUTONOMOUS" });
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId }); // → execute
        await sm.handleStageExit({ taskId }); // → verify (round 0)
        await sm.handleIntent({ taskId, stage: "verify", round: 0 }, { kind: "complete_stage", verdict: "failed" });
        let task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.currentStage).toBe("execute");
        expect(task.round).toBe(1);

        await sm.handleStageExit({ taskId }); // → verify (round 1)
        await sm.handleIntent({ taskId, stage: "verify", round: 1 }, { kind: "complete_stage", verdict: "passed" });
        task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("SUCCEEDED");
    });

    it("T3: a task that always fails verification ESCALATES after maxRounds", async () => {
        let deliveries = 0;
        const sm = createTaskStateMachine({
            daemon: makeDaemon({ deliver: async () => { deliveries += 1; return { prUrl: "x", platform: "github" }; } }),
        });
        const taskId = await createTask({ templateId: "plan-execute-verify", mode: "AUTONOMOUS" }); // maxRounds default 3
        await sm.startTask(taskId);
        await sm.handleStageExit({ taskId }); // execute
        // Fail verification every round until the budget is exhausted.
        for (let round = 0; round < 5; round += 1) {
            const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
            if (task.status !== "RUNNING") break;
            if (task.currentStage === "execute") {
                await sm.handleStageExit({ taskId }); // execute → verify
            }
            const current = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
            await sm.handleIntent({ taskId, stage: "verify", round: current.round }, { kind: "complete_stage", verdict: "failed" });
        }
        const task = await db.teamTask.findUniqueOrThrow({ where: { id: taskId } });
        expect(task.status).toBe("ESCALATED");
        expect(deliveries).toBe(0);
        const escalation = await db.teamTaskTransition.findFirst({ where: { taskId, decision: "escalated" } });
        expect(escalation?.reason).toContain("verification failed");
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
