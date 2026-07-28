/**
 * SecureEnvelope AEAD (spec/envelope.md). AAD is the canonical JSON of the
 * envelope with `ciphertext` set to the empty string, so any tampering with
 * route metadata (or any other field) fails authentication.
 */

import { fromBase64Url, toBase64Url, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import { canonicalizeAny } from '../jcs';
import type { CryptoProvider } from '../crypto/provider';
import { SECURE_ENVELOPE_TYPE, type EnvelopeRoute, type SecureEnvelope } from '../schemas';
import type { SessionState } from './handshake';

function envelopeAad(envelope: SecureEnvelope): Uint8Array {
  return utf8Encode(canonicalizeAny({ ...envelope, ciphertext: '' }));
}

export function encryptEnvelope(
  provider: CryptoProvider,
  state: SessionState,
  opts: { messageId: string; payloadType: string; route: EnvelopeRoute; plaintext: Uint8Array },
): SecureEnvelope {
  if (!state.ready) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'session is not ready for payload delivery');
  }
  const { sequence, nonce } = state.nextSend();
  const envelope: SecureEnvelope = {
    type: SECURE_ENVELOPE_TYPE,
    domain_id: state.domainId,
    message_id: opts.messageId,
    session_id: state.sessionId,
    sender_device_id: state.localDeviceId,
    recipient_device_id: state.peerDeviceId,
    sequence,
    nonce: toBase64Url(nonce),
    payload_type: opts.payloadType,
    route: opts.route,
    ciphertext: '',
  };
  const ciphertext = provider.seal(state.sendKey, nonce, opts.plaintext, envelopeAad(envelope));
  return { ...envelope, ciphertext: toBase64Url(ciphertext) };
}

export function decryptEnvelope(provider: CryptoProvider, state: SessionState, envelope: SecureEnvelope): Uint8Array {
  if (!state.ready) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'session is not ready for payload delivery');
  }
  if (envelope.type !== SECURE_ENVELOPE_TYPE || envelope.session_id !== state.sessionId || envelope.domain_id !== state.domainId) {
    throw iscpError(IscpErrorCodes.EnvelopeInvalid, 'envelope binding mismatch');
  }
  if (envelope.sender_device_id !== state.peerDeviceId || envelope.recipient_device_id !== state.localDeviceId) {
    throw iscpError(IscpErrorCodes.EnvelopeInvalid, 'envelope route identity mismatch');
  }
  state.markReceived(envelope.sequence, envelope.nonce);
  const nonce = fromBase64Url(envelope.nonce);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  return provider.open(state.receiveKey, nonce, ciphertext, envelopeAad(envelope));
}
