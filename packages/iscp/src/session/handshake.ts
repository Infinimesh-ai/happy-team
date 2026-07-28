/**
 * Session establishment (spec/session.md), byte-compatible with the pinned
 * Go reference (pkg/iscp/session/session.go):
 *
 *   initiator hello -> responder hello -> transcript hash -> HKDF -> ready MAC -> READY
 *
 * The transcript binds protocol version, ciphersuite, both device IDs, both
 * identity key thumbprints, both ephemeral X25519 keys, and (via the full
 * hello objects) the Trust Grant ID. HKDF info labels are direction-bound by
 * lexicographic device-ID order: iscp/v2/session/{low-to-high,high-to-low,ready}.
 */

import { fromBase64Url, rfc3339Seconds, toBase64Url, utf8Encode } from '../encoding';
import { IscpErrorCodes, iscpError } from '../errors';
import { canonicalizeAny, compareCodePoints } from '../jcs';
import { identityThumbprint } from '../identity';
import type { Device } from '../identity';
import { signObject, verifyObjectSignature } from '../signing';
import { CIPHERSUITE_V2, type CryptoProvider, X25519PrivateKey, X25519PublicKey } from '../crypto/provider';
import {
  SESSION_HELLO_TYPE,
  SESSION_READY_TYPE,
  type DeviceIdentity,
  type SessionHello,
  type SessionReady,
} from '../schemas';
import { InMemoryReplayStore, type ReplayStore } from './replay';

export interface LocalHello {
  hello: SessionHello;
  ephemeralPrivateKey: X25519PrivateKey;
}

export function createHello(
  provider: CryptoProvider,
  device: Device,
  opts: { sessionId: string; peerDeviceId: string; grantId: string; now?: Date },
): LocalHello {
  const { privateKey, publicKey } = provider.generateSessionKeyPair();
  const unsigned = {
    type: SESSION_HELLO_TYPE,
    session_id: opts.sessionId,
    domain_id: device.identity.domain_id,
    device_id: device.identity.device_id,
    peer_device_id: opts.peerDeviceId,
    ciphersuite: CIPHERSUITE_V2,
    ephemeral_public_key: toBase64Url(publicKey.bytes),
    grant_id: opts.grantId,
    issued_at: rfc3339Seconds(opts.now ?? new Date()),
  };
  const hello = signObject(provider, SESSION_HELLO_TYPE, unsigned, device.privateKey, device.identity.public_key.kid) as SessionHello;
  return { hello, ephemeralPrivateKey: privateKey };
}

export function verifyHello(provider: CryptoProvider, hello: SessionHello, identity: DeviceIdentity): void {
  if (hello.type !== SESSION_HELLO_TYPE) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'invalid session hello type');
  }
  if (hello.device_id !== identity.device_id || hello.domain_id !== identity.domain_id) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'session hello identity mismatch');
  }
  if (hello.ciphersuite !== CIPHERSUITE_V2) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'unsupported ciphersuite');
  }
  verifyObjectSignature(provider, SESSION_HELLO_TYPE, hello, identity.public_key.public, IscpErrorCodes.SessionInvalid, 'session hello signature verification failed');
}

/** SHA-256 over the canonical transcript document (hellos and identities sorted by device id). */
export function transcriptHash(
  provider: CryptoProvider,
  helloA: SessionHello,
  helloB: SessionHello,
  identityA: DeviceIdentity,
  identityB: DeviceIdentity,
): Uint8Array {
  const hellos = [helloA, helloB].sort((a, b) => compareCodePoints(a.device_id, b.device_id));
  const identities = [identityA, identityB].sort((a, b) => compareCodePoints(a.device_id, b.device_id));
  const doc = {
    protocol: 'iscp.session.transcript.v2',
    session_id: helloA.session_id,
    domain_id: helloA.domain_id,
    ciphersuite: CIPHERSUITE_V2,
    hello_a: hellos[0],
    hello_b: hellos[1],
    identity_a: identities[0].device_id,
    identity_b: identities[1].device_id,
    identity_thumbprint_a: identityThumbprint(provider, identities[0]),
    identity_thumbprint_b: identityThumbprint(provider, identities[1]),
  };
  return provider.sha256(utf8Encode(canonicalizeAny(doc)));
}

function directionLabels(localDeviceId: string, remoteDeviceId: string): { send: string; receive: string } {
  if (compareCodePoints(localDeviceId, remoteDeviceId) < 0) {
    return { send: 'low-to-high', receive: 'high-to-low' };
  }
  return { send: 'high-to-low', receive: 'low-to-high' };
}

export class SessionState {
  readonly sessionId: string;
  readonly domainId: string;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
  readonly transcriptHash: Uint8Array;
  readonly sendKey: Uint8Array;
  readonly receiveKey: Uint8Array;
  readonly readyKey: Uint8Array;
  private isReady = false;
  private sendSeq = 0;
  private readonly replayStore: ReplayStore;

