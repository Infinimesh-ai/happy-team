/**
 * ISCPHappyTransport — HappyTransport adapter over an ISCP link to the
 * machine's daemon (dual-stack Phase 3).
 *
 * request(): happy/wire-request.v1 → happy/wire-response.v1 with request-id
 * correlation and timeout; retries are the caller's job and MUST reuse the
 * idempotencyKey (the daemon dedupes).
 *
 * events(): pull-then-subscribe with the recovery philosophy sync.ts already
 * uses — on (re)connect, catch up per session via messages.pull from the
 * last cursor, then consume live happy/wire-event.v1 pushes; duplicates are
 * dropped by (sessionId, seq), a gap or stale-epoch reset triggers a re-pull
 * for that session. Payloads arrive already E2E-protected by iscp_session_v1,
 * so there is no Happy encryption layer here.
 */

import {
    HappyWireRequestError,
    HappyWireResponseSchema,
    SessionWireEventSchema,
    WIRE_EPHEMERAL_PAYLOAD_TYPE,
    WIRE_EVENT_PAYLOAD_TYPE,
    WIRE_REQUEST_PAYLOAD_TYPE,
    WIRE_RESPONSE_PAYLOAD_TYPE,
    type HappyConnectionState,
    type HappyTransport,
    type HappyTransportRequestOptions,
    type HappyWireEvent,
    type HappyWireRequest,
} from '@slopus/happy-wire';

import { AsyncPushIterable } from './asyncPushIterable';
import type { IscpLink, IscpLinkState } from './iscpLink';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: HappyWireRequestError) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface PullResult {
    events: Array<{ seq: number; cursor: string; body: unknown; at: number }>;
    hasMore: boolean;
    lastCursor: string | null;
    reset: boolean;
}

export interface ISCPHappyTransportOptions {
    link: IscpLink;
    defaultTimeoutMs?: number;
    /** Persisted cursor per session, injected so restarts resume (MMKV in the app). */
    cursorStore?: {
        get(sessionId: string): string | null;
        set(sessionId: string, cursor: string): void;
    };
}

export class ISCPHappyTransport implements HappyTransport {
    private readonly link: IscpLink;
    private readonly defaultTimeoutMs: number;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly stateCallbacks = new Set<(state: HappyConnectionState) => void>();
    private state: HappyConnectionState = 'disconnected';
    private eventStream: AsyncPushIterable<HappyWireEvent> | null = null;
    /** Per-session last delivered seq (dedupe + gap detection). */
    private readonly lastSeqBySession = new Map<string, number>();
    private readonly cursorStore: NonNullable<ISCPHappyTransportOptions['cursorStore']>;
    private requestCounter = 0;
    private catchUpChain: Promise<void> = Promise.resolve();

    constructor(options: ISCPHappyTransportOptions) {
        this.link = options.link;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
        const memoryCursors = new Map<string, string>();
        this.cursorStore = options.cursorStore ?? {
            get: (sessionId) => memoryCursors.get(sessionId) ?? null,
            set: (sessionId, cursor) => void memoryCursors.set(sessionId, cursor),
        };
        this.link.onPayload((payloadType, bytes) => this.handlePayload(payloadType, bytes));
        this.link.onState((linkState) => this.handleLinkState(linkState));
    }

    async connect(): Promise<void> {
        this.setState('connecting');
        try {
            await this.link.open();
            this.setState('connected');
        } catch (error) {
            this.setState('error');
            throw error;
        }
    }

