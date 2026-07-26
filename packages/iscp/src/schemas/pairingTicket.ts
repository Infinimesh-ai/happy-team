import * as z from 'zod';
import { Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/pairing_ticket.v2.json

export const PAIRING_TICKET_TYPE = 'iscp.pairing_ticket.v2';

/** Short TTL, limited use, signed by issuer (spec/provisioning.md). */
export const PairingTicketSchema = z.strictObject({
  type: z.literal(PAIRING_TICKET_TYPE),
  ticket_id: z.string().min(1),
  domain_id: z.string().min(1),
  relay_id: z.string().min(1),
  trust_root_id: z.string().min(1),
  max_uses: z.number().int().min(1),
  issued_at: Rfc3339Schema,
  expires_at: Rfc3339Schema,
  signature: SignatureSchema,
});
export type PairingTicket = z.infer<typeof PairingTicketSchema>;
