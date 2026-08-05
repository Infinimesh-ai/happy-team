/**
 * MCP server core for /v1/team/mcp — a stateless Streamable HTTP endpoint
 * (JSON responses, no SSE) that exposes the Cloud Agent task surface as MCP
 * tools for an external personal-assistant client (e.g. SparkClaw). Each tool
 * is a thin wrapper over the same task service the REST routes use, so
 * ownership scoping, template validation and state-machine rules are shared.
 * Mutating calls additionally write a `team.mcp.call` audit entry so the admin
 * audit view shows which actions came through a member's assistant.
 *
 * Protocol: JSON-RPC 2.0, methods initialize / ping / tools/list / tools/call;
 * notifications are acknowledged with 202. Batches (JSON arrays) are rejected —
 * the 2025-06-18 MCP revision removed them.
 */
import { TaskMode } from "@prisma/client";
import { TeamUser } from "@prisma/client";
import { z } from "zod";
import { db } from "@/storage/db";
import { writeTeamAudit } from "@/team/audit";
import {
    cancelTeamTask,
    createTeamTask,
    getTeamTaskDetail,
    listTeamTasks,
    listTemplateDtos,
    TaskRequestError,
} from "@/team/tasks/taskService";
import { approveTeamTask, getTaskPlan, rejectTeamTask, startTeamTask, stopActiveTaskSessions } from "@/team/tasks/taskRuntime";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const KNOWN_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

const SERVER_INFO = { name: "happy-team-tasks", title: "Happy Team Cloud Agent tasks", version: "1.0.0" };

const SERVER_INSTRUCTIONS = [
    "Happy Team Edition Cloud Agent tasks for the authenticated member. A task is a one-sentence job that a",
    "multi-stage agent pipeline executes in a git worktree on the member's own machine, ending in a pull request.",
    "Typical flow: list_machines to find a machineId, create_task to dispatch work, list_tasks / get_task to",
    "follow progress. Tasks in WAITING_APPROVAL have a plan to review: read it with get_task_plan, then",
    "approve_plan or reject_plan — surface that decision to the human owner, do not decide autonomously.",
    "Machine names and session contents are end-to-end encrypted and not available here; only ids and liveness are.",
].join(" ");

interface ToolDefinition {
    description: string;
    title: string;
    schema: z.ZodObject<z.ZodRawShape>;
    mutating: boolean;
    run: (teamUser: TeamUser, args: Record<string, unknown>) => Promise<unknown>;
}

const taskIdShape = { taskId: z.string().min(1).describe("Task id from list_tasks / create_task") };

const TOOLS: Record<string, ToolDefinition> = {
    list_machines: {
        title: "List machines",
        description: "List the member's enrolled machines: id, liveness and timestamps. Machine names/metadata are end-to-end encrypted and not readable server-side — pick the machine by liveness, or resolve names through the member's local happy bridge if available.",
        schema: z.object({}),
        mutating: false,
        run: async (teamUser) => {
            const machines = await db.machine.findMany({ where: { accountId: teamUser.accountId }, orderBy: { lastActiveAt: "desc" } });
            return {
                machines: machines.map((m) => ({
                    id: m.id,
                    active: m.active,
                    lastActiveAt: m.lastActiveAt.toISOString(),
                    createdAt: m.createdAt.toISOString(),
                })),
            };
        },
    },
    list_templates: {
        title: "List task templates",
        description: "List the built-in orchestration templates (stages, agents, transitions). Use a template id in create_task.",
        schema: z.object({}),
        mutating: false,
        run: async () => ({ templates: listTemplateDtos() }),
    },
    list_tasks: {
        title: "List tasks",
        description: "List the member's Cloud Agent tasks, newest first. Optionally filter by status. Tasks in WAITING_APPROVAL need a human decision on their plan.",
        schema: z.object({
            status: z.enum(["PENDING", "PREPARING", "RUNNING", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "ESCALATED", "CANCELLED"]).optional()
                .describe("Only return tasks with this status"),
        }),
        mutating: false,
        run: async (teamUser, args) => {
            const tasks = await listTeamTasks(teamUser);
            const status = args.status as string | undefined;
            return { tasks: status ? tasks.filter((t) => t.status === status) : tasks };
        },
    },
    get_task: {
        title: "Get task detail",
        description: "Full task detail: goal prompt, stage runs, the complete transition history (including rejected agent intents), and the PR URL once delivered.",
        schema: z.object(taskIdShape),
        mutating: false,
        run: async (teamUser, args) => {
            const task = await getTeamTaskDetail(teamUser, args.taskId as string);
            if (!task) throw new TaskRequestError(404, "Task not found");
            return { task };
        },
    },
    get_task_plan: {
        title: "Get task plan",
        description: "Read the task's plan.md from the worktree on the member's machine (the machine must be reachable). Review this before approve_plan / reject_plan.",
        schema: z.object(taskIdShape),
        mutating: false,
        run: async (teamUser, args) => {
            const task = await getTeamTaskDetail(teamUser, args.taskId as string);
            if (!task) throw new TaskRequestError(404, "Task not found");
            return { plan: await getTaskPlan(args.taskId as string) };
        },
    },
    create_task: {
        title: "Create task",
        description: "Create and immediately start a Cloud Agent task on one of the member's machines. The pipeline runs in an isolated git worktree and delivers a pull request. Write goalPrompt as a complete, self-contained instruction.",
        schema: z.object({
            machineId: z.string().min(1).describe("Target machine id from list_machines"),
            repoPath: z.string().min(1).describe("Absolute path of the git repository on the target machine"),
            templateId: z.string().min(1).describe("Template id from list_templates, e.g. plan-execute-verify"),
            mode: z.enum([TaskMode.SUPERVISED, TaskMode.AUTONOMOUS]).default(TaskMode.SUPERVISED)
                .describe("SUPERVISED parks at approval gates for a human; AUTONOMOUS runs unattended"),
            title: z.string().min(1).max(200).describe("Short human-readable task title"),
            goalPrompt: z.string().min(1).describe("The job to do, as a complete instruction with all context the agent needs"),
            baseBranch: z.string().min(1).describe("Branch to base the work on, e.g. main"),
        }),
        mutating: true,
        run: async (teamUser, args) => {
            // args was validated by this tool's schema, which mirrors CreateTaskInput.
            const task = await createTeamTask(teamUser, args as unknown as Parameters<typeof createTeamTask>[1]);
            const detail = await getTeamTaskDetail(teamUser, task.id);
            void startTeamTask(task.id);
            return { task: detail };
        },
    },
    cancel_task: {
        title: "Cancel task",
        description: "Cancel a non-terminal task. Active stage sessions are stopped; the worktree is retained on the machine.",
        schema: z.object(taskIdShape),
        mutating: true,
        run: async (teamUser, args) => {
            const task = await cancelTeamTask(teamUser, args.taskId as string);
            void stopActiveTaskSessions(args.taskId as string);
            return { task };
        },
    },
    approve_plan: {
        title: "Approve plan",
        description: "Approve a task waiting in WAITING_APPROVAL, optionally writing an edited plan back first. This is the human owner's decision — call it only after the owner confirmed, e.g. through your approval inbox.",
        schema: z.object({
            ...taskIdShape,
            editedPlan: z.string().optional().describe("Replacement plan.md content to write back before approving"),
        }),
        mutating: true,
        run: async (teamUser, args) => {
            const detail = await getTeamTaskDetail(teamUser, args.taskId as string);
            if (!detail) throw new TaskRequestError(404, "Task not found");
            if (detail.status !== "WAITING_APPROVAL") throw new TaskRequestError(409, "Task is not awaiting approval");
            await approveTeamTask(args.taskId as string, { editedPlan: args.editedPlan as string | undefined, actorId: teamUser.id });
            return { task: await getTeamTaskDetail(teamUser, args.taskId as string) };
        },
    },
    reject_plan: {
        title: "Reject plan",
        description: "Reject a task waiting in WAITING_APPROVAL — the task fails. This is the human owner's decision — call it only after the owner confirmed.",
        schema: z.object(taskIdShape),
        mutating: true,
        run: async (teamUser, args) => {
            const detail = await getTeamTaskDetail(teamUser, args.taskId as string);
            if (!detail) throw new TaskRequestError(404, "Task not found");
            if (detail.status !== "WAITING_APPROVAL") throw new TaskRequestError(409, "Task is not awaiting approval");
            await rejectTeamTask(args.taskId as string, teamUser.id);
            return { task: await getTeamTaskDetail(teamUser, args.taskId as string) };
        },
    },
};

