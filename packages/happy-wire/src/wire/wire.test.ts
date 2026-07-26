import { describe, expect, it } from 'vitest';
import { HappyWireRequestSchema, HappyWireResponseSchema } from './request';
import { HappyWireEventSchema } from './event';
import { HappyWireErrorSchema, HappyWireRequestError } from './error';
import { decodeWireCursor, encodeWireCursor } from './cursor';
import {
  AGENT_CAPABILITY_PROTOCOL,
  AgentCapabilityManifestSchema,
  defaultAgentCapabilityManifest,
} from './capability';

describe('wire request/response envelopes', () => {
  it('round-trips a mutation request with idempotency key', () => {
    const request = {
      id: 'req-1',
      method: 'messages.send',
      params: { sessionId: 'session-1', text: 'hi' },
      idempotencyKey: 'local-42',
    };
    const parsed = HappyWireRequestSchema.parse(request);
    expect(parsed).toEqual(request);
  });

  it('accepts a read request without idempotency key', () => {
    expect(
      HappyWireRequestSchema.safeParse({
        id: 'req-2',
        method: 'sessions.list',
        params: {},
      }).success,
    ).toBe(true);
  });

  it('discriminates ok and error responses', () => {
    const ok = HappyWireResponseSchema.parse({ ok: true, id: 'req-1', result: [1, 2] });
    expect(ok.ok).toBe(true);

    const err = HappyWireResponseSchema.parse({
      ok: false,
      id: 'req-1',
      error: { code: 'unauthorized', message: 'grant revoked' },
    });
    expect(err.ok).toBe(false);
  });

  it('rejects a response with unknown error code', () => {
    expect(
      HappyWireResponseSchema.safeParse({
        ok: false,
        id: 'req-1',
        error: { code: 'weird', message: 'nope' },
      }).success,
    ).toBe(false);
  });
});

describe('wire events', () => {
  it('parses each event variant', () => {
    const variants = [
      { type: 'legacy-update', body: { anything: true } },
      { type: 'legacy-ephemeral', body: null },
      { type: 'session-event', sessionId: 's1', seq: 7, cursor: 'c', body: {} },
      { type: 'machine-event', machineId: 'm1', cursor: 'c', body: {} },
      { type: 'ephemeral', body: { activity: 'thinking' } },
    ];
    for (const variant of variants) {
      expect(HappyWireEventSchema.safeParse(variant).success).toBe(true);
    }
  });

  it('rejects a session event with negative seq', () => {
    expect(
      HappyWireEventSchema.safeParse({
        type: 'session-event',
        sessionId: 's1',
        seq: -1,
        cursor: 'c',
        body: {},
      }).success,
    ).toBe(false);
  });
});

describe('wire errors', () => {
  it('marks retryable and timeout as retryable', () => {
    expect(new HappyWireRequestError({ code: 'retryable', message: 'x' }).retryable).toBe(true);
    expect(new HappyWireRequestError({ code: 'timeout', message: 'x' }).retryable).toBe(true);
    expect(new HappyWireRequestError({ code: 'forbidden', message: 'x' }).retryable).toBe(false);
  });

  it('carries retryAfterMs through the schema', () => {
    const parsed = HappyWireErrorSchema.parse({ code: 'retryable', message: 'busy', retryAfterMs: 500 });
    expect(parsed.retryAfterMs).toBe(500);
  });
});

describe('wire cursors', () => {
  it('round-trips a cursor payload', () => {
    const payload = { scope: 'session:s1', seq: 41, epoch: 'epoch-a' };
    expect(decodeWireCursor(encodeWireCursor(payload))).toEqual(payload);
  });

  it('returns null for foreign or corrupted cursors', () => {
    expect(decodeWireCursor('not-a-cursor')).toBeNull();
    expect(decodeWireCursor('happy-cursor.v1:{broken')).toBeNull();
    expect(decodeWireCursor('happy-cursor.v1:{"scope":"s","seq":-2,"epoch":"e"}')).toBeNull();
  });
});

describe('agent capability manifest', () => {
  it('validates the default manifest', () => {
    expect(AgentCapabilityManifestSchema.safeParse(defaultAgentCapabilityManifest()).success).toBe(true);
  });

  it('rejects a manifest missing the happy-wire protocol version', () => {
    const manifest = defaultAgentCapabilityManifest();
    expect(
      AgentCapabilityManifestSchema.safeParse({
        ...manifest,
        protocol_versions: [AGENT_CAPABILITY_PROTOCOL],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown capability ids', () => {
    const manifest = defaultAgentCapabilityManifest();
    expect(
      AgentCapabilityManifestSchema.safeParse({
        ...manifest,
        capabilities: [{ id: 'agent.telepathy', version: 1 }],
      }).success,
    ).toBe(false);
  });
});
