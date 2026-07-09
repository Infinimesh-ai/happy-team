# Upstream Sync

This repository is the Team Edition fork. It keeps the original Happy project as `upstream`.

## Remotes

```bash
git remote -v
git remote add upstream /home/dev/Documents/happy
```

Use `origin` for the Team Edition repository and `upstream` only for reading changes from the original project.

## Bring In Upstream Changes

```bash
git fetch upstream
git checkout main
git pull origin main
git merge upstream/main
pnpm install
pnpm --filter happy-server-self-host typecheck
pnpm --filter happy typecheck
pnpm --filter happy-app typecheck
pnpm --filter happy-server-self-host test -- sources/team/routes.spec.ts sources/team/provision/ssh.spec.ts
```

Resolve conflicts by preserving the Team Edition boundaries:

- Server Team code stays under `packages/happy-server/sources/team/`.
- CLI Team surface remains `happy enroll` plus daemon RPC compatibility.
- App Team pages remain under `packages/happy-app/sources/app/(app)/team/`.
- Do not change the existing Happy sync protocol for Team auth; Team login still returns the managed secret key and uses the existing restore-from-key path.

After validation, commit the merge with a message that mentions upstream sync.
