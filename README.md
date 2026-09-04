# nutflix

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

> Status: **Stage 0 complete** (scaffold, frozen contracts, mocks, spikes). Stage 1 parallel
> build not yet started. See [`docs/nfx/status.md`](docs/nfx/status.md).

A Nostr-native peer-to-peer video network where seeders are paid per block in Cashu ecash,
the creator picks the mint, and the UI aims at YouTube rather than at a protocol demo.

**"Nutflix" is the brand name only.** Package scope is `@sovit/*`, the wire protocol is
`pay/1`, and nothing in the code depends on the brand (build plan §9.11).

## Read first

| Document | What it is |
|----------|------------|
| [`docs/plan/build-plan.md`](docs/plan/build-plan.md) | The *what*: assumptions, threat model, architecture, data model, `pay/1`, payment flow, UI, hardening, phases, open questions |
| [`SECURITY.md`](SECURITY.md) | Threat table (normative for the adversary suite), money-path invariants, locked directories |
| [`docs/decisions/`](docs/decisions/) | ADRs — 0002 stack, 0003 spike resolutions |
| [`docs/spikes/`](docs/spikes/) | S-A per-peer gating, S-B browser Hypercore, S-C transcode |
| [`docs/vendor/`](docs/vendor/) | Pinned upstream specs and READMEs. **The API is what is in here and in `node_modules/`, not what you remember.** |

## Layout

```
packages/core         @sovit/core        runtime-agnostic protocol lib: contracts, mocks, (nostr, manifest, media, payment…)
packages/seeder       @sovit/seeder      Corestore + Hyperblobs seeder daemon, pay/1 server side
packages/gateway      @sovit/gateway     seeder + WS bridge + Blossom HTTP
packages/ui           @sovit/ui          React design system + screens, talks only to NetworkAdapter
packages/app-desktop  @sovit/app-desktop Electron + pear-runtime Bare worker shell
packages/app-web      @sovit/app-web     static web shell: in-page Hypercore over WS, service-worker player
```

`packages/core/src/contracts/` is the frozen interface surface (`CONTRACTS_VERSION`).
`payment/`, `signer/`, `pay-protocol/`, `wallet/spend.ts` and `gateway/src/auth/` are
**locked** — interfaces and tests only — until the Stage 2 security session.

## Getting started

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx
cd nfx
npm ci --ignore-scripts     # .npmrc already sets ignore-scripts + exact pins
npm run hooks:install       # pre-commit: lane path allowlist + locked-dir check
npm run ci                  # lint + typecheck/build + test + locked-dir check
```

Requires Node ≥ 22.12. Refresh vendored docs with `scripts/vendor-docs.sh`.

### Working in a lane

```sh
scripts/new-lane-worktree.sh L2 packages/seeder/
cd .worktrees/L2            # .lane holds the allowlist; the hook enforces it
```

## CI

There is deliberately **no `.gitlab-ci.yml`** at the root yet: no runner is registered
against this namespace. The pipeline skeleton lives in [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml)
and mirrors `npm run ci`; move it to the root when a runner exists.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues: see [SECURITY.md](SECURITY.md) — do not open a public issue.

## Licence

Copyright (C) 2026 sovtech. AGPL-3.0-or-later — see [LICENSE](LICENSE).
