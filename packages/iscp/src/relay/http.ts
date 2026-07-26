/**
 * Relay REST client (spec/relay.md, docs/api/openapi.yaml).
 *
 * Envelope submission always attaches the X-ISCP-Access-Proof
 * proof-of-possession header (required by the production profile, ignored by
 * local-lab). The PoP challenge binds method, path, and the SHA-256 of the
 * bearer access token:
 *
 *   iscp/v2/relay/access-proof \0 METHOD \0 PATH \0 base64url(sha256(token))
 */

import { toBase64Url, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError, iscpErrorFromWire } from '../errors';
import { createDeviceProof, type Device } from '../identity';
import type { CryptoProvider } from '../crypto/provider';
import {
  DeliveryReceiptSchema,
  SignedDescriptorSchema,
  type DeliveryReceipt,
  type DeviceProof,
  type SecureEnvelope,
  type SignedDescriptor,
} from '../schemas';
import * as z from 'zod';

/** Access/refresh credential as issued by the reference relay. Tokens are bearer secrets — never log them. */
export const RelayCredentialSchema = z.object({
  domain_id: z.string(),
  device_id: z.string(),
  token: z.string().optional(),
  expires_at: z.string(),
  revoked: z.boolean().optional(),
});
export type RelayCredential = z.infer<typeof RelayCredentialSchema>;

export const RelayCredentialPairSchema = z.object({
  access: RelayCredentialSchema,
  refresh: RelayCredentialSchema,
});
export type RelayCredentialPair = z.infer<typeof RelayCredentialPairSchema>;

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export function accessProofChallenge(provider: CryptoProvider, method: string, path: string, accessToken: string): string {
  const tokenHash = toBase64Url(provider.sha256(utf8Encode(accessToken)));
  return ['iscp/v2/relay/access-proof', method.toUpperCase(), path, tokenHash].join('\0');
}

async function parseError(response: { status: number; json(): Promise<unknown>; text(): Promise<string> }, context: string): Promise<never> {
  let wire: unknown;
  try {
    wire = await response.json();
  } catch {
    wire = undefined;
  }
  throw iscpErrorFromWire(wire, `${context} failed with status ${response.status}`);
}

export interface RelayHttpClientOptions {
  baseUrl: string;
  relayId: string;
  provider: CryptoProvider;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export class RelayHttpClient {
  private readonly baseUrl: string;
  private readonly relayId: string;
  private readonly provider: CryptoProvider;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(opts: RelayHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.relayId = opts.relayId;
    this.provider = opts.provider;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => new Date());
  }

  /** GET /.well-known/iscp/relay — returns the raw signed descriptor plus server-computed pin. */
  async fetchSignedDescriptor(): Promise<{ descriptor: SignedDescriptor; pin?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/.well-known/iscp/relay`);
    if (!response.ok) await parseError(response, 'relay discovery');
    const body = (await response.json()) as { descriptor?: unknown; pin?: unknown };
    return {
      descriptor: SignedDescriptorSchema.parse(body.descriptor),
      pin: typeof body.pin === 'string' ? body.pin : undefined,
    };
  }

  /** POST /v2/relay/devices/bind-self — device self-binding with a fresh proof. */
  async bindSelf(device: Device): Promise<RelayCredentialPair> {
    const proof = this.relayProof(device);
    return this.credentialCall('/v2/relay/devices/bind-self', { identity: device.identity, proof });
  }

  /** POST /v2/relay/devices/register-with-ticket — enrollment via pairing ticket. */
  async registerWithTicket(device: Device, ticket: { ticketId: string; maxUses: number }): Promise<RelayCredentialPair> {
    const proof = this.relayProof(device);
    return this.credentialCall('/v2/relay/devices/register-with-ticket', {
      ticket_id: ticket.ticketId,
      max_uses: ticket.maxUses,
      identity: device.identity,
      proof,
    });
  }

  /** POST /v2/relay/devices/refresh-access — rotates both credentials; the old refresh credential is revoked. */
  async refreshAccess(refreshToken: string): Promise<RelayCredentialPair> {
    return this.credentialCall('/v2/relay/devices/refresh-access', { refresh: refreshToken });
  }

  /** POST /v2/relay/devices/revoke-access — self-revocation with the device's own access credential. */
  async revokeAccess(deviceId: string, accessToken: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/relay/devices/revoke-access`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ device_id: deviceId }),
    });
    if (!response.ok) await parseError(response, 'relay access revocation');
  }

  /** POST /v2/relay/envelopes — submit an opaque envelope; returns the relay receipt (not an E2E receipt). */
  async submitEnvelope(envelope: SecureEnvelope, device: Device, accessToken: string): Promise<DeliveryReceipt> {
    const path = '/v2/relay/envelopes';
    const proof = this.accessProof(device, 'POST', path, accessToken);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-ISCP-Access-Proof': toBase64Url(utf8Encode(JSON.stringify(proof))),
      },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) await parseError(response, 'envelope submission');
    return DeliveryReceiptSchema.parse(await response.json());
  }

  /** DeviceProof for relay HTTP binding endpoints (self-declared challenge, relay audience). */
  relayProof(device: Device): DeviceProof {
    return createDeviceProof(this.provider, device, {
      audience: this.relayId,
      challenge: toBase64Url(this.provider.randomBytes(16)),
      now: this.now(),
    });
  }

  /** DeviceProof for the X-ISCP-Access-Proof PoP header. */
  accessProof(device: Device, method: string, path: string, accessToken: string): DeviceProof {
    return createDeviceProof(this.provider, device, {
      audience: this.relayId,
      challenge: accessProofChallenge(this.provider, method, path, accessToken),
      now: this.now(),
    });
  }

  private async credentialCall(path: string, body: unknown): Promise<RelayCredentialPair> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) await parseError(response, `relay ${path}`);
    const pair = RelayCredentialPairSchema.parse(await response.json());
    if (!pair.access.token || !pair.refresh.token) {
      throw iscpError(IscpErrorCodes.AccessInvalid, 'relay did not return credential tokens');
    }
    return pair;
  }
}
