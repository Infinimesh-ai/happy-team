import * as z from 'zod';
import { Rfc3339Schema } from './common';

// $id: https://schemas.iscp.dev/json/trust_root.descriptor.v2.json

export const TRUST_ROOT_DESCRIPTOR_TYPE = 'iscp.trust_root.descriptor.v2';

export const TrustRootKeyStateSchema = z.enum(['next', 'active', 'retired', 'revoked']);
export type TrustRootKeyState = z.infer<typeof TrustRootKeyStateSchema>;

export const TrustRootKeySchema = z.strictObject({
  kty: z.literal('Ed25519'),
  use: z.enum(['descriptor-signature', 'grant-signature']),
  kid: z.string(),
  public: z.string(), // base64url
  state: TrustRootKeyStateSchema,
});
export type TrustRootKey = z.infer<typeof TrustRootKeySchema>;

export const TrustRootDescriptorSchema = z.strictObject({
  type: z.literal(TRUST_ROOT_DESCRIPTOR_TYPE),
  trust_root_id: z.string().min(1),
  domain_id: z.string().min(1),
  base_url: z.url(),
  keys: z.array(TrustRootKeySchema).min(1),
  issued_at: Rfc3339Schema,
  expires_at: Rfc3339Schema,
  metadata: z.record(z.string(), z.string()).optional(),
});
export type TrustRootDescriptor = z.infer<typeof TrustRootDescriptorSchema>;
