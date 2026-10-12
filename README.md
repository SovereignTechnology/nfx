# nfx

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

NFX is a protocol suite for a Nostr-identified, peer-seeded video network in which
seeders are paid per delivered chunk in Cashu ecash, with an optional per-video
licensing mode. This repository holds the suite and its Rust implementation.

> **Where work stands:** [`docs/nfx/status.md`](docs/nfx/status.md) is the resume point.
> Read it first.

## What is here

| Path | What it is |
|------|------------|
| [`spec/`](spec/README.md) | The NFX documents (NFX-01 to NFX-12), their JSON schemas and regenerable test vectors. Normative. |
| `crates/nfx-proto` | The wire formats: namespaces, manifests, beacons, hash lists, canonical JSON, vouchers, gossip envelopes. Reproduces every vector byte for byte. |
| `crates/nfx-media` | NFX-05 packaging: ladder and ffmpeg argv planning, the CMAF tail, content addressing, hash-list assembly. |
| `crates/nfx-node` | An NFX peer: content store, iroh seeding and fetching, gossip presence, manifests and beacons over Nostr, the pull-through origin, an embeddable scoped relay. |
| `crates/nfxd` | The headless node: seed, fetch, origin and an embedded scoped relay in one process. |
| `crates/nfx-wasm` | `nfx-proto` for browsers. |
| `crates/nfx-pay-wire`, `crates/nfx-pay` | The pay/1 wire and the open-mode payment contracts (NFX-07), with a mock engine and the adversary suite. **Locked**: see below. |
| `crates/desktop` | The desktop viewer: `nfx-node` behind a Tauri 2 window. Outside the workspace. |
| `crates/spikes`, [`web/spikes`](web/spikes) | The Phase A spikes (S1 iroh, S2 Tauri playback, S3 web mesh, S4 CMAF packaging) and a store verifier. Results in [`docs/nfx/spikes/`](docs/nfx/spikes). |
| [`web/player`](web/player) | The test player: hls.js over an NFX-05 origin, every file verified by `nfx-proto` (WASM) before hls.js sees it. |
| [`docs/nfx/`](docs/nfx) | Status, the milestone plans, the exit runs and the dated reviews. |
| [`docs/decisions/`](docs/decisions) | The decision records. 0006 (the NFX suite) and 0008 (the master plan) are this repository's. 0002, 0005 and 0007 are the demo's records, kept unchanged because the specs and the two records above cite them. |

## Getting started

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx
cd nfx
crates/ci/check.sh
```

`crates/ci/check.sh` runs every check, in the order CI runs them: the lock, the spec's
vectors and schemas, `cargo fmt`, `cargo clippy`, `cargo test`, `cargo deny`, and the
wasm32 tests under Node. It needs the Rust toolchain CI's image holds, rustc 1.98.0, and
no other: the lock pins the toolchain's release and commit, so a toolchain that only
meets the `rust-version` in [`crates/Cargo.toml`](crates/Cargo.toml) fails the lock at the
script's last step. It also needs clippy, rustfmt and the `wasm32-unknown-unknown`
target, `cargo-deny`, `wasm-pack`, Node, and a Python with the packages the `check` job
installs; `.github/workflows/ci.yml` pins each version.

The script's header lists the variables it reads, among them `PYTHON`, the Python to run;
`NFX_FFMPEG` and `NFX_FFPROBE`, the ffmpeg and ffprobe that `nfx-media`'s packaging test
runs (the ones on `PATH` by default; with no ffmpeg that test is skipped); and
`NFX_SKIP_WASM=1`, which skips the wasm32 tests.

## CI and the lock

CI runs on GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) as two
jobs: `lock`, and `check`, which runs `crates/ci/check.sh`.
[`crates/ci/gitlab-ci.yml`](crates/ci/gitlab-ci.yml) holds the same two jobs for GitLab
and is dormant.

The money code (`crates/nfx-pay`, `crates/nfx-pay-wire` and the paths listed in
[`crates/ci/check-locked.sh`](crates/ci/check-locked.sh)) is **locked**: every file is
pinned by hash in `crates/ci/locked.sha256`, and the lock fails any change that is not
re-pinned after review. The rule and its history are in
[`docs/nfx/m2-plan.md`](docs/nfx/m2-plan.md).

## The demo

NFX grew beside a TypeScript demo, a Pear-runtime desktop app under the name nutflix,
which is a different design ([ADR 0006](docs/decisions/0006-standardization-suite-nfx.md)).
Until 2026-10-11 this repository mirrored the demo's tree. The mirror was removed
([ADR 0008](docs/decisions/0008-multi-network-master-plan.md), amendment of that date):
the demo lives in its own repository, `nutflix-demo`, and the snapshot that was mirrored
here stays reachable under the tag `demo-base`:

```sh
git show demo-base:README.md
```

Older records under `docs/` that name `packages/`, `scripts/` or `docs/plan/` mean the
demo's tree at that tag.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues: see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Licence

Copyright (C) 2026 sovtech. Code is AGPL-3.0-or-later: see [LICENSE](LICENSE). The
specification text in `spec/` is public domain (CC0): see [`spec/README.md`](spec/README.md).
