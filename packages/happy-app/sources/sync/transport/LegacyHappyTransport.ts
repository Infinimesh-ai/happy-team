import type {
    HappyConnectionState,
    HappyTransport,
    HappyTransportRequestOptions,
    HappyWireEvent,
    HappyWireRequest,
} from '@slopus/happy-wire';
import { HappyWireRequestError } from '@slopus/happy-wire';
import { apiSocket, type SyncSocketConfig } from '@/sync/apiSocket';
import { Encryption } from '@/sync/encryption/encryption';
import { AsyncPushIterable } from './asyncPushIterable';
import type { LegacyChannel } from './legacyChannel';

export interface SessionRpcParams {
    sessionId: string;
    method: string;
    params: unknown;
}

export interface MachineRpcParams {
    machineId: string;
    method: string;
    params: unknown;
}

/**
 * HappyTransport adapter over the existing network stack. Deliberately moves
 * no code: apiSocket keeps connection management, reconnection, RPC encryption
 * and HTTP exactly as before — this class only adapts its surface to the port
 * so call sites stop depending on the singleton. Behavior must stay identical
 * to direct apiSocket usage (Phase 1 contract).
 */
export class LegacyHappyTransport implements HappyTransport {
    readonly legacy: LegacyChannel;
    private state: HappyConnectionState = 'disconnected';
    private stopEvents: (() => void) | null = null;

    constructor(config: SyncSocketConfig, encryption: Encryption) {
        apiSocket.initialize(config, encryption);
        // Mirror the socket status so connectionState() is a sync read.
        apiSocket.onStatusChange((status) => {
            this.state = status;
        });
        this.legacy = {
            request: (path, options) => apiSocket.request(path, options),
            sendAppState: (state) => apiSocket.sendAppState(state),
            emitWithAck: (event, data) => apiSocket.emitWithAck(event, data),
            send: (event, data) => apiSocket.send(event, data),
            updateToken: (newToken) => apiSocket.updateToken(newToken),
            onReconnected: (listener) => apiSocket.onReconnected(listener),
        };
    }

    async connect(): Promise<void> {
        apiSocket.connect();
    }

    async close(): Promise<void> {
        this.stopEvents?.();
        apiSocket.disconnect();
    }

    async request<TResponse>(request: HappyWireRequest, _options?: HappyTransportRequestOptions): Promise<TResponse> {
        switch (request.method) {
            case 'session.rpc': {
                const { sessionId, method, params } = request.params as SessionRpcParams;
                return apiSocket.sessionRPC<TResponse, unknown>(sessionId, method, params);
            }
            case 'machine.rpc': {
                const { machineId, method, params } = request.params as MachineRpcParams;
                return apiSocket.machineRPC<TResponse, unknown>(machineId, method, params);
            }
            default:
                throw new HappyWireRequestError({
                    code: 'unsupported',
                    message: `Legacy transport has no method '${request.method}'`,
                });
        }
    }

    /**
     * Opaque passthrough of the socket 'update' / 'ephemeral' payloads, in
     * arrival order. Decryption and validation stay in the sync ingestion
     * path. The legacy transport ignores `fromCursor` — seq tracking lives in
     * the sync engine, exactly as before.
     */
    events(_fromCursor?: string): AsyncIterable<HappyWireEvent> {
        const stream = new AsyncPushIterable<HappyWireEvent>();
        const offUpdate = apiSocket.onMessage('update', (data) => {
            stream.push({ type: 'legacy-update', body: data });
        });
        const offEphemeral = apiSocket.onMessage('ephemeral', (data) => {
            stream.push({ type: 'legacy-ephemeral', body: data });
        });
        this.stopEvents = () => {
            offUpdate();
            offEphemeral();
            stream.end();
        };
        return stream;
    }

    connectionState(): HappyConnectionState {
        return this.state;
    }

    onConnectionState(callback: (state: HappyConnectionState) => void): () => void {
        return apiSocket.onStatusChange(callback);
    }
}
