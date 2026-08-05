/**
 * Task telemetry aggregation (plan §9.3, milestone C4.5).
 *
 * Turns the TeamTask / TeamTaskTransition black box into the report that drives
 * strategy-layer iteration: per-template outcomes, rework-round distribution,
 * ESCALATED cases, and guardrail (rejected-intent) counts. It answers "which
 * projects/templates escalate abnormally" and feeds the curator (T4).
 */
import { TaskStatus } from "@prisma/client";
import { db } from "@/storage/db";

export interface TemplateOutcome {
    total: number;
    succeeded: number;
    failed: number;
    escalated: number;
    cancelled: number;
}

export interface TaskTelemetry {
    byTemplate: Record<string, TemplateOutcome>;
    reworkDistribution: Record<number, number>;
    escalatedTasks: { taskId: string; templateId: string; error: string | null }[];
    rejectedAgentIntents: number;
    escalationRate: number;
}

/** Compute the telemetry report over all tasks (optionally for one owner). */
export async function computeTaskTelemetry(options?: { ownerUserId?: string }): Promise<TaskTelemetry> {
    const where = options?.ownerUserId ? { ownerUserId: options.ownerUserId } : {};
    const tasks = await db.teamTask.findMany({ where });

    const byTemplate: Record<string, TemplateOutcome> = {};
    const reworkDistribution: Record<number, number> = {};
    const escalatedTasks: TaskTelemetry["escalatedTasks"] = [];
    let finished = 0;
    let escalated = 0;

    for (const task of tasks) {
        const outcome = (byTemplate[task.templateId] ??= { total: 0, succeeded: 0, failed: 0, escalated: 0, cancelled: 0 });
        outcome.total += 1;
        if (task.status === TaskStatus.SUCCEEDED) outcome.succeeded += 1;
        if (task.status === TaskStatus.FAILED) outcome.failed += 1;
        if (task.status === TaskStatus.CANCELLED) outcome.cancelled += 1;
        if (task.status === TaskStatus.ESCALATED) {
            outcome.escalated += 1;
            escalated += 1;
            escalatedTasks.push({ taskId: task.id, templateId: task.templateId, error: task.error });
        }
        if (isFinished(task.status)) {
            finished += 1;
            reworkDistribution[task.round] = (reworkDistribution[task.round] ?? 0) + 1;
        }
    }

    const taskIds = tasks.map((task) => task.id);
    const rejectedAgentIntents = taskIds.length === 0
        ? 0
        : await db.teamTaskTransition.count({ where: { taskId: { in: taskIds }, decision: "rejected", requestedBy: "agent" } });

    return {
        byTemplate,
        reworkDistribution,
        escalatedTasks,
        rejectedAgentIntents,
        escalationRate: finished === 0 ? 0 : escalated / finished,
    };
}

function isFinished(status: TaskStatus): boolean {
    return status === TaskStatus.SUCCEEDED || status === TaskStatus.FAILED
        || status === TaskStatus.CANCELLED || status === TaskStatus.ESCALATED;
}
