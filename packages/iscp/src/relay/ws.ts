/**
 * Relay WebSocket client (spec/relay.md):
 *
 *   CONNECTED -> CHALLENGE_SENT -> POP_VERIFIED -> READY -> CLOSED
 *
 * The server sends {state:"challenge"}; the client answers with a DeviceProof
 * over that challenge (audience = relay id); {state:"ready"} confirms
 * proof-of-possession. Queued envelopes arrive as {state:"message"} followed
 * by {state:"drained"} — the reference relay closes after draining, so
 * continuous delivery is a reconnect loop with backoff.
 */

import { iscpError, IscpErrorCodes } from '../errors';
import { createDeviceProof, type Device } from '../identity';
import type { CryptoProvider } from '../crypto/provider';
import { SecureEnvelopeSchema, type SecureEnvelope } from '../schemas';
import { defaultWebSocketFactory, type RawWebSocket, type WebSocketFactory } from '../ws-adapter';

export type RelayWsState =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'CHALLENGE_SENT'
  | 'POP_VERIFIED'
  | 'READY'
  | 'CLOSED';

export interface RelayWsBackoff {
  /** Delay before reconnecting after a clean drain (poll cadence). */
  pollIntervalMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  /** 0..1 random jitter fraction. */
  jitter: number;
  /**
   * Zombie-socket watchdog: if no message arrives for this long the socket is
   * abandoned and the loop reconnects. Needed because some WebSocket
   * implementations (observed with Node's undici under concurrent relay
   * connections) emit `error` without a following `close`, leaving a
   * half-dead socket that would otherwise stall delivery forever. The
   * reference relay drains and closes every poll cycle, so a healthy
   * connection never sits silent this long.
   */
  idleTimeoutMs: number;
}

const DEFAULT_BACKOFF: RelayWsBackoff = {
  pollIntervalMs: 750,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.2,
  idleTimeoutMs: 60_000,
};

export interface RelayWsClientOptions {
  websocketUrl: string;
  relayId: string;
  device: Device;
  provider: CryptoProvider;
  wsFactory?: WebSocketFactory;
  backoff?: Partial<RelayWsBackoff>;
  now?: () => Date;
  onEnvelope: (envelope: SecureEnvelope) => void;
  onStateChange?: (state: RelayWsState) => void;
  /** Called after each drain with the number of envelopes the relay delivered. */
  onDrained?: (delivered: number) => void;
  /** Relay refused the connection (revoked/unknown device or failed proof). Return true to keep retrying. */
  onAccessDenied?: (error: string) => boolean;
  onError?: (error: unknown) => void;
}

export class RelayWsClient {
  private state: RelayWsState = 'IDLE';
  private stopped = true;
  private socket: RawWebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoff: RelayWsBackoff;

  constructor(private readonly opts: RelayWsClientOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
  }

  get currentState(): RelayWsState {
    return this.state;
  }

  /** Start the connect/drain/reconnect loop. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    this.setState('CLOSED');
  }

  private setState(state: RelayWsState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setState('CONNECTING');
    let socket: RawWebSocket;
    try {
      socket = await (this.opts.wsFactory ?? defaultWebSocketFactory)(this.opts.websocketUrl);
    } catch (error) {
      this.opts.onError?.(error);
      this.scheduleReconnect(false);
      return;
    }
    if (this.stopped) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }
    this.socket = socket;
    let drained = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const abandonIfIdle = () => {
      if (this.socket !== socket) return;
      // Half-dead socket (error without close, or a silent peer): abandon it
      // and reconnect. A late onclose from the old socket is ignored by the
      // identity checks below.
      this.socket = null;
      try {
        socket.close();
      } catch {
        // already dead
      }
      this.scheduleReconnect(drained);
    };
    const armIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(abandonIfIdle, this.backoff.idleTimeoutMs);
    };
    armIdleTimer();
    socket.onopen = () => {
      if (this.socket === socket) this.setState('CONNECTED');
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      armIdleTimer();
      try {
        drained = this.handleMessage(socket, String(event.data)) || drained;
      } catch (error) {
        this.opts.onError?.(error);
      }
    };
    socket.onerror = (error) => {
      if (this.socket === socket) this.opts.onError?.(error);
    };
    socket.onclose = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect(drained);
    };
  }

  /** Returns true once the relay reports the queue drained. */
  private handleMessage(socket: RawWebSocket, raw: string): boolean {
    const message = JSON.parse(raw) as { state?: string; challenge?: string; error?: string; envelope?: unknown; delivered?: number };
    switch (message.state) {
      case 'challenge': {
        if (typeof message.challenge !== 'string' || message.challenge.length === 0) {
          throw iscpError(IscpErrorCodes.AccessInvalid, 'relay challenge missing');
        }
        const proof = createDeviceProof(this.opts.provider, this.opts.device, {
          audience: this.opts.relayId,
          challenge: message.challenge,
          now: (this.opts.now ?? (() => new Date()))(),
        });
        socket.send(JSON.stringify(proof));
        this.setState('CHALLENGE_SENT');
        return false;
      }
      case 'ready':
        this.attempt = 0;
        this.setState('POP_VERIFIED');
        this.setState('READY');
        return false;
      case 'message': {
        const envelope = SecureEnvelopeSchema.parse(message.envelope);
        this.opts.onEnvelope(envelope);
        return false;
      }
      case 'drained':
        this.opts.onDrained?.(typeof message.delivered === 'number' ? message.delivered : 0);
        return true;
      case 'closed': {
        const reason = message.error ?? 'relay closed connection';
        const retry = this.opts.onAccessDenied?.(reason) ?? false;
        if (!retry) {
          this.stopped = true;
          this.opts.onError?.(iscpError(IscpErrorCodes.AccessInvalid, `relay refused connection: ${reason}`));
        }
        return false;
      }
      default:
        return false;
    }
  }

  private scheduleReconnect(cleanDrain: boolean): void {
    if (this.stopped) {
      this.setState('CLOSED');
      return;
    }
    let delay: number;
    if (cleanDrain) {
      delay = this.backoff.pollIntervalMs;
    } else {
      delay = Math.min(this.backoff.initialDelayMs * this.backoff.factor ** this.attempt, this.backoff.maxDelayMs);
      this.attempt += 1;
    }
    delay += delay * this.backoff.jitter * Math.random();
    this.setState('CONNECTING');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
