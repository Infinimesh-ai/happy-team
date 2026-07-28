import * as z from 'zod';
import { Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/device.proof.v2.json

export const DEVICE_PROOF_TYPE = 'iscp.device.proof.v2';

export const DeviceProofSchema = z.strictObject({
  type: z.literal(DEVICE_PROOF_TYPE),
  domain_id: z.string().min(1),
  device_id: z.string().min(1),
  audience: z.string().min(1),
  challenge: z.string().min(8),
  nonce: z.string().min(8),
  issued_at: Rfc3339Schema,
  signature: SignatureSchema,
});
export type DeviceProof = z.infer<typeof DeviceProofSchema>;
