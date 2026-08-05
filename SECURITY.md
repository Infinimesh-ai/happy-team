# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub:
**[Security → Report a vulnerability](https://github.com/Infinimesh-ai/happy-team/security/advisories/new)** on this repository.

Do not open a public issue for anything exploitable. There is no bug bounty program.

If the issue is in base Happy rather than this fork — anything not listed under
[What Team Edition adds](README.md#what-team-edition-adds) or [Cloud Agent](README.md#cloud-agent) —
report it to [slopus/happy](https://github.com/slopus/happy) instead. When in doubt, report it here
and we will route it.

## Scope

This is a self-hosted product. The code in this repository is in scope; individual deployments are
run and secured by their operators. Reports about a specific company's deployment should go to that
company.

Especially relevant areas of this fork:

- Team account auth, password handling and the server-side key escrow
  (`packages/happy-server/sources/team/`)
- SSH provisioning and credential redaction (`sources/team/provision/`)
- Cloud Agent task tokens, intent adjudication and the delivery guards that keep agents from
  pushing to protected branches (`sources/team/tasks/`, `packages/happy-cli/src/team/tasks/`)
- Artifact distribution endpoints (Node binaries, CLI tarball)

## Known design trade-offs

Two decisions are deliberate and documented — reports that merely restate them will be closed as
by-design, though reports of ways to *escape* their stated bounds are very welcome:

- The server escrows member secret keys; this is not strict end-to-end encryption.
  See [docs/team-edition.md § Security model](docs/team-edition.md#security-model).
- Cloud Agent tasks run with the member daemon's own privileges — there is no additional sandbox.
  See [docs/cloud-agent.md](docs/cloud-agent.md).

## Supported versions

Only the current `main` branch is supported. There are no maintained release branches; fixes land on
`main`.
