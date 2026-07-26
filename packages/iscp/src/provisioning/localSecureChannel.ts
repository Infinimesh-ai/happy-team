/**
 * Local Secure Channel (spec/provisioning.md): ephemeral X25519 agreement
 * salted by an out-of-band secret, with a transcript-finished MAC. The
 * channel key schedule is byte-compatible with the Go reference
 * (pkg/iscp/provisioning/provisioning.go EstablishLocalChannel):
 *
 *   transcript = "iscp/v2/provisioning/local-channel" || initiator_pub || responder_pub
 *   key        = HKDF-SHA256(shared_secret, salt = oob_secret, info = transcript, 32)
 *   mac        = HMAC-SHA256(key, transcript)
 *
 * Credentials and grants MUST NOT be transmitted before the channel is ready
 * (both sides hold the key and the humans have compared the OOB code).
 */

import { concatBytes, toBase64Url, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import type { CryptoProvider, X25519PrivateKey } from '../crypto/provider';
import { X25519PublicKey } from '../crypto/provider';

const CHANNEL_TRANSCRIPT_LABEL = 'iscp/v2/provisioning/local-channel';
const CHANNEL_MESSAGE_AAD = utf8Encode('iscp/v2/provisioning/local-channel/msg');

export interface LocalChannel {
  key: Uint8Array;
  transcriptMac: Uint8Array;
  ready: boolean;
}

export interface LocalChannelHalf {
  ephemeralPrivateKey: X25519PrivateKey;
  ephemeralPublicKey: Uint8Array;
}

/** Either side generates its ephemeral half; the initiator's public key travels first. */
export function createLocalChannelHalf(provider: CryptoProvider): LocalChannelHalf {
  const { privateKey, publicKey } = provider.generateSessionKeyPair();
  return { ephemeralPrivateKey: privateKey, ephemeralPublicKey: publicKey.bytes };
}

/**
 * Derive the channel from our half + the peer's public key. Role matters:
 * the transcript orders initiator bytes before responder bytes on both sides.
 */
export function deriveLocalChannel(
  provider: CryptoProvider,
  local: LocalChannelHalf,
  peerPublicKey: Uint8Array,
  role: 'initiator' | 'responder',
  oobSecret: Uint8Array,
): LocalChannel {
  const shared = provider.sharedSecret(local.ephemeralPrivateKey, new X25519PublicKey(peerPublicKey));
  const initiatorPub = role === 'initiator' ? local.ephemeralPublicKey : peerPublicKey;
  const responderPub = role === 'initiator' ? peerPublicKey : local.ephemeralPublicKey;
  const transcript = concatBytes(utf8Encode(CHANNEL_TRANSCRIPT_LABEL), initiatorPub, responderPub);
  const key = provider.hkdfSha256(shared, oobSecret, transcript, 32);
  const transcriptMac = provider.hmacSha256(key, transcript);
  return { key, transcriptMac, ready: true };
}

/**
 * Human-comparable out-of-band confirmation code (6 digits) derived from the
 * transcript MAC. Both sides display it; the operator confirms they match
 * before any credential crosses the channel.
 */
export function localChannelOobCode(channel: LocalChannel): string {
  const view = new DataView(channel.transcriptMac.buffer, channel.transcriptMac.byteOffset, channel.transcriptMac.byteLength);
  const value = view.getUint32(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

/** AEAD-protect a provisioning message (e.g. the bundle) over the channel. */
export function sealChannelMessage(provider: CryptoProvider, channel: LocalChannel, sequence: number, plaintext: Uint8Array): { nonce: string; ciphertext: string } {
  if (!channel.ready) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'local secure channel is not ready');
  }
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence));
  const ciphertext = provider.seal(channel.key, nonce, plaintext, CHANNEL_MESSAGE_AAD);
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
}

export function openChannelMessage(provider: CryptoProvider, channel: LocalChannel, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (!channel.ready) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'local secure channel is not ready');
  }
  return provider.open(channel.key, nonce, ciphertext, CHANNEL_MESSAGE_AAD);
}
