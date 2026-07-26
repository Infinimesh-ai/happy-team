/** Pairing Ticket sign/verify (spec/provisioning.md). Short TTL, limited use. */

import { fromBase64Url, parseRfc3339, toBase64Url, utf8Decode, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import type { Device } from '../identity';
import { signObject, verifyObjectSignature } from '../signing';
import type { CryptoProvider } from '../crypto/provider';
import { PAIRING_TICKET_TYPE, PairingTicketSchema, type PairingTicket } from '../schemas';

export function signPairingTicket(
  provider: CryptoProvider,
  issuer: Device,
  ticket: Omit<PairingTicket, 'type' | 'signature'>,
): PairingTicket {
  const unsigned = { ...ticket, type: PAIRING_TICKET_TYPE };
  return signObject(provider, PAIRING_TICKET_TYPE, unsigned, issuer.privateKey, issuer.identity.public_key.kid) as PairingTicket;
}

export function verifyPairingTicket(
  provider: CryptoProvider,
  ticket: PairingTicket,
  issuerPublicKeyBase64Url: string,
  now: Date = new Date(),
): void {
  const parsed = PairingTicketSchema.parse(ticket);
  const nowMs = now.getTime();
  if (nowMs < parseRfc3339(parsed.issued_at).getTime() || nowMs >= parseRfc3339(parsed.expires_at).getTime()) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'pairing ticket expired');
  }
  verifyObjectSignature(provider, PAIRING_TICKET_TYPE, parsed, issuerPublicKeyBase64Url, IscpErrorCodes.ProvisionInvalid, 'pairing ticket signature failed');
}

/**
 * Encode/decode a ticket for QR/deep-link transport
 * (happy://iscp-enroll?ticket=...): unpadded base64url over the ticket JSON.
 */
export function encodeTicketForTransport(ticket: PairingTicket): string {
  return toBase64Url(utf8Encode(JSON.stringify(ticket)));
}

export function decodeTicketFromTransport(encoded: string): PairingTicket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(fromBase64Url(encoded)));
  } catch (cause) {
    throw iscpError(IscpErrorCodes.ProvisionInvalid, 'invalid ticket encoding', { cause });
  }
  return PairingTicketSchema.parse(parsed);
}
