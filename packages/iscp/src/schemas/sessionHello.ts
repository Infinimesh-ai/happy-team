import * as z from 'zod';
import { CIPHERSUITE_V2 } from '../crypto/provider';
import { Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/session.hello.v2.json

export const SESSION_HELLO_TYPE = 'iscp.session.hello.v2';

export const SessionHelloSchema = z.strictObject({
  type: z.literal(SESSION_HELLO_TYPE),
  session_id: z.string().min(1),
  domain_id: z.string().min(1),
  device_id: z.string().min(1),
  peer_device_id: z.string().min(1),
  ciphersuite: z.literal(CIPHERSUITE_V2),
  ephemeral_public_key: z.string(), // base64url X25519
  grant_id: z.string().min(1),
  issued_at: Rfc3339Schema,
  signature: SignatureSchema,
});
export type SessionHello = z.infer<typeof SessionHelloSchema>;
