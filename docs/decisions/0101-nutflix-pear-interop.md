# 101. nutflix-pear and nfx on one network: both speak NFX, over HyperDHT

Date: 2026-10-21

## Status

Accepted 2026-10-19 (sovtech's decisions, below). One part is conditional: nfx's Rust HyperDHT
stack waits on spike S5′ (§4). If S5′ fails, this record is revisited before any nfx Phase 1
work; the wire profile (NFX-12) stands either way.

Revisited 2026-10-25: S5′ failed, and [ADR 0103](0103-meet-over-iroh.md) records the course
sovtech chose. nfx does not speak HyperDHT, and the two implementations meet over iroh.

Amends ADR 0006 ("any production implementation of NFX is a new codebase") and ADR 0008 §1 and
§3 (the demo is never reshaped; the harvest of the Hypercore seeder as the NFX-12 sidecar; spike
S5).

## Context

`nutflix-pear` (TypeScript: Electron with a Bare worker, on the Holepunch stack; formerly
`nutflix-demo`) and nfx (Rust, on iroh) are two peer-to-peer, pay-per-chunk video
implementations that share nothing on the wire:

| Layer | nutflix-pear | nfx |
|---|---|---|
| Announce | NIP-71 kinds 21/22 on public relays | NFX-02 kind 38504 on scoped relays; NFX-04 refuses every other kind |
| Presence | none (the host reported 0 seeders, issue #23 there) | NFX-03 kind 20464 beacons |
| Media | progressive faststart MP4 in one shared Hyperblobs core per node | CMAF files named by sha256, a hash list and its `root` (NFX-05) |
| Transport | Hypercore replication on `core.discoveryKey` | iroh-blobs (NFX-06) and HTTPS origins |
| Pay | Protomux `pay/1`, binary, per 64 KiB block, two P2PK-locked proof sets with a carry split | NFX-07 `nfx/pay/1`, NDJSON, per file, one unlocked token, no split |

Each side's parser rejects the other's events. ADR 0008 kept the demo untouched until a harvest
that would move its Hypercore seeder into nfx as an NFX-12 sidecar; the first NFX-12 draft was
written for that sidecar (a Hyperdrive per seeder per video, replicated over a Hyperswarm topic).
No code moves bytes between the two.

## Decision

### 1. Both speak NFX

`nutflix-pear` becomes a **second, independent NFX implementation** on the Holepunch stack. It
does not borrow nfx code: it implements NFX-01 to NFX-05, NFX-07 and NFX-12 from the specs and
their vectors, which is what a standard is for. This reverses ADR 0008 §1's "untouched" and
§3's harvest: nothing is imported from the demo into nfx, and the demo is reshaped in its own
repository.

### 2. NFX-12 becomes files over Protomux on HyperDHT

The rewritten NFX-12 (`spec/nfx-12-hyperdht.md`) has no Hypercore or Hyperdrive in it:

- a watcher dials the seeder by its Noise public key with HyperDHT `connect`;
- it requests whole files by sha256 over Protomux `nfx/files/1`, and every refusal is per request
  (in paid mode, a pay/1 `refuse`);
- `nfx/pay/1` rides the same connection, carrying NFX-07 unchanged;
- a new endpoint type, `hyperdht`, carries the peer key and a `bind` signature that ties it to
  the beacon's nostr key and network; `hyper` is deprecated.

Why files and not Hypercore replication: NFX-07 counts chunks as NFX-05 files and refuses per
request. Hypercore serves blocks on request, so enforcing `window` meant gating individual block
requests, possibly in a patched `hypercore` (the first draft's open issue). A whole-file request
maps one to one onto NFX-06 §2's paid delivery.

**nfx stays Rust.** It speaks HyperDHT natively: no JavaScript sidecar, and no Bare or Node
runtime beside `nfxd`. Spike S5 ("Bare vs Node sidecar") and the harvest of the Hypercore seeder
as the NFX-12 sidecar are void.

### 3. nutflix-pear keeps its legacy protocol beside NFX

NIP-71, Hyperblobs and the binary `pay/1` stay as they are, side by side with the NFX path, with
a separate store, so existing videos, seeders and payments keep working. The decision is recorded
on that side as `nutflix-pear`'s ADR 0020.

### 4. Spike S5′: Rust HyperDHT (the condition)

nfx Phase 1 starts only when S5′ says go. It lives in `crates/spikes/`, its own workspace outside
the M2 lock. Candidate: `peeroxide-dht` (pure Rust, MIT/Apache, RustCrypto; HyperDHT,
secret-stream, Protomux, holepunching and blind relays), young, unaudited and with a small
community. Acceptance, proved in CI against Node `hyperdht` 6.34, `@hyperswarm/secret-stream`
6.9.1 and `protomux` 3.11:

- connect by key in both directions, and Protomux channels that pair across the two;
- a listen and announce, keepalive, timeout and firewall API;
- holepunching between two NATed hosts, and the symmetric-NAT case through a blind relay;
- throughput, compared with iroh;
- a review of its Noise and secret-stream composition, since bearer tokens ride that channel;
  `cargo deny` and RustSec; its release cadence; and a decision between pinning it with review
  and forking it.

If it fails: the `datrs` crates (stalled since 2024), or a port of the thin layers onto
RustCrypto, and this record is revisited.

**The money crates never depend on it.** pay/1 over Protomux feeds the same engine as iroh
through a byte-passing trait, so `nfx-pay` and `nfx-pay-wire` stay under the lock unchanged
(M2.x security session).

### 5. Where interop happens

Wherever a seeder advertises `hyperdht`. `nfxd --hyperdht` is opt-in, like nfx's other exposure
flags, so an nfx seeder running iroh only stays unreachable from `nutflix-pear`, which does not
speak iroh. An `nfxd` with both is the bridge: what it fetches over HyperDHT it serves over iroh,
because the files and their sha256 are the same on every transport (NFX-05 §4).

### 6. Order

- **Phase 0:** this record, the creator-share decision ([ADR 0102](0102-creator-share.md)), NFX-12 and its vectors, spike
  S5′, and the `seedersOnline` fix in `nutflix-pear` (its issue #23).
- **Phase 1, free interop:** both sides publish kind 38504 and beacons and fetch from each other
  on `nfx:testnet:1`. Only videos their creators mark free go to NFX from `nutflix-pear`, so the
  free path never undercuts its paid legacy videos.
- **Phase 2, paid interop:** NFX-07 as frozen, after nfx M2.1.
- **Phase 3, the creator share:** ADR 0102's mechanism, in a new additive Draft (NFX-14), after
  NFX-07 freezes.

## Consequences

- NFX gains a second implementation written from the specs alone. Where the two disagree, the
  spec or its vectors were unclear, which is what conformance work is meant to find.
- `nfx-proto` gains `Endpoint::Hyperdht` and the `nfx/files/1` codec; `nfx-node` gains a
  feature-gated HyperDHT endpoint, a `files/1` server and client, and a `Pull` over it; `nfxd`
  gains `--hyperdht`. One owner-reviewed lock re-pin covers the new CI workflow and the
  `Cargo.lock` change.
- A seeder serving both transports holds one copy of each file. `nutflix-pear` holds two
  encodings of a video it publishes both ways (legacy faststart MP4, NFX CMAF), counted in one
  disk cap.
- `spec/README.md` no longer says the TypeScript app "is not an NFX implementation and is not
  evolved toward one".
- Out of scope: ADR 0100's creator-managed mode (`nfx/bill/1`), the browser mesh (NFX-10),
  Windows and macOS builds, and `nutflix-pear` speaking iroh.
