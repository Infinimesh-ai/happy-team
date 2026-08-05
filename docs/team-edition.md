# Team Edition Reference

What Team Edition is, what it added to the Happy monorepo, and the contracts it exposes. This is the reference; the operational walkthrough is [deploy/README.md](../deploy/README.md), and the milestone-by-milestone plan with its full acceptance log is [plans/team-edition.md](plans/team-edition.md).

Paths and field names reflect the current implementation. The code is canonical — when this document and `packages/happy-server/sources/team/` disagree, the code wins.

## Contents

- [Design constraints](#design-constraints)
- [Identity and authentication](#identity-and-authentication)
- [Data model](#data-model)
- [HTTP API](#http-api)
- [Provisioning](#provisioning)
- [Artifact distribution](#artifact-distribution)
- [Agent authentication modes](#agent-authentication-modes)
- [Environment variables](#environment-variables)
- [Security model](#security-model)
- [Audit actions](#audit-actions)
- [Testing](#testing)

## Design constraints

Three constraints shaped every decision below.

**Members do nothing.** A member gets an email and a password. They never see a key, never run an install command, never authenticate an agent. Everything else follows from taking this seriously.

**Target machines are hostile to installers.** Assume no root, no package manager, no public internet — only inbound SSH from the server and outbound reach back to it. Hence self-distributed Node and CLI artifacts, and user-level service persistence.

**Upstream merges must stay cheap.** New code lives in new directories with one registration point each. Existing tables are added to, never modified. The sync and encryption protocols are untouched — Team login ends by handing the app a secret key through its *existing* restore-from-key path.

The explicit non-goals: no SSO/LDAP/OAuth for Team accounts, no native mobile work (Team pages target the web build), and no strict end-to-end encryption (see [Security model](#security-model)).

## Identity and authentication

Team Edition does not replace Happy's identity model — it puts a login in front of it.

A `TeamUser` maps one-to-one onto an existing Happy `Account`. When an admin creates a member:

1. The server generates a NaCl keypair.
2. It upserts an `Account` by `publicKey` using the existing account logic.
3. It encrypts the secret key under a key derived from `HANDY_MASTER_SECRET` and stores the ciphertext in `TeamUser.encSecretKey`.

Login (`POST /v1/team/auth/login`) verifies the argon2id hash, decrypts the escrowed key, and returns:

```jsonc
{
  "happyToken": "...",          // standard Happy JWT for the linked Account
  "secretKey": "...",           // base64url-encoded 32-byte NaCl seed
  "role": "ADMIN" | "MEMBER",
  "mustChangePassword": false
}
```

The web client feeds `{ happyToken, secretKey }` into `AuthProvider.login()`, which writes `TokenStorage` and calls `syncCreate()` — the same path the manual restore-from-key screen uses. From that point every request, every sync frame and every encryption operation is stock Happy. This is why Team Edition needed no protocol changes.

The admin is seeded at startup: if no `ADMIN` exists, the server creates one from `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` with `mustChangePassword` set.

### Disabling a member

`TeamUser.status = DISABLED` must invalidate an already-issued Happy JWT, which is otherwise valid until expiry. Two checks cover both transports:

- HTTP — a check after `app.authenticate` succeeds.
- WebSocket — the handshake plus the per-event socket middleware.

Both are no-ops for plain Happy accounts with no `TeamUser` row, so a Team server still works for non-Team users.

**Disabling is not full offboarding.** It cuts the account off from the server — but nothing reaches out to the member's machine, and by design it no longer can, since the daemon is refused at the handshake and the agent-auth RPC travels over that same connection. So after disabling:

- `~/.happy-team/agent.env` still holds the company `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, readable by that OS user. They can be used directly against Anthropic or OpenAI, entirely outside Happy.
- The enrolled Happy credentials remain on disk; the daemon keeps retrying and failing.
- There is no delete-member or delete-machine endpoint — `DELETE` exists only for SSH credentials.

For a real departure, treat the company API key as compromised and rotate `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY` (which forces a re-push to every remaining machine), or wipe `~/.happy-team/` on the machine while you still have access. Disable the member **before** revoking your SSH access to their host, not after.

### Passwords

argon2id via the pure-JS `@noble/hashes` (chosen over a native argon2 binding to avoid adding a postinstall build step to the server image), PHC-format hashes, minimum length 10. Login is rate limited over a 15-minute window on the hashed `ip:email` pair, in Redis with an in-memory fallback if Redis is unavailable; rejections are audited as `login_failed` with a `reason`. Admin password resets return a one-time temporary password and force a change at next login.

## Data model

Six tables added under `packages/happy-server/prisma/schema.prisma`. `Account`, `Machine`, `Session` and everything else upstream owns are unmodified.

| Model | Purpose | Notes |
| --- | --- | --- |
| `TeamUser` | Team identity | `email` unique, `passwordHash`, `role`, `status`, `mustChangePassword`, `accountId` unique, `encSecretKey`, `claudeAuthMode`, `codexAuthMode` |
| `SshCredential` | Saved SSH access to a member machine | `encAuth` holds the encrypted password or private key; `deleteAfterUse` wipes it once provisioning succeeds |
| `ProvisionJob` | One provisioning run | `status`, `step`, append-only `log`, `hostSnapshot` (survives credential deletion), `machineId` on success |
| `EnrollToken` | One-time machine enrollment | Stores `tokenHash` only; 15-minute expiry; single use via `usedAt` |
| `TeamAgentAuthUpdate` | Per-machine agent-auth application state | Unique on `(teamUserId, machineId)`; holds target modes and `PENDING`/`APPLIED`/`FAILED` — never the generated `agent.env` or any key |
| `TeamAuditLog` | Append-only audit trail | `actorId` nullable (failed logins have no actor; the email goes in `detail`) |

Enums: `TeamRole`, `TeamUserStatus`, `SshAuthType`, `AgentAuthMode`, `ProvisionStatus`, `TeamAgentAuthUpdateStatus`.

## HTTP API

All under `/v1/team`. Everything except the artifact routes and `enroll` requires a Happy JWT plus an `ACTIVE` `TeamUser`; `admin/*` additionally requires `role = ADMIN`.

### Public / bootstrap

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/team/artifacts/cli.tgz` | CLI tarball for target machines |
| `GET` | `/v1/team/artifacts/node/:platform/:arch` | `linux\|darwin` × `x64\|arm64`; `?libc=musl` for musl targets |
| `POST` | `/v1/team/enroll` | `{ token }` → `{ secretKey }`. No JWT — the one-time enroll token is the credential |

### Member

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/team/me` | Current user; `/v1/team/auth/me` is an alias |
| `POST` | `/v1/team/auth/login` | Rate limited, audited |
| `POST` | `/v1/team/auth/change-password` | `{ oldPassword, newPassword }` |
| `GET` | `/v1/team/me/agent-auth` | Current modes plus per-machine application state |
| `PATCH` | `/v1/team/me/agent-auth` | `{ claude?, codex? }`; applies to online machines, queues for offline ones, returns an `agentAuthSync` summary |

### Admin

| Method | Path | Notes |
| --- | --- | --- |
| `GET` `POST` | `/v1/team/admin/users` | List / create (generates the Account and escrowed key) |
| `PATCH` | `/v1/team/admin/users/:id` | Enable/disable, reset password, change agent auth modes |
| `GET` | `/v1/team/admin/machines` | Team-wide: owner, online state, last heartbeat |
| `GET` `POST` | `/v1/team/admin/ssh-credentials` | Responses carry safe fields only — never the secret, plaintext or ciphertext |
| `DELETE` | `/v1/team/admin/ssh-credentials/:id` | |
| `GET` `POST` | `/v1/team/admin/provision-jobs` | List / create |
| `GET` | `/v1/team/admin/provision-jobs/:id` | Status + log; the admin UI polls every 2.5s |
| `POST` | `/v1/team/admin/provision-jobs/:id/retry` | Failed jobs only; new job, new enroll token, old token never reused |
| `POST` | `/v1/team/admin/enroll-token` | `{ targetUserId }` → plaintext token, for the manual-install path |
| `GET` | `/v1/team/admin/audit` | Paginated, filterable by action |
| `GET` | `/v1/team/admin/preflight` | Deployment readiness; statuses, paths, sizes and booleans only |

Implementation: [`routes.ts`](../packages/happy-server/sources/team/routes.ts), [`artifacts.ts`](../packages/happy-server/sources/team/artifacts.ts).

## Provisioning

`sources/team/provision/` connects with `ssh2` and runs a state machine. Jobs are queued with a concurrency limit of 3; each step updates `ProvisionJob.step` and appends timestamped output to `log`.

```
PENDING → RUNNING( connect → detect → install_node → install_cli
                 → enroll → setup_agents → start_daemon → verify ) → SUCCEEDED | FAILED
```

| Step | What it does |
| --- | --- |
| `connect` | SSH with password or private key; distinguishes auth failure, unreachable and timeout |
| `detect` | `uname -s` / `uname -m`, existing Node, existing `happy`, systemd availability, libc (`ldd` → musl) |
| `install_node` | If no Node ≥ 20, downloads a self-contained binary from the company server to `~/.happy-team/bin/node` — no root, no package manager |
| `install_cli` | Unpacks the CLI tarball to `~/.happy-team/cli` and writes `happy` / `claude` / `codex` wrappers into `~/.happy-team/bin`, bound to the Node runtime actually selected |
| `enroll` | Mints a one-time `EnrollToken`, runs `happy enroll --server <url> --token <t>` remotely |
| `setup_agents` | Writes `~/.happy-team/agent.env` mode 0600 per the member's auth modes |
| `start_daemon` | Linux: user systemd unit, falling back to plain daemon + `crontab @reboot`. macOS: user-level `~/Library/LaunchAgents/com.happy-team.daemon.plist` plus `~/.happy-team/launchd-start.sh` |
| `verify` | Polls for a `Machine` heartbeat owned by the right Account; fails after 60s with troubleshooting hints |

Two details worth knowing:

**Enrollment goes through the CLI, not the filesystem.** The provisioner never writes into `~/.happy/` directly — it calls `happy enroll`, which owns the credential format. Upstream can change that layout without breaking provisioning. `enroll` is idempotent: an already-enrolled machine refuses unless `--force`, and exit codes are meaningful so the runner can branch on them.

**The macOS plist holds no secrets.** It only invokes the wrapper, which sources `agent.env` at start. Under Claude personal OAuth the wrapper also tries to export `CLAUDE_CODE_OAUTH_TOKEN` from `~/.claude/.credentials.json`, because launchd runs outside the GUI Keychain session where Claude would otherwise find its credentials.

On success, credentials marked `deleteAfterUse` are deleted; the job keeps `hostSnapshot` for traceability.

### Manual install fallback

Every job also produces a copy-pasteable command for hosts SSH can't reach (Windows, bastion-only networks). It exports the provisioned Node onto `PATH`, enrolls, and starts the daemon — but carries **no company API key**. Instead, when a manually enrolled machine first reports `machine-alive` with no `TeamAgentAuthUpdate` row, the server creates one and pushes the member's current agent auth over encrypted RPC. That keeps API keys out of a string an admin might paste into chat.

### Platform support

| Target | State |
| --- | --- |
| Linux x64 (glibc) | Verified end to end on clean Ubuntu 24.04 |
| Linux arm64 (glibc) | Verified end to end on Ubuntu 24.04 under qemu; physical hardware unverified |
| macOS x64 / arm64 | Implemented and unit-tested; LaunchAgent persistence across a real reboot unverified |
| Linux musl (Alpine) | Out of scope by owner decision. Detection, `?libc=musl` routing and the self-containment guard remain, so enabling it means supplying an artifact, not changing code |
| Windows | No SSH provisioning; use the manual command |

## Artifact distribution

Target machines pull everything from the company server, never from the internet.

**CLI.** `Dockerfile.server` builds `happy-cli.tgz` into the image at `/opt/happy-team/artifacts/happy-cli.tgz` (override with `TEAM_CLI_ARTIFACT_PATH`). Running the server from source means building it yourself — see [deploy/README.md § 4](../deploy/README.md).

Build it with `pnpm install --force` first. [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) pins `supportedArchitectures` to Linux/macOS × x64/arm64 × glibc/musl so the optional native binaries for the Claude Agent SDK and Codex CLI materialize for platforms other than the build machine. Skip it and the tarball only serves the platform you built on — which is exactly what preflight's per-target binary checks are there to catch.

**Node.** Linux x64 glibc is served from the server container's own `process.execPath`. Everything else comes from `TEAM_NODE_ARTIFACT_DIR` (default `/opt/happy-team/artifacts/node`), which compose mounts read-only from the host `TEAM_NODE_ARTIFACT_HOST_DIR`. Flat and nested layouts both resolve:

```
linux-arm64/node            linux/arm64/node
darwin-arm64/node           linux/x64/musl/node
linux-x64-musl/node
```

Stage them with `pnpm team:node-artifacts`, which downloads from the official Node dist and verifies against `SHASUMS256.txt`. Defaults to `linux-arm64`, `darwin-arm64` and `darwin-x64`; `--version`, `--target`, `--output-dir` and `--dry-run` are available. It runs on the deployment machine, not the target.

**Validation before distribution.** The server reads each Node artifact's binary header and rejects a mismatch — a Linux ELF sitting in `darwin-arm64/` is refused with a 503 rather than shipped to a Mac. Linux musl artifacts additionally have their ELF `DT_NEEDED` entries inspected; a dependency on `libstdc++` or `libgcc_s` means the binary is not self-contained and would fail on a clean Alpine host, so it is rejected too. musl never falls back to the server runtime, which would silently install glibc Node on an Alpine target.

## Agent authentication modes

Per member and per agent, stored as `TeamUser.claudeAuthMode` / `codexAuthMode`.

**`COMPANY_API` (default).** Provisioning writes the server's `TEAM_ANTHROPIC_API_KEY` / `TEAM_OPENAI_API_KEY` (and optional `TEAM_ANTHROPIC_BASE_URL` for a corporate gateway) into `~/.happy-team/agent.env` at mode 0600, referenced by the daemon service. Zero member action; usage bills to the company.

**`PERSONAL_OAUTH`.** The company key is *removed* rather than merely ignored — `ANTHROPIC_API_KEY` takes precedence over subscription login, so leaving it in place would silently keep billing the company while the member believed otherwise. The member then runs `~/.happy-team/bin/claude login` or `~/.happy-team/bin/codex login` once. Those wrappers come from the CLI artifact's bundled native binaries, so no global install is required, and a remote session opened in the browser is enough — no physical access to the machine.

### Applying a change

The daemon exposes Machine RPC `team-apply-agent-env`, reusing the existing Socket.IO RPC rooms and per-machine encryption (the server decrypts the machine key with the member's escrowed key to encrypt the payload). The handler rewrites `agent.env` atomically, re-chmods 0600, updates the live `process.env`, and schedules a self-restart.

Offline machines get a `PENDING` `TeamAgentAuthUpdate` row, applied on the next `machine-alive`. `PATCH /v1/team/me/agent-auth` returns an applied/pending/failed summary, and `GET` reports per-machine state so pending and failed machines are visible without saving again.

Switching to Claude personal OAuth also clears any stale `CLAUDE_CODE_OAUTH_TOKEN` and re-exports a fresh one from `~/.claude/.credentials.json` so the restarted daemon inherits it. Switching back to `COMPANY_API` clears that token and requires the corresponding key to still be configured on the server.

## Environment variables

Team-specific, on the server. Base Happy variables (`DATABASE_URL`, `REDIS_URL`, the S3 set) are documented in [deployment.md](deployment.md).

| Variable | Required | Purpose |
| --- | --- | --- |
| `HANDY_MASTER_SECRET` | yes | Existing Happy secret, now **also** the root of escrowed private keys and SSH credential encryption. See the warning below |
| `ADMIN_EMAIL` | first boot | Seed admin, used only when no `ADMIN` exists |
| `ADMIN_INITIAL_PASSWORD` | first boot | Seed admin password; a change is forced at first login |
| `TEAM_PUBLIC_SERVER_URL` | yes | Base URL the server embeds in enroll, manual and artifact URLs — must be reachable **from target machines** |
| `HAPPY_PUBLIC_SERVER_URL` | yes | API URL baked into the webapp at build time — must be reachable **from browsers**. Changing it requires rebuilding `webapp` |
| `TEAM_ANTHROPIC_API_KEY` | for Claude | Company key injected under `COMPANY_API` |
| `TEAM_OPENAI_API_KEY` | for Codex | Company key injected under `COMPANY_API` |
| `TEAM_ANTHROPIC_BASE_URL` | no | Corporate gateway or proxy for Anthropic traffic |
| `TEAM_NODE_ARTIFACT_DIR` | no | In-container Node artifact root; default `/opt/happy-team/artifacts/node` |
| `TEAM_NODE_ARTIFACT_HOST_DIR` | no | Host directory compose mounts read-only into the above |
| `TEAM_CLI_ARTIFACT_PATH` | no | Override the CLI tarball path; default is the one baked into the image |
| `TEAM_NODE_ARTIFACT_VERSION` | no | Read by `pnpm team:node-artifacts` only, not by the server |
| `HAPPY_WEB_HOST` / `HAPPY_API_HOST` | proxy profile | Domains for the Caddy TLS profile |

`TEAM_PUBLIC_SERVER_URL` and `HAPPY_PUBLIC_SERVER_URL` are distinct because they are resolved from different networks. In production both are usually the same public HTTPS API domain; inside a Docker-only test the browser wants `http://localhost:3005` while the target container wants `http://server:3005`. Preflight surfaces a `localhost` value as a warning for exactly this reason.

> **`HANDY_MASTER_SECRET` now protects more than tokens.** It derives the keys encrypting escrowed member private keys and stored SSH credentials. Lose it and that ciphertext is unrecoverable; leak it and you must rotate it *and* reset every secret it protected. Keep it in a secret manager, and keep it out of the database backups it protects.

## Security model

What Team Edition protects, and what it deliberately does not.

**Not end-to-end encrypted against the server.** The server generates and escrows member private keys, so an operator with `HANDY_MASTER_SECRET` and database access can read member sessions. This is the trade for zero-touch onboarding, and it assumes a trusted corporate environment. Inter-client encryption is unchanged; the architecture leaves room to move key generation into the browser later, but that is not implemented.

**Secrets never round-trip.** SSH credential responses carry `label`, `host`, `user`, auth type and the delete-after-use flag — never the secret in any form. Preflight returns statuses, paths, sizes and booleans, never values. Provisioning logs redact SSH passwords, private keys, enroll tokens and API keys, verified by grepping persisted `ProvisionJob.log` rows during acceptance.

**Enroll tokens are one-time and short-lived.** Stored as a hash, valid 15 minutes, single use via `usedAt`. Retries mint new tokens and never reuse the old one.

**`agent.env` is 0600** and is rewritten atomically on every mode change. Company keys are removed — not shadowed — when a member switches to personal OAuth.

**Backups must be encrypted.** Postgres now holds escrowed NaCl private keys and SSH credential ciphertext. Encrypt backups, and manage the backup key separately from `HANDY_MASTER_SECRET`.

**Everything sensitive is audited.** See below.

## Audit actions

Written to `TeamAuditLog`, filterable in the admin UI:

Authentication — `login` · `login_failed` · `change_password` · `change_password_failed`

Member administration — `create_user` · `update_role` · `enable_user` · `disable_user` · `reset_password` · `update_agent_auth_mode` · `self_update_agent_auth_mode`

Machines and provisioning — `create_enroll_token` · `enroll` · `enroll_failed` · `create_ssh_credential` · `delete_ssh_credential` · `provision_created` · `provision_succeeded` · `provision_failed` · `provision_retry_created`

A single `PATCH /v1/team/admin/users/:id` can emit several of the administration actions at once — changing role and disabling in one request writes `update_role` and `disable_user` separately, so filtering by action never hides part of what happened.

`login_failed` records a `reason` (`rate_limited`, `invalid_credentials`, `disabled`) and, since there may be no actor, the attempted email in `detail`.

## Testing

Server Team code is covered by Vitest, following this repo's convention of real calls over mocks — the SSH executor is tested against a local sshd container rather than a stubbed `ssh2`.

```bash
pnpm --filter happy-server test -- sources/team
```

```bash
pnpm --filter happy-server typecheck
pnpm --filter happy typecheck
pnpm --filter happy-app typecheck
```

Unit tests are not the completion bar. Every milestone was also accepted through a real browser against a live compose stack and real target machines; the log is in [plans/team-edition.md § 14](plans/team-edition.md). Outstanding external acceptance — physical arm64/macOS hardware, macOS reboot persistence, real (non-placeholder) API key billing, and a personal-OAuth request confirmed against a personal account — is listed at the end of that document.
