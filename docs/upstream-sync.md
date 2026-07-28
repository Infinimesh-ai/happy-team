# Upstream Sync

This repository is the Team Edition fork, two forks deep:

```
slopus/happy                 base Happy
  └─ Infinimesh-ai/happy     parent fork — ISCP dual-stack, directory browser, session resume
       └─ Infinimesh-ai/happy-team   this repo — Team Edition
```

`upstream` points at the **parent fork**, not at `slopus/happy`. Changes from base Happy reach this repo by first landing in the parent, so syncing the parent is normally all you need.

## Remotes

```bash
git remote -v
```

Expected:

| Remote | URL | Use |
| --- | --- | --- |
| `origin` | `https://github.com/Infinimesh-ai/happy-team` | This fork. Fetch and push |
| `upstream` | `https://github.com/Infinimesh-ai/happy` | Parent fork. **Read only** — push is disabled |

If `upstream` is missing:

```bash
git remote add upstream https://github.com/Infinimesh-ai/happy.git
```

```bash
git remote set-url --push upstream DISABLED
```

The second command is what makes an accidental `git push upstream` fail instead of writing to the parent fork.

## Bringing in changes

Merge, never rebase. History stays bisectable and inherited commits keep their hashes, which matters when you need to tell whether a bug came from base Happy, the parent fork, or Team Edition.

```bash
git fetch upstream
git checkout main
git pull origin main
git merge upstream/main
```

Then reinstall and validate:

```bash
pnpm install --force
```

`--force` re-materializes the cross-platform optional native binaries pinned by `supportedArchitectures` in `pnpm-workspace.yaml`. Without it a later CLI artifact build silently covers only your own platform.

```bash
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy typecheck
pnpm --filter happy-app typecheck
```

```bash
pnpm --filter happy-server-self-host test -- sources/team
```

```bash
pnpm --filter happy exec vitest run --project unit src/api/apiMachine.test.ts src/utils/detectCLI.test.ts
```

Commit the merge with a message that mentions the upstream sync.

## Resolving conflicts

Team Edition was built to make merges cheap: new code lives in new directories, each with a single registration point in existing files. Conflicts should therefore be rare and shallow — and when one shows up in a shared file, the fix is almost always to keep both sides rather than to pick one.

Preserve these boundaries:

- **Server** — Team code stays under `packages/happy-server/sources/team/`. The only expected touchpoints elsewhere are route registration plus `seedTeamAdmin()` in `main.ts`/`index.ts`, the disabled-user checks in `enableAuthentication.ts` and `socket.ts`, the `PATCH` entry in the CORS method list in `api.ts`, the exported `callRegisteredRpcMethod()` helper in `rpcHandler.ts`, and the pending agent-auth hook on `machine-alive` in `machineUpdateHandler.ts`.
- **CLI** — the Team surface is `happy enroll` plus the `team-apply-agent-env` RPC handler in `apiMachine.ts`. If upstream reworks credential persistence, `enroll` adapts; the provisioner must keep going through the CLI rather than writing `~/.happy/` itself.
- **App** — Team pages stay under `packages/happy-app/sources/app/(app)/team/`, with the client in `sources/team/api.ts`, route registration in `(app)/_layout.tsx`, and the entry rows in `SettingsView.tsx`. New Team strings go in `sources/text/_default.ts` and every file under `sources/text/translations/`.
- **Prisma** — Team models are additive. Never modify `Account`, `Machine` or `Session`; if upstream changes them, take upstream's version.
- **Protocol** — do not change the Happy sync protocol for Team auth. Team login still returns the managed secret key and reuses the existing restore-from-key path. A conflict that seems to require protocol changes is a signal to re-read [team-edition.md](team-edition.md) before writing code.

## After a sync that touches provisioning

Typechecks won't catch a broken artifact pipeline. If the merge touched the CLI, its dependencies, or the server Dockerfile, rebuild the stack and run **Deployment Preflight** (`/team/admin/preflight`) — it verifies the CLI tarball still carries the Claude Agent SDK and Codex native binaries for every target platform, which is the failure mode most likely to survive a green test run and only surface on a member's machine.
