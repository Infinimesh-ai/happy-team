/**
 * Relay discovery via GET /.well-known/iscp/relay (spec/relay.md,
 * spec/descriptor.md). Descriptors are signed with the relay's own
 * descriptor-signature key; trust is anchored by pinning SHA-256 over the
 * canonical descriptor bytes.
 */

import { toBase64Url, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import { canonicalizeAny } from '../jcs';
import { verifyObjectSignature } from '../signing';
import type { CryptoProvider } from '../crypto/provider';
import {
  RelayDescriptorSchema,
  SIGNED_DESCRIPTOR_TYPE,
  SignedDescriptorSchema,
  TrustRootDescriptorSchema,
  type RelayDescriptor,
  type SignedDescriptor,
  type TrustRootDescriptor,
} from '../schemas';

/** SHA-256 pin over canonical descriptor bytes (base64url). */
export function descriptorPin(provider: CryptoProvider, signed: SignedDescriptor): string {
  return toBase64Url(provider.sha256(utf8Encode(canonicalizeAny(signed.descriptor))));
}

export interface VerifyDescriptorOptions {
  /** Reject unsigned/mismatched descriptors. Production/staging profiles must not disable this. */
  allowUnsigned?: boolean;
  expectedPin?: string;
  now?: Date;
}

function verifySignedDescriptor(provider: CryptoProvider, signed: SignedDescriptor, opts: VerifyDescriptorOptions, publicKeyBase64Url: string | undefined): void {
  if (!signed.signature?.value) {
    if (!opts.allowUnsigned) {
      throw iscpError(IscpErrorCodes.SignatureInvalid, 'unsigned descriptor rejected');
    }
    return;
  }
  if (publicKeyBase64Url === undefined) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'descriptor signing key not found');
  }
  verifyObjectSignature(provider, SIGNED_DESCRIPTOR_TYPE, signed, publicKeyBase64Url, IscpErrorCodes.SignatureInvalid, 'descriptor signature verification failed');
}

/** Validate a signed relay descriptor and return the parsed descriptor. */
export function verifyRelayDescriptor(provider: CryptoProvider, signed: SignedDescriptor, opts: VerifyDescriptorOptions = {}): RelayDescriptor {
  const parsed = SignedDescriptorSchema.parse(signed);
  if (parsed.descriptor_type !== 'iscp.relay.descriptor.v2') {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'unsupported descriptor type');
  }
  const descriptor = RelayDescriptorSchema.parse(parsed.descriptor);
  const signingKey = descriptor.signing_keys.find((k) => k.kid === parsed.signature?.kid && k.use === 'descriptor-signature');
  verifySignedDescriptor(provider, parsed, opts, signingKey?.public);
  const now = opts.now ?? new Date();
  if (now.getTime() > new Date(descriptor.expires_at).getTime()) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'descriptor expired');
  }
  if (opts.expectedPin !== undefined && descriptorPin(provider, parsed) !== opts.expectedPin) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'descriptor pin mismatch');
  }
  return descriptor;
}

/** Validate a signed trust root descriptor and return the parsed descriptor. */
export function verifyTrustRootDescriptor(provider: CryptoProvider, signed: SignedDescriptor, opts: VerifyDescriptorOptions = {}): TrustRootDescriptor {
  const parsed = SignedDescriptorSchema.parse(signed);
  if (parsed.descriptor_type !== 'iscp.trust_root.descriptor.v2') {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'unsupported descriptor type');
  }
  const descriptor = TrustRootDescriptorSchema.parse(parsed.descriptor);
  // The reference trust root signs its descriptor with its signer identity
  // key, published in `keys`; accept a key whose kid matches the signature.
  const signingKey = descriptor.keys.find((k) => k.kid === parsed.signature?.kid && k.state !== 'revoked');
  verifySignedDescriptor(provider, parsed, opts, signingKey?.public);
  const now = opts.now ?? new Date();
  if (now.getTime() > new Date(descriptor.expires_at).getTime()) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'descriptor expired');
  }
  if (opts.expectedPin !== undefined && descriptorPin(provider, parsed) !== opts.expectedPin) {
    throw iscpError(IscpErrorCodes.SignatureInvalid, 'descriptor pin mismatch');
  }
  return descriptor;
}
