# Happy Docs

Internal documentation for this repository. It covers three layers, and knowing which one a document belongs to tells you how much to trust it for *this* fork:

1. **Team Edition** — what this fork adds. Written here, current.
2. **Parent fork** — ISCP dual-stack networking, inherited from [`Infinimesh-ai/happy`](https://github.com/Infinimesh-ai/happy).
3. **Base Happy** — inherited from [`slopus/happy`](https://github.com/slopus/happy). Describes the stock product; still accurate except where Team Edition adds on top.

Start with the [root README](../README.md) for what this fork is.

## Team Edition

- [team-edition.md](team-edition.md): Reference — identity, data model, HTTP API, provisioning state machine, artifact distribution, agent auth modes, env vars, security model.
- [../deploy/README.md](../deploy/README.md): Deployment walkthrough — env setup, TLS, Node/CLI artifacts, provisioning, preflight, backups (zh).
- [plans/team-edition.md](plans/team-edition.md): The implementation plan, decisions that are settled and not up for re-litigation, and the full acceptance log per milestone (zh).
- [upstream-sync.md](upstream-sync.md): Merging from the parent fork and upstream without breaking Team boundaries.
- [plans/cloud-agent-tasks.md](plans/cloud-agent-tasks.md): Cloud agent task plan.

Team Edition touches `packages/happy-server/sources/team/`, `packages/happy-app/sources/app/(app)/team/`, `packages/happy-cli/src/commands/enroll.ts`, and the root deployment files. Nothing else.

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

## Notes, research and planning

- [plans/](plans/): Design documents and implementation plans. Mixed status — some landed, some drafts, some abandoned; check the document.
- [research/](research/): General research notes and exploratory writeups.
- [competition/](competition/): Competitor research, protocol analysis, comparison notes. [competition/AGENTS.md](competition/AGENTS.md) has the rules for storing results without committing raw checkouts.
- [experimental/](experimental/): Experimental agent and product notes.
- [superpowers/](superpowers/): Skill plans and specs.
- [roadmap.md](roadmap.md), [current-community.md](current-community.md): Base Happy project notes, upstream's.

## Conventions

- Paths and field names reflect the current implementation; the canonical source is always the code, and examples are illustrative.
- Team Edition documents state what the code does today. Where a milestone was accepted with a gap, the gap is written down rather than omitted.
- Documents inherited from upstream describe base Happy. They are not rewritten for Team Edition unless Team Edition actually changed the behavior they describe.
