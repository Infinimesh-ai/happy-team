import * as z from 'zod';
import { Rfc3339Schema } from './common';

// $id: https://schemas.iscp.dev/json/relay.descriptor.v2.json

export const RELAY_DESCRIPTOR_TYPE = 'iscp.relay.descriptor.v2';

export const RelaySigningKeySchema = z.strictObject({
  kty: z.literal('Ed25519'),
  use: z.enum(['descriptor-signature', 'access-signature']),
  kid: z.string(),
  public: z.string(), // base64url
});
export type RelaySigningKey = z.infer<typeof RelaySigningKeySchema>;

export const RelayDescriptorSchema = z.strictObject({
  type: z.literal(RELAY_DESCRIPTOR_TYPE),
  relay_id: z.string().min(1),
  domain_id: z.string().min(1),
  base_url: z.url(),
  websocket_url: z.url(),
  signing_keys: z.array(RelaySigningKeySchema).min(1),
  issued_at: Rfc3339Schema,
  expires_at: Rfc3339Schema,
  metadata: z.record(z.string(), z.string()).optional(),
});
export type RelayDescriptor = z.infer<typeof RelayDescriptorSchema>;
