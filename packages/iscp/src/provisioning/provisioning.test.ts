import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from '../conformance/vectors';
import { createNobleProvider } from '../crypto/noble';
import { X25519PrivateKey } from '../crypto/provider';
import { fromHex, toHex, utf8Encode, fromBase64Url } from '../encoding';
import { type DeviceIdentity, type PairingTicket, type ProvisioningBundle } from '../schemas';
import { applyBundle } from './bundle';
import { createLocalChannelHalf, deriveLocalChannel, localChannelOobCode, openChannelMessage, sealChannelMessage } from './localSecureChannel';
import { decodeTicketFromTransport, encodeTicketForTransport, verifyPairingTicket } from './pairingTicket';

const provider = createNobleProvider();

interface ProvisioningVectors {
  meta: VectorMeta;
  local_channel: { a_priv_hex: string; b_priv_hex: string; oob_secret_hex: string; key_hex: string; mac_hex: string };
  issuer: { seed_hex: string; identity: DeviceIdentity };
  enrollee: { seed_hex: string; identity: DeviceIdentity };
  ticket: PairingTicket;
  bundle: ProvisioningBundle;
  verify_at: string;
}

const vectors = loadVectors<ProvisioningVectors>('provisioning.json');
const verifyAt = new Date(vectors.verify_at);

describe('local secure channel conformance', () => {
  const aPriv = new X25519PrivateKey(fromHex(vectors.local_channel.a_priv_hex));
  const bPriv = new X25519PrivateKey(fromHex(vectors.local_channel.b_priv_hex));
  const aPub = provider.x25519PublicKey(aPriv).bytes;
  const bPub = provider.x25519PublicKey(bPriv).bytes;
  const oob = fromHex(vectors.local_channel.oob_secret_hex);

  it('derives the same channel key and transcript MAC as Go from both roles', () => {
    const initiator = deriveLocalChannel(provider, { ephemeralPrivateKey: aPriv, ephemeralPublicKey: aPub }, bPub, 'initiator', oob);
    const responder = deriveLocalChannel(provider, { ephemeralPrivateKey: bPriv, ephemeralPublicKey: bPub }, aPub, 'responder', oob);
    expect(toHex(initiator.key)).toBe(vectors.local_channel.key_hex);
    expect(toHex(initiator.transcriptMac)).toBe(vectors.local_channel.mac_hex);
    expect(toHex(responder.key)).toBe(vectors.local_channel.key_hex);
    expect(toHex(responder.transcriptMac)).toBe(vectors.local_channel.mac_hex);
    expect(localChannelOobCode(initiator)).toBe(localChannelOobCode(responder));
    expect(localChannelOobCode(initiator)).toMatch(/^\d{6}$/);
  });

  it('wrong OOB secret produces a different key (and different OOB code)', () => {
    const good = deriveLocalChannel(provider, { ephemeralPrivateKey: aPriv, ephemeralPublicKey: aPub }, bPub, 'initiator', oob);
    const bad = deriveLocalChannel(provider, { ephemeralPrivateKey: aPriv, ephemeralPublicKey: aPub }, bPub, 'initiator', utf8Encode('oob-999999'));
    expect(toHex(bad.key)).not.toBe(toHex(good.key));
  });

  it('seals and opens channel messages', () => {
    const half = createLocalChannelHalf(provider);
    const peer = createLocalChannelHalf(provider);
    const channel = deriveLocalChannel(provider, half, peer.ephemeralPublicKey, 'initiator', oob);
    const peerChannel = deriveLocalChannel(provider, peer, half.ephemeralPublicKey, 'responder', oob);
    const sealed = sealChannelMessage(provider, channel, 0, utf8Encode('{"hello":"bundle"}'));
    const opened = openChannelMessage(provider, peerChannel, fromBase64Url(sealed.nonce), fromBase64Url(sealed.ciphertext));
    expect(new TextDecoder().decode(opened)).toBe('{"hello":"bundle"}');
  });
});

describe('pairing ticket conformance', () => {
  it('verifies the Go-signed ticket', () => {
    verifyPairingTicket(provider, vectors.ticket, vectors.issuer.identity.public_key.public, verifyAt);
  });

  it('rejects an expired ticket', () => {
    expect(() =>
      verifyPairingTicket(provider, vectors.ticket, vectors.issuer.identity.public_key.public, new Date('2027-01-01T00:00:00Z')),
    ).toThrowError(/expired/);
  });

  it('rejects a tampered ticket', () => {
    const tampered = { ...vectors.ticket, max_uses: 99 };
    expect(() => verifyPairingTicket(provider, tampered, vectors.issuer.identity.public_key.public, verifyAt)).toThrowError(/signature failed/);
  });

  it('round-trips through QR/deep-link transport encoding', () => {
    const encoded = encodeTicketForTransport(vectors.ticket);
    expect(decodeTicketFromTransport(encoded)).toEqual(vectors.ticket);
  });
});

describe('provisioning bundle conformance', () => {
  const readyChannel = { key: new Uint8Array(32), transcriptMac: new Uint8Array(32), ready: true };

  it('applies the Go-signed bundle bound to the enrollee', () => {
    const parsed = applyBundle(provider, readyChannel, vectors.enrollee.identity, vectors.bundle, vectors.issuer.identity.public_key.public, verifyAt);
    expect(parsed.bundle_id).toBe('bundle-vector-1');
  });

  it('rejects application before the local channel is ready', () => {
    expect(() =>
      applyBundle(provider, { ...readyChannel, ready: false }, vectors.enrollee.identity, vectors.bundle, vectors.issuer.identity.public_key.public, verifyAt),
    ).toThrowError(/not ready/);
  });

  it('rejects a bundle bound to another device', () => {
    expect(() =>
      applyBundle(provider, readyChannel, vectors.issuer.identity, vectors.bundle, vectors.issuer.identity.public_key.public, verifyAt),
    ).toThrowError(/device id mismatch/);
  });

  it('rejects a tampered bundle', () => {
    const tampered = { ...vectors.bundle, refresh_credential_wrapped: 'AAAA' };
    expect(() =>
      applyBundle(provider, readyChannel, vectors.enrollee.identity, tampered, vectors.issuer.identity.public_key.public, verifyAt),
    ).toThrowError(/signature failed/);
  });
});
