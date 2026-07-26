import type { HappyTransport } from '@slopus/happy-wire';
import type { SyncSocketConfig } from '@/sync/apiSocket';
import { Encryption } from '@/sync/encryption/encryption';
import { LegacyHappyTransport } from './LegacyHappyTransport';
import type { LegacyChannel } from './legacyChannel';

/**
 * Module-level transport facade. Exactly one transport is active at a time;
 * profile switching (Phase 3) closes the old one before opening the next.
 * Domain code reaches the network only through getTransport() and the RPC
 * helpers below — importing apiSocket directly outside transport/ is banned.
 */

export type ActiveTransport = HappyTransport & { legacy?: LegacyChannel };

let activeTransport: ActiveTransport | null = null;

let wireRequestCounter = 0;
function nextWireRequestId(): string {
    return `wire-${++wireRequestCounter}`;
}

export function initializeLegacyTransport(config: SyncSocketConfig, encryption: Encryption): ActiveTransport {
    const transport = new LegacyHappyTransport(config, encryption);
    activeTransport = transport;
    return transport;
}

export function getTransport(): ActiveTransport {
    if (!activeTransport) {
        throw new Error('Transport not initialized');
    }
    return activeTransport;
}

export function getTransportOrNull(): ActiveTransport | null {
    return activeTransport;
}

export async function closeTransport(): Promise<void> {
    if (activeTransport) {
        await activeTransport.close();
        activeTransport = null;
    }
}

//
// RPC helpers — the wire-level replacements for apiSocket.sessionRPC/machineRPC.
// Mutation call sites pass their retry-stable key via idempotencyKey.
//

export async function sessionRPC<R, A>(sessionId: string, method: string, params: A): Promise<R> {
    return getTransport().request<R>({
        id: nextWireRequestId(),
        method: 'session.rpc',
        params: { sessionId, method, params },
    });
}

export async function machineRPC<R, A>(machineId: string, method: string, params: A): Promise<R> {
    return getTransport().request<R>({
        id: nextWireRequestId(),
        method: 'machine.rpc',
        params: { machineId, method, params },
    });
}

//
// Legacy-channel helpers. These exist for the legacy-only modules; each one
// is a hard error in ISCP mode except sendAppState, which is a safe no-op
// (it can fire from app-state listeners before any transport exists).
//

export function legacyRequest(path: string, options?: RequestInit): Promise<Response> {
    const legacy = getTransport().legacy;
    if (!legacy) {
        throw new Error('Legacy channel unavailable on this transport');
    }
    return legacy.request(path, options);
}

export function legacyEmitWithAck<T = any>(event: string, data: any): Promise<T> {
    const legacy = getTransport().legacy;
    if (!legacy) {
        throw new Error('Legacy channel unavailable on this transport');
    }
    return legacy.emitWithAck<T>(event, data);
}

export function legacySendAppState(state: string): void {
    activeTransport?.legacy?.sendAppState(state);
}
