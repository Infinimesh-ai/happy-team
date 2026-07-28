import * as z from 'zod';
import { HappyWireErrorSchema } from './error';

/**
 * Request envelope for HappyTransport.request(). `method` is namespaced
 * (e.g. 'sessions.list', 'messages.send', 'session.rpc', 'machine.rpc').
 * The method catalog is intentionally NOT frozen here — transports own their
 * registries and reject unknown methods with code 'unsupported'. Only the
 * envelope shape is a compatibility contract.
 *
 * `idempotencyKey` is required by convention for every mutation; retries MUST
 * reuse the same key so the responder can dedupe. For message sends this is
 * the existing `localId` (see SessionMessageSchema), keeping legacy and ISCP
 * dedupe semantics identical.
 */
export const HappyWireRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
  idempotencyKey: z.string().optional(),
});
export type HappyWireRequest = z.infer<typeof HappyWireRequestSchema>;

/**
 * Response envelope used by transports that carry requests over a message
 * stream (ISCP). `id` echoes the request id for correlation. Legacy transport
 * answers in-band (HTTP/ack) and never serializes this envelope.
 */
export const HappyWireResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    id: z.string(),
    result: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    id: z.string(),
    error: HappyWireErrorSchema,
  }),
]);
export type HappyWireResponse = z.infer<typeof HappyWireResponseSchema>;
