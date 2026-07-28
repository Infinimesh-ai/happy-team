/**
 * Provisioning Bundle (spec/provisioning.md): signed bundle bound to the
 * enrolled device id and its public key thumbprint. Application mirrors the
 * Go reference ApplyBundle checks.
 */

import { parseRfc3339 } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import { identityThumbprint, type Device } from '../identity';
import { signObject, verifyObjectSignature } from '../signing';
import type { CryptoProvider } from '../crypto/provider';
import { PROVISIONING_BUNDLE_TYPE, ProvisioningBundleSchema, type DeviceIdentity, type ProvisioningBundle } from '../schemas';
import type { LocalChannel } from './localSecureChannel';

export function signBundle(
  provider: CryptoProvider,
  issuer: Device,
  bundle: Omit<ProvisioningBundle, 'type' | 'signature'>,
): ProvisioningBundle {
  const unsigned = { ...bundle, type: PROVISIONING_BUNDLE_TYPE };
  return signObject(provider, PROVISIONING_BUNDLE_TYPE, unsigned, issuer.privateKey, issuer.identity.public_key.kid) as ProvisioningBundle;
}

/**
 * Validate a received bundle before trusting anything in it: the local
 * secure channel must be ready, the bundle must be within its validity
 * window, bound to this exact device (id + public key thumbprint), and
 * signed by the expected issuer.
 */
export function applyBundle(
  provider: CryptoProvider,
  channel: LocalChannel,
  localIdentity: DeviceIdentity,
  bundle: ProvisioningBundle,
  issuerPublicKeyBase64Url: string,
  now: Date = new Date(),
): ProvisioningBundle {
  if (!channel.ready) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'local secure channel is not ready');
  }
  const parsed = ProvisioningBundleSchema.parse(bundle);
  const nowMs = now.getTime();
  if (nowMs < parseRfc3339(parsed.issued_at).getTime() || nowMs >= parseRfc3339(parsed.expires_at).getTime()) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'provisioning bundle expired');
  }
  if (parsed.issued_to_device_id !== localIdentity.device_id) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'bundle device id mismatch');
  }
  if (parsed.issued_to_public_key_thumbprint !== identityThumbprint(provider, localIdentity)) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'bundle public key thumbprint mismatch');
  }
  verifyObjectSignature(provider, PROVISIONING_BUNDLE_TYPE, parsed, issuerPublicKeyBase64Url, IscpErrorCodes.ProvisionInvalid, 'bundle signature failed');
  return parsed;
}
