/** Generic ISCP v2 signed-object helpers shared by every signed schema. */

import { fromBase64Url, toBase64Url } from './encoding';
import { IscpErrorCodes, iscpError } from './errors';
import { signatureInput } from './jcs';
import type { CryptoProvider, Ed25519PrivateKey } from './crypto/provider';
import { Ed25519PublicKey } from './crypto/provider';
import type { IscpSignature } from './schemas/common';

/**
 * Sign an object: canonicalize without `signature`, sign
 * ISCP-V2-SIGNATURE\0<type>\0<canonical>, attach the signature envelope.
 */
export function signObject<T extends object>(
  provider: CryptoProvider,
  objectType: string,
  object: T,
  privateKey: Ed25519PrivateKey,
  kid: string,
): T & { signature: IscpSignature } {
  const input = signatureInput(objectType, object);
  const value = toBase64Url(provider.sign(privateKey, input));
  return { ...object, signature: { alg: 'Ed25519', kid, value } };
}

/** Verify a signed object's signature against a public key. Throws with `errorCode` on failure. */
export function verifyObjectSignature(
  provider: CryptoProvider,
  objectType: string,
  object: { signature?: IscpSignature },
  publicKeyBase64Url: string,
  errorCode: Parameters<typeof iscpError>[0] = IscpErrorCodes.SignatureInvalid,
  what = 'signature verification failed',
): void {
  const signature = object.signature;
  if (!signature || signature.alg !== 'Ed25519' || !signature.value) {
    throw iscpError(errorCode, what);
  }
  const publicKey = new Ed25519PublicKey(fromBase64Url(publicKeyBase64Url));
  const input = signatureInput(objectType, object);
  if (!provider.verify(publicKey, input, fromBase64Url(signature.value))) {
    throw iscpError(errorCode, what);
  }
}
