/**
 * Device identity and Device Proof (spec/identity.md).
 *
 * Long-term Ed25519 private keys are generated and held only on the device;
 * nothing in this module serializes private key material except through an
 * explicitly injected CredentialStore (storage.ts).
 */

import { concatBytes, fromBase64Url, parseRfc3339, rfc3339Seconds, toBase64Url, utf8Encode } from './encoding';
import { IscpErrorCodes, iscpError } from './errors';
import { signObject, verifyObjectSignature } from './signing';
import type { CryptoProvider, Ed25519PrivateKey } from './crypto/provider';
import { DEVICE_IDENTITY_TYPE, DEVICE_PROOF_TYPE, DeviceIdentitySchema, type DeviceIdentity, type DeviceProof } from './schemas';

/** thumbprint = base64url(SHA-256("iscp/v2/thumbprint/<kty>\0" || public_bytes)) — binds key type and bytes. */
export function keyThumbprint(provider: CryptoProvider, keyType: string, publicBytes: Uint8Array): string {
  const input = concatBytes(utf8Encode(`iscp/v2/thumbprint/${keyType}\0`), publicBytes);
  return toBase64Url(provider.sha256(input));
}

export function identityThumbprint(provider: CryptoProvider, identity: DeviceIdentity): string {
  return keyThumbprint(provider, identity.public_key.kty, fromBase64Url(identity.public_key.public));
}

export interface Device {
  identity: DeviceIdentity;
  privateKey: Ed25519PrivateKey;
}

/** Generate a new device identity locally. The private key never leaves the returned handle. */
export function createDevice(
  provider: CryptoProvider,
  opts: { domainId: string; deviceId: string; now?: Date; metadata?: Record<string, string> },
): Device {
  const { privateKey, publicKey } = provider.generateIdentityKeyPair();
  const kid = keyThumbprint(provider, 'Ed25519', publicKey.bytes);
  const identity: DeviceIdentity = {
    type: DEVICE_IDENTITY_TYPE,
    domain_id: opts.domainId,
    device_id: opts.deviceId,
    public_key: {
      kty: 'Ed25519',
      use: 'identity-signature',
      kid,
      public: toBase64Url(publicKey.bytes),
    },
    created_at: rfc3339Seconds(opts.now ?? new Date()),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
  return { identity, privateKey };
}

/** Rebuild a Device from a stored identity + private key (validates the pair matches). */
export function deviceFromStored(provider: CryptoProvider, identity: DeviceIdentity, privateKey: Ed25519PrivateKey): Device {
  const parsed = DeviceIdentitySchema.parse(identity);
  const derived = toBase64Url(provider.ed25519PublicKey(privateKey).bytes);
  if (derived !== parsed.public_key.public) {
    throw iscpError(IscpErrorCodes.KeyInvalid, 'stored private key does not match device identity');
  }
  return { identity: parsed, privateKey };
}

export function createDeviceProof(
  provider: CryptoProvider,
  device: Device,
  opts: { audience: string; challenge: string; nonce?: string; now?: Date },
): DeviceProof {
  const nonce = opts.nonce ?? toBase64Url(provider.randomBytes(16));
  const unsigned = {
    type: DEVICE_PROOF_TYPE,
    domain_id: device.identity.domain_id,
    device_id: device.identity.device_id,
    audience: opts.audience,
    challenge: opts.challenge,
    nonce,
    issued_at: rfc3339Seconds(opts.now ?? new Date()),
  };
  return signObject(provider, DEVICE_PROOF_TYPE, unsigned, device.privateKey, device.identity.public_key.kid) as DeviceProof;
}

/**
 * Verify a device proof (spec/identity.md): type, identity binding, audience,
 * challenge, freshness window, signature. Nonce replay tracking is the
 * verifier's responsibility (see session/replay.ts stores).
 */
export function verifyDeviceProof(
  provider: CryptoProvider,
  identity: DeviceIdentity,
  proof: DeviceProof,
  opts: { audience: string; challenge: string; now?: Date; ttlMs?: number },
): void {
  if (proof.type !== DEVICE_PROOF_TYPE) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'invalid proof type');
  }
  if (identity.domain_id !== proof.domain_id || identity.device_id !== proof.device_id) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'proof identity mismatch');
  }
  if (proof.audience !== opts.audience || proof.challenge !== opts.challenge) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'proof audience or challenge mismatch');
  }
  const now = (opts.now ?? new Date()).getTime();
  const issuedAt = parseRfc3339(proof.issued_at).getTime();
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  if (now - issuedAt > ttlMs || issuedAt > now + ttlMs) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'proof is outside allowed time window');
  }
  verifyObjectSignature(provider, DEVICE_PROOF_TYPE, proof, identity.public_key.public, IscpErrorCodes.SignatureInvalid, 'proof signature verification failed');
}