    async close(): Promise<void> {
        this.link.close();
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new HappyWireRequestError({ code: 'retryable', message: 'transport closed' }));
        }
        this.pending.clear();
        this.eventStream?.end();
        this.eventStream = null;
        this.setState('disconnected');
    }

    async request<TResponse>(request: HappyWireRequest, options?: HappyTransportRequestOptions): Promise<TResponse> {
        const id = request.id !== '' ? request.id : `req-${++this.requestCounter}`;
        const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
        const payload = textEncoder.encode(JSON.stringify({ ...request, id }));
        const result = new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new HappyWireRequestError({ code: 'timeout', message: `request ${request.method} timed out after ${timeoutMs}ms` }));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        try {
            await this.link.send(WIRE_REQUEST_PAYLOAD_TYPE, payload);
        } catch (error) {
            const pending = this.pending.get(id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
            }
            throw new HappyWireRequestError({ code: 'retryable', message: error instanceof Error ? error.message : 'send failed' });
        }
        return (await result) as TResponse;
    }

    events(fromCursor?: string): AsyncIterable<HappyWireEvent> {
        if (this.eventStream) {
            throw new Error('ISCPHappyTransport supports a single events() consumer');
        }
        void fromCursor; // cursors are tracked per session via cursorStore
        const stream = new AsyncPushIterable<HappyWireEvent>();
        this.eventStream = stream;
        // Start catch-up + live subscription once connected.
        this.scheduleCatchUp();
        return stream;
    }

    connectionState(): HappyConnectionState {
        return this.state;
    }

    onConnectionState(callback: (state: HappyConnectionState) => void): () => void {
        this.stateCallbacks.add(callback);
        return () => this.stateCallbacks.delete(callback);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private setState(state: HappyConnectionState): void {
        if (this.state === state) return;
        this.state = state;
        for (const callback of this.stateCallbacks) callback(state);
    }

    private handleLinkState(linkState: IscpLinkState): void {
        if (linkState === 'connected') {
            this.setState('connected');
            // Reconnect: catch up (covers events missed while offline), then
            // live pushes resume. Subscription is re-asserted on every catch-up.
            this.scheduleCatchUp();
            return;
        }
        if (this.state === 'connected' && (linkState === 'connecting' || linkState === 'disconnected')) {
            this.setState('connecting');
        }
    }

    private handlePayload(payloadType: string, bytes: Uint8Array): void {
        if (payloadType === WIRE_RESPONSE_PAYLOAD_TYPE) {
            const response = HappyWireResponseSchema.parse(JSON.parse(textDecoder.decode(bytes)));
            const pending = this.pending.get(response.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (response.ok) {
                pending.resolve(response.result);
            } else {
                pending.reject(new HappyWireRequestError(response.error));
            }
            return;
        }
        if (payloadType === WIRE_EVENT_PAYLOAD_TYPE) {
            const event = SessionWireEventSchema.safeParse(JSON.parse(textDecoder.decode(bytes)));
            if (!event.success) return;
            this.deliverSessionEvent(event.data.sessionId, event.data.seq, event.data.cursor, event.data.body, true);
            return;
        }
        if (payloadType === WIRE_EPHEMERAL_PAYLOAD_TYPE) {
            this.eventStream?.push({ type: 'ephemeral', body: JSON.parse(textDecoder.decode(bytes)) });
        }
    }

    private deliverSessionEvent(sessionId: string, seq: number, cursor: string, body: unknown, live: boolean): void {
        const lastSeq = this.lastSeqBySession.get(sessionId) ?? 0;
        if (seq <= lastSeq) return; // duplicate (pull/subscribe overlap)
        if (live && seq > lastSeq + 1) {
            // Gap on the live stream: re-pull this session instead of
            // delivering out of order (same recovery philosophy as sync.ts).
            this.scheduleCatchUp(sessionId);
            return;
        }
        this.lastSeqBySession.set(sessionId, seq);
        this.cursorStore.set(sessionId, cursor);
        this.eventStream?.push({ type: 'session-event', sessionId, seq, cursor, body });
    }

    private scheduleCatchUp(onlySessionId?: string): void {
        if (!this.eventStream) return;
        this.catchUpChain = this.catchUpChain
            .then(() => this.catchUp(onlySessionId))
            .catch(() => {
                // Transport-level failure: the next reconnect re-triggers catch-up.
            });
    }

    private async catchUp(onlySessionId?: string): Promise<void> {
        let sessionIds: string[];
        if (onlySessionId !== undefined) {
            sessionIds = [onlySessionId];
        } else {
            const list = await this.request<{ sessions: Array<{ sessionId: string }> }>({
                id: '',
                method: 'sessions.list',
                params: {},
            });
            sessionIds = list.sessions.map((session) => session.sessionId);
        }
        for (const sessionId of sessionIds) {
            await this.pullSession(sessionId);
        }
        if (onlySessionId === undefined) {
            await this.request({ id: '', method: 'events.subscribe', params: {} });
        }
    }

    private async pullSession(sessionId: string): Promise<void> {
        for (;;) {
            const afterCursor = this.cursorStore.get(sessionId);
            const page = await this.request<PullResult>({
                id: '',
                method: 'messages.pull',
                params: { sessionId, ...(afterCursor !== null ? { afterCursor } : {}) },
            });
            if (page.reset) {
                // Stale epoch: daemon log was rebuilt; drop local position and
                // deliver from scratch (the page already contains history from 0).
                this.lastSeqBySession.delete(sessionId);
            }
            for (const event of page.events) {
                this.deliverSessionEvent(sessionId, event.seq, event.cursor, event.body, false);
            }
            if (!page.hasMore) return;
        }
    }
}
