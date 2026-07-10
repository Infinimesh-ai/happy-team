/**
 * `happy task-mcp` — the task-control MCP server (plan §7, milestone C1.4).
 *
 * A stdio MCP binary registered into a task's agent session (Claude Code / Codex
 * use the same implementation). It exposes a deliberately narrow tool surface;
 * each call forwards an intent to the server's internal intent endpoint,
 * authenticated by the per-task token in the environment. The server's task
 * state machine adjudicates the intent against the template.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { configuration } from '@/configuration';

export interface TaskMcpConfig {
    serverUrl: string;
    taskId: string;
    token: string;
    /** Injectable for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
}

export type TaskIntentBody =
    | { kind: 'get_task_context' }
    | { kind: 'complete_stage'; summary?: string; verdict?: 'passed' | 'failed' }
    | { kind: 'report_blocker'; reason: string }
    | { kind: 'request_transition'; toStage: string; reason?: string };

export interface TaskIntentResponse {
    ok: boolean;
    error?: string;
    context?: unknown;
}

/** POST an intent to the server, returning the parsed result (never throws on HTTP status). */
export async function postTaskIntent(config: TaskMcpConfig, intent: TaskIntentBody): Promise<TaskIntentResponse> {
    const doFetch = config.fetchImpl ?? fetch;
    const url = `${config.serverUrl.replace(/\/$/, '')}/v1/team/tasks/${encodeURIComponent(config.taskId)}/intent`;
    let response: Response;
    try {
        response = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: config.token, ...intent }),
        });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'network error' };
    }
    const text = await response.text();
    const body = text ? safeJson(text) : {};
    if (!response.ok) {
        return { ok: false, error: (body as { error?: string }).error ?? `HTTP ${response.status}` };
    }
    return body as TaskIntentResponse;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

function toolResult(payload: TaskIntentResponse, okText: string) {
    if (payload.ok) {
        const text = payload.context ? JSON.stringify(payload.context, null, 2) : okText;
        return { content: [{ type: 'text' as const, text }], isError: false };
    }
    return { content: [{ type: 'text' as const, text: `Error: ${payload.error ?? 'unknown error'}` }], isError: true };
}

/** Build the task-control MCP server bound to a task config. */
export function createTaskMcpServer(config: TaskMcpConfig): McpServer {
    const mcp = new McpServer({ name: 'Happy Task Control', version: '1.0.0' });

    mcp.registerTool('get_task_context', {
        description: 'Return the current task goal, stage, round and artifact paths.',
        title: 'Get Task Context',
        inputSchema: {},
    }, async () => toolResult(await postTaskIntent(config, { kind: 'get_task_context' }), 'ok'));

    mcp.registerTool('complete_stage', {
        description: 'Declare the current stage complete. Provide a short summary; verify stages must include a verdict.',
        title: 'Complete Stage',
        inputSchema: {
            summary: z.string().optional().describe('Short summary of what was done'),
            verdict: z.enum(['passed', 'failed']).optional().describe('Verify-stage verdict'),
        },
    }, async (args) => toolResult(await postTaskIntent(config, { kind: 'complete_stage', summary: args.summary, verdict: args.verdict }), 'Stage completion recorded'));

    mcp.registerTool('report_blocker', {
        description: 'Report that the task is blocked and needs human help. Escalates the task.',
        title: 'Report Blocker',
        inputSchema: {
            reason: z.string().describe('Why the task is blocked'),
        },
    }, async (args) => toolResult(await postTaskIntent(config, { kind: 'report_blocker', reason: args.reason }), 'Blocker reported'));

    mcp.registerTool('request_transition', {
        description: 'Request a non-default transition to another stage (e.g. skipping ahead). The server adjudicates it against the template.',
        title: 'Request Transition',
        inputSchema: {
            toStage: z.string().describe('The stage to transition to'),
            reason: z.string().optional().describe('Why this transition is warranted'),
        },
    }, async (args) => toolResult(await postTaskIntent(config, { kind: 'request_transition', toStage: args.toStage, reason: args.reason }), 'Transition requested'));

    return mcp;
}

/**
 * Resolve config from the environment injected at spawn time. The server URL
 * falls back to the CLI's configured endpoint — spawn only injects the task
 * id/token, and HAPPY_SERVER_URL is a dev override that production daemons
 * typically don't export.
 */
export function resolveTaskMcpConfigFromEnv(env: NodeJS.ProcessEnv = process.env, fallbackServerUrl?: string): TaskMcpConfig | null {
    const taskId = env.HAPPY_TASK_ID;
    const token = env.HAPPY_TASK_TOKEN;
    const serverUrl = env.HAPPY_SERVER_URL || fallbackServerUrl || configuration.serverUrl;
    if (!taskId || !token || !serverUrl) return null;
    return { serverUrl, taskId, token };
}

/** Entry point for `happy task-mcp`: serve the tools over stdio until the pipe closes. */
export async function runTaskMcp(): Promise<void> {
    const config = resolveTaskMcpConfigFromEnv();
    if (!config) {
        process.stderr.write('happy task-mcp: HAPPY_TASK_ID and HAPPY_TASK_TOKEN must be set\n');
        process.exitCode = 1;
        return;
    }
    const server = createTaskMcpServer(config);
    await server.connect(new StdioServerTransport());
}
