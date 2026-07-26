import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from '../conformance/vectors';
import { createNobleProvider } from '../crypto/noble';
import { accessProofChallenge } from './http';

interface AccessProofVectors {
  meta: VectorMeta;
  cases: Array<{ name: string; method: string; path: string; token: string; challenge: string }>;
}

const provider = createNobleProvider();
const vectors = loadVectors<AccessProofVectors>('access_proof.json');

describe('X-ISCP-Access-Proof challenge conformance', () => {
  for (const c of vectors.cases) {
    it(`builds the ${c.name} challenge byte-identically to the Go relay`, () => {
      expect(accessProofChallenge(provider, c.method, c.path, c.token)).toBe(c.challenge);
    });
  }

  it('uppercases the method like the Go relay', () => {
    const reference = vectors.cases[0];
    expect(accessProofChallenge(provider, 'post', reference.path, reference.token)).toBe(reference.challenge);
  });
});
