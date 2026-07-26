import * as z from 'zod';

/**
 * Wire cursors are opaque strings to every consumer except the transport that
 * minted them. The structured form below is the ISCP implementation's encoding;
 * legacy transports may keep using raw seq numbers internally and never mint
 * these. `epoch` guards against event-log resets on the daemon: a cursor whose
 * epoch does not match the current log epoch must be treated as invalid and the
 * consumer must re-sync from scratch instead of resuming.
 */
export const WireCursorPayloadSchema = z.object({
  scope: z.string(),
  seq: z.number().int().nonnegative(),
  epoch: z.string(),
});
export type WireCursorPayload = z.infer<typeof WireCursorPayloadSchema>;

const CURSOR_PREFIX = 'happy-cursor.v1:';

export function encodeWireCursor(payload: WireCursorPayload): string {
  return CURSOR_PREFIX + JSON.stringify(WireCursorPayloadSchema.parse(payload));
}

/**
 * Returns null for anything that is not a valid v1 cursor (foreign prefixes,
 * truncated JSON, schema mismatch). Callers treat null as "resume impossible,
 * full re-sync required" — never as an error to surface.
 */
export function decodeWireCursor(cursor: string): WireCursorPayload | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(cursor.slice(CURSOR_PREFIX.length));
    const result = WireCursorPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
