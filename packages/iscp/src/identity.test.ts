import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from './conformance/vectors';
import { createNobleProvider } from './crypto/noble';
import { Ed25519PrivateKey } from './crypto/provider';
import { fromHex, toBase64Url } from './encoding';
import { createDevice, createDeviceProof, deviceFromStored, identityThumbprint, keyThumbprint, verifyDeviceProof } from './identity';
import { DeviceIdentitySchema, DeviceProofSchema, type DeviceIdentity, type DeviceProof } from './schemas';

const provider = createNobleProvider();

interface ThumbprintVectors {
  meta: VectorMeta;
  cases: Array<{ name: string; key_type: string; public_hex: string; thumbprint: string }>;
}

interface IdentityVectors {
  meta: VectorMeta;
  seed_hex: string;
  identity: DeviceIdentity;
  thumbprint: string;
  proof: { audience: string; challenge: string; nonce: string; issued_at: string; object: DeviceProof };
}

describe('thumbprint conformance', () => {
  const vectors = loadVectors<ThumbprintVectors>('thumbprint.json');
  for (const c of vectors.cases) {
    it(`matches Go for ${c.name}`, () => {
      expect(keyThumbprint(provider, c.key_type, fromHex(c.public_hex))).toBe(c.thumbprint);
    });
  }
});

describe('device identity + proof conformance', () => {
  const vectors = loadVectors<IdentityVectors>('identity.json');
  const identity = DeviceIdentitySchema.parse(vectors.identity);
  const privateKey = new Ed25519PrivateKey(fromHex(vectors.seed_hex));

  it('derives the same public key and kid from the vector seed', () => {
    const pub = provider.ed25519PublicKey(privateKey);
    expect(toBase64Url(pub.bytes)).toBe(identity.public_key.public);
    expect(keyThumbprint(provider, 'Ed25519', pub.bytes)).toBe(identity.public_key.kid);
    expect(identityThumbprint(provider, identity)).toBe(vectors.thumbprint);
  });

  it('verifies the Go-produced proof', () => {
    const proof = DeviceProofSchema.parse(vectors.proof.object);
    verifyDeviceProof(provider, identity, proof, {
      audience: vectors.proof.audience,
      challenge: vectors.proof.challenge,
      now: new Date(vectors.proof.issued_at),
    });
  });

  it('reproduces the Go proof signature byte-for-byte (deterministic Ed25519)', () => {
    const device = deviceFromStored(provider, identity, privateKey);
    const proof = createDeviceProof(provider, device, {
      audience: vectors.proof.audience,
      challenge: vectors.proof.challenge,
      nonce: vectors.proof.nonce,
      now: new Date(vectors.proof.issued_at),
    });
    expect(proof).toEqual(vectors.proof.object);
  });

  it('rejects audience mismatch, tampering, and stale proofs', () => {
    const proof = DeviceProofSchema.parse(vectors.proof.object);
    const now = new Date(vectors.proof.issued_at);
    expect(() => verifyDeviceProof(provider, identity, proof, { audience: 'evil', challenge: vectors.proof.challenge, now })).toThrowError(/audience or challenge mismatch/);
    expect(() =>
      verifyDeviceProof(provider, identity, { ...proof, nonce: 'nonce-tampered-1' }, { audience: vectors.proof.audience, challenge: vectors.proof.challenge, now }),
    ).toThrowError(/signature verification failed/);
    expect(() =>
      verifyDeviceProof(provider, identity, proof, {
        audience: vectors.proof.audience,
        challenge: vectors.proof.challenge,
        now: new Date(now.getTime() + 6 * 60 * 1000),
      }),
    ).toThrowError(/time window/);
  });
});

describe('createDevice', () => {
  it('creates a schema-valid identity whose kid is the key thumbprint', () => {
    const device = createDevice(provider, { domainId: 'local', deviceId: 'unit-device' });
    const parsed = DeviceIdentitySchema.parse(device.identity);
    expect(parsed.public_key.kid).toBe(identityThumbprint(provider, parsed));
  });

  it('deviceFromStored rejects a mismatched private key', () => {
    const device = createDevice(provider, { domainId: 'local', deviceId: 'unit-device' });
    const other = createDevice(provider, { domainId: 'local', deviceId: 'other' });
    expect(() => deviceFromStored(provider, device.identity, other.privateKey)).toThrowError(/does not match/);
  });
});
