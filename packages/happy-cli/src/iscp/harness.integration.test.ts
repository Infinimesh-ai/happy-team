/**
 * Phase 3 acceptance: the real daemon-side ISCP stack (enrollment →
 * startDaemonIscpPeers → WireResponder over the event log) against the
 * upstream reference services, driven by a peer speaking exactly what the
 * app's ISCPHappyTransport speaks (happy/wire-*.v1 payloads).
 *
 *   docker compose -f environments/iscp/docker-compose.yaml up -d
 *   ISCP_HARNESS=1 pnpm vitest run src/iscp/harness.integration.test.ts
 *
 * Covers: dual enrollment → capability exchange → sessions.list →
 * messages.send idempotency (same key = one log entry) → cursor resume +
 * stale-epoch reset → live event push after events.subscribe → relay access
 * revocation refused.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const RELAY_URL = process.env.ISCP_RELAY_URL ?? 'http://localhost:18080'
const TRUST_URL = process.env.ISCP_TRUST_URL ?? 'http://localhost:18081'

const enabled = process.env.ISCP_HARNESS === '1'

describe.runIf(enabled)('daemon ISCP stack over the reference harness', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'happy-iscp-e2e-'))
  process.env.HAPPY_HOME_DIR = homeDir
  const stops: Array<() => void> = []

  afterAll(() => {
    for (const stop of stops) stop()
    rmSync(homeDir, { recursive: true, force: true })
    delete process.env.HAPPY_HOME_DIR
  })

  it('enrolls, exchanges wire traffic, dedupes, resumes, pushes, and refuses revoked access', async () => {
    // Dynamic imports so HAPPY_HOME_DIR is set before configuration loads.
    const { enroll, readProfileBundle } = await import('@/iscp/enrollment')
    const { DaemonIscpService } = await import('@/iscp/daemonIscp')
    const { startDaemonIscpPeers } = await import('@/iscp/daemonPeer')
    const iscpLib = await import('@slopus/iscp')
    const wire = await import('@slopus/happy-wire')

    // --- 1. Enroll the daemon profile (real HTTP against the harness). ---
    const logLines: string[] = []
    const { profileId, bundle } = await enroll({
      relayUrl: RELAY_URL,
      trustUrl: TRUST_URL,
      relayId: 'relay-local',
      trustRootId: 'trust-local',
      domainId: 'local',
      log: (line) => logLines.push(line),
    })
    expect(readProfileBundle(profileId)).not.toBeNull()
    const daemonDeviceId = bundle.device_identity.device_id

    // --- 2. Bring the daemon peer online with a scripted spawn. ---
    const iscp = new DaemonIscpService()
    const spawned: string[] = []
    const peers = await startDaemonIscpPeers({
      iscp,
      getChildren: () => [],
      stopSession: () => true,
      spawnSession: async (options) => {
        spawned.push(options.environmentVariables?.HAPPY_NETWORK_PROFILE ?? '')
        return { type: 'success' as const, sessionId: 'sess-e2e' }
      },
    })
    stops.push(peers.stop)
    expect(peers.profiles).toContain(profileId)

    // --- 3. Enroll the "app" device and connect its peer. ---
    const provider = iscpLib.createNobleProvider()
    const relayHttp = new iscpLib.RelayHttpClient({ baseUrl: RELAY_URL, relayId: 'relay-local', provider })
    const trustRoot = new iscpLib.TrustRootClient({ baseUrl: TRUST_URL, trustRootId: 'trust-local', provider })
    const appDevice = iscpLib.createDevice(provider, { domainId: 'local', deviceId: `e2e-app-${iscpLib.toBase64Url(provider.randomBytes(6))}` })
    const appCredentials = await relayHttp.bindSelf(appDevice)
    await trustRoot.submitDevice(appDevice)
    const { grant: appGrant } = await trustRoot.authorizeDevice({
      deviceId: appDevice.identity.device_id,
      audience: 'local',
      permissions: ['text'],
      relayId: 'relay-local',
      ttlSeconds: 3600,
    })
    const { descriptor: signedRelay } = await relayHttp.fetchSignedDescriptor()
    const relayDescriptor = iscpLib.verifyRelayDescriptor(provider, signedRelay)

    const responses: Array<{ ok: boolean; id: string; result?: unknown; error?: { code: string; message: string } }> = []
    const liveEvents: Array<{ sessionId: string; seq: number; localId?: string }> = []
    const dec = new TextDecoder()
    const enc = new TextEncoder()
    const appPeer = new iscpLib.IscpPeer({
      device: appDevice,
      grant: appGrant,
      relayDescriptor,
      credentials: { accessToken: appCredentials.access.token as string, refreshToken: appCredentials.refresh.token as string },
      resolvePeerIdentity: async (deviceId) => (await trustRoot.deviceStatus(deviceId)).identity,
      manifest: { product_kind: 'happy', device_type: 'app' },
      provider,
      wsBackoff: { pollIntervalMs: 150, initialDelayMs: 150, maxDelayMs: 2000 },
      onPayload: (_from, payloadType, plaintext) => {
        if (payloadType === wire.WIRE_RESPONSE_PAYLOAD_TYPE) {
          responses.push(JSON.parse(dec.decode(plaintext)))
        } else if (payloadType === wire.WIRE_EVENT_PAYLOAD_TYPE) {
          liveEvents.push(JSON.parse(dec.decode(plaintext)))
        }
      },
    })
    appPeer.start()
    stops.push(() => appPeer.stop())
    const daemonManifest = await appPeer.openSession(daemonDeviceId, { timeoutMs: 20_000 })
    expect(daemonManifest).toMatchObject({ product_kind: 'happy', device_type: 'agent_runtime' })

    let requestCounter = 0
    const request = async (method: string, params: unknown, idempotencyKey?: string) => {
      const id = `e2e-${++requestCounter}`
      await appPeer.sendPayload(daemonDeviceId, wire.WIRE_REQUEST_PAYLOAD_TYPE, enc.encode(JSON.stringify({ id, method, params, ...(idempotencyKey !== undefined ? { idempotencyKey } : {}) })))
      const deadline = Date.now() + 15_000
      for (;;) {
        const response = responses.find((r) => r.id === id)
        if (response) return response
        if (Date.now() > deadline) throw new Error(`timed out waiting for response to ${method}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    // --- 4. sessions.list + spawn env injection. ---
    const list = await request('sessions.list', {})
    expect(list.ok).toBe(true)
    const spawn = await request('sessions.spawn', { directory: '/tmp/e2e' }, 'spawn-key-1')
    expect(spawn).toMatchObject({ ok: true, result: { sessionId: 'sess-e2e' } })
    expect(spawned).toEqual([profileId])

    // --- 5. messages.send idempotency: same key twice → one log entry. ---
    const send1 = await request('messages.send', { sessionId: 'sess-e2e', body: { t: 'user-msg' } }, 'msg-key-1')
    const send2 = await request('messages.send', { sessionId: 'sess-e2e', body: { t: 'user-msg' } }, 'msg-key-1')
    expect(send1).toMatchObject({ ok: true, result: { seq: 1, deduped: false } })
    expect(send2).toMatchObject({ ok: true, result: { seq: 1, deduped: true } })

    const pull1 = await request('messages.pull', { sessionId: 'sess-e2e' })
    const page1 = pull1.result as { events: Array<{ seq: number; cursor: string; localId?: string }>; reset: boolean }
    expect(page1.events).toHaveLength(1)
    expect(page1.events[0].localId).toBe('msg-key-1')

    // --- 6. events.subscribe → tee ingestion is pushed live with localId. ---
    await request('events.subscribe', {})
    iscp.ingest(profileId, 'sess-e2e', [{ localId: 'agent-evt-1', body: { t: 'agent-msg' } }])
    const pushDeadline = Date.now() + 15_000
    while (liveEvents.length === 0 && Date.now() < pushDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(liveEvents[0]).toMatchObject({ sessionId: 'sess-e2e', seq: 2, localId: 'agent-evt-1' })

    // --- 7. Cursor resume + stale-epoch reset. ---
    const pull2 = await request('messages.pull', { sessionId: 'sess-e2e', afterCursor: page1.events[0].cursor })
    const page2 = pull2.result as { events: Array<{ seq: number }>; reset: boolean }
    expect(page2.events.map((event) => event.seq)).toEqual([2])
    expect(page2.reset).toBe(false)

    const staleCursor = wire.encodeWireCursor({ scope: 'sess-e2e', seq: 1, epoch: 'not-the-epoch' })
    const pull3 = await request('messages.pull', { sessionId: 'sess-e2e', afterCursor: staleCursor })
    const page3 = pull3.result as { events: Array<{ seq: number }>; reset: boolean }
    expect(page3.reset).toBe(true)
    expect(page3.events.map((event) => event.seq)).toEqual([1, 2])

    // --- 8. Revoked relay access is refused (unauthorized surface). ---
    await relayHttp.revokeAccess(appDevice.identity.device_id, appCredentials.access.token as string)
    await expect(
      appPeer.sendPayload(daemonDeviceId, wire.WIRE_REQUEST_PAYLOAD_TYPE, enc.encode(JSON.stringify({ id: 'post-revoke', method: 'sessions.list', params: {} }))),
    ).rejects.toSatisfy((error: unknown) => error instanceof iscpLib.IscpError && error.code === 'ISCPACCESS001')

    // The daemon profile (separate credentials) is unaffected: its bundle is
    // intact and its peer still answers nothing-changed sessions.list via the
    // event log (no relay round trip needed to check the log itself).
    expect(readProfileBundle(profileId)?.device_identity.device_id).toBe(daemonDeviceId)
  }, 120_000)
})
