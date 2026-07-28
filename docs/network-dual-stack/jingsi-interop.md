# JingSi iOS interop (happy-wire.v1 over ISCP)

The JingSi iOS app (sibling repo `JingSi-iOS`) ships a Swift port of the ISCP
v2 stack (byte-compatible with the pin, verified against
`packages/iscp/test/vectors`) and speaks `happy-wire.v1` to the daemon's
WireResponder as a capability node client — same contract as happy-app's
ISCPHappyTransport:

- enrollment: reference-protocol bind-self / pairing ticket + trust-root
  self-authorization (local-lab), two-step with the OOB device confirmation
  code (`iscp/happy/device-confirmation\0<kid>` derivation, identical to
  happy-cli/happy-app);
- session: hello/ready through the relay (handshake envelope convention from
  `packages/iscp/src/peer.ts`), `agent.capability.v1` manifest gate;
- wire: `sessions.list/spawn`, `messages.send` (idempotencyKey = localId),
  `messages.pull` with cursor resume + stale-epoch reset, `events.subscribe`
  live push, pull-then-subscribe recovery with (sessionId, seq) dedupe.

The JingSi app sends its own manifest (`product_kind: "jingsi"`,
`runtime_kind: "jingsi-app"`); the daemon does not validate app manifests, so
no happy-side change was needed for interop.

## Cross-client acceptance

`packages/happy-cli/src/iscp/e2eDaemonRunner.ts` boots the real daemon-side
stack against the docker harness and stays alive with a small control plane
(`GET /info`, `POST /ingest`) so the Swift test suite can drive the full flow:

```sh
sudo docker compose -f environments/iscp/docker-compose.yaml up -d
cd packages/happy-cli && HAPPY_HOME_DIR=$(mktemp -d) npx tsx src/iscp/e2eDaemonRunner.ts
# JingSi-iOS repo:
ISCP_HARNESS=1 swift test --filter HarnessE2E
```

Covered end to end (Swift phone ⇄ reference relay/trust root ⇄ TS daemon):
enrollment → handshake → manifest → spawn → send idempotency → cursor resume →
stale-epoch reset → live push. Note the reference relay rate-limits bind-self;
back-to-back runs (each enrolls a fresh device) can hit `rate limit exceeded`.

## Hardening found during interop

Node's undici WebSocket was observed emitting `error` without a following
`close` under concurrent relay connections, leaving a half-dead socket that
silently stopped envelope delivery. `RelayWsClient` now has a zombie-socket
watchdog (`backoff.idleTimeoutMs`, default 60s): a connection silent that long
is abandoned and the loop reconnects. The daemon peer runs it at 15s (the
reference relay drains and closes every poll cycle, so seconds of silence
means dead). The Swift client applies the same watchdog.
