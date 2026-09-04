# Spike S-B — Browser Hypercore + Hyperblobs over a WebSocket bridge (assumption A8)

Date: 2026-09-04. Scratch dir: `/tmp/scratch/spikes/S-B` (throwaway; nothing under the repo was touched except this file).

## Question

Does the CURRENT pinned stack (hypercore@11.35.3, hyperblobs@2.12.1, corestore@7.12.2, protomux@3.11.0, ws@8.21.3) run in a browser page with **in-memory storage**, replicate over a **WebSocket-as-Duplex** bridge to a Node-side core, and hand back verified blob bytes (full + ranged) fast enough to feed `<video>` via a range-serving service worker / MSE? PASS/FAIL with evidence.

## Method

1. **Node side** (`server.cjs`): real `Corestore` on a tmp dir (i.e. real `hypercore-storage@3.2.1` → `rocksdb-native@3.17.4` linux-x64 prebuild, loaded fine with `npm install --ignore-scripts`) → `Hypercore` → `Hyperblobs.put()` of a 2 MiB `crypto.randomBytes` buffer (32 blocks × 64 KiB; sha256 recorded). `ws` server; each socket wrapped as a `streamx` Duplex (~12 lines) and piped into `core.replicate(false)`. Same HTTP server serves the bundle + `/info`.
2. **Browser side** (`browser.js`, bundled with esbuild): `new Hypercore(new CoreStorage(memDb), key)` where `memDb` is an **in-memory drop-in for `rocksdb-native`** written for this spike (`shims/mem-rocksdb.js`, ~260 lines: sorted array + binary search, read/write batches, range iterators, snapshots, sessions). Browser `WebSocket` wrapped as a streamx Duplex, piped into `core.replicate(true)`. `core.update({wait:true})`, then `blobs.get(id)` and `blobs.get(id, {start:123456, length:66536})`, sha256 via WebCrypto, compared to Node's.
3. **Runner** (`run.cjs`): Playwright 1.62.1 driving ungoogled-chromium (a local Chromium build, `headless: true`, **no `--no-sandbox` needed** — the existing AppArmor userns profile covers it). Three full runs.

## Findings

1. **Storage is the only real obstacle, and it is solvable in JS.** Hypercore 11 accepts ONLY a `hypercore-storage` instance (random-access-storage is gone, per the vendored README); `hypercore-storage` is pure JS *except* for its `rocksdb-native` dependency (a NAPI addon — no browser field, no JS fallback). The API surface it actually uses is small (`session/columnFamily/snapshot/ready/close/suspend/resume/flush/compactRange/get/read/write/iterator`, plus private `_state.closing`/`_index`), so an in-memory shim aliased in place of `rocksdb-native` makes the whole stack load unchanged. `device-file` (fs lock) is never instantiated when a db *instance* (not a path) is passed, and `fs` is only touched by the never-taken `tmpFixStorage`/migration-0 paths — both stubbed. Verified first in Node (shim under real hypercore-storage: put/get/replicate/partial all OK), then in-page.
2. **Bundle builds** with esbuild (`--platform=browser --format=iife --minify`): **559 KB minified, 163 KB gzipped**, 0 Node builtins left (`buffer`, `crypto`, `stream` are not needed — the stack already uses `b4a`/`streamx`/`sodium-universal`). Composition: hypercore 373k, hypercore-storage 158k, sodium-javascript 99k, @noble/curves 88k, streamx 40k, compact-encoding 39k. `protomux`, `compact-encoding`, `hyperblobs`, `@hyperswarm/secret-stream` need no shims.
3. **Second (unexpected) gap: sodium-javascript is incomplete for the Noise handshake.** First in-page run: `core ready` OK, WS connected, then `Error: Noise handshake failed` (from `@hyperswarm/secret-stream` `_onhandshakert`). Cause: `sodium-universal`'s browser field maps `sodium-native → sodium-javascript@0.8`, which lacks **`crypto_scalarmult_ed25519_noclamp`** (+ `crypto_scalarmult_ed25519_BYTES`) required by `noise-curve-ed`. Of 54 sodium symbols the bundle uses, that is the *only* missing one. Polyfilled in 20 lines with `@noble/curves` `ed25519.ExtendedPoint.multiply`; handshake then succeeds against Node's real `sodium-native`.
4. **Core opens in-page with in-memory storage**: `openMs` 7–12 ms; storage impl = `hypercore-storage@3.2.1` over the mem-rocksdb shim; `core.writable=false`, key matches Node's.
5. **Replication over WS completes**: Node logs `peer-add`; in-page `core.update()` → `length 32, peers 1` in **56–61 ms**; `contiguousLength 32` after get.
6. **Bytes match**: full blob 2,097,152 bytes, in-page WebCrypto sha256 == Node sha256 on all 3 runs; ranged `get(id,{start:123456,length:66536})` returned 66,536 bytes whose sha256 == Node's `buf.subarray(...)` sha256. (Merkle-proof verification is done by hypercore before `download` fires, so these are *verified* bytes.)
7. **Timing (loopback, 3 runs)**: time-to-first-verified-block after replication start **78–86 ms** (includes Noise handshake); `blobs.get()` of 2 MiB **196–248 ms**; whole page flow (open→handshake→update→2 MiB→partial) **284–327 ms**. ~8–10 MB/s with the un-tuned spike shim; no `download()`/prefetch hints used.
8. **`download` events fire per block in-page with a peer argument**: 32 events for 32 blocks, signature `(index, byteLength, peer)`; `peer.remotePublicKey` is set and `peer.stream` is present — exactly what pay-after-verify needs to attribute a verified block to a peer.
9. Not built (by design): the service worker / MSE range-serving layer. It is standard browser tech and not the risk A8 was about; the ranged `get` in (6) is the primitive it would call.
10. Native prebuild note: `--ignore-scripts` install worked for the Node side (`rocksdb-native.node`, `sodium-native.node` for linux-x64 present). No missing prebuilds encountered.

