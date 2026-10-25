# 103. nfx and nutflix-pear meet over iroh: the desktop app runs a thin iroh helper

Date: 2026-10-25

## Status

**Proposed** 2026-10-25. The course (§1) is sovtech's decision of 2026-10-25. The mechanism (§2)
and the order (§3) await sovtech's acceptance.

Revisits [ADR 0101](0101-nutflix-pear-interop.md) §4, as that record requires once spike S5′
fails, and amends its §2 ("nfx stays Rust. It speaks HyperDHT natively") and §5 (where interop
happens). ADR 0101 §1 (both speak NFX, nutflix-pear written from the specs alone) and §3 (the
legacy protocol beside NFX) stand.

## Context

- **Spike S5′ failed** (2026-10-21, [`spikes/s5-hyperdht.md`](../nfx/spikes/s5-hyperdht.md)).
  peeroxide 1.7.3, the one Rust HyperDHT, does not serve Node peers, its client fails behind
  NATs, two Rust peers lose their connection, and it has security findings of its own. Making it
  work means owning most of a 30,000-line stack: the routing, holepunching and relays failed, not
  the thin layers.
- **sovtech chose the record's third course on 2026-10-25:** nutflix-pear speaks iroh as well,
  "as long as it can work over the Pear network and pear:// addresses", confirmed as: it stays a
  Pear app, on the Pear runtime and HyperDHT, installable from its `pear://` address; iroh is
  added beside what it has. A Rust HyperDHT stays possible later; it is not planned.
