/**
 * In-memory relay double for unit tests: implements just enough of the
 * reference relay's HTTP + WS surface (submit → queue → challenge → proof →
 * ready → drain, then live push) to exercise IscpPeer end-to-end without
 * network or docker. The real reference services are exercised by the
 * integration suite in src/integration/.
 */

import type { FetchLike } from '../relay/http';
import type { SecureEnvelope } from '../schemas';
import type { RawWebSocket, WebSocketFactory } from '../ws-adapter';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function wireError(code: string, message: string, retryable = false) {
  return { type: 'iscp.error.v2', code, message, retryable };
}

class FakeSocket implements RawWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  closed = false;
  authedDeviceId: string | null = null;

  constructor(private readonly relay: FakeRelay) {}

  send(data: string): void {
    // Client → server: the only client message is the device proof.
    const proof = JSON.parse(data) as { device_id?: string };
    this.relay.handleProof(this, typeof proof.device_id === 'string' ? proof.device_id : '');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.detach(this);
    queueMicrotask(() => this.onclose?.({}));
  }

  /** Server → client. */
  push(message: unknown): void {
    if (this.closed) return;
    const data = JSON.stringify(message);
    queueMicrotask(() => {
      if (!this.closed) this.onmessage?.({ data });
    });
  }

  serverClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.detach(this);
    queueMicrotask(() => this.onclose?.({}));
  }
}

export class FakeRelay {
  readonly relayId = 'relay-fake';
  readonly domainId = 'local';
  /** When true, envelope submission fails with a retryable error (network outage simulation). */
  offline = false;
  readonly revokedDevices = new Set<string>();
  readonly submitted: SecureEnvelope[] = [];
  private readonly queues = new Map<string, SecureEnvelope[]>();
  private readonly sockets = new Map<string, FakeSocket>();
  private tokenCounter = 0;
  private readonly accessTokens = new Map<string, string>(); // token → deviceId
  private readonly refreshTokens = new Map<string, string>();

  issueCredentials(deviceId: string): { accessToken: string; refreshToken: string } {
    const accessToken = `access-${deviceId}-${this.tokenCounter++}`;
    const refreshToken = `refresh-${deviceId}-${this.tokenCounter++}`;
    this.accessTokens.set(accessToken, deviceId);
    this.refreshTokens.set(refreshToken, deviceId);
    return { accessToken, refreshToken };
  }

  /** Simulate the app killing its WS mid-session. */
  killSockets(): void {
    for (const socket of [...this.sockets.values()]) socket.serverClose();
  }

  /** Redeliver an already-delivered envelope (replay attack simulation). */
  redeliver(envelope: SecureEnvelope): void {
    this.enqueue(envelope);
  }

  readonly fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v2/relay/envelopes') {
      if (this.offline) {
        return jsonResponse(503, wireError('ISCPENV001', 'relay unavailable', true));
      }
      const auth = init?.headers?.Authorization ?? '';
      const token = auth.replace(/^Bearer /, '');
      const deviceId = this.accessTokens.get(token);
      if (deviceId === undefined) {
        return jsonResponse(401, wireError('ISCPACCESS001', 'access credential invalid'));
      }
      if (this.revokedDevices.has(deviceId)) {
        return jsonResponse(401, wireError('ISCPACCESS001', 'access revoked'));
      }
      const envelope = JSON.parse(init?.body ?? '') as SecureEnvelope;
      if (envelope.sender_device_id !== deviceId) {
        return jsonResponse(403, wireError('ISCPACCESS001', 'access credential does not match envelope sender'));
      }
      this.submitted.push(envelope);
      this.enqueue(envelope);
      return jsonResponse(202, {
        type: 'iscp.delivery_receipt.v2',
        receipt_id: `receipt-${envelope.message_id}`,
        message_id: envelope.message_id,
        domain_id: envelope.domain_id,
        relay_id: this.relayId,
        status: 'queued',
        issued_at: new Date().toISOString(),
      });
    }
    if (path === '/v2/relay/devices/refresh-access') {
      const { refresh } = JSON.parse(init?.body ?? '') as { refresh: string };
      const deviceId = this.refreshTokens.get(refresh);
      if (deviceId === undefined || this.revokedDevices.has(deviceId)) {
        return jsonResponse(401, wireError('ISCPACCESS001', 'refresh credential invalid'));
      }
      this.refreshTokens.delete(refresh);
      const pair = this.issueCredentials(deviceId);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      return jsonResponse(200, {
        access: { domain_id: this.domainId, device_id: deviceId, token: pair.accessToken, expires_at: expiresAt },
        refresh: { domain_id: this.domainId, device_id: deviceId, token: pair.refreshToken, expires_at: expiresAt },
      });
    }
    return jsonResponse(404, wireError('ISCPACCESS001', `unhandled fake relay path ${path}`));
  };

  wsFactory: WebSocketFactory = () => {
    const socket = new FakeSocket(this);
    queueMicrotask(() => {
      socket.onopen?.({});
      socket.push({ state: 'challenge', challenge: `chal-${this.tokenCounter++}` });
    });
    return socket;
  };

  handleProof(socket: FakeSocket, deviceId: string): void {
    if (deviceId === '' || this.revokedDevices.has(deviceId)) {
      socket.push({ state: 'closed', error: 'access revoked or unknown' });
      socket.serverClose();
      return;
    }
    socket.authedDeviceId = deviceId;
    this.sockets.get(deviceId)?.serverClose();
    this.sockets.set(deviceId, socket);
    socket.push({ state: 'ready' });
    const queue = this.queues.get(deviceId) ?? [];
    this.queues.set(deviceId, []);
    for (const envelope of queue) {
      socket.push({ state: 'message', message_id: envelope.message_id, envelope });
    }
    socket.push({ state: 'drained', delivered: queue.length });
  }

  detach(socket: FakeSocket): void {
    if (socket.authedDeviceId !== null && this.sockets.get(socket.authedDeviceId) === socket) {
      this.sockets.delete(socket.authedDeviceId);
    }
  }

  private enqueue(envelope: SecureEnvelope): void {
    const recipient = envelope.recipient_device_id;
    const socket = this.sockets.get(recipient);
    if (socket && !socket.closed) {
      // Live push once a connection is READY (spec behavior).
      socket.push({ state: 'message', message_id: envelope.message_id, envelope });
      return;
    }
    const queue = this.queues.get(recipient) ?? [];
    queue.push(envelope);
    this.queues.set(recipient, queue);
  }
}
