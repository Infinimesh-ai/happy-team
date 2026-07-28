import * as z from 'zod';
import { JsonObjectSchema, Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/provisioning.bundle.v2.json

export const PROVISIONING_BUNDLE_TYPE = 'iscp.provisioning.bundle.v2';

/** Signed bundle bound to the enrolled device id and public key thumbprint. */
export const ProvisioningBundleSchema = z.strictObject({
  type: z.literal(PROVISIONING_BUNDLE_TYPE),
  bundle_id: z.string().min(1),
  issued_to_device_id: z.string().min(1),
  issued_to_public_key_thumbprint: z.string().min(8),
  relay_descriptor: JsonObjectSchema,
  trust_root_descriptor: JsonObjectSchema,
  access_credential: JsonObjectSchema,
  refresh_credential_wrapped: z.string(), // base64url
  trust_grant: JsonObjectSchema,
  issued_at: Rfc3339Schema,
  expires_at: Rfc3339Schema,
  signature: SignatureSchema,
});
export type ProvisioningBundle = z.infer<typeof ProvisioningBundleSchema>;
