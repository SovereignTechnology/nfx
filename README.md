# NFX

A Nostr-identified, peer-seeded video network: an open standard with a Rust reference
implementation.

NFX lets a creator publish a signed video manifest on Nostr and lets peers seed and watch
the video, checking every file against signed hashes. The normative specification is in
`spec/`. The Rust reference implementation in `crates/` covers iroh (native), a WebRTC
mesh (browsers) and an HTTP origin, which a public deployment puts behind TLS and a CDN.
The optional Hypercore profile (NFX-12) and payments (Cashu ecash, per delivered chunk)
are specified as drafts.

**Status (2026-10-12):** NFX is pre-release. There is no released version, so build from
source. The free end-to-end slice (milestone M1: publish, seed, fetch, play; no payments)
is built and passed its exit run. That run and the Phase A exit run before it used two
hosts on a private network with plain HTTP and WebSocket endpoints; they did not cover
NAT traversal, TLS, a CDN or paid delivery. What each run left out:
[M1](docs/nfx/m1-exit.md#what-this-does-not-cover),
[Phase A](docs/nfx/phase-a-exit.md#what-this-does-not-cover).
The Hypercore profile (NFX-12) is not implemented. Payments are specified (NFX-07);
the open-mode contracts, the mock engine and the adversary suite sit in `crates/nfx-pay`
and `crates/nfx-pay-wire`, behind the lock, and are not deployed. NFX-01 to NFX-06 are
Frozen; the status of every document and its freeze milestone is in
[spec/README.md](spec/README.md). Log and resume point:
[docs/nfx/status.md](docs/nfx/status.md).

## Repository layout

| Path | What it is |
|---|---|
| `spec/` | NFX-01 to NFX-12, the JSON schemas (`schemas/`) and the regenerable test vectors (`test-vectors/`) |
| `crates/` | The Cargo workspace (edition 2024), with the members below |
| `crates/nfx-proto` | Wire formats: manifests, beacons, hash lists, canonical JSON, vouchers, gossip envelopes. Pure (no I/O, clock or RNG); builds natively and for `wasm32` |
| `crates/nfx-node` | The peer: content store, iroh seeding and fetching, gossip presence, Nostr manifests and beacons, pull-through origin, embeddable scoped relay, browser-mesh tracker and WebRTC bridge |
| `crates/nfx-media` | NFX-05 packaging (ladder planning, CMAF output, content addressing); ships the `nfx-package` binary |
| `crates/nfx-wasm` | `nfx-proto` for browsers: verifies manifests, beacons, hash lists and files from JS |
| `crates/nfxd` | The headless node: `key`, `publish`, `delete` and `run` |
| `crates/desktop` | Tauri 2 desktop viewer on top of the `nfxd` daemon; its own Cargo workspace, sharing is opt-in |
| `crates/spikes` | Spike code and tools (`s1-iroh`, `s2-tauri`, `nfx-verify-store`), each its own workspace |
| `crates/ci` | `check.sh`, the lock scripts and the CI job definition |
| `crates/nfx-pay-wire`, `crates/nfx-pay` | The pay/1 wire and the open-mode payment contracts (NFX-07), with a mock engine and the adversary suite. **Locked**: see below |
| `web/player` | The browser test player: hls.js behind a loader that verifies every file with `nfx-wasm`, plus the WebRTC mesh |
| `web/spikes` | Browser spike code (`s3-mesh`, `s4-cmaf`) |
| `docs/` | `decisions/` (ADRs) and `nfx/` (status, plans, exit runs, reviews, spike write-ups); index in [docs/README.md](docs/README.md) |

## Quick start

Clone from Nostr (needs ngit's `git-remote-nostr`) or, instead, from the GitHub mirror:

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx
# or: git clone https://github.com/SovereignTechnology/nfx
cd nfx
```

Prerequisites: a Rust toolchain at least as new as `rust-version` in `crates/Cargo.toml`;
for the player, the `wasm32-unknown-unknown` target, wasm-pack and Node; for packaging,
ffmpeg and ffprobe on `PATH` (or `NFX_FFMPEG` and `NFX_FFPROBE`). The versions CI uses
are pinned in `.github/workflows/ci.yml`.

```sh
repo=$PWD                                  # the root of the clone
cargo build --release --locked --manifest-path crates/Cargo.toml -p nfxd -p nfx-media
export PATH="$repo/crates/target/release:$PATH"
work=$(mktemp -d); echo "$work"            # a scratch directory for the demo files
cd "$work"
cp /path/to/any-video.mp4 clip.mp4         # any local video that ffmpeg can read
```

Package the clip, create a key, and run a node that seeds it. `--embed-relay` and
`--origin` take `ip:port`; a bare `:port` is refused.

```sh
nfx-package clip.mp4 --video nfx:testnet:1:my-video --out pkg   # pkg/store, pkg/nfx.json
pub=$(nfxd key new node.key | head -n 1)   # prints the public key as hex, then as npub
A=38504:$pub:nfx:testnet:1:my-video        # the manifest address
nfxd run --key node.key --store pkg/store --seed "$A" \
  --embed-relay 127.0.0.1:7447 --origin 127.0.0.1:3473
```

In a second terminal, change to the scratch directory printed above and set `repo` (the
clone root) and `PATH` again. Publish the manifest to the embedded relay. It prints the
address, and the node then logs `<address>: Seeding`. Then serve the browser test player,
which listens on `0.0.0.0:3471`:

```sh
nfxd publish --key node.key --relay ws://127.0.0.1:7447 --package pkg --title "My video"
cd "$repo/web/player" && npm ci --ignore-scripts && npm run serve
# open http://127.0.0.1:3471/?a=<address>&relay=ws://127.0.0.1:7447&origin=http://127.0.0.1:3473
```

## Checks

```sh
PYTHON=/path/to/venv/bin/python crates/ci/check.sh
```

`check.sh` stops at the first failing step. The step list, what each one needs and the
environment switches are in [CONTRIBUTING.md](CONTRIBUTING.md#checks). CI runs what
`check.sh` runs. The browser end-to-end suites (`npm run e2e` and `npm run e2e:mesh` in
`web/player`, `./e2e.sh` in `crates/desktop`) are separate.


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

## Documentation

- [spec/README.md](spec/README.md): the suite, its reading order, status and conformance.
- [docs/README.md](docs/README.md): the index of the documentation tree.
- [docs/nfx/status.md](docs/nfx/status.md): current status, milestone log, what is next.
- [ADR 0008](docs/decisions/0008-multi-network-master-plan.md): the master plan.

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

## Contributing, security, licence

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
[SECURITY.md](SECURITY.md) (how to report a vulnerability).

Copyright (C) 2026 sovtech. Code is AGPL-3.0-or-later: see [LICENSE](LICENSE). The
specification text in `spec/` is public domain (CC0): see [`spec/README.md`](spec/README.md).
