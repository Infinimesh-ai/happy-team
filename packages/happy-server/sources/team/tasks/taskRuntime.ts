/**
 * Task runtime — binds the state machine to live infrastructure (milestone
 * C0.7). Resolves a task's owner + machine + socket server, builds the real
 * machine-RPC daemon gateway, and exposes the entry points the HTTP layer and
 * the session-lifecycle handler fire into:
 *   - startTeamTask: begin orchestration after a task is created
 *   - handleTaskSessionEnd: session-exit → completion determination
 *   - stopActiveTaskSessions: terminate a cancelled task's live session
 *
 * When there is no connected socket server (e.g. unit tests, or the member's
 * daemon is offline) the runtime is a safe no-op; the task simply stays put
 * until conditions allow. All calls are best-effort and log rather than throw.
 */
import { StageRunStatus } from "@prisma/client";
import { getSocketServer } from "@/app/api/socket";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { callMachineRpc } from "@/team/machineRpc";
import { createMachineTaskDaemon, type MachineRpcCall } from "./machineTaskDaemon";
import { createTaskNotifier } from "./taskNotifier";
import { createTaskStateMachine, readTaskContext, type IntentResult, type TaskIntent, type TaskStateMachine } from "./taskStateMachine";
import type { TaskTokenClaims } from "./taskToken";

/** Resolve the encrypted machine-RPC transport for a task, or null when offline. */
async function resolveMachineCall(taskId: string): Promise<{ call: MachineRpcCall; accountId: string; worktreePath: string | null } | null> {
    const task = await db.teamTask.findUnique({ where: { id: taskId } });
    if (!task) return null;
    const io = getSocketServer();
    if (!io) return null;
    const [teamUser, machine] = await Promise.all([
        db.teamUser.findUnique({ where: { id: task.ownerUserId } }),
        db.machine.findUnique({ where: { id: task.machineId } }),
    ]);
    if (!teamUser || !machine) return null;

    const call: MachineRpcCall = async (baseMethod, payload) => {
        const rpc = await callMachineRpc(io, teamUser, machine, baseMethod, payload);
        if (!rpc.ok) throw new Error(rpc.error);
        return rpc.result;
    };
    return { call, accountId: teamUser.accountId, worktreePath: task.worktreePath };
}

async function buildStateMachine(taskId: string): Promise<TaskStateMachine | null> {
    const resolved = await resolveMachineCall(taskId);
    if (!resolved) return null;
    return createTaskStateMachine({
        daemon: createMachineTaskDaemon(resolved.call),
        notifier: createTaskNotifier(resolved.accountId),
    });
}

/** Begin orchestrating a freshly-created task (PENDING → PREPARING → RUNNING). */
export async function startTeamTask(taskId: string): Promise<void> {
    try {
        const sm = await buildStateMachine(taskId);
        if (!sm) return;
        await sm.startTask(taskId);
    } catch (error) {
        log({ module: "team-tasks", level: "error" }, `startTeamTask(${taskId}) failed: ${error}`);
    }
}

/** Session-exit signal: run the completion determination for the owning task. */
export async function handleTaskSessionEnd(sessionId: string): Promise<void> {
    try {
        const stageRun = await db.teamTaskStageRun.findFirst({
            where: { sessionId, status: StageRunStatus.RUNNING },
            orderBy: { startedAt: "desc" },
        });
        if (!stageRun) return;
        const sm = await buildStateMachine(stageRun.taskId);
        if (!sm) return;
        await sm.handleStageExit({ taskId: stageRun.taskId, sessionId });
    } catch (error) {
        log({ module: "team-tasks", level: "error" }, `handleTaskSessionEnd(${sessionId}) failed: ${error}`);
    }
}

/**
 * Apply an agent MCP intent (daemon-forwarded, task-token authenticated). The
 * read-only get_task_context does not need the daemon; state-changing intents
 * require a connected socket server and return an error otherwise.
 */
export async function applyTaskIntent(claims: TaskTokenClaims, intent: TaskIntent): Promise<IntentResult> {
    if (intent.kind === "get_task_context") {
        const context = await readTaskContext(claims.taskId);
        if (!context) return { ok: false, error: "task has no active stage" };
        return { ok: true, context };
    }
    const sm = await buildStateMachine(claims.taskId);
    if (!sm) return { ok: false, error: "task runtime unavailable" };
    return sm.handleIntent(claims, intent);
}

/** Approve a supervised plan gate (optionally with an edited plan.md). */
export async function approveTeamTask(taskId: string, options?: { editedPlan?: string; actorId?: string }): Promise<void> {
    const sm = await buildStateMachine(taskId);
    if (!sm) return;
    await sm.approveTask(taskId, options);
}

/** Reject a supervised plan gate (task terminates as FAILED). */
export async function rejectTeamTask(taskId: string, actorId?: string): Promise<void> {
    const sm = await buildStateMachine(taskId);
    if (!sm) return;
    await sm.rejectTask(taskId, actorId);
}

/** Read the current plan.md from the task worktree (for the approval card). */
export async function getTaskPlan(taskId: string): Promise<string | null> {
    try {
        const resolved = await resolveMachineCall(taskId);
        if (!resolved || !resolved.worktreePath) return null;
        const daemon = createMachineTaskDaemon(resolved.call);
        const { content } = await daemon.readArtifact({ worktreePath: resolved.worktreePath, artifact: ".happy-task/plan.md" });
        return content;
    } catch (error) {
        log({ module: "team-tasks", level: "error" }, `getTaskPlan(${taskId}) failed: ${error}`);
        return null;
    }
}

/** Best-effort teardown of a cancelled task's most recent stage session. */
export async function stopActiveTaskSessions(taskId: string): Promise<void> {
    try {
        const io = getSocketServer();
        if (!io) return;
        const task = await db.teamTask.findUnique({ where: { id: taskId } });
        if (!task) return;
        const stageRun = await db.teamTaskStageRun.findFirst({
            where: { taskId, sessionId: { not: null } },
            orderBy: { startedAt: "desc" },
        });
        if (!stageRun?.sessionId) return;
        const [teamUser, machine] = await Promise.all([
            db.teamUser.findUnique({ where: { id: task.ownerUserId } }),
            db.machine.findUnique({ where: { id: task.machineId } }),
        ]);
        if (!teamUser || !machine) return;
        await callMachineRpc(io, teamUser, machine, "stop-session", { sessionId: stageRun.sessionId });
    } catch (error) {
        log({ module: "team-tasks", level: "error" }, `stopActiveTaskSessions(${taskId}) failed: ${error}`);
    }
}
