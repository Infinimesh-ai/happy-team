/**
 * Integration suite against the upstream Go reference services (relay +
 * trust root) from the pinned commit, run via the docker harness:
 *
 *   docker compose -f environments/iscp/docker-compose.yaml up --build -d
 *   ISCP_HARNESS=1 pnpm --filter @slopus/iscp test:integration
 *
 * Covers the Phase 2 acceptance flow: two peers enroll → handshake →
 * envelopes in both directions → WS kill + reconnect → offline queue drain →
 * replay rejected → revoked grant / revoked access refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNobleProvider } from '../crypto/noble';
import { toBase64Url, utf8Decode, utf8Encode } from '../encoding';
import { IscpError } from '../errors';
import { createDevice, identityThumbprint, type Device } from '../identity';
import { IscpPeer } from '../peer';
import { descriptorPin, verifyRelayDescriptor, verifyTrustRootDescriptor } from '../relay/discovery';
import { RelayHttpClient, type RelayCredentialPair } from '../relay/http';
import { RelayWsClient } from '../relay/ws';
import { createHello, establish } from '../session/handshake';
import { decryptEnvelope, encryptEnvelope } from '../session/secureEnvelope';
import { TrustRootClient } from '../trustRoot';
import { verifyGrant, grantSigningKey } from '../trustRoot';
import type { RelayDescriptor, SecureEnvelope, TrustGrant, TrustRootDescriptor } from '../schemas';

const RELAY_URL = process.env.ISCP_RELAY_URL ?? 'http://localhost:18080';
const TRUST_URL = process.env.ISCP_TRUST_URL ?? 'http://localhost:18081';
const RELAY_ID = 'relay-local';
const TRUST_ROOT_ID = 'trust-local';
const DOMAIN_ID = 'local';

const provider = createNobleProvider();
const runId = toBase64Url(provider.randomBytes(6)); // unique device ids per run (services keep state)

interface Enrolled {
  device: Device;
  credentials: RelayCredentialPair;
  grant: TrustGrant;
}

let relayHttp: RelayHttpClient;
let trustRoot: TrustRootClient;
let relayDescriptor: RelayDescriptor;
let trustRootDescriptor: TrustRootDescriptor;

async function enroll(deviceId: string): Promise<Enrolled> {
  const device = createDevice(provider, { domainId: DOMAIN_ID, deviceId });
  const credentials = await relayHttp.bindSelf(device);
  await trustRoot.submitDevice(device);
  // local-lab: admin endpoints are open, so the test plays the operator.
  const { grant } = await trustRoot.authorizeDevice({
    deviceId,
    audience: 'happy-domain',
    permissions: ['text'],
    relayId: RELAY_ID,
    ttlSeconds: 3600,
  });
  const record = await trustRoot.waitForAuthorization(deviceId, { intervalMs: 200, timeoutMs: 10_000 });
  expect(record.status).toBe('authorized');
  return { device, credentials, grant };
}

function makePeer(enrolled: Enrolled, manifest: unknown, sink: {
  payloads: Array<{ from: string; type: string; text: string }>;
  manifests: Array<{ from: string; manifest: unknown }>;
  errors: unknown[];
}): IscpPeer {
  return new IscpPeer({
    device: enrolled.device,
    grant: enrolled.grant,
    relayDescriptor,
    credentials: {
      accessToken: enrolled.credentials.access.token as string,
      refreshToken: enrolled.credentials.refresh.token as string,
    },
    resolvePeerIdentity: async (id) => (await trustRoot.deviceStatus(id)).identity,
    manifest,
    provider,
    wsBackoff: { pollIntervalMs: 150, initialDelayMs: 150, maxDelayMs: 2000 },
    onPayload: (from, type, plaintext) => sink.payloads.push({ from, type, text: utf8Decode(plaintext) }),
    onPeerReady: (from, m) => sink.manifests.push({ from, manifest: m }),
    onError: (error) => sink.errors.push(error),
  });
}

function newSink() {
  return { payloads: [] as Array<{ from: string; type: string; text: string }>, manifests: [] as Array<{ from: string; manifest: unknown }>, errors: [] as unknown[] };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  relayHttp = new RelayHttpClient({ baseUrl: RELAY_URL, relayId: RELAY_ID, provider });
  trustRoot = new TrustRootClient({ baseUrl: TRUST_URL, trustRootId: TRUST_ROOT_ID, provider });

  // Discovery + descriptor verification + pin check.
  const { descriptor: signedRelay, pin } = await relayHttp.fetchSignedDescriptor();
  relayDescriptor = verifyRelayDescriptor(provider, signedRelay);
  expect(pin).toBe(descriptorPin(provider, signedRelay));
  expect(relayDescriptor.relay_id).toBe(RELAY_ID);
  // The compose file maps the relay to localhost:18080; the descriptor
  // advertises that same base URL.
  expect(relayDescriptor.base_url).toBe(RELAY_URL);

  const signedTrust = await trustRoot.fetchSignedDescriptor();
  trustRootDescriptor = verifyTrustRootDescriptor(provider, signedTrust);
  expect(trustRootDescriptor.trust_root_id).toBe(TRUST_ROOT_ID);
}, 30_000);

describe('dual-peer enroll → handshake → envelopes → reconnect → replay → revocation', () => {
  const peers: IscpPeer[] = [];

  afterAll(() => {
    for (const peer of peers) peer.stop();
  });

  it('enrolls two devices, verifies grants locally, and exchanges payloads', async () => {
    const alpha = await enroll(`it-alpha-${runId}`);
    const beta = await enroll(`it-beta-${runId}`);

    // Client-side grant verification against the trust root descriptor key.
    for (const enrolled of [alpha, beta]) {
      const issuerKey = grantSigningKey(trustRootDescriptor, enrolled.grant.signature.kid);
      verifyGrant(provider, enrolled.grant, issuerKey, {
        audience: 'happy-domain',
        subjectDeviceId: enrolled.device.identity.device_id,
        confirmationThumbprint: identityThumbprint(provider, enrolled.device.identity),
        permission: 'text',
        relayId: RELAY_ID,
        currentRevocationEpoch: 0,
      });
    }

    const alphaSink = newSink();
    const betaSink = newSink();
    const alphaPeer = makePeer(alpha, { device: 'alpha' }, alphaSink);
    const betaPeer = makePeer(beta, { device: 'beta' }, betaSink);
    peers.push(alphaPeer, betaPeer);
    alphaPeer.start();
    betaPeer.start();

    const betaManifest = await alphaPeer.openSession(beta.device.identity.device_id, { timeoutMs: 20_000 });
    expect(betaManifest).toMatchObject({ device: 'beta' });
    await waitFor(() => betaSink.manifests.length > 0, 10_000, 'beta manifest receipt');

    await alphaPeer.sendPayload(beta.device.identity.device_id, 'text', utf8Encode('{"text":"alpha→beta"}'));
    await betaPeer.sendPayload(alpha.device.identity.device_id, 'text', utf8Encode('{"text":"beta→alpha"}'));
    await waitFor(() => betaSink.payloads.length > 0, 10_000, 'beta payload');
    await waitFor(() => alphaSink.payloads.length > 0, 10_000, 'alpha payload');
    expect(betaSink.payloads[0].text).toBe('{"text":"alpha→beta"}');
    expect(alphaSink.payloads[0].text).toBe('{"text":"beta→alpha"}');

    // --- WS kill + offline queue drain: alpha goes offline; beta keeps sending. ---
    alphaPeer.stop();
    await betaPeer.sendPayload(alpha.device.identity.device_id, 'text', utf8Encode('{"text":"while alpha offline 1"}'));
    await betaPeer.sendPayload(alpha.device.identity.device_id, 'text', utf8Encode('{"text":"while alpha offline 2"}'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alphaSink.payloads.length).toBe(1); // nothing delivered while offline
    alphaPeer.start();
    await waitFor(() => alphaSink.payloads.length === 3, 15_000, 'offline queue drained after reconnect');
    expect(alphaSink.payloads.map((p) => p.text)).toContain('{"text":"while alpha offline 2"}');
  }, 90_000);

  it('rejects a replayed envelope end-to-end (relay accepts, receiver refuses)', async () => {
    const sender = await enroll(`it-replay-a-${runId}`);
    const receiver = await enroll(`it-replay-b-${runId}`);

    // Manual handshake (transported out of band here; the relay only sees envelopes).
    const senderHello = createHello(provider, sender.device, {
      sessionId: `sess-replay-${runId}`,
      peerDeviceId: receiver.device.identity.device_id,
      grantId: sender.grant.grant_id,
    });
    const receiverHello = createHello(provider, receiver.device, {
      sessionId: `sess-replay-${runId}`,
      peerDeviceId: sender.device.identity.device_id,
      grantId: receiver.grant.grant_id,
    });
    const senderState = establish(provider, senderHello, receiverHello.hello, sender.device.identity, receiver.device.identity);
    const receiverState = establish(provider, receiverHello, senderHello.hello, receiver.device.identity, sender.device.identity);
    senderState.verifyReady(provider, receiverState.createReady(provider, receiver.device), receiver.device.identity);
    receiverState.verifyReady(provider, senderState.createReady(provider, sender.device), sender.device.identity);

    const envelope = encryptEnvelope(provider, senderState, {
      messageId: `msg-replay-${runId}`,
      payloadType: 'text',
      route: { relay_id: RELAY_ID, ttl_seconds: 60, priority: 5 },
      plaintext: utf8Encode('{"text":"replay me"}'),
    });

    // Submit the same envelope twice — the relay queues both copies.
    const accessToken = sender.credentials.access.token as string;
    const receipt1 = await relayHttp.submitEnvelope(envelope, sender.device, accessToken);
    const receipt2 = await relayHttp.submitEnvelope(envelope, sender.device, accessToken);
    expect(receipt1.status).toBe('queued');
    expect(receipt2.status).toBe('queued');

    // Drain via WS and decrypt: first copy passes, second is ISCPENV002.
    const received: SecureEnvelope[] = [];
    const ws = new RelayWsClient({
      websocketUrl: relayDescriptor.websocket_url,
      relayId: RELAY_ID,
      device: receiver.device,
      provider,
      backoff: { pollIntervalMs: 150, initialDelayMs: 150, maxDelayMs: 2000, factor: 2, jitter: 0.1 },
      onEnvelope: (env) => received.push(env),
    });
    ws.start();
    try {
      await waitFor(() => received.length >= 2, 15_000, 'both envelope copies drained');
    } finally {
      ws.stop();
    }
    expect(utf8Decode(decryptEnvelope(provider, receiverState, received[0]))).toBe('{"text":"replay me"}');
    expect(() => decryptEnvelope(provider, receiverState, received[1])).toThrowError(/ISCPENV002/);
  }, 60_000);

  it('refuses connections and submissions after revocation (trust + relay access)', async () => {
    const victim = await enroll(`it-revoked-${runId}`);
    const peerDevice = await enroll(`it-revoker-peer-${runId}`);

    // --- Trust revocation: epoch bumps, grant verification fails locally and remotely. ---
    const revokedRecord = await trustRoot.revokeDevice(victim.device.identity.device_id, 'integration test');
    expect(revokedRecord.status).toBe('revoked');
    const revocations = await trustRoot.revocations();
    const epoch = revocations[victim.device.identity.device_id];
    expect(epoch).toBeGreaterThan(0);

    const issuerKey = grantSigningKey(trustRootDescriptor, victim.grant.signature.kid);
    expect(() =>
      verifyGrant(provider, victim.grant, issuerKey, {
        audience: 'happy-domain',
        subjectDeviceId: victim.device.identity.device_id,
        confirmationThumbprint: identityThumbprint(provider, victim.device.identity),
        permission: 'text',
        relayId: RELAY_ID,
        currentRevocationEpoch: epoch,
      }),
    ).toThrowError(/revoked/);

    const remoteVerdict = await trustRoot.verifyGrantRemote({
      grant: victim.grant,
      audience: 'happy-domain',
      subjectDeviceId: victim.device.identity.device_id,
      confirmationThumbprint: identityThumbprint(provider, victim.device.identity),
      permission: 'text',
      relayId: RELAY_ID,
    });
    expect(remoteVerdict).toBe(false);

    // --- Relay access revocation: envelope submission 401s, WS connect is refused. ---
    const accessToken = victim.credentials.access.token as string;
    await relayHttp.revokeAccess(victim.device.identity.device_id, accessToken);

    const envelope: SecureEnvelope = {
      type: 'iscp.secure_envelope.v2',
      domain_id: DOMAIN_ID,
      message_id: `msg-revoked-${runId}`,
      session_id: 'sess-revoked',
      sender_device_id: victim.device.identity.device_id,
      recipient_device_id: peerDevice.device.identity.device_id,
      sequence: 0,
      nonce: toBase64Url(provider.randomBytes(12)),
      payload_type: 'text',
      route: { relay_id: RELAY_ID, ttl_seconds: 60, priority: 5 },
      ciphertext: toBase64Url(provider.randomBytes(32)),
    };
    await expect(relayHttp.submitEnvelope(envelope, victim.device, accessToken)).rejects.toSatisfy(
      (error: unknown) => error instanceof IscpError && error.code === 'ISCPACCESS001',
    );

    const denials: string[] = [];
    const ws = new RelayWsClient({
      websocketUrl: relayDescriptor.websocket_url,
      relayId: RELAY_ID,
      device: victim.device,
      provider,
      backoff: { pollIntervalMs: 150, initialDelayMs: 150, maxDelayMs: 2000, factor: 2, jitter: 0.1 },
      onEnvelope: () => undefined,
      onAccessDenied: (reason) => {
        denials.push(reason);
        return false;
      },
      onError: () => undefined,
    });
    ws.start();
    try {
      await waitFor(() => denials.length > 0, 10_000, 'relay refuses revoked device');
    } finally {
      ws.stop();
    }
    expect(denials[0]).toMatch(/revoked|unknown/);

    // The refresh credential is dead too.
    await expect(relayHttp.refreshAccess(victim.credentials.refresh.token as string)).rejects.toSatisfy(
      (error: unknown) => error instanceof IscpError && error.code === 'ISCPACCESS001',
    );
  }, 60_000);

  it('register-with-ticket consumes uses and 409s when exhausted', async () => {
    const deviceOne = createDevice(provider, { domainId: DOMAIN_ID, deviceId: `it-ticket-1-${runId}` });
    const deviceTwo = createDevice(provider, { domainId: DOMAIN_ID, deviceId: `it-ticket-2-${runId}` });
    const ticket = { ticketId: `ticket-${runId}`, maxUses: 1 };
    const pair = await relayHttp.registerWithTicket(deviceOne, ticket);
    expect(pair.access.token).toBeTruthy();
    await expect(relayHttp.registerWithTicket(deviceTwo, ticket)).rejects.toSatisfy(
      (error: unknown) => error instanceof IscpError && error.code === 'ISCPPROV001',
    );
  }, 30_000);
});
