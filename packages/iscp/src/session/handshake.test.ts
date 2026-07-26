import { describe, expect, it } from 'vitest';

import { loadVectors, type VectorMeta } from '../conformance/vectors';
import { createNobleProvider } from '../crypto/noble';
import { Ed25519PrivateKey, X25519PrivateKey } from '../crypto/provider';
import { fromHex, toBase64Url, toHex, utf8Decode, utf8Encode } from '../encoding';
import { deviceFromStored, type Device } from '../identity';
import { signObject } from '../signing';
import { SESSION_HELLO_TYPE, SessionHelloSchema, type DeviceIdentity, type SecureEnvelope, type SessionHello, type SessionReady } from '../schemas';
import { establish, transcriptHash, verifyHello, type LocalHello } from './handshake';
import { decryptEnvelope, encryptEnvelope } from './secureEnvelope';

const provider = createNobleProvider();

interface SessionVectors {
  meta: VectorMeta;
  device_a: { seed_hex: string; identity: DeviceIdentity };
  device_b: { seed_hex: string; identity: DeviceIdentity };
  ephemeral_a_hex: string;
  ephemeral_b_hex: string;
  hello_a: SessionHello;
  hello_b: SessionHello;
  transcript_hash_b64: string;
  keys_a: { send_hex: string; receive_hex: string; ready_hex: string };
  ready_a: SessionReady;
  ready_b: SessionReady;
  envelope_a_to_b: { plaintext_hex: string; object: SecureEnvelope };
  envelope_b_to_a: { plaintext_hex: string; object: SecureEnvelope };
}

const vectors = loadVectors<SessionVectors>('session.json');
const identityA = vectors.device_a.identity;
const identityB = vectors.device_b.identity;
const helloA = SessionHelloSchema.parse(vectors.hello_a);
const helloB = SessionHelloSchema.parse(vectors.hello_b);

function localHelloA(): LocalHello {
  return { hello: helloA, ephemeralPrivateKey: new X25519PrivateKey(fromHex(vectors.ephemeral_a_hex)) };
}

function localHelloB(): LocalHello {
  return { hello: helloB, ephemeralPrivateKey: new X25519PrivateKey(fromHex(vectors.ephemeral_b_hex)) };
}

function establishedPair() {
  const stateA = establish(provider, localHelloA(), helloB, identityA, identityB);
  const stateB = establish(provider, localHelloB(), helloA, identityB, identityA);
  stateA.verifyReady(provider, vectors.ready_b, identityB);
  stateB.verifyReady(provider, vectors.ready_a, identityA);
  return { stateA, stateB };
}

describe('session handshake conformance (Go reference vectors)', () => {
  it('verifies both Go hello signatures', () => {
    verifyHello(provider, helloA, identityA);
    verifyHello(provider, helloB, identityB);
  });

  it('reproduces hello signatures from vector seeds (deterministic)', () => {
    const deviceA = deviceFromStored(provider, identityA, new Ed25519PrivateKey(fromHex(vectors.device_a.seed_hex)));
    // Recreating the hello with the same ephemeral key must yield the exact Go object.
    const ephPub = provider.x25519PublicKey(new X25519PrivateKey(fromHex(vectors.ephemeral_a_hex)));
    expect(toBase64Url(ephPub.bytes)).toBe(helloA.ephemeral_public_key);
    const recreated = createHelloWithFixedKey(deviceA, helloA);
    expect(recreated).toEqual(vectors.hello_a);
  });

  it('computes the same transcript hash as Go (order-independent)', () => {
    expect(toBase64Url(transcriptHash(provider, helloA, helloB, identityA, identityB))).toBe(vectors.transcript_hash_b64);
    expect(toBase64Url(transcriptHash(provider, helloB, helloA, identityB, identityA))).toBe(vectors.transcript_hash_b64);
  });

  it('derives the same direction-bound keys as Go', () => {
    const state = establish(provider, localHelloA(), helloB, identityA, identityB);
    expect(toHex(state.sendKey)).toBe(vectors.keys_a.send_hex);
    expect(toHex(state.receiveKey)).toBe(vectors.keys_a.receive_hex);
    expect(toHex(state.readyKey)).toBe(vectors.keys_a.ready_hex);
  });

  it('verifies Go ready objects and reproduces them byte-for-byte', () => {
    const { stateA, stateB } = establishedPair();
    expect(stateA.ready).toBe(true);
    expect(stateB.ready).toBe(true);
    const deviceA = deviceFromStored(provider, identityA, new Ed25519PrivateKey(fromHex(vectors.device_a.seed_hex)));
    expect(stateA.createReady(provider, deviceA)).toEqual(vectors.ready_a);
  });

  it('decrypts Go envelopes in both directions and re-encrypts identically', () => {
    const { stateA, stateB } = establishedPair();
    expect(utf8Decode(decryptEnvelope(provider, stateB, vectors.envelope_a_to_b.object))).toBe(
      utf8Decode(fromHex(vectors.envelope_a_to_b.plaintext_hex)),
    );
    expect(utf8Decode(decryptEnvelope(provider, stateA, vectors.envelope_b_to_a.object))).toBe(
      utf8Decode(fromHex(vectors.envelope_b_to_a.plaintext_hex)),
    );
    // Deterministic re-encryption: same keys, same sequence 0 → same ciphertext.
    const fresh = establish(provider, localHelloA(), helloB, identityA, identityB);
    fresh.verifyReady(provider, vectors.ready_b, identityB);
    const reencrypted = encryptEnvelope(provider, fresh, {
      messageId: vectors.envelope_a_to_b.object.message_id,
      payloadType: vectors.envelope_a_to_b.object.payload_type,
      route: vectors.envelope_a_to_b.object.route,
      plaintext: fromHex(vectors.envelope_a_to_b.plaintext_hex),
    });
    expect(reencrypted).toEqual(vectors.envelope_a_to_b.object);
  });
});

