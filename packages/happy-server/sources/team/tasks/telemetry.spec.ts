import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { computeTaskTelemetry as ComputeFn } from "./telemetry";

let db: typeof import("@/storage/db").db;
let computeTaskTelemetry: typeof ComputeFn;
let pgliteDir: string;

async function makeTask(status: string, templateId: string, round = 0): Promise<string> {
    const task = await db.teamTask.create({
        data: {
            ownerUserId: "owner", machineId: "m", templateId, status: status as never, round,
            title: "t", goalPrompt: "g", repoPath: "/r", baseBranch: "main", workBranch: `happy/u/${Math.random().toString(36).slice(2)}`,
        },
    });
    return task.id;
}

describe("computeTaskTelemetry", () => {
    beforeAll(async () => {
        pgliteDir = await mkdtemp(path.join(tmpdir(), "happy-telemetry-"));
        process.env.DB_PROVIDER = "pglite";
        process.env.PGLITE_DIR = pgliteDir;
        process.env.HANDY_MASTER_SECRET = "telemetry-test-secret";
        const { runMigrations } = await import("@/standalone");
        await runMigrations({ pgliteDir, migrationsDir: path.join(process.cwd(), "prisma", "migrations") });
        ({ db } = await import("@/storage/db"));
        ({ computeTaskTelemetry } = await import("./telemetry"));
        await db.$connect();
    });

    afterAll(async () => {
        await db?.$disconnect();
        if (pgliteDir) await rm(pgliteDir, { recursive: true, force: true });
    });

    it("aggregates outcomes, rework distribution, escalations and rejected intents", async () => {
        await makeTask("SUCCEEDED", "plan-execute-verify", 0);
        await makeTask("SUCCEEDED", "plan-execute-verify", 2);
        const escId = await makeTask("ESCALATED", "plan-execute-verify", 3);
        await makeTask("FAILED", "execute-only", 0);
        await db.teamTaskTransition.create({ data: { taskId: escId, fromStage: "verify", toStage: "verify", requestedBy: "agent", decision: "rejected" } });

        const report = await computeTaskTelemetry();
        expect(report.byTemplate["plan-execute-verify"]).toMatchObject({ total: 3, succeeded: 2, escalated: 1 });
        expect(report.byTemplate["execute-only"]).toMatchObject({ total: 1, failed: 1 });
        expect(report.reworkDistribution[0]).toBe(2); // two round-0 finishers
        expect(report.reworkDistribution[2]).toBe(1);
        expect(report.reworkDistribution[3]).toBe(1);
        expect(report.escalatedTasks.map((t) => t.taskId)).toContain(escId);
        expect(report.rejectedAgentIntents).toBe(1);
        expect(report.escalationRate).toBeCloseTo(1 / 4);
    });
});
