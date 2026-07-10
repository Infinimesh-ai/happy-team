/**
 * Task push notifications (milestone C0.8). Reuses the existing session-event
 * push channel (dispatchSessionEventPush → Expo), so task events land on the
 * owner's phone with the same suppression-when-active behaviour as normal
 * session notifications (plan §1.1: stage advance / failure / delivery).
 */
import { db } from "@/storage/db";
import { dispatchSessionEventPush } from "@/app/push/pushDispatch";
import type { TaskNotification, TaskNotifier } from "./taskDaemon";

export interface TaskPushDispatch {
    (params: { userId: string; sessionId: string; title: string; body: string; data?: Record<string, unknown> }): Promise<void>;
}

export interface TaskNotifierDeps {
    dispatch?: TaskPushDispatch;
}

export interface RenderedNotification {
    title: string;
    body: string;
}

/** Map a task lifecycle event to a push title/body. */
export function renderTaskNotification(event: TaskNotification): RenderedNotification {
    switch (event.type) {
        case "stage_started":
            return { title: "Task in progress", body: `Stage “${event.stage}” started` };
        case "approval_needed":
            return { title: "Approval needed", body: `Review the plan to continue past “${event.stage}”` };
        case "task_escalated":
            return { title: "Task needs you", body: event.reason };
        case "task_delivered":
            return { title: "Task delivered", body: `Pull request ready: ${event.prUrl}` };
        case "task_failed":
            return { title: "Task failed", body: event.error };
        case "task_cancelled":
            return { title: "Task cancelled", body: "The task was cancelled" };
    }
}

/**
 * Build a notifier that pushes to `accountId` (TeamUser.accountId). The current
 * stage session is used as the deep-link target when available so tapping the
 * notification opens the running session.
 */
export function createTaskNotifier(accountId: string, deps?: TaskNotifierDeps): TaskNotifier {
    const dispatch = deps?.dispatch ?? dispatchSessionEventPush;
    return {
        async notify(event: TaskNotification) {
            const { title, body } = renderTaskNotification(event);
            const sessionId = (await latestSessionIdForTask(event.taskId)) ?? event.taskId;
            await dispatch({
                userId: accountId,
                sessionId,
                title,
                body,
                data: { taskId: event.taskId, kind: event.type },
            });
        },
    };
}

async function latestSessionIdForTask(taskId: string): Promise<string | null> {
    const stageRun = await db.teamTaskStageRun.findFirst({
        where: { taskId, sessionId: { not: null } },
        orderBy: { startedAt: "desc" },
    });
    return stageRun?.sessionId ?? null;
}
