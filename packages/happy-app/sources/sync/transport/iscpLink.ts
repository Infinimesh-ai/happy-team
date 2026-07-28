/**
 * IscpLink — the thin seam between ISCPHappyTransport and @slopus/iscp's
 * IscpPeer. The transport logic (request correlation, cursor resume, dedupe)
 * is pure and unit-testable against a fake link; the peer-backed factory
 * below is the only place that touches real networking.
 */

import {
    IscpPeer,
    type DeviceIdentity,
    type IscpPeerOptions,
    type RelayWsState,
} from '@slopus/iscp';

export type IscpLinkState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface IscpLink {
    /** Bring the relay connection up and complete session + manifest exchange. */
    open(): Promise<void>;
    close(): void;
    send(payloadType: string, bytes: Uint8Array): Promise<void>;
    onPayload(callback: (payloadType: string, bytes: Uint8Array) => void): void;
    onState(callback: (state: IscpLinkState) => void): void;
}

export interface IscpPeerLinkOptions {
    /** The daemon's ISCP device id (from trust root / enrollment). */
    agentDeviceId: string;
    /** Everything IscpPeer needs except the payload/state callbacks. */
    peerOptions: Omit<IscpPeerOptions, 'onPayload' | 'onConnectionState'>;
    /** App-side capability manifest exchanged after session.ready. */
    openTimeoutMs?: number;
}

function mapWsState(state: RelayWsState): IscpLinkState {
    switch (state) {
        case 'READY':
            return 'connected';
        case 'CLOSED':
            return 'disconnected';
        case 'IDLE':
            return 'disconnected';
        default:
            return 'connecting';
    }
}

/** Production link: wraps a real IscpPeer talking to the daemon via the relay. */
export function createIscpPeerLink(options: IscpPeerLinkOptions): IscpLink {
    let payloadCallback: ((payloadType: string, bytes: Uint8Array) => void) | null = null;
    let stateCallback: ((state: IscpLinkState) => void) | null = null;

    const peer = new IscpPeer({
        ...options.peerOptions,
        onPayload: (peerDeviceId, payloadType, plaintext) => {
            if (peerDeviceId !== options.agentDeviceId) return;
            payloadCallback?.(payloadType, plaintext);
        },
        onConnectionState: (state) => {
            stateCallback?.(mapWsState(state));
        },
    });

    return {
        open: async () => {
            peer.start();
            await peer.openSession(options.agentDeviceId, { timeoutMs: options.openTimeoutMs ?? 60_000 });
        },
        close: () => peer.stop(),
        send: (payloadType, bytes) => peer.sendPayload(options.agentDeviceId, payloadType, bytes),
        onPayload: (callback) => {
            payloadCallback = callback;
        },
        onState: (callback) => {
            stateCallback = callback;
        },
    };
}

export type { DeviceIdentity };