- **How a Pear app can speak iroh** (research of 2026-10-25; sources at the end):

  | Way | Connectivity | iroh-blobs | Fits the desktop app | Verdict |
  |---|---|---|---|---|
  | A helper process, Rust, spawned by the Bare worker over stdio | direct and relayed | n0's crate as is | `bare-subprocess` as for ffmpeg; a per-platform `prebuilds/` package like `bare-sidecar`, which the native-module inventory and ADR 0017's staging see; a `pear://` drive keeps the executable bit (Hyperdrive's per-entry `executable`) | **chosen** |
  | `@number0/iroh` 1.2.0 (napi-rs) in the worker | full | **none**, nor iroh-gossip; stream I/O as `Array<number>` | its `.node` imports 57 Node-API symbols that Bare's libnapi exports, but no napi-rs addon is known to run under Bare | rejected |
  | A Rust addon of our own (`bare-rust`) | full | in process | `.bare` prebuilds fit the inventory exactly | later, once `bare-rust` (0.0.x) is proven |
  | iroh built for wasm32 | **relay only** | memory store | no `.wasm` marker in the inventory; a WHATWG WebSocket shim over `bare-ws`; unverified in Bare | a spike at most |

- **Pear v3 removed `pear run`** (pear 3.0.0, 2026-07-14). A `pear://` address is now a drive
  holding the packaged app for each platform, installed with `pear install`; nutflix-pear's ADR
  0017 §6 already plans it as a download channel, with no OTA.

## Decision

### 1. The networks meet on iroh

- **nfx does not speak HyperDHT.** ADR 0101 §2's native Rust HyperDHT, and every nfx item of
  its Phase 1 that rests on it (`Endpoint::Hyperdht` dialing, a `files/1` server and client, a
  `Pull` over them, `nfxd --hyperdht`), are dropped. `nfx-proto` already skips a `hyperdht`
  endpoint as NFX-03 §4 requires, and keeps doing so.
- **NFX-12 stays in the suite** as an optional profile, which nutflix-pear speaks between its own
  peers over the reference stack. It is not where the two implementations meet.
- **nutflix-pear speaks NFX-06**: it advertises an `iroh` endpoint in its beacons (NFX-03), serves
  and fetches over iroh-blobs as NFX-06 §2 states (one HashSeq per rendition, the pinned
  0.103.x series of NFX-11 §4), and, in Phase 2, carries `nfx/pay/1` over iroh unchanged.
- **The legacy protocol and NFX-12 stay**: nutflix-pear keeps HyperDHT, its NIP-71 path and its
  Hyperblobs cores beside NFX, and stays installable from its `pear://` address.

### 2. How the desktop app runs iroh (proposed)

- **A thin helper, not `nfxd`.** A small Rust program in nutflix-pear's own repository, built on
  n0's `iroh` 1.x and `iroh-blobs` 0.103.x. Running `nfxd` would run nfx's own NFX code inside
  nutflix-pear, against ADR 0101 §1's "written from the specs alone", and would hash and store
  files where the worker cannot check them.
- **It moves bytes; the worker decides.** The helper dials and accepts iroh connections, fetches
  and serves blobs by their BLAKE3 hash, and passes `nfx/pay/1` streams through as bytes.
  NFX-05 parsing and every sha256 check before a file is used, the NFX file store, beacons,
  NFX-07 and every money decision stay in the JS worker, as the codec and store do today.
- **Configured as nfx's node is:** the network's own relays (a custom relay map), no n0
  discovery, the iroh-blobs standard ALPN and `nfx/pay/1` (NFX-06).
- **Supervised by the Bare worker:** spawned with `bare-subprocess`, framed messages over stdio,
  no listening socket of its own, restarted on exit. The transcode path's `ProcessRunner` runs a
  process to completion, so this is a new, long-lived supervisor.
- **Packaged like `bare-sidecar`:** a `prebuilds/<platform>-<arch>/` package, executable at
  build time and never `chmod`ed at run time, so `check:native` lists it and ADR 0017's staging
  keeps one per target. It is signed with the rest of the app once the app has its certificates.

### 3. Order

1. **A spike in nutflix-pear** before any slice depends on it: the helper on linux-x64; it fetches
   a rendition from `nfxd` over iroh-blobs and serves one to it, both directions, through the
   NAT matrix S5′ used, in CI. Its size and memory are measured.
2. The helper for the other targets nutflix-pear ships (macOS, Windows), which nfx itself has
   never built for.
3. nutflix-pear's Phase 1 slices that publish and fetch over iroh, and the Phase 1 exit run's
   cross pairs over NFX-06.

## Consequences

- **nfx's Phase 1 has no transport work left:** it already speaks NFX-06, publishes kind 38504
  and beacons, and fetches over iroh. Its Phase 1 is the exit run against nutflix-pear.
- **nutflix-pear gains a Rust build** for every target it ships, a second process per node, and
  a helper of unmeasured size per platform (likely 20 MB or more), signed like the rest.
- **One file may be held twice on a desktop node**: once in the helper's iroh-blobs store, to
  serve it, and once in the worker's NFX file store, checked. Whether the helper's store is a
  cache handed off and evicted, or counted in the one disk cap, is the spike's to settle.
- **Payments stay in JS:** in Phase 2 `nfx/pay/1` crosses the stdio pipe as bytes, so the money
  code is nutflix-pear's locked JS, not the helper.
- **Not decided here:** an in-process Rust addon, once `bare-rust` is proven; and Windows on
  `pear://`, which waits for an msix maker (ADR 0017's open question 3).

## Sources (read 2026-10-25)

- iroh's JavaScript binding: `@number0/iroh` 1.2.0 on npm (from `n0-computer/iroh-ffi`, iroh 1.4.1;
  its `index.d.ts`), docs.iroh.computer/languages, and n0's advice for other languages, "a small
  application-specific binary" (docs.iroh.computer/deployment/other-languages).
- iroh in browsers, relay only: docs.iroh.computer/deployment/wasm-browser-support.
- iroh 1.0's stable wire protocol across 1.x: iroh.computer/blog/v1.
- Bare's addons and Node-API layer: `bare-module` (`Bare.Addon.load`), holepunchto/libnapi,
  holepunchto/bare-rust and bare-addon-rust; `bare-sidecar` 0.5.4's per-platform executable.
- `pear://` and executables: localdrive 2.2.1, hyperdrive 13.3.3 (`executable` per entry),
  mirror-drive 1.14.2, pear-install 1.4.0, and pear's CHANGELOG for 3.0.0 (no `pear run`).
- nutflix-pear's own constraints: its ADR 0017 (packaging, `pear://`), ADR 0020 (speak NFX), the
  native-module inventory (`scripts/native-module-inventory.mjs`, `docs/native-modules.txt`) and
  the worker's `bare-process-runner.ts`.

