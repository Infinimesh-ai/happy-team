import * as z from 'zod';
import { Rfc3339Schema, SignatureSchema } from './common';

// $id: https://schemas.iscp.dev/json/delivery_receipt.v2.json

export const DELIVERY_RECEIPT_TYPE = 'iscp.delivery_receipt.v2';

export const DeliveryReceiptStatusSchema = z.enum([
  'accepted',
  'queued',
  'delivered_to_connection',
  'expired',
  'rejected',
]);
export type DeliveryReceiptStatus = z.infer<typeof DeliveryReceiptStatusSchema>;

/** Relay receipt only — never an E2E application receipt (spec/relay.md). */
export const DeliveryReceiptSchema = z.strictObject({
  type: z.literal(DELIVERY_RECEIPT_TYPE),
  receipt_id: z.string().min(1),
  message_id: z.string().min(1),
  domain_id: z.string().min(1),
  relay_id: z.string().min(1),
  status: DeliveryReceiptStatusSchema,
  issued_at: Rfc3339Schema,
  signature: SignatureSchema.optional(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;
