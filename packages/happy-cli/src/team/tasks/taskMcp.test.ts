/**
 * task-mcp intent client tests. The MCP tool wiring is thin; the substance is
 * the HTTP intent forwarding, tested with an injected fetch (no network).
 */
import { describe, expect, it } from 'vitest';
import { postTaskIntent, resolveTaskMcpConfigFromEnv } from './taskMcp';

function fakeFetch(status: number, body: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('postTaskIntent', () => {
    it('posts the token and intent to the task intent endpoint', async () => {
        const calls: { url: string; body: any }[] = [];
        const capture: typeof fetch = (async (url: string, init: RequestInit) => {
            calls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ ok: true, context: { stage: 'execute' } }), { status: 200 });
        }) as unknown as typeof fetch;

        const result = await postTaskIntent(
            { serverUrl: 'https://srv.test/', taskId: 't1', token: 'tok', fetchImpl: capture },
            { kind: 'get_task_context' },
        );
        expect(result).toEqual({ ok: true, context: { stage: 'execute' } });
        expect(calls[0].url).toBe('https://srv.test/v1/team/tasks/t1/intent');
        expect(calls[0].body).toEqual({ token: 'tok', kind: 'get_task_context' });
    });

    it('surfaces a server error body on non-2xx', async () => {
        const result = await postTaskIntent(
            { serverUrl: 'https://srv.test', taskId: 't1', token: 'bad', fetchImpl: fakeFetch(401, { error: 'invalid task token' }) },
            { kind: 'complete_stage', summary: 's' },
        );
        expect(result).toEqual({ ok: false, error: 'invalid task token' });
    });

    it('returns a network error rather than throwing', async () => {
        const boom: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
        const result = await postTaskIntent(
            { serverUrl: 'https://srv.test', taskId: 't1', token: 'tok', fetchImpl: boom },
            { kind: 'report_blocker', reason: 'stuck' },
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('ECONNREFUSED');
    });
});

describe('resolveTaskMcpConfigFromEnv', () => {
    it('reads the injected task env', () => {
        expect(resolveTaskMcpConfigFromEnv({ HAPPY_TASK_ID: 't', HAPPY_TASK_TOKEN: 'k', HAPPY_SERVER_URL: 'https://s' } as NodeJS.ProcessEnv))
            .toEqual({ serverUrl: 'https://s', taskId: 't', token: 'k' });
    });

    it('returns null when the env is incomplete', () => {
        expect(resolveTaskMcpConfigFromEnv({ HAPPY_TASK_ID: 't' } as NodeJS.ProcessEnv)).toBeNull();
    });
});
