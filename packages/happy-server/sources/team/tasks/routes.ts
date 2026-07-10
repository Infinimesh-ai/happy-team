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
import { startTeamTask, stopActiveTaskSessions } from "./taskRuntime";

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
}

function sendTaskError(reply: { code: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
    if (error instanceof TaskRequestError) {
        return reply.code(error.statusCode).send({ error: error.message });
    }
    throw error;
}
