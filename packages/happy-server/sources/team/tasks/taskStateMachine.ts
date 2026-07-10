/**
 * Task orchestration state machine (plan §6, milestone C0.5).
 *
 * The spine of the cloud-agent task system: it drives a task through
 * PENDING → PREPARING → RUNNING → SUCCEEDED / FAILED / CANCELLED, persisting
 * every step to TeamTask / TeamTaskStageRun / TeamTaskTransition and emitting
 * audit + notification events. All machine-side effects go through an injected
 * {@link TaskDaemonGateway}; this module contains no I/O of its own beyond the
 * database, so it is fully testable against real Prisma + a fake daemon.
 *
 * Stage completion is determined by the combination of a session-exit signal
 * (the trigger for {@link TaskStateMachine.handleStageExit}) and an
 * artifact-existence check via the daemon (plan §6). The MCP `complete_stage`
 * intent — the third signal — arrives in C1; approvals, ESCALATED and rounds
 * are later milestones. This minimal machine covers the T1 execute-only flow.
 */
import { StageRunStatus, TaskMode, TaskStatus, type TeamTask, type TeamTaskStageRun } from "@prisma/client";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { writeTeamAudit } from "@/team/audit";
import { DELIVER_STAGE, getEntryStage, getTaskTemplate, renderStagePrompt, TASK_ARTIFACTS, type TaskTemplate } from "./templates";
import { noopTaskNotifier, type TaskDaemonGateway, type TaskNotifier } from "./taskDaemon";
import { issueTaskToken, type TaskTokenClaims } from "./taskToken";

/** An agent-declared intent arriving via the task-control MCP (plan §7). */
export type TaskIntent =
    | { kind: "get_task_context" }
    | { kind: "complete_stage"; summary?: string; verdict?: "passed" | "failed" }
    | { kind: "report_blocker"; reason: string };

export interface TaskContext {
    taskId: string;
    title: string;
    goalPrompt: string;
    stage: string;
    round: number;
    maxRounds: number;
    mode: TaskMode;
    artifacts: { plan: string; findings: string; pr: string };
}

export interface IntentResult {
    ok: boolean;
    error?: string;
    context?: TaskContext;
}

const DEFAULT_STAGE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h no activity (plan §6)

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
    TaskStatus.SUCCEEDED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.ESCALATED,
]);

export interface TaskStateMachineDeps {
    daemon: TaskDaemonGateway;
    notifier?: TaskNotifier;
    now?: () => Date;
    stageTimeoutMs?: number;
}

export interface TaskStateMachine {
    /** PENDING → PREPARING → RUNNING; prepares the worktree and enters stage 1. */
    startTask(taskId: string): Promise<void>;
    /** Session-exit trigger: run completion determination and advance/deliver/fail. */
    handleStageExit(input: { taskId: string; sessionId?: string }): Promise<void>;
    /** Apply an agent MCP intent (complete_stage / report_blocker / get_task_context). */
    handleIntent(claims: TaskTokenClaims, intent: TaskIntent): Promise<IntentResult>;
    /** Approve a supervised plan gate (optionally with an edited plan.md) and proceed. */
    approveTask(taskId: string, options?: { editedPlan?: string; actorId?: string }): Promise<void>;
    /** Reject a supervised plan gate; the task terminates as FAILED. */
    rejectTask(taskId: string, actorId?: string): Promise<void>;
    /** Cancel a non-terminal task (worktree retained; sessions stopped in C0.7). */
    cancelTask(taskId: string, actorId?: string): Promise<void>;
    /** Fail any task whose active stage exceeded the no-activity timeout. */
    sweepStageTimeouts(): Promise<string[]>;
}

