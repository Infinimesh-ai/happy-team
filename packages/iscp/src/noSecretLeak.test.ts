/**
 * Security-baseline backstop (spec/security-baseline.md "Logging and
 * Output"): this package must never print key material. Two layers:
 *
 * 1. grep-style: no console output calls exist anywhere in runtime sources —
 *    the package communicates only through return values, thrown IscpErrors,
 *    and injected callbacks;
 * 2. behavioral: IscpError wire forms never carry key bytes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createNobleProvider } from './crypto/noble';
import { IscpError, IscpErrorCodes, iscpError } from './errors';
import { toHex } from './encoding';

const SRC_ROOT = new URL('.', import.meta.url).pathname;

function runtimeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'testing' || entry === 'integration' || entry === 'conformance') continue;
      out.push(...runtimeSources(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.bench.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('no secret leakage', () => {
  it('runtime sources contain no console output calls', () => {
    const offenders: string[] = [];
    for (const file of runtimeSources(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      if (/console\.(log|info|warn|error|debug|trace)/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime sources never JSON.stringify private key objects', () => {
    // Private keys only exist as branded classes; ensure no source
    // serializes `privateKey`/`sendKey`/`receiveKey` fields into strings.
    const pattern = /JSON\.stringify\([^)]*(privateKey|sendKey|receiveKey|readyKey|\.key\b)/;
    const offenders: string[] = [];
    for (const file of runtimeSources(SRC_ROOT)) {
      if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('AEAD failures never echo key material in the error', () => {
    const provider = createNobleProvider();
    const key = provider.randomBytes(32);
    const nonce = provider.randomBytes(12);
    try {
      provider.open(key, nonce, provider.randomBytes(32), new Uint8Array(0));
      expect.unreachable('open must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(IscpError);
      const message = (error as IscpError).message + JSON.stringify((error as IscpError).toWire());
      expect(message).not.toContain(toHex(key));
      expect(message).not.toContain(Buffer.from(key).toString('base64'));
    }
  });

  it('IscpError wire form carries only declared fields', () => {
    const error = iscpError(IscpErrorCodes.EnvelopeInvalid, 'boom', { details: { hint: 'safe' } });
    expect(error.toWire()).toEqual({
      type: 'iscp.error.v2',
      code: 'ISCPENV001',
      message: 'boom',
      retryable: false,
      details: { hint: 'safe' },
    });
  });
});
