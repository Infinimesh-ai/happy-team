import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskPushDispatch } from "./taskNotifier";

let db: typeof import("@/storage/db").db;
let createTaskNotifier: typeof import("./taskNotifier").createTaskNotifier;
let renderTaskNotification: typeof import("./taskNotifier").renderTaskNotification;
let pgliteDir: string;

describe("task notifier", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-task-notifier-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "task-notifier-test-secret";
        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });
        ({ db } = await import("@/storage/db"));
        ({ createTaskNotifier, renderTaskNotification } = await import("./taskNotifier"));
        await db.$connect();
    });

    afterAll(async () => {
        await db?.$disconnect();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it("maps each event type to a title and body", () => {
        expect(renderTaskNotification({ type: "stage_started", taskId: "t", stage: "execute" })).toEqual({
            title: "Task in progress",
            body: "Stage “execute” started",
        });
        expect(renderTaskNotification({ type: "task_delivered", taskId: "t", prUrl: "https://pr/1" })).toEqual({
            title: "Task delivered",
            body: "Pull request ready: https://pr/1",
        });
        expect(renderTaskNotification({ type: "task_failed", taskId: "t", error: "boom" })).toEqual({
            title: "Task failed",
            body: "boom",
        });
        expect(renderTaskNotification({ type: "task_cancelled", taskId: "t" })).toEqual({
            title: "Task cancelled",
            body: "The task was cancelled",
        });
    });

    it("dispatches to the account with the current stage session as the deep link", async () => {
        const task = await db.teamTask.create({
            data: {
                ownerUserId: "owner-1", machineId: "m", templateId: "execute-only", title: "T",
                goalPrompt: "g", repoPath: "/r", baseBranch: "main", workBranch: "happy/u/x",
            },
        });
        await db.teamTaskStageRun.create({
            data: { taskId: task.id, stage: "execute", round: 0, agent: "claude", sessionId: "sess-77" },
        });

        const calls: Parameters<TaskPushDispatch>[0][] = [];
        const notifier = createTaskNotifier("account-9", { dispatch: async (p) => { calls.push(p); } });
        await notifier.notify({ type: "task_delivered", taskId: task.id, prUrl: "https://pr/7" });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            userId: "account-9",
            sessionId: "sess-77",
            title: "Task delivered",
            body: "Pull request ready: https://pr/7",
            data: { taskId: task.id, kind: "task_delivered" },
        });
    });

    it("falls back to the task id when no stage session exists yet", async () => {
        const task = await db.teamTask.create({
            data: {
                ownerUserId: "owner-2", machineId: "m", templateId: "execute-only", title: "T2",
                goalPrompt: "g", repoPath: "/r", baseBranch: "main", workBranch: "happy/u/y",
            },
        });
        const calls: Parameters<TaskPushDispatch>[0][] = [];
        const notifier = createTaskNotifier("account-2", { dispatch: async (p) => { calls.push(p); } });
        await notifier.notify({ type: "task_failed", taskId: task.id, error: "nope" });
        expect(calls[0].sessionId).toBe(task.id);
    });
});
