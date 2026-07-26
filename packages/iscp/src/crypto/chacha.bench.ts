/**
 * ChaCha20-Poly1305 throughput benchmark (pure-TS noble implementation).
 *
 * Purpose: an early signal for the Hermes/React Native performance risk
 * called out in the dual-stack plan. Run with `pnpm bench`. If sustained
 * throughput on target mobile hardware is too low for streaming payloads,
 * swap a native provider in behind crypto/provider.ts — no protocol code
 * changes required. (vitest bench runs on Node; treat Hermes as roughly an
 * order of magnitude slower and validate on-device in Phase 3.)
 */

import { bench, describe } from 'vitest';

import { createNobleProvider } from './noble';

const provider = createNobleProvider();
const key = provider.randomBytes(32);
const nonce = provider.randomBytes(12);
const aad = provider.randomBytes(128);

const sizes = [
  ['256B', 256],
  ['4KiB', 4 * 1024],
  ['64KiB', 64 * 1024],
  ['1MiB', 1024 * 1024],
] as const;

for (const [label, size] of sizes) {
  const plaintext = provider.randomBytes(size);
  const ciphertext = provider.seal(key, nonce, plaintext, aad);
  describe(`chacha20-poly1305 ${label}`, () => {
    bench('seal', () => {
      provider.seal(key, nonce, plaintext, aad);
    });
    bench('open', () => {
      provider.open(key, nonce, ciphertext, aad);
    });
  });
}
