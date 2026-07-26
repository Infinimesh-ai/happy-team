import { describe, expect, it } from 'vitest';

import {
    HappyWireRequestError,
    WIRE_EVENT_PAYLOAD_TYPE,
    WIRE_REQUEST_PAYLOAD_TYPE,
    WIRE_RESPONSE_PAYLOAD_TYPE,
    type HappyWireEvent,
    type HappyWireRequest,
} from '@slopus/happy-wire';

import { ISCPHappyTransport } from './ISCPHappyTransport';
import type { IscpLink, IscpLinkState } from './iscpLink';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Scripted daemon double behind the IscpLink seam. */
class FakeLink implements IscpLink {
    payloadCb: ((payloadType: string, bytes: Uint8Array) => void) | null = null;
    stateCb: ((state: IscpLinkState) => void) | null = null;
    requests: HappyWireRequest[] = [];
    /** method → handler returning a result (or throwing {code,message}). */
    handlers = new Map<string, (request: HappyWireRequest) => unknown>();
    autoRespond = true;

    async open(): Promise<void> {
        this.stateCb?.('connected');
    }
    close(): void {
        this.stateCb?.('disconnected');
    }
    async send(payloadType: string, bytes: Uint8Array): Promise<void> {
        if (payloadType !== WIRE_REQUEST_PAYLOAD_TYPE) return;
        const request = JSON.parse(dec.decode(bytes)) as HappyWireRequest;
        this.requests.push(request);
        if (!this.autoRespond) return;
        const handler = this.handlers.get(request.method);
        queueMicrotask(() => {
            if (!handler) {
                this.respond({ ok: false, id: request.id, error: { code: 'unsupported', message: `no handler for ${request.method}` } });
                return;
            }
            try {
                this.respond({ ok: true, id: request.id, result: handler(request) });
            } catch (error) {
                this.respond({ ok: false, id: request.id, error: error as { code: string; message: string } });
            }
        });
    }
    onPayload(callback: (payloadType: string, bytes: Uint8Array) => void): void {
        this.payloadCb = callback;
    }
    onState(callback: (state: IscpLinkState) => void): void {
        this.stateCb = callback;
    }

    respond(response: unknown): void {
        this.payloadCb?.(WIRE_RESPONSE_PAYLOAD_TYPE, enc.encode(JSON.stringify(response)));
    }
    pushEvent(sessionId: string, seq: number, body: unknown): void {
        const cursor = `happy-cursor.v1:${JSON.stringify({ scope: sessionId, seq, epoch: 'e1' })}`;
        this.payloadCb?.(WIRE_EVENT_PAYLOAD_TYPE, enc.encode(JSON.stringify({ type: 'session-event', sessionId, seq, cursor, body })));
    }
}

async function collect(iterator: AsyncIterator<HappyWireEvent>, count: number, timeoutMs = 2000): Promise<HappyWireEvent[]> {
    const out: HappyWireEvent[] = [];
    const deadline = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('collect timed out')), timeoutMs).unref?.();
    });
    while (out.length < count) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        out.push(next.value);
    }
    return out;
}

function makeCursor(sessionId: string, seq: number): string {
    return `happy-cursor.v1:${JSON.stringify({ scope: sessionId, seq, epoch: 'e1' })}`;
}

