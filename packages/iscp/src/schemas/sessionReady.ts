import * as z from 'zod';
import { SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/session.ready.v2.json

export const SESSION_READY_TYPE = 'iscp.session.ready.v2';

export const SessionReadySchema = z.strictObject({
  type: z.literal(SESSION_READY_TYPE),
  session_id: z.string().min(1),
  device_id: z.string().min(1),
  transcript_hash: z.string(), // base64url
  ready_mac: z.string(), // base64url
  signature: SignatureSchema,
});
export type SessionReady = z.infer<typeof SessionReadySchema>;
