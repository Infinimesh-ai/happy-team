/**
 * Task service — persistence, validation and DTO shaping for the task API
 * (plan §10.1, milestone C0.6). HTTP concerns live in ./routes.ts; this module
 * owns the business rules and never touches Fastify.
 *
 * Scope note: POST creates a task in PENDING. Auto-starting it (running the
 * state machine with the real daemon gateway) and unifying cancel with the
 * state machine's session teardown are C0.7; cancel here is a self-contained
 * DB transition so the API surface is complete without pulling C0.7 forward.
 */
import { randomBytes } from "crypto";
import { StageRunStatus, TaskMode, TaskStatus, type TeamTask, type TeamTaskStageRun, type TeamTaskTransition, type TeamUser } from "@prisma/client";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { writeTeamAudit } from "@/team/audit";
import { getTaskTemplate, listTaskTemplates, type TaskTemplate } from "./templates";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
    TaskStatus.SUCCEEDED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.ESCALATED,
]);

/** Error carrying an HTTP status for the route layer to surface. */
export class TaskRequestError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "TaskRequestError";
        this.statusCode = statusCode;
    }
}

export interface CreateTaskInput {
    machineId: string;
    repoPath: string;
    templateId: string;
    mode: TaskMode;
    title: string;
    goalPrompt: string;
    baseBranch: string;
    /** Per-stage model overrides (plan §10.1). Accepted but not yet persisted (C1). */
    stageOverrides?: Record<string, { model?: string }>;
}

export interface TaskSummaryDto {
    id: string;
    title: string;
    templateId: string;
    mode: TaskMode;
    status: TaskStatus;
    machineId: string;
    repoPath: string;
    baseBranch: string;
    workBranch: string;
    currentStage: string | null;
    round: number;
    maxRounds: number;
    prUrl: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
}

export interface StageRunDto {
    id: string;
    stage: string;
    round: number;
    agent: string;
    model: string | null;
    sessionId: string | null;
    status: StageRunStatus;
    summary: string | null;
    startedAt: string;
    endedAt: string | null;
}

export interface TransitionDto {
    id: string;
    fromStage: string | null;
    toStage: string;
    requestedBy: string;
    reason: string | null;
    decision: string;
    decidedBy: string | null;
    createdAt: string;
}

export interface TaskDetailDto extends TaskSummaryDto {
    goalPrompt: string;
    worktreePath: string | null;
    skillsCommit: string | null;
    stageRuns: StageRunDto[];
    transitions: TransitionDto[];
}

export interface TemplateStageDto {
    agent: string;
    model: string | null;
    permissionMode: string;
    expectedArtifacts: string[];
}

export interface TemplateDto {
    id: string;
    stages: Record<string, TemplateStageDto>;
    transitions: TaskTemplate["transitions"];
}

/** Create a task in PENDING. Validates the template and machine ownership. */
export async function createTeamTask(teamUser: TeamUser, input: CreateTaskInput): Promise<TeamTask> {
    const template = getTaskTemplate(input.templateId);
    if (!template) {
        throw new TaskRequestError(400, `Unknown template "${input.templateId}"`);
    }
    const machine = await db.machine.findFirst({
        where: { id: input.machineId, accountId: teamUser.accountId },
    });
    if (!machine) {
        throw new TaskRequestError(404, "Machine not found");
    }
    validateStageOverrides(template, input.stageOverrides);

    const workBranch = buildWorkBranch(teamUser.email, input.title);
    const task = await db.teamTask.create({
        data: {
            ownerUserId: teamUser.id,
            machineId: input.machineId,
            templateId: input.templateId,
            mode: input.mode,
            status: TaskStatus.PENDING,
            title: input.title,
            goalPrompt: input.goalPrompt,
            repoPath: input.repoPath,
            baseBranch: input.baseBranch,
            workBranch,
        },
    });
    await writeTeamAudit({
        actorId: teamUser.id,
        action: "team.task.created",
        target: task.id,
        detail: { templateId: input.templateId, machineId: input.machineId, mode: input.mode },
    });
    return task;
}

export async function listTeamTasks(teamUser: TeamUser): Promise<TaskSummaryDto[]> {
    const tasks = await db.teamTask.findMany({
        where: { ownerUserId: teamUser.id },
        orderBy: { createdAt: "desc" },
    });
    return tasks.map(toTaskSummaryDto);
}

