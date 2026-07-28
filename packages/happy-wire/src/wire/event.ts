import * as z from 'zod';

/**
 * Events yielded by HappyTransport.events().
 *
 * Two deliberate regimes (see docs/network-dual-stack/inventory.md):
 * - 'legacy-update' / 'legacy-ephemeral': opaque passthrough of the existing
 *   Socket.IO 'update' / 'ephemeral' payloads. Emitted only by the legacy
 *   transport; decrypted and validated by the existing sync ingestion path,
 *   byte-for-byte identical to today. Bodies are deliberately `unknown` here —
 *   the app keeps its richer ApiUpdateContainerSchema as the validator.
 * - 'session-event' / 'machine-event' / 'ephemeral': normalized happy-wire.v1
 *   events, emitted only by the ISCP transport. Cursor-bearing events resume
 *   via events(fromCursor); 'ephemeral' has no cursor and is lossy by design
 *   (activity/typing/thinking).
 */
export const LegacyUpdateEventSchema = z.object({
  type: z.literal('legacy-update'),
  body: z.unknown(),
});
export type LegacyUpdateEvent = z.infer<typeof LegacyUpdateEventSchema>;

export const LegacyEphemeralEventSchema = z.object({
  type: z.literal('legacy-ephemeral'),
  body: z.unknown(),
});
export type LegacyEphemeralEvent = z.infer<typeof LegacyEphemeralEventSchema>;

export const SessionWireEventSchema = z.object({
  type: z.literal('session-event'),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  cursor: z.string(),
  /** Idempotency key of the originating append (mirrors legacy localId), for optimistic-send reconciliation. */
  localId: z.string().optional(),
  body: z.unknown(),
});
export type SessionWireEvent = z.infer<typeof SessionWireEventSchema>;

export const MachineWireEventSchema = z.object({
  type: z.literal('machine-event'),
  machineId: z.string(),
  cursor: z.string(),
  body: z.unknown(),
});
export type MachineWireEvent = z.infer<typeof MachineWireEventSchema>;

export const EphemeralWireEventSchema = z.object({
  type: z.literal('ephemeral'),
  body: z.unknown(),
});
export type EphemeralWireEvent = z.infer<typeof EphemeralWireEventSchema>;

export const HappyWireEventSchema = z.discriminatedUnion('type', [
  LegacyUpdateEventSchema,
  LegacyEphemeralEventSchema,
  SessionWireEventSchema,
  MachineWireEventSchema,
  EphemeralWireEventSchema,
]);
export type HappyWireEvent = z.infer<typeof HappyWireEventSchema>;
