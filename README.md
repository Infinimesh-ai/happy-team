<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="320" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Happy Team Edition
</h1>

<h4 align="center">
Self-hosted Happy for a company · email + password accounts with managed keys · one-click SSH provisioning of member machines · one-sentence agent tasks that end in a pull request
</h4>

<div align="center">

[**Quick start**](#quick-start) • [**What Team Edition adds**](#what-team-edition-adds) • [**Cloud Agent**](#cloud-agent) • [**Deployment guide**](deploy/README.md) • [**Reference**](docs/team-edition.md)

</div>

---

Happy is a mobile and web client for Claude Code, Codex and other coding agents — you run `happy claude` instead of `claude` on your machine and drive the session from a browser or your phone. For what Happy is and how the base product works, read [upstream's README](https://github.com/slopus/happy#readme) and [docs](https://happy.engineering/docs/).

**Team Edition turns that into something a company can run for its employees.** One `docker compose up -d` on a company server; admins create members with an email and a password; admins point the console at a member's machine over SSH and it comes online a few minutes later with the agents already authenticated. No member ever handles a key, a token, or an install command.

**Cloud Agent is what happens next.** With machines online, a member describes a job in one sentence from the web or their phone; a multi-stage agent pipeline runs it in an isolated git worktree on their own machine and delivers a pull request. It lives on the [`cloud-agent`](#cloud-agent) branch.

This README documents this fork. Anything not described here behaves like [upstream `slopus/happy`](https://github.com/slopus/happy).

## Fork chain

This repo is two forks deep. Knowing which layer a feature came from tells you where to file a bug.

| Layer | Repo | Adds |
| --- | --- | --- |
| Base | [`slopus/happy`](https://github.com/slopus/happy) | Happy itself — app, CLI, server, wire protocol |
| Parent | [`Infinimesh-ai/happy`](https://github.com/Infinimesh-ai/happy) | ISCP dual-stack networking, in-app directory browser, resume of terminal-started sessions ([details](#inherited-from-the-parent-fork)) |
| **This repo** | [`Infinimesh-ai/happy-team`](https://github.com/Infinimesh-ai/happy-team) | **Team Edition** — everything below |

`main` follows the parent by merge (not rebase), so history stays bisectable and upstream commits keep their hashes. See [upstream-sync.md](docs/upstream-sync.md).

## What Team Edition adds

| Area | Base Happy | Team Edition |
| --- | --- | --- |
| Hosting | Hosted service at app.happy.engineering | `docker compose up -d` on your own server — Postgres, Redis, MinIO, server, webapp, optional Caddy/TLS |
| Sign-in | Scan a QR code or paste a secret key | Email + password (argon2id), ADMIN / MEMBER roles, admin seeded from env |
| Key handling | User holds the NaCl secret key | Server generates and escrows it; login returns it and reuses the existing restore-from-key path — the sync/encryption protocol is unchanged |
| Getting a machine online | Member installs the CLI and authenticates by hand | Admin enters SSH credentials once; the server installs Node + CLI, enrolls, writes agent credentials and starts the daemon |
| Agent credentials | Each user logs into Claude/Codex themselves | Company API key injected by default; members can opt into personal OAuth per agent |
| Administration | — | Members, machines, provisioning jobs, SSH credentials, audit log, deployment preflight |
| Target machine requirements | Node, network access, manual setup | No root, no public internet — only inbound SSH from the server and outbound reach to the server |
| Running work | You drive each session yourself | Also: describe a job in one sentence, get a pull request — [Cloud Agent](#cloud-agent), on a branch |

### 1. Self-hosted deployment

`docker-compose.yml` at the repo root brings up Postgres, Redis, MinIO, the server and the webapp; a `proxy` profile adds Caddy for TLS on real domains. The server container runs `prisma migrate deploy` before Fastify starts, and seeds a Team ADMIN from `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` when no admin exists yet.

Full walkthrough, env reference and backup requirements: [deploy/README.md](deploy/README.md).

### 2. Team accounts with managed keys

A `TeamUser` row sits alongside each existing Happy `Account`. Creating a member generates a NaCl keypair server-side and stores the secret key encrypted under a key derived from `HANDY_MASTER_SECRET`. Login verifies the argon2id password hash, decrypts the escrowed key, and returns `{ happyToken, secretKey, role, mustChangePassword }` — which the app feeds into its **existing** restore-from-key path. Nothing about the sync or encryption protocol changed.

Disabling a member takes effect within minutes on both transports: the HTTP `authenticate` hook and the WebSocket handshake each re-check `TeamUser.status`. Plain (non-Team) Happy accounts are unaffected. Note that this cuts off the *account*, not the machine — company API keys already written to a member's disk survive it, so read [offboarding](docs/team-edition.md#disabling-a-member) before treating disable as a departure process.

This is deliberately **not** strict end-to-end encryption — the server escrows member private keys. That is the trade the design makes for zero-touch onboarding in a trusted corporate environment; see [team-edition.md § Security model](docs/team-edition.md#security-model).

### 3. SSH provisioning

An admin picks a member, supplies (or reuses) SSH credentials, picks the agents, and hits Start Provisioning. The server drives a state machine over `ssh2`:

```
connect → detect → install_node → install_cli → enroll → setup_agents → start_daemon → verify
```

It downloads a self-contained Node binary and the CLI tarball **from the company server**, so the target machine never needs a package manager, root, or public internet access. `enroll` runs `happy enroll --server <url> --token <one-time>`, so credential-file layout stays owned by the CLI and doesn't break when upstream changes it. Persistence is a user-level systemd unit on Linux (with a `crontab @reboot` fallback), or a user-level LaunchAgent on macOS.

Job logs are redacted — SSH passwords, private keys, enroll tokens and API keys never reach the database. A failed job gets a Retry button that mints a fresh token; the old one is never reused. Every job also emits a copy-pasteable **Manual Command** for hosts SSH can't reach (Windows, bastion-only networks).

### 4. Agent authentication modes

Per member, per agent (`claudeAuthMode` / `codexAuthMode`):

- **Company API (default)** — provisioning writes `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` into `~/.happy-team/agent.env` (mode 0600) from the server's `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY`. Members do nothing; usage bills to the company.
- **Personal OAuth** — the company key is *removed* (an `ANTHROPIC_API_KEY` in the environment overrides subscription login, so leaving it would silently keep billing the company). The member then runs `~/.happy-team/bin/claude login` or `~/.happy-team/bin/codex login` once — reachable from a remote session in the browser, no physical access to the machine needed.

Switching modes goes out over an encrypted Machine RPC (`team-apply-agent-env`) which rewrites `agent.env` atomically and restarts the daemon. If the machine is offline the change is queued as a `TeamAgentAuthUpdate` row and applied on the next `machine-alive`. Both the member's own settings page and the admin members page can change it.

### 5. Admin console and preflight

Under `/team/admin/`: **users** (create, disable, reset password, change agent auth), **machines** (owner, online state, last heartbeat), **provision** (wizard, live logs, retry, saved SSH credentials), **audit** (filterable by action), and **preflight**.

Deployment Preflight (`GET /v1/team/admin/preflight`) answers "will provisioning actually work from here?" before you touch a real machine — public URLs, CLI artifact, per-platform Node artifacts, and whether the bundled `happy-cli.tgz` really contains the Claude Agent SDK and Codex native binaries for each target platform. It returns statuses, paths and booleans only — never secret values.

## Cloud Agent

> On the **`cloud-agent`** branch, not merged into `main`. Code-complete with tests green; every milestone still carries an owner end-to-end acceptance step. See [status](#status-and-known-limits).

Team Edition ends with a machine that is online and authenticated. Cloud Agent is what runs on it: a member writes one sentence in **Settings → Tasks**, picks a machine, a repository and a template, and a multi-stage agent pipeline executes it inside an isolated git worktree, ending in a pull request.

```
New Task
   │   prepare worktree: happy/<user>/<slug>, team skills mounted, task MCP attached
   ▼
  plan ──[approve]──► execute ──► verify ──┬─ passed ──────► deliver: gh pr create / glab mr create
 Claude   supervised    Codex     Claude   ├─ failed ──────► execute   (round++, up to maxRounds)
read-only    only                + real    └─ budget out ──► escalate to a human
                                gate output
```

Four templates ship: `execute-only` (one-shot), `plan-execute` (plan approved before code is written), `plan-execute-verify` (closed loop with bounded rework), and `skills-curator` (runs against the team's skills repo and proposes revisions). Tasks run **supervised** — parked for human approval on marked edges — or **autonomous**, where the same pipeline runs unattended.

Five things make it more than a prompt in a loop:

- **The server owns control flow.** Agents don't decide what happens next; they declare intent through MCP tools (`complete_stage`, `report_blocker`, `request_transition`) and the server adjudicates each one against the template. Every decision, *including rejections*, lands in a per-task black box you can replay.
- **Stages hand off through files,** not conversation history — `.happy-task/plan.md`, `findings.md`, `pr.md`. That's what lets Claude plan, a human edit the plan mid-flight, and Codex execute it. Each artifact has a frontmatter contract, so "the file exists" can't pass as done.
- **The reviewer is handed real evidence.** Before a verify stage starts, the daemon runs the project's own validation command in the worktree and injects the actual output into the prompt. A reviewer that's merely *asked* to run the tests is being trusted twice.
- **Delivery is mechanical and fenced.** No agent pushes anything. The daemon does it, and refuses any branch not prefixed `happy/` — writing a file cannot get you a push to `main`.
- **Policy is content, not code.** Prompts reference team skills mounted from a separate repository and pinned per task by commit, under a content contract (`repo:`, `validation:`, a per-skill line budget) the product knows how to check. Changing how the team works is a PR in that repo, not a release here.

Reference — templates, state machine, MCP surface, artifact contract, API, security model and the honest gap list: [docs/cloud-agent.md](docs/cloud-agent.md).

## Quick start

Requires Docker with Compose v2.

```bash
cp .env.example .env
```

Fill in at least `HANDY_MASTER_SECRET`, `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` and one company API key — [deploy/README.md § 1](deploy/README.md) has a copy-pasteable generator for the random values. `.env` is gitignored; never commit it. Compose refuses to start if a required value is missing, naming the one it wants. Then:

```bash
docker compose build && docker compose up -d
```

Open `http://localhost:8080/team/login`, sign in with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`, change the password when prompted, then run **Deployment Preflight** before creating your first member.

Local ports: webapp `8080`, server API `3005`, MinIO console `9001`.

For non-x64 or macOS targets, stage self-contained Node binaries first:

```bash
pnpm team:node-artifacts
```

### Developing on the fork

```bash
pnpm install --force
```

`--force` matters: [`pnpm-workspace.yaml`](pnpm-workspace.yaml) uses `supportedArchitectures` to materialize the Linux/macOS × x64/arm64 (glibc and musl) native binaries for the Claude Agent SDK and Codex CLI. Without them the CLI tarball only serves the platform you built on.

```bash
pnpm --filter happy-server typecheck
pnpm --filter happy typecheck
pnpm --filter happy-app typecheck
```

Fork tests, narrowed to the directories this fork owns:

```bash
pnpm --filter happy-server exec vitest run sources/team
pnpm --filter happy exec vitest run --project unit src/team
```

Use `exec vitest run <path>`, not `test -- <path>` — the package `test` scripts don't forward a path filter, so the latter quietly runs the whole suite instead of the part you asked for.

The server package is `happy-server`; the separate `happy-server-self-host` package is only the standalone publishing wrapper. App and CLI development (Expo, native builds, local server) is covered in the [Contributing Guide](docs/CONTRIBUTING.md).

## Architecture

```
┌─────────────────────────── company server ───────────────────────────┐
│                                                                      │
│  webapp (browser)                  server (packages/happy-server)    │
│  ├─ /team/login  ────────────────► sources/team/                     │
│  ├─ /team/admin/* (ADMIN only)     ├─ teamUsers, passwords, escrow   │
│  ├─ /team/agent-auth               ├─ enrollTokens, agentAuth        │
│  ├─ /team/tasks/* (task board)     ├─ provision/{runner,ssh}         │
│  └─ session UI (unchanged)         ├─ artifacts, preflight, audit    │
│                                    ├─ tasks/ state machine + tokens  │
│  Postgres   Redis   MinIO   Caddy  └─ existing sync/session/machine  │
└──────────────────────────────────────────────────────────────────────┘
        │ SSH (one-time bootstrap)       ▲ WebSocket 443 (outbound)
        ▼                                │ machine RPC · task intents
   member machine ── happy daemon ── claude / codex
   ~/.happy-team/{bin,cli,agent.env}
   ~/.happy/{worktrees/<taskId>, team-skills}
```

The daemon dials out, so member machines never expose a port. SSH is used exactly once, for bootstrap. Task stages are ordinary Happy sessions — spawned by the server into a worktree, with a task-scoped MCP server attached.

### Where the code lives

New code is deliberately confined to new directories with a single registration point each, so upstream merges stay cheap:

| Path | Contents |
| --- | --- |
| [`packages/happy-server/sources/team/`](packages/happy-server/sources/team/) | All server-side Team code — auth, escrow, provisioning, artifacts, audit |
| [`packages/happy-server/sources/team/tasks/`](packages/happy-server/sources/team/tasks/) | Cloud Agent — templates, state machine, task tokens, artifact and skills contracts |
| [`packages/happy-app/sources/app/(app)/team/`](packages/happy-app/sources/app/%28app%29/team/) | Login, change-password, agent-auth, the admin pages and the task board |
| [`packages/happy-app/sources/team/api.ts`](packages/happy-app/sources/team/api.ts) | Typed client for `/v1/team/*` |
| [`packages/happy-cli/src/commands/enroll.ts`](packages/happy-cli/src/commands/enroll.ts) | `happy enroll` |
| [`packages/happy-cli/src/team/tasks/`](packages/happy-cli/src/team/tasks/) | Cloud Agent daemon side — worktrees, skills injection, validation gate, delivery, MCP servers |
| [`scripts/team-node-artifacts.cjs`](scripts/team-node-artifacts.cjs) | Downloads + SHA256-verifies Node artifacts for provisioning |
| `docker-compose.yml`, `Dockerfile.server`, `deploy/` | Self-hosted deployment |

Existing `Account` / `Machine` / `Session` tables are not modified — Team Edition and Cloud Agent only add tables.

## Status and known limits

### Team Edition (`main`)

Milestones M0–M3 are implemented and were accepted against a live compose stack, real browsers and real target machines. Honest gaps:

- **Verified end to end:** Linux x64 (Ubuntu 24.04, glibc) and Linux arm64 (Ubuntu 24.04 under qemu) — clean machines with no Node and no Happy, provisioned to an online daemon.
- **Not verified on real hardware:** physical arm64, and macOS (the LaunchAgent path is implemented and unit-tested, but persistence across a real reboot is unconfirmed).
- **Company API keys were placeholders** during acceptance — key injection and process environment were verified, actual Claude/OpenAI billing was not.
- **Personal OAuth** was verified as far as the mode switch, key removal and daemon restart; no personal account was available to confirm a request actually billed to it.
- **Alpine/musl is closed as out of scope** by owner decision (targets are Ubuntu x64 with root). The libc detection, `?libc=musl` artifact routing and ELF `DT_NEEDED` self-containment guard all remain in place, so supporting it later means supplying an artifact, not changing code.
- **Windows** targets are not SSH-provisionable; use the Manual Command.
- **No SSO/LDAP/OAuth login** for Team accounts, and no native mobile work — Team pages target the web build.

Full acceptance log and the reasoning behind each decision: [docs/plans/team-edition.md](docs/plans/team-edition.md).

### Cloud Agent (`cloud-agent` branch)

Milestones C0–C4 are code-complete with unit and integration tests green, and **none has been accepted end to end** — each carries an owner acceptance step needing a real machine, a real browser and real GitHub/GitLab. Don't run this in production yet.

- **Proven without a real machine:** the whole spine against real git — worktree creation on a local bare origin, a simulated agent committing `pr.md`, session exit, artifact validation, a real push, delivery, `SUCCEEDED` — plus the negative case where a missing `pr.md` blocks the push. Untested is narrow: encrypted transport to a live daemon, real `gh`/`glab` calls, real agents calling the MCP tools, and the browser UI.
- **Implemented but not wired to any caller:** pre-distribution skills validation (an unfit ref isn't refused automatically), task-prerequisite detection (a machine missing `gh` fails at delivery rather than warning at provisioning), telemetry aggregation (no route returns it), skills-repo scaffolding, and periodic curator scheduling (a curator run is created like any other task).
- **`findings.md` is not enforced** as a completion gate; whether to require it on the failed path is left open until real-machine observation.
- **No sandbox of its own** — a task can do whatever the member's daemon can do, with the agent credentials Team Edition provisioned.
- **Not integrated with ISCP dual-stack,** and Windows machines can't run tasks (they can't be SSH-provisioned).

Reference and the full gap list: [docs/cloud-agent.md](docs/cloud-agent.md). Acceptance steps, milestone by milestone: [docs/plans/cloud-agent-tasks-progress.md](docs/plans/cloud-agent-tasks-progress.md).

## Inherited from the parent fork

These come from [`Infinimesh-ai/happy`](https://github.com/Infinimesh-ai/happy) and are present here, but are not what this fork is about:

- **Directory browser and session resume** in the new-session flow — browse the machine's tree instead of typing paths, and resume sessions started in your terminal from `~/.claude/projects` / `~/.codex/sessions`.
- **ISCP dual-stack networking** ([`packages/iscp`](packages/iscp/README.md)) — an opt-in transport that reaches the daemon over [ISCP v2](https://github.com/Infinimesh-ai/ISCP) instead of happy-server. Off by default; **not integrated with Team Edition** — Team auth, provisioning and the admin console all assume the happy-server path.

Details: [docs/network-dual-stack/](docs/network-dual-stack/), and the parent fork's README.

## Documentation

| Doc | What's in it |
| --- | --- |
| [deploy/README.md](deploy/README.md) | Deployment walkthrough: env, TLS, artifacts, provisioning, preflight, backup/restore, upgrades, key rotation, offboarding (zh) |
| [deploy/troubleshooting.md](deploy/troubleshooting.md) | Symptom-indexed troubleshooting, with the real error strings from each provisioning step (zh) |
| [docs/team-edition.md](docs/team-edition.md) | Reference: data model, API surface, provisioning state machine, env vars, security model |
| [docs/cloud-agent.md](docs/cloud-agent.md) | Reference: templates, task state machine, MCP tool surface, artifact and skills contracts, security model |
| [.env.example](.env.example) | Annotated environment template — every variable, which are required, and why the two public URLs differ (zh) |
| [docs/plans/team-edition.md](docs/plans/team-edition.md) | The implementation plan and full acceptance log, milestone by milestone (zh) |
| [docs/plans/cloud-agent-tasks.md](docs/plans/cloud-agent-tasks.md) | Cloud Agent blueprint and acceptance criteria; [progress](docs/plans/cloud-agent-tasks-progress.md) is the single source of truth for state (zh) |
| [docs/upstream-sync.md](docs/upstream-sync.md) | Merging from the parent fork and upstream without breaking Team boundaries |
| [docs/README.md](docs/README.md) | Index of everything else, fork-specific and inherited |

## Credits

Happy is by [slopus/happy](https://github.com/slopus/happy) and its contributors — all credit for the product goes to them. Please don't file this fork's issues on their tracker; open them [here](https://github.com/Infinimesh-ai/happy-team/issues). Their [Discord](https://discord.gg/fX9WBAhyfD) is the right place for questions about Happy itself.

## License

MIT License — see [LICENSE](LICENSE) for details.
