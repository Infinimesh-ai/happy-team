/**
 * ISCP v2 canonical JSON (spec/canonical-jcs-v2.md), byte-compatible with the
 * pinned Go reference implementation (pkg/iscp/canonical/canonical.go):
 *
 * - strict parse: duplicate keys, floats/exponents, integers outside int64,
 *   leading-zero and `-0`-prefixed integers, and trailing input are rejected;
 * - object members ordered lexicographically by Unicode code point;
 * - strings escaped exactly like Go `encoding/json` (HTML escaping on:
 *   `<`, `>`, `&` → </>/&; U+2028/U+2029 escaped; control
 *   characters as \u00xx except \n, \r, \t; invalid UTF-16 → �);
 * - bytes are unpadded base64url strings, timestamps RFC3339 UTC seconds;
 * - deterministic signature input: ISCP-V2-SIGNATURE\0<type>\0<canonical>.
 */

import { utf8Encode } from './encoding';
import { IscpErrorCodes, iscpError } from './errors';

export type CanonicalValue =
  | null
  | boolean
  | string
  | bigint
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export const SIGNATURE_CONTEXT_PREFIX = 'ISCP-V2-SIGNATURE\0';

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

function fail(message: string): never {
  throw iscpError(IscpErrorCodes.CanonicalInvalid, message);
}

// ---------------------------------------------------------------------------
// Strict parser
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): CanonicalValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.pos !== this.text.length) fail('unexpected trailing json value');
    return value;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.pos++;
      else break;
    }
  }

  private parseValue(): CanonicalValue {
    this.skipWhitespace();
    if (this.pos >= this.text.length) fail('unexpected end of json input');
    const c = this.text[this.pos];
    switch (c) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        this.expectLiteral('true');
        return true;
      case 'f':
        this.expectLiteral('false');
        return false;
      case 'n':
        this.expectLiteral('null');
        return null;
      default:
        if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
        fail(`unexpected character ${JSON.stringify(c)} in json input`);
    }
  }

  private expectLiteral(literal: string): void {
    if (this.text.slice(this.pos, this.pos + literal.length) !== literal) {
      fail(`invalid literal in json input`);
    }
    this.pos += literal.length;
  }

  private parseObject(): { [key: string]: CanonicalValue } {
    this.pos++; // '{'
    const out: { [key: string]: CanonicalValue } = Object.create(null);
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') fail('object key must be a string');
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`duplicate object field ${JSON.stringify(key)}`);
      this.skipWhitespace();
      if (this.text[this.pos] !== ':') fail('expected ":" in object');
      this.pos++;
      out[key] = this.parseValue();
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === '}') {
        this.pos++;
        return out;
      }
      fail('object not closed');
    }
  }

  private parseArray(): CanonicalValue[] {
    this.pos++; // '['
    const out: CanonicalValue[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWhitespace();
      const c = this.text[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ']') {
        this.pos++;
        return out;
      }
      fail('array not closed');
    }
  }

  private parseString(): string {
    this.pos++; // '"'
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) fail('unterminated string');
      const c = this.text[this.pos];
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        this.pos++;
        const e = this.text[this.pos];
        this.pos++;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape');
            this.pos += 4;
            out += String.fromCharCode(Number.parseInt(hex, 16));
            break;
          }
          default:
            fail('invalid escape character');
        }
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) fail('unescaped control character in string');
      out += c;
      this.pos++;
    }
  }

  private parseNumber(): bigint {
    const start = this.pos;
    if (this.text[this.pos] === '-') this.pos++;
    if (this.pos >= this.text.length) fail('invalid number');
    const first = this.text[this.pos];
    if (first < '0' || first > '9') fail('invalid number');
    if (first === '0') {
      this.pos++;
      // JSON forbids further digits after a leading zero.
      const next = this.text[this.pos];
      if (next !== undefined && next >= '0' && next <= '9') fail('leading zero integer is not allowed');
    } else {
      while (this.pos < this.text.length && this.text[this.pos] >= '0' && this.text[this.pos] <= '9') this.pos++;
    }
    const next = this.text[this.pos];
    if (next === '.' || next === 'e' || next === 'E') fail('float values are not allowed');
    const raw = this.text.slice(start, this.pos);
    if (raw.startsWith('-0')) fail('negative leading zero integer is not allowed');
    const value = BigInt(raw);
    if (value < INT64_MIN || value > INT64_MAX) fail('integer exceeds int64 range');
    return value;
  }
}

