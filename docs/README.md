# Happy Docs

Internal documentation for this repository. It covers four layers, and knowing which one a document belongs to tells you how much to trust it for *this* fork:

1. **Team Edition** — what this fork adds. Written here, current.
2. **Cloud Agent** — agent task orchestration built on top of Team Edition. Written here, current; merged into `main` (2026-08-04) but not yet accepted end to end.
3. **Parent fork** — ISCP dual-stack networking, inherited from [`Infinimesh-ai/happy`](https://github.com/Infinimesh-ai/happy).
4. **Base Happy** — inherited from [`slopus/happy`](https://github.com/slopus/happy). Describes the stock product; still accurate except where Team Edition adds on top.

Start with the [root README](../README.md) for what this fork is.

## Team Edition

- [team-edition.md](team-edition.md): Reference — identity, data model, HTTP API, provisioning state machine, artifact distribution, agent auth modes, env vars, security model.
- [../deploy/README.md](../deploy/README.md): Deployment walkthrough — env setup, TLS, Node/CLI artifacts, provisioning, preflight, backup/restore, upgrades, secret rotation, offboarding (zh).
- [../deploy/troubleshooting.md](../deploy/troubleshooting.md): Symptom-indexed troubleshooting — per-step provisioning failures with the real error strings, artifact 503 causes, silent daemon-persistence downgrades (zh).
- [../.env.example](../.env.example): Annotated environment template; required vs optional, and why `HAPPY_PUBLIC_SERVER_URL` and `TEAM_PUBLIC_SERVER_URL` are separate (zh).
- [plans/team-edition.md](plans/team-edition.md): The implementation plan, decisions that are settled and not up for re-litigation, and the full acceptance log per milestone (zh).
- [upstream-sync.md](upstream-sync.md): Merging from the parent fork and upstream without breaking Team boundaries.

Team Edition touches `packages/happy-server/sources/team/`, `packages/happy-app/sources/app/(app)/team/`, `packages/happy-cli/src/commands/enroll.ts`, and the root deployment files. Nothing else.

## Cloud Agent

One-sentence tasks executed by a multi-stage agent pipeline in an isolated git worktree on the member's own machine, ending in a pull request. Built on Team Edition — it assumes members, machines and agent credentials already exist.

**Merged into `main` (2026-08-04).** Code-complete with all automated tests green; every milestone still carries an owner end-to-end acceptance step, scheduled as initial rollout testing. Read the status section before relying on any of it.

- [cloud-agent.md](cloud-agent.md): Reference — templates, task state machine, task-control MCP, artifact and skills contracts, validation gate, delivery guards, API, security model, and the honest gap list.
- [plans/cloud-agent-tasks.md](plans/cloud-agent-tasks.md): The blueprint and acceptance criteria — what to build, authoritative on scope (zh).
- [plans/cloud-agent-tasks-progress.md](plans/cloud-agent-tasks-progress.md): Single source of truth for state — per-item checkboxes, the pending manual acceptance steps, and the decision log with every recorded deviation (zh).
- [plans/cloud-agent-tasks-goal.md](plans/cloud-agent-tasks-goal.md): The execution contract a working session follows — ordering rules, red lines, decision authority (zh).

## Parent fork: ISCP dual-stack

An opt-in transport that reaches the daemon over ISCP v2 instead of happy-server. Off by default, and **not integrated with Team Edition** — Team auth, provisioning and the admin console all assume the happy-server path.

- [network-dual-stack/inventory.md](network-dual-stack/inventory.md): Frozen Phase 0 decisions, every app/CLI network touchpoint classified, namespace and logout contract, explicit gaps (zh).
- [network-dual-stack/enrollment.md](network-dual-stack/enrollment.md): Pairing ticket → secure channel → provisioning bundle, failure and revocation semantics (zh).
- [network-dual-stack/jingsi-interop.md](network-dual-stack/jingsi-interop.md): Swift ⇄ TS cross-client acceptance, and the zombie-socket watchdog it uncovered.
- [../packages/iscp/README.md](../packages/iscp/README.md): Spec pinning and conformance vector generation.

## Protocol and encryption

- [protocol.md](protocol.md): Wire protocol (WebSocket), payload formats, sequencing, and concurrency rules.
- [session-protocol.md](session-protocol.md): Unified encrypted chat event protocol.
- [session-protocol-claude.md](session-protocol-claude.md): Claude-specific flow (local vs remote launchers, dedupe/restarts).
- [encryption.md](encryption.md): Encryption boundaries and on-wire encoding.
- [user-identity.md](user-identity.md): Account model, signature challenge, and encrypted storage of vendor tokens — the base that Team Edition's escrowed keys build on.
- [happy-wire.md](happy-wire.md): Shared wire schemas/types package and migration notes.
- [api.md](api.md): HTTP endpoints and authentication flows.
- [realtime-sync-and-rpc.md](realtime-sync-and-rpc.md): Realtime socket management and RPC control flow.
- [permission-resolution.md](permission-resolution.md): State-based permission mode resolution across app and CLI, including sandbox behavior.

## Server, CLI and app

- [backend-architecture.md](backend-architecture.md): Internal backend structure, data flow, and key subsystems.
- [multi-process.md](multi-process.md): Multi-replica Socket.IO + Redis streams behavior, failure modes, and integration-test history.
- [cli-architecture.md](cli-architecture.md): CLI and daemon architecture and how they interact with the server.
- [layout-core.md](layout-core.md): App layout primitives.
- [voice-architecture.md](voice-architecture.md): ElevenLabs voice integration, session routing, context batching, VAD detection.
- [paid-voice.md](paid-voice.md): Voice usage gating.
- [product-analytics.md](product-analytics.md): Analytics events and conventions.

## Deployment and development

- [deployment.md](deployment.md): Base server deployment and required infrastructure. Team Edition's compose stack sits on top of this — see [../deploy/README.md](../deploy/README.md).
- [dev-environments.md](dev-environments.md): Local `environments/data/` workflow, lab-rat project provisioning, `env:cli` passthrough, daemon usage.
- [CONTRIBUTING.md](CONTRIBUTING.md): Development workflow, build variants, native builds, local server.
- [3dparty.md](3dparty.md): Third-party dependencies and licensing.
- [../AGENTS.md](../AGENTS.md): Working conventions for coding agents in this repo (the sync-to-main workflow).
- [../SECURITY.md](../SECURITY.md): Vulnerability reporting, scope, and the documented design trade-offs.
- [../PRIVACY.md](../PRIVACY.md): Privacy policy.

## Notes, research and planning

- [plans/](plans/): Design documents and implementation plans. Mixed status — some landed, some drafts, some abandoned; check the document.
- [research/](research/): General research notes and exploratory writeups.
- [competition/](competition/): Competitor research, protocol analysis, comparison notes. [competition/AGENTS.md](competition/AGENTS.md) has the rules for storing results without committing raw checkouts.
- [experimental/](experimental/): Experimental agent and product notes.
- [superpowers/](superpowers/): Skill plans and specs.
- [roadmap.md](roadmap.md), [current-community.md](current-community.md): Base Happy project notes, upstream's.

## Conventions

- Paths and field names reflect the current implementation; the canonical source is always the code, and examples are illustrative.
- Fork documents state what the code does today, not what a plan intended. Where a milestone was accepted with a gap — or was never accepted at all — the gap is written down rather than omitted, and code that exists but nothing calls is named as such.
- Documents inherited from upstream describe base Happy. They are not rewritten for Team Edition unless Team Edition actually changed the behavior they describe.
