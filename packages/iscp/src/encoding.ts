/** Byte/string encoding helpers shared across the package (Node + React Native/Hermes safe). */

import { IscpErrorCodes, iscpError } from './errors';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64URL_ALPHABET.length; i++) B64URL_LOOKUP[B64URL_ALPHABET[i]] = i;

/** Unpadded base64url, matching Go base64.RawURLEncoding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63] + B64URL_ALPHABET[(n >> 6) & 63] + B64URL_ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63] + B64URL_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) {
    throw iscpError(IscpErrorCodes.CanonicalInvalid, 'invalid base64url length');
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let accBits = 0;
  let pos = 0;
  for (const ch of text) {
    const v = B64URL_LOOKUP[ch];
    if (v === undefined) throw iscpError(IscpErrorCodes.CanonicalInvalid, 'invalid base64url character');
    acc = (acc << 6) | v;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[pos++] = (acc >> accBits) & 0xff;
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw iscpError(IscpErrorCodes.CanonicalInvalid, 'invalid hex length');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw iscpError(IscpErrorCodes.CanonicalInvalid, 'invalid hex character');
    out[i] = byte;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** RFC3339 UTC with seconds precision, as ISCP v2 canonical timestamps require. */
export function rfc3339Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Lenient RFC3339 parse (reference services emit nanosecond precision). */
export function parseRfc3339(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw iscpError(IscpErrorCodes.SchemaInvalid, 'invalid RFC3339 timestamp');
  }
  return date;
}
