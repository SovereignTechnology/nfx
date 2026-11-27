# NFX

> **Source of truth:** [`nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx`](https://gitworkshop.dev/npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx) — issues and pull requests live there. This GitHub repository is a mirror; push to the Nostr remote, not here.

A Nostr-identified, peer-seeded video network: an open standard with a Rust reference
implementation.

NFX lets a creator publish a signed video manifest on Nostr and lets peers seed and watch
the video, checking every file against signed hashes. The normative specification is in
`spec/`. The Rust reference implementation in `crates/` covers iroh (native), a WebRTC
mesh (browsers) and an HTTP origin, which a public deployment puts behind TLS and a CDN.
The optional Hypercore profile (NFX-12) and payments (Cashu ecash, per delivered chunk)
are specified as drafts.

**Status (2026-11-25):** NFX 0.1.4 is the latest release: `nfxd` and `nfx-package` for
linux-x64 on the [Releases page](https://github.com/SovereignTechnology/nfx/releases), free video
only ([release notes](docs/nfx/releases/v0.1.4.md); earlier: [0.1.3](docs/nfx/releases/v0.1.3.md),
[0.1.2](docs/nfx/releases/v0.1.2.md), [0.1.1](docs/nfx/releases/v0.1.1.md),
[0.1.0](docs/nfx/releases/v0.1.0.md)). `nfxd` serves
browsers directly, through NATs, signaling only over Nostr relays (its mesh endpoint, NFX-10 §6),
and since 0.1.3 its embedded scoped relay can carry that signaling too (`--embed-relay-mesh`);
since 0.1.4 that relay keeps its manifests across a restart (`--state`) and a client can find a
STUN server through Nostr (NFX-10 §1); a video gets one rendition by default. It is tested against the nutflix-pear desktop app in both directions, behind NATs and
over TLS relays, and against browsers behind NATs. The public services on `nfx:testnet:1` are an iroh
relay, `https://iroh.nutflix.xyz/`, and a scoped Nostr relay, `wss://relay.nutflix.xyz` ([testnet](docs/nfx/testnet.md)). The free end-to-end slice (milestone M1: publish, seed, fetch,
play; no payments) is built and passed its exit run. That run and the Phase A exit run before it used two
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
| `crates/nfx-node` | The peer: content store, iroh seeding and fetching, gossip presence, Nostr manifests and beacons, pull-through origin, embeddable scoped relay, browser-mesh tracker and WebRTC bridge, and the Nostr-signaled full-ICE mesh endpoint |
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

`nfx-package` makes one rendition by default: 720p, or the clip's own size when it is
smaller. A size is the picture's short side, so 720p is 1280x720, or 720x1280 for a
portrait clip. While the network is small, each extra rendition is another set of segments
to store and another browser swarm to split viewers across
([nutflix-pear#97](https://github.com/SovereignTechnology/nutflix-pear/issues/97) tracks a
fuller default). `--renditions` picks the sizes instead, from those the clip offers: the
tiers 2160p, 1440p, 1080p, 720p, 480p and 360p up to its size, and its own size
(`--renditions 2160p` for one 4K rendition, `--renditions 1080p,720p,360p` for the old
three-size ladder). Nothing is upscaled: a size the clip does not offer is refused.

In a second terminal, change to the scratch directory printed above and set `repo` (the
clone root) and `PATH` again. Publish the manifest to the embedded relay. It prints the
address, and the node then logs `<address>: Seeding`. Then serve the browser test player,
which listens on `0.0.0.0:3471`:

```sh
nfxd publish --key node.key --relay ws://127.0.0.1:7447 --package pkg --title "My video"
cd "$repo/web/player" && npm ci --ignore-scripts && npm run serve
# open http://127.0.0.1:3471/?a=<address>&relay=ws://127.0.0.1:7447&origin=http://127.0.0.1:3473
```

A node binds iroh to a random UDP port, and peers on the internet reach it through an iroh
relay (`--iroh-relay`) or by hole-punching. A host that can forward one UDP port to itself, a
home router's port forward or a DNAT in front of a VM, can be dialled directly instead:

```sh
nfxd run --key node.key --store pkg/store --seed "$A" --embed-relay 127.0.0.1:7447 \
  --iroh-bind 0.0.0.0:7843 --iroh-external 203.0.113.7:7843
```

Here `203.0.113.7:7843` stands for the public address and port forwarded to the host's UDP
port 7843. Tickets and beacons then name that address and leave out the host's private ones.

Without `--iroh-external`, a node names its private addresses (LAN, VPN, tailnet, loopback) only
to relays it reaches at such an address: its `--embed-relay`, or a relay on the same LAN or
tailnet, so a viewer there still dials it directly. A relay it reaches at a public address gets
beacons that name only its iroh relay and its public addresses. What counts is the address the
connection reached, not the relay's host name, and an `--embed-relay` on `0.0.0.0` counts as
public. `--public-addrs-only` leaves private addresses out everywhere, for a node whose loopback
or private relay is published to the internet (behind a TLS proxy or a DNAT).

`--embed-tracker` and `--bridge <ip:port>` add the browser mesh (NFX-10): the bridge serves
the video to browsers over WebRTC, and its address is the one candidate they are told. Behind
a DNAT, bind `--bridge` to the host's own address and pass the public one as
`--bridge-public` (for example `--bridge-public 203.0.113.7:7844`); `--bridge-max-peers`
(default 64) caps the browsers it serves at once.

A node behind a NAT, a home node say, serves browsers with no tracker and no forwarded port
through the mesh endpoint (NFX-10 §6): `--mesh-relay <url>` (1 to 8 Nostr relays: general
ones, or a scoped relay that admits the signaling kind, NFX-04 §1, such as nfxd's own with
`--embed-relay-mesh`) turns it on, and `--mesh-stun <ip:port>` names a
public node's `--stun` so it learns its public mapping. Browsers that play a rendition it
holds meet it in that rendition's room, and both ends punch through their NATs with full
ICE:

```sh
nfxd run --key node.key --store pkg/store --seed "$A" --relay wss://relay.example \
  --mesh-relay wss://general-relay.example --mesh-stun 203.0.113.7:3478
```

Joining a room tells anyone present there the node's candidate addresses, its public mapping
included, as a tracker's swarm would. `--mesh-bind` fixes its UDP port and `--mesh-max-peers`
(default 16) caps its connections.

The mesh endpoint also learns STUN servers from Nostr (NFX-10 §1), on its `--mesh-relay`s,
from the `stun` endpoints of its videos' beacons. After its own `--mesh-stun` it asks those
a beacon signed by the video's creator names, by the rules every NFX client uses: global
unicast addresses only, on a port of 1024 or above, at most 4 in all. A beacon signed by any
other key adds none of these, however many keys name a server: keys are free. STUN service
announcements (below) are never used on their own. So `--mesh-stun` is optional where the
creator's beacons name a STUN server. `--mesh-stun-from-nostr=false` turns this off. If no
server it asks returns a mapping, or it asks none, it also asks a server a seeder's beacon
names, one per seeder and within the 4, when that server's IP is among the candidates of a
peer it is signaling with, and uses the answer for that peer's connection only.

Behind a DNAT, a VM's say, STUN cannot tell the node its public address when the STUN server
is its own (that would take a UDP hairpin), and no gateway maps a port. Name the address with
`--mesh-public`, as `--bridge-public` does for the bridge:

```sh
nfxd run --key node.key --store pkg/store --seed "$A" --relay wss://relay.example \
  --mesh-relay wss://general-relay.example --mesh-bind 0.0.0.0:7845 --mesh-public 203.0.113.7:7845
```

Here `203.0.113.7:7845` stands for the public address and port forwarded to the host's UDP
port 7845; `--mesh-bind` must then be a fixed port. The node offers that address as a host
candidate and takes what arrives as sent to it, and offers no candidate address that is not
public, so its address behind the DNAT never reaches a peer. `--mesh-stun` stays optional
beside it.

## Run a STUN server for the network

Browsers and mesh endpoints behind NATs learn their public UDP mapping from STUN servers, and
the more independent ones a network has, the less it depends on any one. `nfxd stun` runs
one and nothing else: no store, no videos, no iroh, only RFC 8489 Binding requests answered,
with the same rate limits as `nfxd run --stun` (16 answers a second per source address or
IPv6 /64, 256 per /24 or /48, 4096 in all). No TURN, no authentication, and nothing about a
client is logged.

```sh
nfxd key new stun.key                       # the operator key that signs the announcement
nfxd stun --bind 203.0.113.7:3478 \
  --announce --key stun.key --relay wss://relay.nutflix.xyz --relay wss://nos.lol \
  --network nfx:mainnet:1
```

Here `203.0.113.7` stands for the host's public address: a documentation address like it
routes nowhere, and `nfxd stun` refuses to announce one. `--bind` is the UDP address it
answers on. On a host with several addresses, bind the one clients reach (not `0.0.0.0`): an answer leaves from the address the route picks, and a
client's NAT drops one from another. Behind a DNAT, bind the host's own address and name the
public one with `--public 203.0.113.7:3478`. With `--announce`, it signs a STUN service
announcement (kind 33478, NFX-10 §1) with `--key`: that public address, for each
`--network` (1 to 8), valid 24 h, sent to the `--relay`s (1 to 8) at once and again every
12 h. The announcements form a directory: the people and operators of those networks find
the server over Nostr and choose whether to use it. No client asks it just because it is
announced. A page names it among its own STUN servers, a node with `--mesh-stun`, and a
creator in the `stun` endpoint of its own beacons, which every viewer of its videos then
uses. A scoped relay carries the announcement only if it admits kind 33478 (NFX-04 §1, as
`nfxd run --embed-relay-stun-ads` makes nfxd's own); general relays carry it as is. Without
`--announce` it is a STUN server that people must be told about some other way.

A relay operator can offer it to the clients that signal through the relay. When the STUN
server answers on the relay's own host name, `nfxd run --embed-relay-stun-port 3478` puts
`"stun_port": 3478` in the embedded relay's NIP-11 `nfx` object (NFX-04 §3), and a page
that signals through the relay (with `--embed-relay-mesh`) asks
`stun:<host of the relay URL>:3478` after its own servers and before the creator's (NFX-10
§1, decision record 0108). The relay sees the client's address anyway, so its STUN server
learns only the client's UDP port. nfxd does not check that anything answers there: the
host is whatever the relay's name resolves to, so behind a TLS proxy or a CDN it is the
proxy's, and a port that does not answer costs clients a slot and a gathering timeout. Only
the web player asks relays' STUN servers so far; nfxd's own mesh endpoint does not.

Open UDP 3478 to it, for example with ufw:

```sh
sudo ufw allow 3478/udp comment 'nfxd stun'
```

A systemd unit (put the key where only the service user reads it):

```ini
# /etc/systemd/system/nfxd-stun.service
[Unit]
Description=nfxd stun: a STUN server for NFX networks
Wants=network-online.target
After=network-online.target

[Service]
User=nfxd
ExecStart=/usr/local/bin/nfxd stun --bind 203.0.113.7:3478 --announce --key /var/lib/nfxd/stun.key --relay wss://relay.nutflix.xyz --network nfx:mainnet:1
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/var/lib/nfxd
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

**What the operator learns.** Every client that asks reveals its IP address, and when it
gathers candidates, which is when it plays a video; a STUN server sees no video and no
peer, and never touches a byte of one. The announcement ties the server's address to the
operator's key, publicly. Clients use at most 4 STUN servers: their own, those of the relays
they signal through that name one for their own host (`--embed-relay-stun-port`), those the
creator of the video names, and through the fallback a seeder's at the address of a peer
they already signal with. A relay's operator learns the client's UDP port and when it
gathers, beside the address the relay already saw. Clients never take an address from Nostr
that is not public (private, loopback or documentation) or a port below 1024 (NFX-10 §1), so
a lying or dead server costs a client one candidate, nothing more.

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