export function createTaskStateMachine(deps: TaskStateMachineDeps): TaskStateMachine {
    const daemon = deps.daemon;
    const notifier = deps.notifier ?? noopTaskNotifier;
    const now = deps.now ?? (() => new Date());
    const stageTimeoutMs = deps.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;

    function requireTemplate(task: TeamTask): TaskTemplate {
        const template = getTaskTemplate(task.templateId);
        if (!template) {
            throw new Error(`Unknown template "${task.templateId}" for task ${task.id}`);
        }
        return template;
    }

    async function recordTransition(
        taskId: string,
        fromStage: string | null,
        toStage: string,
        decision: string,
        requestedBy: string,
        reason?: string,
    ): Promise<void> {
        await db.teamTaskTransition.create({
            data: { taskId, fromStage, toStage, requestedBy, decision, decidedBy: "system", reason: reason ?? null },
        });
    }

    async function escalateTask(task: TeamTask, reason: string): Promise<void> {
        await inTx(async (tx) => {
            await tx.teamTaskStageRun.updateMany({
                where: { taskId: task.id, status: StageRunStatus.RUNNING },
                data: { status: StageRunStatus.FAILED, endedAt: now() },
            });
            await tx.teamTask.update({ where: { id: task.id }, data: { status: TaskStatus.ESCALATED } });
        });
        await writeTeamAudit({ actorId: task.ownerUserId, action: "team.task.escalated", target: task.id, detail: { reason } });
        await notifier.notify({ type: "task_escalated", taskId: task.id, reason });
    }

    async function failTask(task: TeamTask, error: string): Promise<void> {
        await inTx(async (tx) => {
            await tx.teamTaskStageRun.updateMany({
                where: { taskId: task.id, status: StageRunStatus.RUNNING },
                data: { status: StageRunStatus.FAILED, endedAt: now() },
            });
            await tx.teamTask.update({
                where: { id: task.id },
                data: { status: TaskStatus.FAILED, error, finishedAt: now() },
            });
        });
        await writeTeamAudit({ actorId: task.ownerUserId, action: "team.task.failed", target: task.id, detail: { error } });
        await notifier.notify({ type: "task_failed", taskId: task.id, error });
    }

    async function succeedTask(task: TeamTask, prUrl: string | null): Promise<void> {
        await db.teamTask.update({
            where: { id: task.id },
            data: { status: TaskStatus.SUCCEEDED, prUrl, currentStage: null, finishedAt: now() },
        });
        await writeTeamAudit({ actorId: task.ownerUserId, action: "team.task.succeeded", target: task.id, detail: { prUrl } });
        if (prUrl) {
            await notifier.notify({ type: "task_delivered", taskId: task.id, prUrl });
        }
    }

    async function enterStage(task: TeamTask, stage: string, round: number): Promise<void> {
        const template = requireTemplate(task);
        const definition = template.stages[stage];
        if (!definition) {
            throw new Error(`Stage "${stage}" is not an agent stage in template "${template.id}"`);
        }
        if (!task.worktreePath) {
            throw new Error(`Task ${task.id} has no worktree path`);
        }

        const stageRun = await db.teamTaskStageRun.create({
            data: {
                taskId: task.id,
                stage,
                round,
                agent: definition.agent,
                model: definition.model ?? null,
                status: StageRunStatus.RUNNING,
            },
        });
        await db.teamTask.update({ where: { id: task.id }, data: { currentStage: stage, round, status: TaskStatus.RUNNING } });

        const prompt = renderStagePrompt(template, stage, { goalPrompt: task.goalPrompt });
        const token = issueTaskToken({ taskId: task.id, stage, round });
        try {
            const { sessionId } = await daemon.spawnStage({
                taskId: task.id,
                stage,
                agent: definition.agent,
                model: definition.model,
                worktreePath: task.worktreePath,
                prompt,
                permissionMode: definition.permissionMode,
                token,
            });
            await db.teamTaskStageRun.update({ where: { id: stageRun.id }, data: { sessionId } });
        } catch (error) {
            await db.teamTaskStageRun.update({
                where: { id: stageRun.id },
                data: { status: StageRunStatus.FAILED, endedAt: now() },
            });
            await failTask({ ...task, currentStage: stage }, `failed to spawn stage "${stage}": ${messageOf(error)}`);
            return;
        }
        await notifier.notify({ type: "stage_started", taskId: task.id, stage });
    }

    async function startTask(taskId: string): Promise<void> {
        // Guard + claim PENDING → PREPARING atomically so a retried start is a no-op.
        const claimed = await inTx(async (tx) => {
            const task = await tx.teamTask.findUnique({ where: { id: taskId } });
            if (!task) throw new Error(`Task ${taskId} not found`);
            if (task.status !== TaskStatus.PENDING) return null;
            return tx.teamTask.update({ where: { id: taskId }, data: { status: TaskStatus.PREPARING } });
        });
        if (!claimed) return;

        let prepared: { worktreePath: string; skillsCommit: string | null };
        try {
            prepared = await daemon.prepareWorktree({
                taskId: claimed.id,
                repoPath: claimed.repoPath,
                baseBranch: claimed.baseBranch,
                workBranch: claimed.workBranch,
            });
        } catch (error) {
            await failTask(claimed, `prepare-worktree failed: ${messageOf(error)}`);
            return;
        }

        const running = await db.teamTask.update({
            where: { id: claimed.id },
            data: {
                worktreePath: prepared.worktreePath,
                skillsCommit: prepared.skillsCommit,
                status: TaskStatus.RUNNING,
            },
        });
        await writeTeamAudit({ actorId: running.ownerUserId, action: "team.task.prepared", target: running.id });

        const template = requireTemplate(running);
        const entryStage = getEntryStage(template);
        if (!entryStage) {
            await failTask(running, `template "${template.id}" has no entry stage`);
            return;
        }
        await recordTransition(running.id, null, entryStage, "auto_approved", "system");
        await enterStage(running, entryStage, 0);
    }

    async function handleStageExit(input: { taskId: string; sessionId?: string }): Promise<void> {
        const task = await db.teamTask.findUnique({ where: { id: input.taskId } });
        if (!task || task.status !== TaskStatus.RUNNING || !task.currentStage) return;

        const stageRun = input.sessionId
            ? await db.teamTaskStageRun.findFirst({ where: { taskId: task.id, sessionId: input.sessionId, status: StageRunStatus.RUNNING }, orderBy: { startedAt: "desc" } })
            : await db.teamTaskStageRun.findFirst({ where: { taskId: task.id, stage: task.currentStage, status: StageRunStatus.RUNNING }, orderBy: { startedAt: "desc" } });
        if (!stageRun || stageRun.stage !== task.currentStage) return;

        await completeStage(task, stageRun);
    }

    /**
     * Three-signal completion (plan §6): the session-exit signal OR a
     * complete_stage intent, combined with artifact existence. Idempotent on the
     * specific stage run — a complete_stage intent and the later session-exit
     * cannot double-advance, because the stage run is claimed atomically.
     */
    async function completeStage(task: TeamTask, stageRun: TeamTaskStageRun, summary?: string): Promise<void> {
        if (task.status !== TaskStatus.RUNNING || task.currentStage !== stageRun.stage
            || stageRun.status !== StageRunStatus.RUNNING || !task.worktreePath) {
            return;
        }
        const template = requireTemplate(task);
        const definition = template.stages[stageRun.stage];
        if (!definition) return;

        const { missing } = await daemon.checkArtifacts({ worktreePath: task.worktreePath, artifacts: definition.expectedArtifacts });
        if (missing.length > 0) {
            await failTask(task, `stage "${stageRun.stage}" ended without expected artifacts: ${missing.join(", ")}`);
            return;
        }

        const claimed = await db.teamTaskStageRun.updateMany({
            where: { id: stageRun.id, status: StageRunStatus.RUNNING },
            data: { status: StageRunStatus.SUCCEEDED, endedAt: now(), summary: summary ?? stageRun.summary },
        });
        if (claimed.count === 0) return;

        const edge = template.transitions.find((transition) => transition.from === stageRun.stage);
        if (!edge) {
            await succeedTask(task, task.prUrl);
            return;
        }
        if (edge.requiresApproval && task.mode === TaskMode.SUPERVISED) {
            await db.teamTask.update({ where: { id: task.id }, data: { status: TaskStatus.WAITING_APPROVAL } });
            await recordTransition(task.id, stageRun.stage, edge.to, "awaiting_approval", "system");
            await notifier.notify({ type: "approval_needed", taskId: task.id, stage: stageRun.stage });
            return;
        }
        await proceedToStage(task, stageRun.stage, edge.to, "auto_approved", "system");
    }

    async function proceedToStage(task: TeamTask, fromStage: string, toStage: string, decision: string, requestedBy: string): Promise<void> {
        if (toStage === DELIVER_STAGE) {
            if (!task.worktreePath) {
                await failTask(task, "cannot deliver without a worktree");
                return;
            }
            try {
                const { prUrl } = await daemon.deliver({ worktreePath: task.worktreePath, baseBranch: task.baseBranch });
                await recordTransition(task.id, fromStage, DELIVER_STAGE, decision, requestedBy);
                await succeedTask(task, prUrl);
            } catch (error) {
                await failTask(task, `deliver failed: ${messageOf(error)}`);
            }
            return;
        }
        await recordTransition(task.id, fromStage, toStage, decision, requestedBy);
        await enterStage(task, toStage, task.round);
    }

    async function handleIntent(claims: TaskTokenClaims, intent: TaskIntent): Promise<IntentResult> {
        const task = await db.teamTask.findUnique({ where: { id: claims.taskId } });
        if (!task) return { ok: false, error: "task not found" };

        if (intent.kind === "get_task_context") {
            if (!task.currentStage) return { ok: false, error: "task has no active stage" };
            return { ok: true, context: toTaskContext(task) };
        }

        const isCurrent = task.status === TaskStatus.RUNNING && task.currentStage === claims.stage && task.round === claims.round;
        if (!isCurrent) {
            await recordTransition(task.id, task.currentStage, claims.stage, "rejected", "agent", "stale token");
            return { ok: false, error: "stale token: not the current stage" };
        }

        if (intent.kind === "report_blocker") {
            await recordTransition(task.id, claims.stage, "ESCALATED", "escalated", "agent", intent.reason);
            await escalateTask(task, intent.reason);
            return { ok: true };
        }

        // complete_stage — record the intent, then run completion determination.
        await recordTransition(task.id, claims.stage, claims.stage, "auto_approved", "agent", intent.summary);
        const stageRun = await db.teamTaskStageRun.findFirst({
            where: { taskId: task.id, stage: claims.stage, status: StageRunStatus.RUNNING },
            orderBy: { startedAt: "desc" },
        });
        if (stageRun) {
            await completeStage(task, stageRun, intent.summary);
        }
        return { ok: true };
    }

    async function approveTask(taskId: string, options?: { editedPlan?: string; actorId?: string }): Promise<void> {
        const task = await db.teamTask.findUnique({ where: { id: taskId } });
        if (!task || task.status !== TaskStatus.WAITING_APPROVAL || !task.currentStage) return;
        const template = requireTemplate(task);
        const edge = template.transitions.find((transition) => transition.from === task.currentStage);
        if (!edge) {
            await succeedTask(task, task.prUrl);
            return;
        }
        if (options?.editedPlan != null && task.worktreePath) {
            await daemon.writeArtifact({ worktreePath: task.worktreePath, artifact: TASK_ARTIFACTS.plan, content: options.editedPlan });
        }
        await writeTeamAudit({ actorId: options?.actorId ?? task.ownerUserId, action: "team.task.approved", target: task.id });
        await proceedToStage(task, task.currentStage, edge.to, "user_approved", options?.actorId ? `user:${options.actorId}` : "user");
    }

    async function rejectTask(taskId: string, actorId?: string): Promise<void> {
        const task = await db.teamTask.findUnique({ where: { id: taskId } });
        if (!task || task.status !== TaskStatus.WAITING_APPROVAL) return;
        await inTx(async (tx) => {
            await tx.teamTaskStageRun.updateMany({
                where: { taskId, status: StageRunStatus.RUNNING },
                data: { status: StageRunStatus.FAILED, endedAt: now() },
            });
            await tx.teamTask.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED, error: "plan rejected", finishedAt: now() } });
        });
        if (task.currentStage) {
            await recordTransition(taskId, task.currentStage, task.currentStage, "rejected", actorId ? `user:${actorId}` : "user");
        }
        await writeTeamAudit({ actorId: actorId ?? task.ownerUserId, action: "team.task.rejected", target: taskId });
        await notifier.notify({ type: "task_failed", taskId, error: "plan rejected" });
    }

    async function cancelTask(taskId: string, actorId?: string): Promise<void> {
        const task = await db.teamTask.findUnique({ where: { id: taskId } });
        if (!task || TERMINAL_STATUSES.has(task.status)) return;

        await inTx(async (tx) => {
            await tx.teamTaskStageRun.updateMany({
                where: { taskId: task.id, status: StageRunStatus.RUNNING },
                data: { status: StageRunStatus.FAILED, endedAt: now() },
            });
            await tx.teamTask.update({
                where: { id: task.id },
                data: { status: TaskStatus.CANCELLED, currentStage: null, finishedAt: now() },
            });
        });
        if (task.currentStage) {
            await recordTransition(task.id, task.currentStage, TaskStatus.CANCELLED, "rejected", actorId ? `user:${actorId}` : "user");
        }
        await writeTeamAudit({ actorId: actorId ?? task.ownerUserId, action: "team.task.cancelled", target: task.id });
        await notifier.notify({ type: "task_cancelled", taskId: task.id });
    }

    async function sweepStageTimeouts(): Promise<string[]> {
        const cutoff = new Date(now().getTime() - stageTimeoutMs);
        const running = await db.teamTask.findMany({ where: { status: TaskStatus.RUNNING } });
        const timedOut: string[] = [];
        for (const task of running) {
            if (!task.currentStage) continue;
            const stageRun = await db.teamTaskStageRun.findFirst({
                where: { taskId: task.id, stage: task.currentStage, status: StageRunStatus.RUNNING },
                orderBy: { startedAt: "desc" },
            });
            if (!stageRun || stageRun.startedAt > cutoff) continue;
            await failTask(task, `stage "${task.currentStage}" timed out after ${Math.round(stageTimeoutMs / 1000)}s of inactivity`);
            timedOut.push(task.id);
        }
        return timedOut;
    }

    return { startTask, handleStageExit, handleIntent, approveTask, rejectTask, cancelTask, sweepStageTimeouts };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Build the MCP task context from a task row (plan §7 get_task_context). */
export function toTaskContext(task: TeamTask): TaskContext {
    return {
        taskId: task.id,
        title: task.title,
        goalPrompt: task.goalPrompt,
        stage: task.currentStage ?? "",
        round: task.round,
        maxRounds: task.maxRounds,
        mode: task.mode,
        artifacts: { plan: TASK_ARTIFACTS.plan, findings: TASK_ARTIFACTS.findings, pr: TASK_ARTIFACTS.pr },
    };
}

/** Read-only task context by id (no daemon needed); null if no active stage. */
export async function readTaskContext(taskId: string): Promise<TaskContext | null> {
    const task = await db.teamTask.findUnique({ where: { id: taskId } });
    if (!task || !task.currentStage) return null;
    return toTaskContext(task);
}