describe('ISCPHappyTransport', () => {
    it('correlates requests/responses and maps wire errors', async () => {
        const link = new FakeLink();
        link.handlers.set('sessions.list', () => ({ sessions: [] }));
        const transport = new ISCPHappyTransport({ link });
        await transport.connect();

        const result = await transport.request<{ sessions: unknown[] }>({ id: '', method: 'sessions.list', params: {} });
        expect(result.sessions).toEqual([]);

        await expect(transport.request({ id: '', method: 'nope', params: {} })).rejects.toSatisfy(
            (error: unknown) => error instanceof HappyWireRequestError && error.code === 'unsupported',
        );
    });

    it('times out unanswered requests with code timeout', async () => {
        const link = new FakeLink();
        link.autoRespond = false;
        const transport = new ISCPHappyTransport({ link, defaultTimeoutMs: 50 });
        await transport.connect();
        await expect(transport.request({ id: '', method: 'sessions.list', params: {} })).rejects.toSatisfy(
            (error: unknown) => error instanceof HappyWireRequestError && error.code === 'timeout',
        );
    });

    it('pulls backlog, subscribes, dedupes overlap, and re-pulls on gaps', async () => {
        const link = new FakeLink();
        const backlog = [
            { seq: 1, cursor: makeCursor('s1', 1), body: { n: 1 }, at: 1 },
            { seq: 2, cursor: makeCursor('s1', 2), body: { n: 2 }, at: 2 },
        ];
        const late = { seq: 3, cursor: makeCursor('s1', 3), body: { n: 3 }, at: 3 };
        let pulls = 0;
        link.handlers.set('sessions.list', () => ({ sessions: [{ sessionId: 's1' }] }));
        link.handlers.set('events.subscribe', () => ({ subscribed: true }));
        link.handlers.set('messages.pull', (request) => {
            pulls += 1;
            const params = request.params as { afterCursor?: string };
            const afterSeq = params.afterCursor ? (JSON.parse(params.afterCursor.slice('happy-cursor.v1:'.length)) as { seq: number }).seq : 0;
            const events = [...backlog, ...(pulls > 1 ? [late] : [])].filter((event) => event.seq > afterSeq);
            return { events, hasMore: false, lastCursor: null, reset: false };
        });

        const transport = new ISCPHappyTransport({ link });
        await transport.connect();
        const stream = transport.events()[Symbol.asyncIterator]();

        const initial = await collect(stream, 2);
        expect(initial.map((event) => (event.type === 'session-event' ? event.seq : -1))).toEqual([1, 2]);

        // Duplicate live push (overlaps the pull) is dropped; a gap (seq 4
        // after 2..3 missing) triggers a targeted re-pull that recovers seq 3.
        link.pushEvent('s1', 2, { n: 2 });
        link.pushEvent('s1', 4, { n: 4 });

        const recovered = await collect(stream, 1);
        expect(recovered[0]).toMatchObject({ type: 'session-event', sessionId: 's1', seq: 3 });
        expect(link.requests.filter((request) => request.method === 'events.subscribe')).toHaveLength(1);
    });

    it('handles stale-epoch resets by re-delivering from scratch', async () => {
        const link = new FakeLink();
        link.handlers.set('sessions.list', () => ({ sessions: [{ sessionId: 's1' }] }));
        link.handlers.set('events.subscribe', () => ({ subscribed: true }));
        let resetMode = false;
        link.handlers.set('messages.pull', () => {
            if (!resetMode) {
                return { events: [{ seq: 5, cursor: makeCursor('s1', 5), body: { n: 5 }, at: 5 }], hasMore: false, lastCursor: null, reset: false };
            }
            return {
                events: [{ seq: 1, cursor: makeCursor('s1', 1), body: { n: 1 }, at: 1 }],
                hasMore: false,
                lastCursor: null,
                reset: true,
            };
        });

        const transport = new ISCPHappyTransport({ link });
        await transport.connect();
        const stream = transport.events()[Symbol.asyncIterator]();
        const first = await collect(stream, 1);
        expect(first[0]).toMatchObject({ type: 'session-event', seq: 5 });

        // Daemon log reset (new epoch): reconnect triggers catch-up, reset
        // page drops local position and re-delivers seq 1.
        resetMode = true;
        link.stateCb?.('connecting');
        link.stateCb?.('connected');
        const redelivered = await collect(stream, 1);
        expect(redelivered[0]).toMatchObject({ type: 'session-event', seq: 1 });
    });
});
