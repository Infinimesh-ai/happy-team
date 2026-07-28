<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="320" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Happy — Infinimesh fork
</h1>

<h4 align="center">
ISCP dual-stack networking · a real path browser and terminal-session resume · Grok as an ACP agent
</h4>

<div align="center">

[**Upstream repo**](https://github.com/slopus/happy) • [**Upstream docs**](https://happy.engineering/docs/) • [**What's different**](#whats-different) • [**Running this fork**](#running-this-fork)

</div>

---

Happy is a mobile and web client for Claude Code, Codex, Gemini and other coding agents — you run `happy claude` instead of `claude` on your machine and drive the session from your phone, end-to-end encrypted. For what Happy is, how to install it, and how to use it, read [upstream's README](https://github.com/slopus/happy#readme) and [docs](https://happy.engineering/docs/).

**This README only documents what this fork changes.** Anything not described here behaves exactly like upstream `slopus/happy`.

## What's different

| Area | Upstream | This fork |
| --- | --- | --- |
| Picking a project folder | Type the absolute path by hand | Browse the machine's directory tree in the app |
| Resuming a session you started in the terminal | Not available | Conversation picker over `~/.claude/projects` and `~/.codex/sessions` |
| Networking | App ⇄ happy-server (Socket.IO + HTTP), master-secret E2E | Same by default, **plus** an opt-in ISCP v2 stack that bypasses happy-server entirely |
| Session history in ISCP mode | Stored server-side | The daemon's own event log is the only source; app pulls by cursor |
| Identity in ISCP mode | Account + master secret | Per-device Ed25519 key, pairing-ticket provisioning, isolated network profiles |
| Agents | `claude`, `codex`, `gemini`, `agy`, `acp <agent>` | `happy grok` (xAI Grok Build CLI) on a branch, plus generic ACP fixes |
| happy-server | — | Untouched (zero diff) |

Two of these are on `main`; Grok lives on its own branch. See [Branch layout](#branch-layout).

## 1. Browse and resume in the new-session flow

On `main`. Two additions to the screen you use to start a session on a remote machine:

**Directory browser.** A Browse section in the path picker, backed by a new `machine-list-directory` daemon RPC — read-only, confined to the daemon user's home directory, and it marks which entries are git repos. No more typing paths from memory on a phone keyboard.

**Resume conversations started outside Happy.** A Conversation picker lists sessions found in `~/.claude/projects` and `~/.codex/sessions` and resumes them through the normal spawn path, so a session you opened in your terminal this morning is reachable from your phone at lunch. It is also reachable from the native composer's settings sheet inside a running session.

Discovery is pluggable rather than hardcoded: a `list-local-sessions` RPC resolves through a provider registry (`claude` and `codex` built in, `registerLocalSessionProvider` for anything else), and agents without a provider simply hide the picker.

## 2. ISCP dual-stack networking

On `main` — the largest change in this fork (~11k lines, a new workspace package). **Opt-in and off by default:** without a network profile, every byte of the existing happy-server path is unchanged, and existing users have nothing to migrate.

The idea: let the app reach its agents over [ISCP v2](https://github.com/Infinimesh-ai/ISCP) — the protocol maintained by the same organization as this fork — instead of happy-server, without forking the app into two codebases.

- **`packages/iscp`** — a TypeScript ISCP v2 client ([@slopus/iscp](packages/iscp/README.md)) implemented from a pinned spec revision, validated against the upstream conformance vectors, running on both Node (happy-cli) and React Native/Hermes (happy-app).
- **A transport port.** All app networking goes through a `HappyTransport` interface. `LegacyHappyTransport` preserves today's behavior; `ISCPHappyTransport` speaks a `happy-wire.v1` method set (`sessions.list/spawn`, `messages.send/pull`, `events.subscribe`, `session.rpc`, `machine.rpc`) to the daemon.
- **The daemon is the only history source.** It keeps an append-only event log per session on the agent machine; the app pulls by cursor and subscribes for live push. The relay does online delivery plus a short-TTL offline queue — no server-side ciphertext at rest.
- **One layer of encryption, not two.** ISCP mode uses the ISCP session's ChaCha20-Poly1305 envelope (`iscp_session_v1`) with no Happy inner layer, and happy-server is not in the path at all.
- **Enrollment instead of login.** Each Happy device (daemon and app separately) generates its own Ed25519 identity; a one-time pairing ticket opens a local secure channel confirmed by an out-of-band code, and only then is a provisioning bundle delivered. `happy iscp enroll` on the CLI, a dev-menu screen in the app.
- **Profiles isolate everything.** A network profile is the unit of identity, storage namespace and logout: wiping one touches only its own MMKV instance, SecureStore entry and transport, and can never disturb the legacy account.
- **Verified across languages.** The sibling `JingSi-iOS` app's Swift port of the same stack drives the real TS daemon end to end — enrollment, handshake, capability manifest, spawn, send idempotency, cursor resume, stale-epoch reset, live push ([details](docs/network-dual-stack/jingsi-interop.md)).

**Status.** Phases 0–3 are landed and covered by an e2e acceptance run against a local relay/trust-root harness; Phases 4–5 exist only as interface seams. Known and accepted gaps in ISCP mode: **no push notifications**, no history while the daemon is offline, and happy-server-backed extras (feed, friends, GitHub, voice, KV, usage, attachment upload) are hidden. These are documented, not bugs to file — see [inventory.md §4](docs/network-dual-stack/inventory.md).

## 3. Grok as a first-class ACP agent

On the [`spport-grok-cli`](https://github.com/Infinimesh-ai/happy/tree/spport-grok-cli) branch, not merged, no upstream PR — it stays a branch while the grok CLI itself iterates quickly.

`happy grok` runs the xAI Grok Build CLI over ACP with its own branding, session resume, token telemetry and a correct context-window reading. Most of the work underneath is generic and helps every ACP agent: permission options matched by `kind` instead of Codex/Gemini id heuristics, client-side `acceptEdits` / `bypassPermissions` for agents that expose no approval config of their own, `session/load` resume with replay suppression, and typewriter streaming through an ephemeral encrypted draft channel.

Full write-up, usage and known limitations: [that branch's README](https://github.com/Infinimesh-ai/happy/blob/spport-grok-cli/README.md).

## Branch layout

| Branch | Contents |
| --- | --- |
| [`main`](https://github.com/Infinimesh-ai/happy/tree/main) | Upstream `main` + sections 1 and 2 |
| [`spport-grok-cli`](https://github.com/Infinimesh-ai/happy/tree/spport-grok-cli) | `main` + section 3 |

`main` follows upstream by merge (not rebase), so fork history stays bisectable and upstream commits keep their hashes. The dual-stack work was developed on a local `iscp-dual-stack` branch and merged in `ce92f7af`.

## Running this fork

The `happy` npm package, the App Store / Play Store builds and [app.happy.engineering](https://app.happy.engineering) are all **upstream's** — none of the changes above are in them. Build from source:

```bash
git clone https://github.com/Infinimesh-ai/happy.git
cd happy
pnpm install
```

```bash
pnpm --filter happy cli:install    # build + link this workspace as your global `happy`
```

That replaces the npm-installed binary with a symlink to this checkout and reuses `~/.happy/`. To go back to upstream: `npm unlink -g happy && npm i -g happy@latest`. Set `HAPPY_HOME_DIR=~/.happy-dev` to sandbox dev data instead.

For the client, `pnpm --filter happy-app start` (Expo) or `pnpm web`. Requires Node >= 20 and pnpm; build variants, native builds and the local server are covered in the [Contributing Guide](docs/CONTRIBUTING.md).

### Trying ISCP mode

The local lab runs a reference relay and trust root in Docker:

```bash
sudo docker compose -f environments/iscp/docker-compose.yaml up -d
```

```bash
happy iscp enroll          # bind-self dev flow; prints the OOB confirmation code
happy iscp status          # show enrolled profiles
```

Enrollment writes `~/.happy/iscp/<profileId>/`; the daemon then serves that profile over ISCP while the legacy path keeps working untouched. `happy iscp help` lists the relay/trust-root/domain flags.

## Fork-specific docs

| Doc | What's in it |
| --- | --- |
| [network-dual-stack/inventory.md](docs/network-dual-stack/inventory.md) | Frozen Phase 0 decisions, every app/CLI network touchpoint classified, namespace + logout contract, explicit gaps (zh) |
| [network-dual-stack/enrollment.md](docs/network-dual-stack/enrollment.md) | Pairing ticket → secure channel → provisioning bundle, failure and revocation semantics (zh) |
| [network-dual-stack/jingsi-interop.md](docs/network-dual-stack/jingsi-interop.md) | Swift ⇄ TS cross-client acceptance, and the zombie-socket watchdog it uncovered |
| [packages/iscp/README.md](packages/iscp/README.md) | Spec pinning and how conformance vectors are generated |

Everything else in [docs/](docs/README.md) is upstream's and describes the legacy stack.

## Upstream

All credit for Happy goes to [slopus/happy](https://github.com/slopus/happy) and its contributors. Please don't file this fork's issues on upstream's tracker — open them [here](https://github.com/Infinimesh-ai/happy/issues) instead. Upstream's [Contributing Guide](docs/CONTRIBUTING.md) still describes the development workflow, and their [Discord](https://discord.gg/fX9WBAhyfD) is the place for questions about Happy itself.

## License

MIT License — see [LICENSE](LICENSE) for details.
