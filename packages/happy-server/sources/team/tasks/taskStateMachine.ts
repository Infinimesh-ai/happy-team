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
import { StageRunStatus, TaskStatus, type TeamTask } from "@prisma/client";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { writeTeamAudit } from "@/team/audit";
import { DELIVER_STAGE, getEntryStage, getTaskTemplate, renderStagePrompt, type TaskTemplate } from "./templates";
import { noopTaskNotifier, type TaskDaemonGateway, type TaskNotifier } from "./taskDaemon";

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
    handleStageExit(input: { taskId: string }): Promise<void>;
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
    ): Promise<void> {
        await db.teamTaskTransition.create({
            data: { taskId, fromStage, toStage, requestedBy, decision, decidedBy: "system" },
        });
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

    async function enterStage(task: TeamTask, fromStage: string | null, stage: string, round: number): Promise<void> {
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
        await db.teamTask.update({ where: { id: task.id }, data: { currentStage: stage, round } });
        await recordTransition(task.id, fromStage, stage, "auto_approved", "system");

        const prompt = renderStagePrompt(template, stage, { goalPrompt: task.goalPrompt });
        try {
            const { sessionId } = await daemon.spawnStage({
                taskId: task.id,
                stage,
                agent: definition.agent,
                model: definition.model,
                worktreePath: task.worktreePath,
                prompt,
                permissionMode: definition.permissionMode,
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
        await enterStage(running, null, entryStage, 0);
    }

    async function handleStageExit(input: { taskId: string }): Promise<void> {
        const task = await db.teamTask.findUnique({ where: { id: input.taskId } });
        if (!task || task.status !== TaskStatus.RUNNING || !task.currentStage || !task.worktreePath) {
            return;
        }
        const stage = task.currentStage;
        const template = requireTemplate(task);
        const definition = template.stages[stage];
        if (!definition) return;

        const stageRun = await db.teamTaskStageRun.findFirst({
            where: { taskId: task.id, stage, status: StageRunStatus.RUNNING },
            orderBy: { startedAt: "desc" },
        });

        // Completion determination: session exit (this trigger) + artifact existence.
        const { missing } = await daemon.checkArtifacts({
            worktreePath: task.worktreePath,
            artifacts: definition.expectedArtifacts,
        });
        if (missing.length > 0) {
            await failTask(task, `stage "${stage}" ended without expected artifacts: ${missing.join(", ")}`);
            return;
        }

        if (stageRun) {
            await db.teamTaskStageRun.update({
                where: { id: stageRun.id },
                data: { status: StageRunStatus.SUCCEEDED, endedAt: now() },
            });
        }

        const edge = template.transitions.find((transition) => transition.from === stage);
        if (!edge) {
            await succeedTask(task, task.prUrl);
            return;
        }
        if (edge.to === DELIVER_STAGE) {
            try {
                const { prUrl } = await daemon.deliver({ worktreePath: task.worktreePath, baseBranch: task.baseBranch });
                await recordTransition(task.id, stage, DELIVER_STAGE, "auto_approved", "system");
                await succeedTask(task, prUrl);
            } catch (error) {
                await failTask(task, `deliver failed: ${messageOf(error)}`);
            }
            return;
        }
        await enterStage(task, stage, edge.to, task.round);
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

    return { startTask, handleStageExit, cancelTask, sweepStageTimeouts };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
