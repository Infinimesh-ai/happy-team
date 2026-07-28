import * as z from 'zod';

/**
 * Shared $defs mirrored from the pinned ISCP JSON schemas. All ISCP v2
 * objects are strict: unknown fields are rejected (spec/canonical-jcs-v2.md).
 */

/** RFC3339 timestamp. Spec canonical form is seconds precision UTC; the Go reference services emit nanosecond precision, so any precision is accepted on parse. */
export const Rfc3339Schema = z.iso.datetime();

/** Mirrors the `signature` $def shared by every signed schema. */
export const SignatureSchema = z.strictObject({
  alg: z.literal('Ed25519'),
  kid: z.string(),
  value: z.string(), // base64url
});
export type IscpSignature = z.infer<typeof SignatureSchema>;

/** An arbitrary JSON object (schema `{ "type": "object" }`). */
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;