interface JsonRpcResponse {
    status: number;
    body?: unknown;
}

function rpcResult(id: unknown, result: unknown): JsonRpcResponse {
    return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
    return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown, isError = false): unknown {
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function listToolsResult(): unknown {
    return {
        tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            title: tool.title,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.schema),
        })),
    };
}

async function callTool(teamUser: TeamUser, id: unknown, params: unknown): Promise<JsonRpcResponse> {
    const shape = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
    if (!shape.success) return rpcError(id, -32602, "Invalid tools/call params");
    const tool = TOOLS[shape.data.name];
    if (!tool) return rpcError(id, -32602, `Unknown tool "${shape.data.name}"`);

    const args = tool.schema.safeParse(shape.data.arguments ?? {});
    if (!args.success) {
        return rpcResult(id, toolResult(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, true));
    }

    try {
        const result = await tool.run(teamUser, args.data);
        if (tool.mutating) {
            await writeTeamAudit({
                actorId: teamUser.id,
                action: "team.mcp.call",
                target: (args.data as { taskId?: string }).taskId ?? null,
                detail: { tool: shape.data.name },
            });
        }
        return rpcResult(id, toolResult(result));
    } catch (error) {
        if (error instanceof TaskRequestError) {
            return rpcResult(id, toolResult(error.message, true));
        }
        throw error;
    }
}

/**
 * Handle one Streamable HTTP POST body for an authenticated member. Returns
 * the HTTP status and JSON body to send (202 with no body for notifications).
 */
export async function handleMcpRequest(teamUser: TeamUser, body: unknown): Promise<JsonRpcResponse> {
    if (Array.isArray(body)) {
        return rpcError(null, -32600, "Batch requests are not supported");
    }
    const message = z.object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.unknown().optional(),
    }).safeParse(body);
    if (!message.success) {
        return rpcError(null, -32600, "Invalid JSON-RPC message");
    }
    const { id, method, params } = message.data;

    // Notifications (no id) are acknowledged and ignored.
    if (id === undefined) return { status: 202 };

    if (method === "initialize") {
        const requested = z.object({ protocolVersion: z.string().optional() }).safeParse(params);
        const version = requested.success && requested.data.protocolVersion && KNOWN_PROTOCOL_VERSIONS.has(requested.data.protocolVersion)
            ? requested.data.protocolVersion
            : MCP_PROTOCOL_VERSION;
        return rpcResult(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS,
        });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, listToolsResult());
    if (method === "tools/call") return callTool(teamUser, id, params);
    return rpcError(id, -32601, `Method not found: ${method}`);
}