export async function getTeamTaskDetail(teamUser: TeamUser, taskId: string): Promise<TaskDetailDto | null> {
    const task = await db.teamTask.findFirst({ where: { id: taskId, ownerUserId: teamUser.id } });
    if (!task) return null;
    const [stageRuns, transitions] = await Promise.all([
        db.teamTaskStageRun.findMany({ where: { taskId }, orderBy: { startedAt: "asc" } }),
        db.teamTaskTransition.findMany({ where: { taskId }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
        ...toTaskSummaryDto(task),
        goalPrompt: task.goalPrompt,
        worktreePath: task.worktreePath,
        skillsCommit: task.skillsCommit,
        stageRuns: stageRuns.map(toStageRunDto),
        transitions: transitions.map(toTransitionDto),
    };
}

/**
 * Cancel an owned, non-terminal task. Worktree is retained (plan §8); session
 * teardown is added when the state machine gets the real daemon gateway (C0.7).
 */
export async function cancelTeamTask(teamUser: TeamUser, taskId: string): Promise<TaskSummaryDto> {
    const task = await db.teamTask.findFirst({ where: { id: taskId, ownerUserId: teamUser.id } });
    if (!task) {
        throw new TaskRequestError(404, "Task not found");
    }
    if (TERMINAL_STATUSES.has(task.status)) {
        throw new TaskRequestError(409, `Task is already ${task.status.toLowerCase()}`);
    }

    const now = new Date();
    const updated = await inTx(async (tx) => {
        await tx.teamTaskStageRun.updateMany({
            where: { taskId, status: StageRunStatus.RUNNING },
            data: { status: StageRunStatus.FAILED, endedAt: now },
        });
        if (task.currentStage) {
            await tx.teamTaskTransition.create({
                data: {
                    taskId,
                    fromStage: task.currentStage,
                    toStage: TaskStatus.CANCELLED,
                    requestedBy: `user:${teamUser.id}`,
                    decision: "rejected",
                    decidedBy: `user:${teamUser.id}`,
                },
            });
        }
        return tx.teamTask.update({
            where: { id: taskId },
            data: { status: TaskStatus.CANCELLED, currentStage: null, finishedAt: now },
        });
    });
    await writeTeamAudit({ actorId: teamUser.id, action: "team.task.cancelled", target: taskId });
    return toTaskSummaryDto(updated);
}

export function listTemplateDtos(): TemplateDto[] {
    return listTaskTemplates().map(toTemplateDto);
}

function validateStageOverrides(template: TaskTemplate, overrides?: Record<string, { model?: string }>): void {
    if (!overrides) return;
    for (const stage of Object.keys(overrides)) {
        if (!template.stages[stage]) {
            throw new TaskRequestError(400, `Stage "${stage}" is not part of template "${template.id}"`);
        }
    }
}

/** Build a `happy/<user>/<slug>-<rand>` work branch (plan §1.3, collision-safe). */
export function buildWorkBranch(email: string, title: string): string {
    const user = slugify(email.split("@")[0]) || "user";
    const slug = slugify(title).slice(0, 40) || "task";
    const suffix = randomBytes(3).toString("hex");
    return `happy/${user}/${slug}-${suffix}`;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function toTaskSummaryDto(task: TeamTask): TaskSummaryDto {
    return {
        id: task.id,
        title: task.title,
        templateId: task.templateId,
        mode: task.mode,
        status: task.status,
        machineId: task.machineId,
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        workBranch: task.workBranch,
        currentStage: task.currentStage,
        round: task.round,
        maxRounds: task.maxRounds,
        prUrl: task.prUrl,
        error: task.error,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
    };
}

function toStageRunDto(run: TeamTaskStageRun): StageRunDto {
    return {
        id: run.id,
        stage: run.stage,
        round: run.round,
        agent: run.agent,
        model: run.model,
        sessionId: run.sessionId,
        status: run.status,
        summary: run.summary,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt ? run.endedAt.toISOString() : null,
    };
}

function toTransitionDto(transition: TeamTaskTransition): TransitionDto {
    return {
        id: transition.id,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
        requestedBy: transition.requestedBy,
        reason: transition.reason,
        decision: transition.decision,
        decidedBy: transition.decidedBy,
        createdAt: transition.createdAt.toISOString(),
    };
}

function toTemplateDto(template: TaskTemplate): TemplateDto {
    const stages: Record<string, TemplateStageDto> = {};
    for (const [name, definition] of Object.entries(template.stages)) {
        stages[name] = {
            agent: definition.agent,
            model: definition.model ?? null,
            permissionMode: definition.permissionMode,
            expectedArtifacts: definition.expectedArtifacts,
        };
    }
    return { id: template.id, stages, transitions: template.transitions };
}
