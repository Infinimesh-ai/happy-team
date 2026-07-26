/**
 * Crypto provider seam for @slopus/iscp.
 *
 * The default implementation (crypto/noble.ts) is pure TypeScript and works on
 * Node and React Native/Hermes. Native-accelerated implementations (e.g. a
 * JSI ChaCha20 binding) can be swapped in behind this interface without
 * touching protocol code — see benchmark in src/crypto/chacha.bench.ts for
 * when that becomes necessary.
 *
 * Key-type separation (security-baseline: Ed25519 identity keys MUST NOT be
 * usable as X25519 session keys) is enforced both at compile time via branded
 * key classes and at runtime via brand checks.
 */

import { IscpErrorCodes, iscpError } from '../errors';

declare const ed25519PrivateBrand: unique symbol;
declare const ed25519PublicBrand: unique symbol;
declare const x25519PrivateBrand: unique symbol;
declare const x25519PublicBrand: unique symbol;

/** Ed25519 signing key (32-byte seed). Long-term identity signatures only. */
export class Ed25519PrivateKey {
  declare readonly [ed25519PrivateBrand]: true;
  readonly kind = 'ed25519-private' as const;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== 32) throw iscpError(IscpErrorCodes.KeyInvalid, 'invalid ed25519 private key size');
  }
}

export class Ed25519PublicKey {
  declare readonly [ed25519PublicBrand]: true;
  readonly kind = 'ed25519-public' as const;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== 32) throw iscpError(IscpErrorCodes.KeyInvalid, 'invalid ed25519 public key size');
  }
}

/** X25519 agreement key. Ephemeral session agreement only. */
export class X25519PrivateKey {
  declare readonly [x25519PrivateBrand]: true;
  readonly kind = 'x25519-private' as const;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== 32) throw iscpError(IscpErrorCodes.KeyInvalid, 'invalid x25519 private key size');
  }
}

export class X25519PublicKey {
  declare readonly [x25519PublicBrand]: true;
  readonly kind = 'x25519-public' as const;
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== 32) throw iscpError(IscpErrorCodes.KeyInvalid, 'invalid x25519 public key size');
  }
}

export function assertEd25519Private(key: Ed25519PrivateKey): void {
  if (!(key instanceof Ed25519PrivateKey) || key.kind !== 'ed25519-private') {
    throw iscpError(IscpErrorCodes.KeyInvalid, 'expected an Ed25519 private key');
  }
}

export function assertX25519Private(key: X25519PrivateKey): void {
  if (!(key instanceof X25519PrivateKey) || key.kind !== 'x25519-private') {
    throw iscpError(IscpErrorCodes.KeyInvalid, 'expected an X25519 private key');
  }
}

export const CIPHERSUITE_V2 = 'ISCP_V2_X25519_HKDF_SHA256_CHACHA20POLY1305';

export const CHACHA20_POLY1305_NONCE_SIZE = 12;
export const CHACHA20_POLY1305_KEY_SIZE = 32;

export interface CryptoProvider {
  randomBytes(length: number): Uint8Array;

  generateIdentityKeyPair(): { privateKey: Ed25519PrivateKey; publicKey: Ed25519PublicKey };
  ed25519PublicKey(privateKey: Ed25519PrivateKey): Ed25519PublicKey;
  sign(privateKey: Ed25519PrivateKey, message: Uint8Array): Uint8Array;
  verify(publicKey: Ed25519PublicKey, message: Uint8Array, signature: Uint8Array): boolean;

  generateSessionKeyPair(): { privateKey: X25519PrivateKey; publicKey: X25519PublicKey };
  x25519PublicKey(privateKey: X25519PrivateKey): X25519PublicKey;
  sharedSecret(privateKey: X25519PrivateKey, publicKey: X25519PublicKey): Uint8Array;

  hkdfSha256(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;

  /** ChaCha20-Poly1305 AEAD (RFC 8439, 12-byte nonce). */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  /** Throws IscpError(ISCPENV001) on authentication failure. */
  open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
}