  constructor(fields: {
    sessionId: string;
    domainId: string;
    localDeviceId: string;
    peerDeviceId: string;
    transcriptHash: Uint8Array;
    sendKey: Uint8Array;
    receiveKey: Uint8Array;
    readyKey: Uint8Array;
    replayStore?: ReplayStore;
  }) {
    this.sessionId = fields.sessionId;
    this.domainId = fields.domainId;
    this.localDeviceId = fields.localDeviceId;
    this.peerDeviceId = fields.peerDeviceId;
    this.transcriptHash = fields.transcriptHash;
    this.sendKey = fields.sendKey;
    this.receiveKey = fields.receiveKey;
    this.readyKey = fields.readyKey;
    this.replayStore = fields.replayStore ?? new InMemoryReplayStore();
  }

  get ready(): boolean {
    return this.isReady;
  }

  /** Allocate the next send sequence and its deterministic 96-bit nonce (big-endian counter in bytes 4..12). */
  nextSend(): { sequence: number; nonce: Uint8Array } {
    const sequence = this.sendSeq;
    this.sendSeq += 1;
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence));
    return { sequence, nonce };
  }

  /** Reject duplicate sequence or nonce on the receive direction (ISCPENV002). */
  markReceived(sequence: number, nonce: string): void {
    if (this.replayStore.isReplay(sequence, nonce)) {
      throw iscpError(IscpErrorCodes.ReplayDetected, 'duplicate envelope sequence');
    }
    this.replayStore.record(sequence, nonce);
  }

  createReady(provider: CryptoProvider, device: Device): SessionReady {
    const unsigned = {
      type: SESSION_READY_TYPE,
      session_id: this.sessionId,
      device_id: this.localDeviceId,
      transcript_hash: toBase64Url(this.transcriptHash),
      ready_mac: toBase64Url(provider.hmacSha256(this.readyKey, utf8Encode(`ready:${this.localDeviceId}`))),
    };
    return signObject(provider, SESSION_READY_TYPE, unsigned, device.privateKey, device.identity.public_key.kid) as SessionReady;
  }

  verifyReady(provider: CryptoProvider, ready: SessionReady, remoteIdentity: DeviceIdentity): void {
    if (ready.type !== SESSION_READY_TYPE || ready.session_id !== this.sessionId || ready.device_id !== this.peerDeviceId) {
      throw iscpError(IscpErrorCodes.SessionInvalid, 'ready binding mismatch');
    }
    if (toBase64Url(this.transcriptHash) !== ready.transcript_hash) {
      throw iscpError(IscpErrorCodes.SessionInvalid, 'ready transcript mismatch');
    }
    const expectedMac = toBase64Url(provider.hmacSha256(this.readyKey, utf8Encode(`ready:${ready.device_id}`)));
    if (expectedMac !== ready.ready_mac) {
      throw iscpError(IscpErrorCodes.SessionInvalid, 'ready mac mismatch');
    }
    verifyObjectSignature(provider, SESSION_READY_TYPE, ready, remoteIdentity.public_key.public, IscpErrorCodes.SessionInvalid, 'ready signature verification failed');
    this.isReady = true;
  }
}

/**
 * Combine the local hello (with its ephemeral private key) and the verified
 * remote hello into a session key state. Forward secrecy comes from the
 * ephemeral X25519 agreement; the transcript hash salts every derivation.
 */
export function establish(
  provider: CryptoProvider,
  local: LocalHello,
  remote: SessionHello,
  localIdentity: DeviceIdentity,
  remoteIdentity: DeviceIdentity,
  opts?: { replayStore?: ReplayStore },
): SessionState {
  if (local.hello.session_id !== remote.session_id) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'session id mismatch');
  }
  if (local.hello.domain_id !== remote.domain_id) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'domain mismatch');
  }
  if (local.hello.peer_device_id !== remote.device_id || remote.peer_device_id !== local.hello.device_id) {
    throw iscpError(IscpErrorCodes.SessionInvalid, 'peer binding mismatch');
  }
  verifyHello(provider, remote, remoteIdentity);
  const remotePub = new X25519PublicKey(fromBase64Url(remote.ephemeral_public_key));
  const secret = provider.sharedSecret(local.ephemeralPrivateKey, remotePub);
  const th = transcriptHash(provider, local.hello, remote, localIdentity, remoteIdentity);
  const labels = directionLabels(local.hello.device_id, remote.device_id);
  const sendKey = provider.hkdfSha256(secret, th, utf8Encode(`iscp/v2/session/${labels.send}`), 32);
  const receiveKey = provider.hkdfSha256(secret, th, utf8Encode(`iscp/v2/session/${labels.receive}`), 32);
  const readyKey = provider.hkdfSha256(secret, th, utf8Encode('iscp/v2/session/ready'), 32);
  return new SessionState({
    sessionId: local.hello.session_id,
    domainId: local.hello.domain_id,
    localDeviceId: local.hello.device_id,
    peerDeviceId: remote.device_id,
    transcriptHash: th,
    sendKey,
    receiveKey,
    readyKey,
    replayStore: opts?.replayStore,
  });
}