/** Parse JSON with ISCP v2 strictness. Numbers are returned as bigint. */
export function parseStrict(text: string): CanonicalValue {
  return new Parser(text).parse();
}

// ---------------------------------------------------------------------------
// Canonical emitter
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

/** Escape a string exactly like Go encoding/json (escapeHTML=true), with quotes. */
export function escapeGoString(input: string): string {
  let out = '"';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code !== 0x22 && code !== 0x5c && code !== 0x3c && code !== 0x3e && code !== 0x26) {
      if (code === 0x2028 || code === 0x2029) {
        out += code === 0x2028 ? '\\u2028' : '\\u2029';
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // Surrogate handling: a well-formed pair passes through literally
        // (Go emits the UTF-8 bytes); a lone surrogate is invalid UTF-8 and
        // Go emits the � escape sequence.
        if (code <= 0xdbff && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            out += input[i] + input[i + 1];
            i++;
            continue;
          }
        }
        out += '\\ufffd';
        continue;
      }
      out += input[i];
      continue;
    }
    switch (code) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      case 0x3c: out += '\\u003c'; break;
      case 0x3e: out += '\\u003e'; break;
      case 0x26: out += '\\u0026'; break;
      default:
        out += '\\u00' + HEX[(code >> 4) & 0xf] + HEX[code & 0xf];
    }
  }
  return out + '"';
}

/** Compare strings by Unicode code point (equivalent to UTF-8 byte order used by Go sort.Strings). */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const ra = a.length - i;
  const rb = b.length - j;
  return ra === rb ? 0 : ra < rb ? -1 : 1;
}

function writeCanonical(value: CanonicalValue, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'string':
      out.push(escapeGoString(value));
      return;
    case 'bigint':
      out.push(value.toString(10));
      return;
    case 'number':
      // Defensive: canonical trees produced by parseStrict never contain
      // JS numbers, but trees built by hand might.
      if (!Number.isSafeInteger(value)) fail('float values are not allowed');
      out.push(String(value));
      return;
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(',');
          writeCanonical(value[i], out);
        }
        out.push(']');
        return;
      }
      const keys = Object.keys(value).sort(compareCodePoints);
      out.push('{');
      for (let i = 0; i < keys.length; i++) {
        if (i > 0) out.push(',');
        out.push(escapeGoString(keys[i]), ':');
        writeCanonical((value as { [key: string]: CanonicalValue })[keys[i]], out);
      }
      out.push('}');
      return;
    }
    default:
      fail(`unsupported canonical type ${typeof value}`);
  }
}

/** Serialize a canonical value tree to canonical JSON text. */
export function canonicalize(value: CanonicalValue): string {
  const out: string[] = [];
  writeCanonical(value, out);
  return out.join('');
}

/** Equivalent to Go canonical.Marshal: strict parse then canonical emit. */
export function canonicalJson(text: string): string {
  return canonicalize(parseStrict(text));
}

/**
 * Canonicalize an arbitrary in-memory value (object built by this package).
 * Round-trips through JSON.stringify so floats and unsupported types are
 * rejected with the same strictness Go applies.
 */
export function canonicalizeAny(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) fail('value is not representable as json');
  return canonicalJson(text);
}

// ---------------------------------------------------------------------------
// Signature input
// ---------------------------------------------------------------------------

/**
 * Deterministic signature input: ISCP-V2-SIGNATURE\0<object_type>\0<canonical>.
 * The `signature` field is removed from the top-level object before
 * canonicalization; input must be a JSON object.
 */
export function signatureInput(objectType: string, object: unknown): Uint8Array {
  const text = typeof object === 'string' ? object : JSON.stringify(object);
  if (text === undefined) fail('signed object is not representable as json');
  const value = parseStrict(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('signed object must be a json object');
  }
  const clone: { [key: string]: CanonicalValue } = Object.create(null);
  for (const key of Object.keys(value)) {
    if (key === 'signature') continue;
    clone[key] = (value as { [key: string]: CanonicalValue })[key];
  }
  const canonical = canonicalize(clone);
  return utf8Encode(SIGNATURE_CONTEXT_PREFIX + objectType + '\0' + canonical);
}

/** Reject unknown top-level fields (schema strictness aid for raw JSON text). */
export function rejectUnknownTopLevel(text: string, allowed: ReadonlySet<string>): void {
  const value = parseStrict(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('top-level value must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown top-level field: ${key}`);
  }
}
