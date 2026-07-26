import * as z from 'zod';
import { Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/trust_grant.v2.json

export const TRUST_GRANT_TYPE = 'iscp.trust_grant.v2';

/** Authorization from a Trust Root only — relay access is never trust (spec/protocol.md). */
export const TrustGrantSchema = z.strictObject({
  type: z.literal(TRUST_GRANT_TYPE),
  grant_id: z.string().min(1),
  issuer: z.string().min(1),
  subject_device_id: z.string().min(1),
  audience: z.string().min(1),
  confirmation_thumbprint: z.string().min(8),
  permissions: z.array(z.string()).min(1),
  relay_constraints: z.array(z.string()).optional(),
  not_before: Rfc3339Schema,
  expires_at: Rfc3339Schema,
  revocation_epoch: z.number().int().min(0),
  signature: SignatureSchema,
});
export type TrustGrant = z.infer<typeof TrustGrantSchema>;
