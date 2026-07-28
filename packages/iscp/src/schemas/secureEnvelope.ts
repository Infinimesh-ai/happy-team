import * as z from 'zod';

// $id: https://schemas.iscp.dev/json/secure_envelope.v2.json

export const SECURE_ENVELOPE_TYPE = 'iscp.secure_envelope.v2';

export const EnvelopeRouteSchema = z.strictObject({
  relay_id: z.string().min(1),
  ttl_seconds: z.number().int().min(1),
  priority: z.number().int().min(0).max(9),
});
export type EnvelopeRoute = z.infer<typeof EnvelopeRouteSchema>;

/** AEAD-protected payload; AAD binds every field except `ciphertext` (spec/envelope.md). */
export const SecureEnvelopeSchema = z.strictObject({
  type: z.literal(SECURE_ENVELOPE_TYPE),
  domain_id: z.string().min(1),
  message_id: z.string().min(1),
  session_id: z.string().min(1),
  sender_device_id: z.string().min(1),
  recipient_device_id: z.string().min(1),
  sequence: z.number().int().min(0),
  nonce: z.string(), // base64url
  payload_type: z.string().min(1),
  route: EnvelopeRouteSchema,
  ciphertext: z.string(), // base64url
});
export type SecureEnvelope = z.infer<typeof SecureEnvelopeSchema>;
