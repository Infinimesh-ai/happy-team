import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from './conformance/vectors';
import { createNobleProvider } from './crypto/noble';
import { type DeviceIdentity, type TrustGrant } from './schemas';
import { verifyGrant, grantSigningKey } from './trustRoot';
import { identityThumbprint } from './identity';

const provider = createNobleProvider();

interface TrustVectors {
  meta: VectorMeta;
  issuer: { seed_hex: string; identity: DeviceIdentity };
  subject: { seed_hex: string; identity: DeviceIdentity };
  grant: TrustGrant;
  verify_at: string;
}

const vectors = loadVectors<TrustVectors>('trust_grant.json');
const verifyAt = new Date(vectors.verify_at);
const issuerKey = vectors.issuer.identity.public_key.public;

function baseOpts() {
  return {
    audience: 'happy-domain',
    subjectDeviceId: vectors.subject.identity.device_id,
    confirmationThumbprint: identityThumbprint(provider, vectors.subject.identity),
    permission: 'text',
    relayId: 'relay-local',
    currentRevocationEpoch: 0,
    now: verifyAt,
  };
}

describe('trust grant conformance (Go reference vectors)', () => {
  it('verifies the Go-signed grant', () => {
    verifyGrant(provider, vectors.grant, issuerKey, baseOpts());
  });

  it('NEG-013: rejects audience mismatch', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), audience: 'evil-domain' })).toThrowError(/audience mismatch/);
  });

  it('NEG-014: rejects confirmation thumbprint mismatch', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), confirmationThumbprint: 'AAAAAAAAAAAA' })).toThrowError(/confirmation mismatch/);
  });

  it('NEG-012: rejects a grant behind the current revocation epoch', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), currentRevocationEpoch: 1 })).toThrowError(/revoked/);
  });

  it('rejects permission not present in the grant', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), permission: 'audio.frame' })).toThrowError(/permission denied/);
  });

  it('rejects relay constraint mismatch', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), relayId: 'other-relay' })).toThrowError(/relay constraint/);
  });

  it('rejects expiry and not-before violations', () => {
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), now: new Date('2027-01-01T00:00:00Z') })).toThrowError(/not currently valid/);
    expect(() => verifyGrant(provider, vectors.grant, issuerKey, { ...baseOpts(), now: new Date('2020-01-01T00:00:00Z') })).toThrowError(/not currently valid/);
  });

  it('rejects a tampered grant (signature covers permissions)', () => {
    const tampered = { ...vectors.grant, permissions: [...vectors.grant.permissions, 'admin'] };
    expect(() => verifyGrant(provider, tampered, issuerKey, { ...baseOpts(), permission: 'admin' })).toThrowError(/signature verification failed/);
  });

  it('grantSigningKey rejects revoked and next keys', () => {
    const descriptor = {
      type: 'iscp.trust_root.descriptor.v2' as const,
      trust_root_id: 'trust-local',
      domain_id: 'local',
      base_url: 'http://localhost:8081',
      keys: [
        { kty: 'Ed25519' as const, use: 'grant-signature' as const, kid: 'k-active', public: issuerKey, state: 'active' as const },
        { kty: 'Ed25519' as const, use: 'grant-signature' as const, kid: 'k-revoked', public: issuerKey, state: 'revoked' as const },
        { kty: 'Ed25519' as const, use: 'grant-signature' as const, kid: 'k-next', public: issuerKey, state: 'next' as const },
      ],
      issued_at: '2026-01-02T03:04:05Z',
      expires_at: '2026-01-03T03:04:05Z',
    };
    expect(grantSigningKey(descriptor, 'k-active')).toBe(issuerKey);
    expect(() => grantSigningKey(descriptor, 'k-revoked')).toThrowError(/unknown or not active/);
    expect(() => grantSigningKey(descriptor, 'k-next')).toThrowError(/unknown or not active/);
  });
});
