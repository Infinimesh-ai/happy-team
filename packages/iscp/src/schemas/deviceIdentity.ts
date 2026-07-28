import * as z from 'zod';
import { Rfc3339Schema } from './common';

// $id: https://schemas.iscp.dev/json/device.identity.v2.json

export const DEVICE_IDENTITY_TYPE = 'iscp.device.identity.v2';

export const DeviceIdentityPublicKeySchema = z.strictObject({
  kty: z.literal('Ed25519'),
  use: z.literal('identity-signature'),
  kid: z.string().min(1),
  public: z.string(), // base64url
});
export type DeviceIdentityPublicKey = z.infer<typeof DeviceIdentityPublicKeySchema>;

export const DeviceIdentitySchema = z.strictObject({
  type: z.literal(DEVICE_IDENTITY_TYPE),
  domain_id: z.string().min(1),
  device_id: z.string().min(1),
  public_key: DeviceIdentityPublicKeySchema,
  created_at: Rfc3339Schema,
  metadata: z.record(z.string(), z.string()).optional(),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;
