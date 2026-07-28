import * as z from 'zod';
import { JsonObjectSchema, Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/signed_descriptor.v2.json

export const SIGNED_DESCRIPTOR_TYPE = 'iscp.signed_descriptor.v2';

export const SignedDescriptorSchema = z.strictObject({
  type: z.literal(SIGNED_DESCRIPTOR_TYPE),
  descriptor_type: z.enum(['iscp.relay.descriptor.v2', 'iscp.trust_root.descriptor.v2']),
  descriptor: JsonObjectSchema,
  signed_by: z.string().min(1),
  signed_at: Rfc3339Schema,
  signature: SignatureSchema,
});
export type SignedDescriptor = z.infer<typeof SignedDescriptorSchema>;
