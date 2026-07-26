import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from './conformance/vectors';
import { toHex } from './encoding';
import { IscpError } from './errors';
import { canonicalJson, canonicalizeAny, compareCodePoints, escapeGoString, parseStrict, rejectUnknownTopLevel, signatureInput } from './jcs';

interface JcsVectors {
  meta: VectorMeta;
  canonical: Array<{ name: string; input: string; canonical: string }>;
  rejected: Array<{ name: string; input: string }>;
  signature_inputs: Array<{ name: string; object_type: string; input: string; signature_input_hex: string }>;
}

const vectors = loadVectors<JcsVectors>('jcs.json');

describe('canonical JSON conformance (Go reference vectors)', () => {
  it('records the pinned upstream commit', () => {
    expect(vectors.meta.pin).toMatch(/^[0-9a-f]{40}$/);
  });

  for (const c of vectors.canonical) {
    it(`canonicalizes ${c.name} byte-identically to Go`, () => {
      expect(canonicalJson(c.input)).toBe(c.canonical);
      // Canonical output is a fixed point.
      expect(canonicalJson(c.canonical)).toBe(c.canonical);
    });
  }

  for (const c of vectors.rejected) {
    it(`rejects ${c.name} like Go`, () => {
      expect(() => canonicalJson(c.input)).toThrowError(IscpError);
      expect(() => canonicalJson(c.input)).toThrowError(/ISCPCAN001/);
    });
  }

  for (const c of vectors.signature_inputs) {
    it(`builds signature input for ${c.name} byte-identically to Go`, () => {
      expect(toHex(signatureInput(c.object_type, c.input))).toBe(c.signature_input_hex);
    });
  }
});

describe('parseStrict', () => {
  it('parses integers as bigint within int64', () => {
    expect(parseStrict('9223372036854775807')).toBe(9223372036854775807n);
    expect(parseStrict('-9223372036854775808')).toBe(-9223372036854775808n);
  });

  it('rejects unescaped control characters', () => {
    expect(() => parseStrict('{"s":"ab"}')).toThrowError(/ISCPCAN001/);
  });

  it('rejects unknown top-level fields via rejectUnknownTopLevel', () => {
    const allowed = new Set(['type', 'a']);
    expect(() => rejectUnknownTopLevel('{"type":"x","a":1}', allowed)).not.toThrow();
    expect(() => rejectUnknownTopLevel('{"type":"x","evil":1}', allowed)).toThrowError(/unknown top-level field/);
  });
});

describe('escapeGoString', () => {
  it('escapes HTML characters like Go encoding/json', () => {
    expect(escapeGoString('<a>&b')).toBe('"\\u003ca\\u003e\\u0026b"');
  });

  it('escapes U+2028/U+2029 and control characters', () => {
    expect(escapeGoString('a b c')).toBe('"a\\u2028b\\u2029c"');
    expect(escapeGoString('\n\t\r')).toBe('"\\u0001\\n\\t\\r"');
  });

  it('replaces lone surrogates with U+FFFD escapes (invalid UTF-8 in Go)', () => {
    expect(escapeGoString('a\ud800b')).toBe('"a\\ufffdb"');
    expect(escapeGoString('ok 🎉')).toBe('"ok 🎉"');
  });
});

describe('compareCodePoints', () => {
  it('orders astral characters after U+FFFD (UTF-8 byte order, not UTF-16)', () => {
    // In UTF-16 code-unit order the surrogate pair would sort first.
    expect(compareCodePoints('�', '\u{1f389}')).toBeLessThan(0);
    expect('�' < '\u{1f389}').toBe(false); // JS default order disagrees — that's the point
  });
});

describe('canonicalizeAny', () => {
  it('rejects floats produced by in-memory objects', () => {
    expect(() => canonicalizeAny({ a: 1.5 })).toThrowError(/ISCPCAN001/);
  });

  it('sorts keys of in-memory objects', () => {
    expect(canonicalizeAny({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });
});
