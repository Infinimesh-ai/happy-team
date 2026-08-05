# Cloud Agent Reference

Team Edition gets a member's machine online and authenticated. Cloud Agent is what runs on it afterwards: a member describes a job in one sentence from the web or their phone, and a multi-stage agent pipeline executes it inside an isolated git worktree on their own machine, ending in a pull request.

This is the reference. The implementation plan and its milestone-by-milestone acceptance log are [plans/cloud-agent-tasks.md](plans/cloud-agent-tasks.md) and [plans/cloud-agent-tasks-progress.md](plans/cloud-agent-tasks-progress.md) (zh). Architectural background — how members, machines and agent credentials got there in the first place — is [team-edition.md](team-edition.md).

> **Status.** Merged into `main` on 2026-08-04. Every milestone (C0–C4) is code-complete with all automated tests green; each one still carries an owner end-to-end acceptance step that requires a real machine, a real browser and real GitHub/GitLab, scheduled as initial rollout testing. See [Status and known limits](#status-and-known-limits) before treating any of this as production-ready.

Paths and field names reflect the current implementation. The code is canonical — when this document and `packages/happy-server/sources/team/tasks/` disagree, the code wins.

## Contents

- [Design constraints](#design-constraints)
- [The loop](#the-loop)
- [Templates](#templates)
- [State machine](#state-machine)
- [Task-control MCP](#task-control-mcp)
- [Artifact contract](#artifact-contract)
- [Skills injection](#skills-injection)
- [Validation gate](#validation-gate)
- [Delivery](#delivery)
- [HTTP API](#http-api)
- [Daemon RPCs](#daemon-rpcs)
- [Data model](#data-model)
- [Environment variables](#environment-variables)
- [Telemetry and the curator](#telemetry-and-the-curator)
- [Security model](#security-model)
- [Status and known limits](#status-and-known-limits)
- [Testing](#testing)

## Design constraints

Five constraints shaped the design, and they are settled — the plan treats them as red lines rather than open questions.

**The state machine is the spine; MCP is the nerves.** Control flow lives server-side in an explicit state machine. Agents do not decide what happens next — they *declare intent* through MCP tools, and the server adjudicates each intent against the template. An agent that wants to skip a stage can ask; the answer is a server decision, recorded either way.

**Files are the hand-off medium.** Stages communicate through `.happy-task/plan.md`, `findings.md` and `pr.md` in the worktree — not through conversation history. A plan written by Claude is read by Codex because it is a file on disk, which also makes it reviewable, editable by a human mid-flight, and diffable.

**Delivery is deterministic and belongs to the daemon.** Pushing a branch and opening a PR are mechanical steps, so no agent does them. The daemon runs git and `gh`/`glab` itself, with hard guards, after the agent session has exited.

**Rework is budgeted.** The execute↔verify loop is bounded by `maxRounds` (default 3). Exhausting the budget escalates to a human rather than looping forever.

**The policy layer is content, not code.** Prompts reference team skills mounted into the worktree from a separate repository, so how the team wants work done is versioned, reviewable content that ships independently of the product. The product owns the contract that content must satisfy, and the validator for it — though the gate that would refuse an unfit ref at distribution time is [not yet wired](#status-and-known-limits).

## The loop

What actually happens between "New Task" and a pull request:

```
member (web/phone)          server                        member's machine
─────────────────────────────────────────────────────────────────────────────
New Task ──POST /tasks──►  create TeamTask (PENDING)
                           startTeamTask ──RPC──────────►  task-prepare-worktree
                                                           git fetch
                                                           git worktree add -b happy/<user>/<slug>
                                                           mount team skills, write .mcp.json
                           ◄──worktreePath, skillsCommit──
                           PREPARING → RUNNING
                           render stage prompt
                           ──spawn-happy-session─────────►  agent session in the worktree
                                                           (HAPPY_TASK_ID / _TOKEN / _STAGE
                                                            + prompt, permission mode, model)
                                                                    │
                                                           agent works, writes artifacts
                                                                    │
                           ◄──complete_stage (MCP intent)──────────┘
                           ◄──session-end ──────────────────────────
                           ◄──task-check-artifacts ─────────────────
                           adjudicate → next stage
                           or WAITING_APPROVAL (supervised)
                           or verify verdict → rework / deliver
                           ──RPC───────────────────────────►  task-deliver
                                                           git push, gh pr create / glab mr create
   push notification ◄──── SUCCEEDED + prUrl ◄──────────────
```

The worktree is retained after delivery by default, so a member can `cd` into it.

## Templates

A template is a static description of how a task is orchestrated: which agent runs each stage, the prompt it receives, which artifacts prove the stage is done, and the allowed transitions. Templates are server-side TypeScript constants in [`templates.ts`](../packages/happy-server/sources/team/tasks/templates.ts) — the structure is already data, so moving them to the database later is a small step.

| id | Stages | What it's for |
| --- | --- | --- |
| `execute-only` | execute (claude) | One-shot changes. No plan, no review. |
| `plan-execute` | plan (claude, read-only) → execute (codex) | The plan is human-approved before any code is written. |
| `plan-execute-verify` | plan (claude) → execute (codex) → verify (claude) | Closed loop: review can send work back for rework, up to `maxRounds`. |
| `skills-curator` | consolidate (claude) → verify (claude) | Runs against the *skills* repo: merges lessons, proposes rule retirements, opens a PR for a human to merge. |

Two properties are worth calling out:

- **`deliver` is not a stage.** It appears only as a transition target. Stages are agent sessions; delivery is a daemon step.
- **The plan stage runs in `plan` permission mode**, which is read-only. Every other stage runs `auto` (the CLI's unattended default). This is the one place a stage overrides the CLI's normal permission behavior.

Prompts use `{{token}}` placeholders — `goalPrompt`, `planPath`, `findingsPath`, `prPath`, `validationOutput` — substituted by `renderStagePrompt`. An unknown token renders as an empty string rather than leaking literal `{{...}}` into an agent prompt.

Stage prompts and the [artifact contract](#artifact-contract) are kept in sync by a round-trip test: an artifact produced by following the prompt literally must pass the validator. Without it the two drift, and a well-behaved agent's output starts failing validation.

## State machine

`TaskStatus` values and how a task moves between them:

```
PENDING ─► PREPARING ─► RUNNING ─┬─► WAITING_APPROVAL ─► RUNNING
                                 │        └─(reject)──► FAILED
                                 ├─► SUCCEEDED      (delivered)
                                 ├─► FAILED         (error, timeout, rejected plan)
                                 ├─► ESCALATED      (blocker, or budget exhausted)
                                 └─► CANCELLED      (user)
```

### Completion: two triggers, one gate

Completion is claimed atomically per `TeamTaskStageRun`. Two triggers can claim it — whichever arrives first wins, the other becomes a no-op:

1. **Intent** — the agent calls `complete_stage` over MCP. The clean path.
2. **Session exit** — the stage session ends (hooked into the existing `session-end` handler). The fallback for an agent that crashes, is killed, or simply never calls the tool — a task must not hang because an agent forgot its manners.

Either trigger then passes through the same **artifact gate**: the stage's `expectedArtifacts` must exist in the worktree *and* parse against the [contract](#artifact-contract). Missing or malformed artifacts do not park the stage — they fail the task. Nothing polls artifacts independently; the gate only runs when one of the two triggers fires.

### Approval

In `SUPERVISED` mode, an edge marked `requiresApproval` parks the task in `WAITING_APPROVAL` and pushes "Approval needed". The owner can approve, edit the plan and then approve — the edit is written back into the worktree through `task-write-artifact` — or reject, which fails the task. In `AUTONOMOUS` mode every edge is auto-approved and the same pipeline runs unattended.

Every task route is scoped to `ownerUserId`, including for admins: there is no cross-member task view, and an admin approving someone else's plan gets a 404. If a task needs approving and its owner is unavailable, nothing in the current API unblocks it.

### Verify verdicts and the round budget

`complete_stage` from a verify stage carries a verdict:

- `passed` → the `verify_passed` edge → deliver.
- `failed` and `round + 1 < maxRounds` → back to execute with `round++`; `findings.md` is on disk for the executing agent to address.
- `failed` and the budget is spent → `ESCALATED`, with the last `findings.md` as evidence.

### Stage timeouts

A sweeper (`startTaskTimeoutSweeper`, started from `main.ts` on a 60s loop) fails stage runs older than 2 hours. Two details matter operationally:

- The bound is measured from `stageRun.startedAt`, so it is a **maximum stage duration**, not an idle timeout — there is no per-message activity tracking to key off.
- `PREPARING` and `WAITING_APPROVAL` are never swept. The first is a controlled RPC wait; the second is waiting on a human.

The sweep runs against a deliberately unreachable daemon stub: failing a task is a pure database-plus-push operation, and it has to work precisely when the machine is unreachable.

### The black box

Every transition — including agent intents that were **rejected** — is written to `TeamTaskTransition` as `from → to · decision · requestedBy · reason`. Decisions are `auto_approved`, `awaiting_approval`, `user_approved`, `rejected`, `escalated`. The task detail screen replays the full sequence, so "why did it do that" is answerable after the fact.

The one exception is `get_task_context`, which is a pure read and is not recorded — logging it would flood the black box without adding information.

## Task-control MCP

`happy task-mcp` is a stdio MCP server registered into the stage session. Claude Code picks it up from a `.mcp.json` written into the worktree at prepare time (and added to `.git/info/exclude`, so it never enters the delivered branch). The config carries no secrets: per-session identity arrives through the environment, which is what lets one config stay valid across every stage.

| Tool | Effect |
| --- | --- |
| `get_task_context` | Returns goal, stage, round, `maxRounds` and artifact paths. Pure read, not recorded. |
| `complete_stage` | Declares the stage done. Takes a summary; verify stages must include a verdict. |
| `report_blocker` | The task is stuck and needs a human → `ESCALATED` plus a push notification. |
| `request_transition` | Asks for a non-default transition. The server checks the template: an edge that exists is `auto_approved`, one that does not is `rejected`. Both land in the black box. |

Tools forward to `POST /v1/team/tasks/:id/intent` over HTTP, authenticated by the task token rather than the member's account.

**Task tokens** are stateless: an HMAC-SHA256 signature over `{taskId, stage, round, exp}`, keyed on `HANDY_MASTER_SECRET`, domain-separated by the message prefix `happy-task-token.v1`. Nothing is stored. Revocation is structural — the intent endpoint compares the token's `{stage, round}` against the task's current `{stage, round}`, so a token minted for a finished stage stops matching the moment the task advances. Expiry (12h) is a secondary bound.

The stage session receives `HAPPY_TASK_ID`, `HAPPY_TASK_TOKEN`, `HAPPY_TASK_STAGE`, plus `HAPPY_TASK_PROMPT`, `HAPPY_TASK_PERMISSION_MODE` and `HAPPY_TASK_MODEL`. The CLI's `taskSessionBootstrap` module reads them at startup — the Claude entry point queues the prompt and sets the initial permission mode; the Codex entry point passes it as the session's initial prompt.

## Artifact contract

Completion is not "the file exists" — it is "the file parses and carries its required fields". An empty or malformed artifact is a classic fake-completion vector, so each artifact has a minimal frontmatter contract, checked by [`artifactSchema.ts`](../packages/happy-server/sources/team/tasks/artifactSchema.ts):

| Artifact | Required shape |
| --- | --- |
| `.happy-task/plan.md` | frontmatter `goal:` + at least one `- [ ]` checklist item |
| `.happy-task/findings.md` | frontmatter `verdict:` of exactly `passed` or `failed`; at least one bullet required only when `failed` |
| `.happy-task/pr.md` | a title — frontmatter `title:` or the first non-empty body line |

If the daemon cannot read the file at all, completion falls back to existence — a read failure should not be indistinguishable from a malformed artifact.

`findings.md` is currently **not enforced** as a completion gate: the verify stage's `expectedArtifacts` is empty, because a verify stage that passes legitimately produces no findings. Whether to require it on the `failed` path is deliberately left open until real-machine observation.

## Skills injection

The team's working standards live in a separate skills repository, cloned once per machine at `~/.happy/team-skills/` (override with `HAPPY_SKILLS_DIR`). At prepare time the daemon:

1. Optionally syncs the clone to `TEAM_SKILLS_REF` (a branch or release tag — this is the gradual-rollout mechanism). A sync failure falls back to local HEAD rather than failing the task.
2. Records the clone's HEAD into `TeamTask.skillsCommit`, so every task says exactly which policy version produced it.
3. Symlinks the `standards/` layer, plus the project skill whose `repo:` field matches the task repo's origin remote, into `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex), appends a block to `AGENTS.md`, and git-excludes all of it.

No skills clone means `skillsCommit: null` and a clean no-op — tasks still run, just without team standards mounted.

The contract that makes this safe to distribute is in [`skillsContract.ts`](../packages/happy-server/sources/team/tasks/skillsContract.ts): `skills.yaml` must declare a supported `contractVersion` (currently `1`); every project `SKILL.md` must carry `repo:` and `validation:`; and every `SKILL.md` must stay under a 200-line budget, because an oversized skill is a token tax levied on every task the team runs.

`happy skills-mcp` exposes the repo to agents as MCP tools — `get_skill` (read standards or a project skill by name) and `append_lesson` (append-only write to the lessons inbox, curated by a human later). The subcommand ships, but worktree preparation currently registers only `task-mcp` in `.mcp.json`, so stage sessions cannot reach these tools yet (see [Status](#status-and-known-limits)). A `scaffoldSkillsRepo` function generates a contract-valid skeleton for a team starting from an empty repository, but no command or tool currently calls it.

## Validation gate

A reviewer who is merely *asked* to run the tests is being trusted twice — once to run them and once to report honestly. So the daemon runs them instead.

Before a stage with `injectValidation` starts (the verify stage of `plan-execute-verify`), the server calls `task-run-validation`. The daemon resolves the `validation:` command from the matched project skill, runs it inside the worktree under a 10-minute timeout, truncates the output to 16 KB, and returns command, exit code and output. The server substitutes them into the prompt as `{{validationOutput}}`:

```
$ pnpm test && pnpm typecheck
(exit 1)
<the real output>
```

The reviewing agent therefore opens with the actual result already in context rather than a request to go find it. Two degraded cases are explicit rather than silent: with no skills clone or no matched project skill the injected text is `No validation command is configured for this project.`, and if the gate itself throws, `validation gate could not be run: <error>` is injected.

## Delivery

`task-deliver` is pure mechanism, and it refuses rather than guesses:

- The current branch must start with `happy/`, or delivery is refused — this is the guard against a task pushing straight onto `main`.
- The work branch must differ from the base branch.
- The platform is detected from the origin remote host (`github` / `gitlab`); a self-hosted domain that carries neither string can be pinned with an explicit `platform` parameter.
- Title and body come from `pr.md`; `gh pr create` or `glab mr create` opens the PR/MR and the resulting URL is written to `TeamTask.prUrl`.

Work branches are named `happy/<user>/<slug>-<suffix>` — the slug is truncated to 40 characters and the random suffix avoids collisions — and worktrees live at `<happyHomeDir>/worktrees/<taskId>`. Preparation is idempotent — an already-registered worktree is reused, which makes retries safe. `task-cleanup` retains the worktree by default and never touches the branch; note that nothing on the server invokes it today (see [Status](#status-and-known-limits)), so in practice worktrees are always retained.

## HTTP API

All member routes require an authenticated, active `TeamUser`, and every one of them is scoped to `ownerUserId` — including for admins.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/team/tasks/templates` | Built-in templates (static segment, matched ahead of `/:id`) |
| `POST` | `/v1/team/tasks` | Create and immediately start. Body: `machineId`, `repoPath`, `templateId`, `mode`, `title`, `goalPrompt`, `baseBranch`, optional `stageOverrides` |
| `GET` | `/v1/team/tasks` | The caller's tasks |
| `GET` | `/v1/team/tasks/:id` | Detail, including stage runs and the transition sequence |
| `POST` | `/v1/team/tasks/:id/cancel` | → `CANCELLED`, stops active stage sessions, retains the worktree |
| `POST` | `/v1/team/tasks/:id/intent` | **Task-token auth, not account auth.** The MCP forwarding endpoint |
| `GET` | `/v1/team/tasks/:id/plan` | Reads `plan.md` through the daemon on demand |
| `POST` | `/v1/team/tasks/:id/approve` | Optional `plan` body writes an edited plan back first. 409 unless `WAITING_APPROVAL` |
| `POST` | `/v1/team/tasks/:id/reject` | → `FAILED`. 409 unless `WAITING_APPROVAL` |

`plan.md` is fetched on demand rather than embedded in the detail DTO, so opening a task board does not hit the daemon once per card.

Task audit actions, filterable in the admin audit view: `team.task.created`, `.prepared`, `.approved`, `.rejected`, `.succeeded`, `.failed`, `.escalated`, `.cancelled`.

Push notifications reuse the existing session-event channel (so the "suppress when active" behavior is inherited) and deep-link to the current stage session: `stage_started`, `approval_needed`, `task_escalated`, `task_delivered`, `task_failed`, `task_cancelled`. A user-initiated cancel does not notify — they just did it.

### External assistant MCP

The same task surface is exposed as an MCP server at `POST /v1/team/mcp` (Streamable HTTP, stateless JSON — no SSE; `GET`/`DELETE` answer 405) so a member's personal assistant (e.g. SparkClaw) can follow progress, dispatch tasks and relay the owner's approval decisions. Code: `packages/happy-server/sources/team/mcp/`.

- **Tools**: `list_machines` (ids + liveness only — metadata stays E2E-encrypted), `list_templates`, `list_tasks`, `get_task`, `get_task_plan`, `create_task`, `cancel_task`, `approve_plan`, `reject_plan`. Each is a thin wrapper over the task service above, so ownership scoping and state-machine rules are shared with the REST routes.
- **Auth**: a personal MCP token minted at `POST /v1/team/mcp/token` (account auth). Stateless HMAC over `HANDY_MASTER_SECRET`, domain-separated from task tokens, 90-day expiry, bound to a digest of the member's current password hash — a password change revokes every issued token, and DISABLED members are rejected at resolve time.
- **Audit**: issuance writes `team.mcp.token_issued`; every mutating tool call writes `team.mcp.call` with the tool name, so the admin audit view shows which actions came through an assistant.
- **Approvals**: the `approve_plan`/`reject_plan` tool descriptions instruct the client to surface the decision to the human owner (e.g. SparkClaw's approval inbox) rather than decide autonomously.

For decrypted session content — which this endpoint deliberately cannot serve — the assistant connects to the member-local bridge (`happy-agent mcp`, inherited from the parent fork) as a second MCP endpoint.

## Daemon RPCs

Registered by `registerTaskHandlers` at a single point in the CLI's machine API, and carried over the same encrypted machine-RPC transport Team Edition already uses for agent-auth changes:

| RPC | Effect |
| --- | --- |
| `task-prepare-worktree` | fetch, `git worktree add -b happy/…`, `.happy-task/`, skills injection, `.mcp.json` |
| `task-check-artifacts` | Existence check for a stage's expected artifacts (contract validation happens server-side, reading each file over `task-read-artifact`) |
| `task-read-artifact` / `task-write-artifact` | Plan review: read for display, write back an approved edit |
| `task-run-validation` | Runs the project's validation gate in the worktree, returns real output |
| `task-deliver` | Branch guards, push, platform detection, `gh`/`glab` |
| `task-cleanup` | Removes the worktree (opt-in); never deletes the branch |

Git is invoked through `execFile` without a shell.

## Data model

Three new tables. Consistent with Team Edition's rule, no existing table is modified — the new tables reference `ownerUserId` / `machineId` / `sessionId` as indexed plain `String` columns rather than Prisma relations, because a relation would require adding back-reference fields to existing models.

**`TeamTask`** — `ownerUserId`, `machineId`, `templateId`, `mode` (`SUPERVISED` | `AUTONOMOUS`), `status`, `title`, `goalPrompt`, `repoPath`, `baseBranch`, `workBranch`, `worktreePath`, `currentStage`, `round`, `maxRounds` (default 3), `skillsCommit`, `prUrl`, `error`, timestamps.

**`TeamTaskStageRun`** — `taskId`, `stage`, `round`, `agent`, `model`, `sessionId`, `status` (`RUNNING` | `SUCCEEDED` | `FAILED`), `summary`, `startedAt`, `endedAt`. Indexed by `sessionId` so a `session-end` event resolves to its stage in one lookup.

**`TeamTaskTransition`** — the black box: `taskId`, `fromStage`, `toStage`, `requestedBy`, `reason`, `decision`, `decidedBy`, `createdAt`.

## Environment variables

Cloud Agent adds no *server* environment variables — task tokens are signed with the `HANDY_MASTER_SECRET` that Team Edition already requires. The additions are read on the member's machine by the daemon:

| Variable | Where | Default | Meaning |
| --- | --- | --- | --- |
| `HAPPY_SKILLS_DIR` | machine | `<happyHomeDir>/team-skills` | Skills clone location (leading `~` expanded) |
| `TEAM_SKILLS_REF` | machine | none | Branch or tag to sync the skills clone to before mounting — the gradual-rollout switch |

These are injected per stage session and are not part of the task token: `HAPPY_TASK_ID`, `HAPPY_TASK_TOKEN`, `HAPPY_TASK_STAGE`, `HAPPY_TASK_PROMPT`, `HAPPY_TASK_PERMISSION_MODE`, `HAPPY_TASK_MODEL`. `happy task-mcp` uses `HAPPY_SERVER_URL` when the environment sets it, and otherwise falls back to the CLI's own configured server URL — production daemons don't export the variable, so configuration is the normal path.

## Telemetry and the curator

`computeTaskTelemetry` aggregates per-template outcomes, the rework-round distribution, escalation cases, rejected intents and an overall escalation rate. That is the evidence base for the `skills-curator` template: a task that runs against the skills repo itself, consolidates pending lessons, promotes cross-project rules, and proposes retiring rules that telemetry shows have not fired in N periods — each change requiring a decision-log entry classifying it as durable or model-compensating. It only ever opens a PR; a human merges.

Both pieces are honest about their wiring: the aggregation is a server function with no HTTP route exposing it yet, and curator runs are created like any other task rather than by a built-in scheduler. See [Status and known limits](#status-and-known-limits).

## Security model

Cloud Agent inherits Team Edition's [security model](team-edition.md#security-model) — including its central trade, that the server escrows member private keys — and adds the following.

**Task tokens are not account credentials.** A stage token authorizes exactly one thing: submitting intents for one task at one stage and round. It cannot read sessions, cannot act on other tasks, and stops working the moment the task advances. It is not stored server-side, so there is nothing to leak from the database.

**Agents cannot self-advance.** Every transition is adjudicated by the server against the template. `request_transition` is the only way an agent can ask for something non-default, and an edge the template does not contain is rejected and logged.

**Delivery is fenced.** Only `happy/`-prefixed branches can be pushed, and never onto the base branch. An agent cannot cause a push to `main` by writing a file.

**The plan stage is read-only.** Planning runs under Claude Code's `plan` permission mode, so the stage that runs before human approval does not modify the repository. This is an agent-level constraint, not a sandbox.

**Blast radius is a worktree.** Stages run inside a per-task worktree under the daemon's own user, using the same company or personal agent credentials Team Edition already provisioned. The gate on what a task may reach is that machine's account — Cloud Agent adds no sandbox of its own, so a task can do anything the member's daemon can do.

## Status and known limits

Every milestone is code-complete with unit and integration tests green, and every milestone still has an owner acceptance step that could not be performed inside an agent session. Treating this as production-ready before those run would be a mistake.

**Pending owner end-to-end acceptance** (real machine, real browser, real GitHub/GitLab): C0.11, C1.9, C2.8, C3.6, C4.9. Each has its concrete steps written out in [plans/cloud-agent-tasks-progress.md](plans/cloud-agent-tasks-progress.md).

**What was proven without a real machine.** The full spine runs against real git in-process — real `git worktree add` against a local bare origin, a simulated agent writing and committing `pr.md`, session exit, artifact validation, a real `git push` landing on origin, delivery, `SUCCEEDED` — plus the negative case where a missing `pr.md` blocks the push and fails the task. What is genuinely untested is narrow: encrypted socket transport to a live daemon, real `gh`/`glab` network calls, real agents actually calling the MCP tools, and the browser UI.

**Implemented but not wired to a runtime path.** These are functions with tests and no caller — real code, but nothing invokes them today:

- `validateSkillsDirectory` — pre-distribution contract validation. No route or job runs it, so an unfit skills ref is not yet refused automatically.
- `detectTaskPrerequisites` — checks `gh`/`glab` availability and authentication plus the skills clone. Not surfaced in provisioning or preflight, so a machine missing `gh` currently fails at delivery time rather than warning earlier.
- `scaffoldSkillsRepo` — generates a contract-valid skills skeleton, but no command or MCP tool exposes it.
- `computeTaskTelemetry` — no HTTP route returns it, so the aggregate report is not reachable from the admin console.
- Curator scheduling — the `skills-curator` template exists and runs, but nothing schedules it periodically; a curator run is created like any other task.
- `happy skills-mcp` registration — the subcommand ships, but preparation writes only `task-mcp` into the worktree `.mcp.json`, so stage agents cannot call `get_skill` / `append_lesson` yet.
- `task-cleanup` — registered CLI-side, but the server's daemon gateway has no cleanup member and no call site; worktrees are retained because nothing ever asks for removal, not because a default was chosen at call time.

**No admin view over tasks.** Every task route is owner-scoped, so an admin cannot list a team's tasks or approve a plan on behalf of an absent member — a supervised task whose owner is away stays parked until they return or someone cancels it as them.

**Not integrated with ISCP dual-stack.** Like the rest of Team Edition, Cloud Agent assumes the happy-server transport.

**Windows machines** cannot be provisioned over SSH (a Team Edition limit that Cloud Agent inherits), so they cannot run tasks through the console.

## Testing

```bash
pnpm --filter happy-server exec vitest run sources/team/tasks
pnpm --filter happy exec vitest run --project unit src/team/tasks
```

As of this writing: 80 server tests across 10 files, 43 CLI tests across 8 files, all passing. Use `exec vitest run <path>` rather than `test -- <path>` — the package `test` scripts do not forward a path filter, so the latter silently runs the whole suite.

Conventions the tests follow, matching the surrounding packages: no mocking of things that can be run for real. Git operations are exercised against real local bare repositories, skills injection against a real clone and a real worktree, the state machine against in-memory PGlite. Only three seams are injectable — hosted-platform CLIs (`gh`/`glab`), the encrypted machine transport, and push dispatch — because each requires a real external account. Everything deterministic runs for real.

No test may use real external credentials or trigger a billable call.
