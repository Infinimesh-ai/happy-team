/**
 * Cross-client acceptance runner: boots the real daemon-side ISCP stack
 * (enrollment → startDaemonIscpPeers → WireResponder over the event log)
 * against the reference harness and keeps it alive so an external client —
 * e.g. the JingSi iOS Swift stack (`ISCP_HARNESS=1 swift test` in the
 * JingSi-iOS repo) — can run the full handshake + happy-wire.v1 flow
 * against it.
 *
 *   docker compose -f environments/iscp/docker-compose.yaml up -d
 *   cd packages/happy-cli && HAPPY_HOME_DIR=$(mktemp -d) npx tsx src/iscp/e2eDaemonRunner.ts
 *
 * Control endpoints (default 127.0.0.1:18099, override ISCP_E2E_CTRL_PORT):
 *   GET  /info    → { daemonDeviceId, profileId }
 *   POST /ingest  → { sessionId, localId?, body }  (simulates a session tee
 *                    append, which fans out to events.subscribe'd peers)
 */

import fastify from 'fastify'

const RELAY_URL = process.env.ISCP_RELAY_URL ?? 'http://localhost:18080'
const TRUST_URL = process.env.ISCP_TRUST_URL ?? 'http://localhost:18081'
const CTRL_PORT = Number(process.env.ISCP_E2E_CTRL_PORT ?? 18099)

async function main(): Promise<void> {
  if (!process.env.HAPPY_HOME_DIR) {
    throw new Error('set HAPPY_HOME_DIR to a scratch directory before running')
  }
  // Dynamic imports so HAPPY_HOME_DIR is set before configuration loads.
  const { enroll } = await import('@/iscp/enrollment')
  const { DaemonIscpService } = await import('@/iscp/daemonIscp')
  const { startDaemonIscpPeers } = await import('@/iscp/daemonPeer')

  const { profileId, bundle } = await enroll({
    relayUrl: RELAY_URL,
    trustUrl: TRUST_URL,
    relayId: 'relay-local',
    trustRootId: 'trust-local',
    domainId: 'local',
    log: (line) => console.log(line),
  })
  const daemonDeviceId = bundle.device_identity.device_id

  const iscp = new DaemonIscpService()
  let spawnCounter = 0
  const peers = await startDaemonIscpPeers({
    iscp,
    getChildren: () => [],
    stopSession: () => true,
    // Unique per spawn so repeated external test runs get isolated logs.
    spawnSession: async () => ({ type: 'success' as const, sessionId: `sess-swift-e2e-${++spawnCounter}` }),
  })
  if (!peers.profiles.includes(profileId)) {
    throw new Error('daemon peer failed to come online')
  }

  const ctrl = fastify({ logger: false })
  ctrl.get('/info', async () => ({ daemonDeviceId, profileId }))
  ctrl.post('/ingest', async (request) => {
    const { sessionId, localId, body } = request.body as { sessionId: string; localId?: string; body: unknown }
    const results = iscp.ingest(profileId, sessionId, [{ localId, body }])
    return { seq: results[0].seq, deduped: results[0].deduped }
  })
  await ctrl.listen({ port: CTRL_PORT, host: '127.0.0.1' })

  console.log('')
  console.log(`e2e daemon runner online: device ${daemonDeviceId} (profile ${profileId})`)
  console.log(`control plane: http://127.0.0.1:${CTRL_PORT}  (GET /info, POST /ingest)`)

  setInterval(() => {
    console.log(`[heartbeat] peer ws state: ${peers.connectionStates().join(', ')}`)
  }, 10_000).unref?.()

  const shutdown = () => {
    peers.stop()
    void ctrl.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
