/**
 * Task HTTP API (plan §10.1, milestone C0.6). Auth and audit reuse the Team
 * edition patterns: `app.authenticate` populates request.userId, then the
 * active TeamUser is resolved before any task action. Registered from a single
 * point (api.ts) via {@link teamTaskRoutes}.
 */
import { TaskMode } from "@prisma/client";
import { z } from "zod";
import { type Fastify } from "@/app/api/types";
import { getActiveTeamUser } from "@/team/status";
import {
    cancelTeamTask,
    createTeamTask,
    getTeamTaskDetail,
    listTeamTasks,
    listTemplateDtos,
    TaskRequestError,
} from "./taskService";
import { applyTaskIntent, approveTeamTask, getTaskPlan, rejectTeamTask, startTeamTask, stopActiveTaskSessions } from "./taskRuntime";
import { verifyTaskToken } from "./taskToken";
import type { TaskIntent } from "./taskStateMachine";

const createTaskBodySchema = z.object({
    machineId: z.string().min(1),
    repoPath: z.string().min(1),
    templateId: z.string().min(1),
    mode: z.enum([TaskMode.SUPERVISED, TaskMode.AUTONOMOUS]).default(TaskMode.SUPERVISED),
    title: z.string().min(1).max(200),
    goalPrompt: z.string().min(1),
    baseBranch: z.string().min(1),
    stageOverrides: z.record(z.string(), z.object({ model: z.string().optional() })).optional(),
});

const taskIdParamsSchema = z.object({ id: z.string().min(1) });

const intentBodySchema = z.object({
    token: z.string().min(1),
    kind: z.enum(["get_task_context", "complete_stage", "report_blocker"]),
    summary: z.string().optional(),
    verdict: z.enum(["passed", "failed"]).optional(),
    reason: z.string().optional(),
});

const approveBodySchema = z.object({ plan: z.string().optional() }).optional();

function toIntent(body: z.infer<typeof intentBodySchema>): TaskIntent | null {
    if (body.kind === "get_task_context") return { kind: "get_task_context" };
    if (body.kind === "complete_stage") return { kind: "complete_stage", summary: body.summary, verdict: body.verdict };
    if (!body.reason) return null;
    return { kind: "report_blocker", reason: body.reason };
}

export function teamTaskRoutes(app: Fastify) {
    app.get("/v1/team/tasks/templates", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        return reply.send({ templates: listTemplateDtos() });
    });

    app.post("/v1/team/tasks", {
        preHandler: app.authenticate,
        schema: { body: createTaskBodySchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        try {
            const task = await createTeamTask(teamUser, request.body);
            const detail = await getTeamTaskDetail(teamUser, task.id);
            // Begin orchestration on the member's machine (best-effort, async).
            void startTeamTask(task.id);
            return reply.code(201).send({ task: detail });
        } catch (error) {
            return sendTaskError(reply, error);
        }
    });

    app.get("/v1/team/tasks", {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        return reply.send({ tasks: await listTeamTasks(teamUser) });
    });

    app.get("/v1/team/tasks/:id", {
        preHandler: app.authenticate,
        schema: { params: taskIdParamsSchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        const detail = await getTeamTaskDetail(teamUser, request.params.id);
        if (!detail) return reply.code(404).send({ error: "Task not found" });
        return reply.send({ task: detail });
    });

    app.post("/v1/team/tasks/:id/cancel", {
        preHandler: app.authenticate,
        schema: { params: taskIdParamsSchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        try {
            const task = await cancelTeamTask(teamUser, request.params.id);
            // Terminate the active stage session (worktree retained, plan §8).
            void stopActiveTaskSessions(request.params.id);
            return reply.send({ task });
        } catch (error) {
            return sendTaskError(reply, error);
        }
    });

    // Internal: daemon-forwarded MCP intent, authenticated by the task token
    // (not the account). complete_stage / report_blocker / get_task_context.
    app.post("/v1/team/tasks/:id/intent", {
        schema: { params: taskIdParamsSchema, body: intentBodySchema },
    }, async (request, reply) => {
        const claims = verifyTaskToken(request.body.token);
        if (!claims || claims.taskId !== request.params.id) {
            return reply.code(401).send({ error: "invalid task token" });
        }
        const intent = toIntent(request.body);
        if (!intent) return reply.code(400).send({ error: "report_blocker requires a reason" });
        const result = await applyTaskIntent(claims, intent);
        if (!result.ok) return reply.code(409).send({ error: result.error });
        return reply.send(result);
    });

    app.get("/v1/team/tasks/:id/plan", {
        preHandler: app.authenticate,
        schema: { params: taskIdParamsSchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        const detail = await getTeamTaskDetail(teamUser, request.params.id);
        if (!detail) return reply.code(404).send({ error: "Task not found" });
        return reply.send({ plan: await getTaskPlan(request.params.id) });
    });

    app.post("/v1/team/tasks/:id/approve", {
        preHandler: app.authenticate,
        schema: { params: taskIdParamsSchema, body: approveBodySchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        const detail = await getTeamTaskDetail(teamUser, request.params.id);
        if (!detail) return reply.code(404).send({ error: "Task not found" });
        if (detail.status !== "WAITING_APPROVAL") return reply.code(409).send({ error: "Task is not awaiting approval" });
        await approveTeamTask(request.params.id, { editedPlan: request.body?.plan, actorId: teamUser.id });
        return reply.send({ task: await getTeamTaskDetail(teamUser, request.params.id) });
    });

    app.post("/v1/team/tasks/:id/reject", {
        preHandler: app.authenticate,
        schema: { params: taskIdParamsSchema },
    }, async (request, reply) => {
        const teamUser = await getActiveTeamUser(request.userId);
        if (!teamUser) return reply.code(403).send({ error: "Team user required" });
        const detail = await getTeamTaskDetail(teamUser, request.params.id);
        if (!detail) return reply.code(404).send({ error: "Task not found" });
        if (detail.status !== "WAITING_APPROVAL") return reply.code(409).send({ error: "Task is not awaiting approval" });
        await rejectTeamTask(request.params.id, teamUser.id);
        return reply.send({ task: await getTeamTaskDetail(teamUser, request.params.id) });
    });
}

function sendTaskError(reply: { code: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
    if (error instanceof TaskRequestError) {
        return reply.code(error.statusCode).send({ error: error.message });
    }
    throw error;
}