describe('session negative paths (P0 security matrix)', () => {
  it('NEG-008: refuses payload before session.ready', () => {
    const state = establish(provider, localHelloA(), helloB, identityA, identityB);
    expect(() =>
      encryptEnvelope(provider, state, { messageId: 'm', payloadType: 'text', route: vectors.envelope_a_to_b.object.route, plaintext: utf8Encode('x') }),
    ).toThrowError(/not ready/);
    expect(() => decryptEnvelope(provider, state, vectors.envelope_b_to_a.object)).toThrowError(/not ready/);
  });

  it('NEG-009: route metadata tamper fails AEAD authentication', () => {
    const { stateA } = establishedPair();
    const tampered = { ...vectors.envelope_b_to_a.object, route: { ...vectors.envelope_b_to_a.object.route, priority: 9 } };
    expect(() => decryptEnvelope(provider, stateA, tampered)).toThrowError(/aead authentication failed/);
  });

  it('NEG-010: duplicate sequence/nonce is rejected as replay', () => {
    const { stateA } = establishedPair();
    decryptEnvelope(provider, stateA, vectors.envelope_b_to_a.object);
    expect(() => decryptEnvelope(provider, stateA, vectors.envelope_b_to_a.object)).toThrowError(/ISCPENV002/);
  });

  it('rejects envelope route identity mismatch', () => {
    const { stateA } = establishedPair();
    const wrongSender = { ...vectors.envelope_b_to_a.object, sender_device_id: 'mallory' };
    expect(() => decryptEnvelope(provider, stateA, wrongSender)).toThrowError(/route identity mismatch/);
  });

  it('rejects peer binding mismatch during establish', () => {
    const otherHello = { ...helloB, peer_device_id: 'someone-else' };
    expect(() => establish(provider, localHelloA(), otherHello, identityA, identityB)).toThrowError(/peer binding mismatch/);
  });

  it('NEG-004: Ed25519 keys are rejected by X25519 APIs at runtime', () => {
    const seed = new Ed25519PrivateKey(fromHex(vectors.device_a.seed_hex));
    expect(() => provider.sharedSecret(seed as unknown as X25519PrivateKey, provider.generateSessionKeyPair().publicKey)).toThrowError(/ISCPKEY001/);
    expect(() => provider.x25519PublicKey(seed as unknown as X25519PrivateKey)).toThrowError(/ISCPKEY001/);
  });
});

/**
 * Rebuild hello_a deterministically: createHello would draw a fresh
 * ephemeral key, so sign the exact reference fields with the vector seed
 * instead and compare against the Go-signed object.
 */
function createHelloWithFixedKey(device: Device, reference: SessionHello): SessionHello {
  const unsigned: Record<string, unknown> = { ...reference };
  delete unsigned.signature;
  return SessionHelloSchema.parse(signObject(provider, SESSION_HELLO_TYPE, unsigned, device.privateKey, device.identity.public_key.kid));
}