## Decision

**PASS.** A8 holds: the pinned Hypercore 11 + Hyperblobs stack runs in a browser page against in-memory storage and replicates over a plain WebSocket Duplex to a Node core, returning verified full and ranged blob bytes in well under a second for 2 MiB, with per-block/per-peer `download` events available. The two things that do NOT work out of the box are (a) `rocksdb-native` (needs a JS `hypercore-storage`-compatible backend — the ~260-line in-memory shim here proves the surface is small) and (b) `sodium-javascript` missing `crypto_scalarmult_ed25519_noclamp` (20-line polyfill). Both are shim work, not architectural blockers. The A8 fallback (gateway-served sha256 segments + MSE) remains available but is not needed.

## Shim/alias list (esbuild `--alias:` flags, exactly as used)

| Alias | → | Why |
|---|---|---|
| `rocksdb-native` | `shims/mem-rocksdb.js` (spike-written) | NAPI addon, no browser build. Implements the batch/iterator/session/snapshot subset hypercore-storage uses. |
| `sodium-universal` | `shims/sodium.js` = `sodium-javascript@0.8` + `@noble/curves` polyfill | `crypto_scalarmult_ed25519_noclamp` missing from sodium-javascript. |
| `sodium-native` | `sodium-javascript` | Belt-and-braces; sodium-universal's own browser field does the same. |
| `device-file` | throwing stub | fs lock file; never constructed when a db instance is passed. |
| `fs` | `{existsSync: () => false}` stub | Only reached by `tmpFixStorage()` / `migrations/0` — neither runs on a fresh in-memory store. |
| `path` | `{join, resolve}` stub | `path.join(db.path, '..')` / `path.join(path, 'db')` in hypercore-storage. |
| `events` | `bare-events` | Node builtin `events` required by hypercore/index.js; bare-events is already in the tree. |

Not needed: `udx-native` (never imported when only `core.replicate()` is used), `buffer`, `crypto`, `stream`, `bare-*` (all resolve via their `default`/browser conditions), `--define:process.env.NODE_ENV` (harmless, kept). Extra runtime deps introduced: `sodium-javascript@0.8.0`, `@noble/curves@1`. A `WebSocket`→streamx Duplex adapter (~15 lines each side) is the only bridge code.

## Open questions

- Production storage backend: the spike shim is in-memory only, snapshot = array copy, `deleteRange` O(n). For a viewer that is probably fine (ephemeral, tens of MB), but a real `rocksdb-native`-compatible OPFS/IndexedDB backend would be needed for persistence/resume — worth a follow-up spike sized in days, not weeks (`hypercore-storage` pokes two private fields, `_state.closing` and `_index`, that should be pinned in tests).
- Throughput at scale: measured on loopback with 64 KiB blocks and no `core.download()` prefetch; real-WAN numbers, larger blobs (hundreds of MB), and memory growth of the shim under a long video are untested.
- `@noble/curves` adds 88k; `libsodium-wrappers-sumo` (WASM) is the alternative if a full-featured sodium is preferred over patching one function. sodium-javascript is also unmaintained-ish (0.8, 2021) — audit before shipping.
- `protomux`/Corestore-level replication (many cores per socket) was not exercised — only a single `core.replicate()`; corestore's `replicate()` should be identical on the wire but was not run in-page.
- The AppArmor userns profile on this machine made headless ungoogled-chromium launch cleanly; CI runners will need the equivalent (or Playwright's own chromium).
