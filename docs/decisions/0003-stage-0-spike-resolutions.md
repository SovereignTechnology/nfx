# 3. Stage 0 spike resolutions: A4, A8, A9, transcode path, desktop shell shape

Date: 2026-09-04

## Status

Accepted

## Context

`docs/plan/build-plan.md` §0 lists assumptions that had to be verified before the
contracts could freeze. Stage 0 ran three spikes (`docs/spikes/`) against the pinned
versions and vendored docs (`docs/vendor/`), and the vendoring itself surfaced one more
discrepancy with the plan.

## Decision

| Item | Resolution | Evidence |
|------|------------|----------|
| **A4** per-peer upload gating | Hypercore has no per-peer pause API. The tool is `hyperswarm` `peerInfo.ban(true)` then `stream.destroy()`, invoked **synchronously inside the `upload` event**, which fires before the block hits the wire — so the block that crosses the window is never sent. Residual = window. Bans persisted on both Noise key and Nostr pubkey. | `docs/spikes/S-A-…` (source read of `hypercore@11.35.3`) |
| **A8** browser playback | **Holds.** Hypercore 11 + Hyperblobs replicate in-page over a WebSocket Duplex with an in-memory `hypercore-storage` backend; verified bytes, per-block `download` events with peer attribution, 2 MiB in ~250 ms on loopback. Requires two shims: an in-memory `rocksdb-native` drop-in (~260 lines) and a `crypto_scalarmult_ed25519_noclamp` polyfill for `sodium-javascript`. Web shell primary = service-worker range serving from the in-page core; MSE fallback kept. | `docs/spikes/S-B-…` (runtime, Playwright + ungoogled-chromium) |
| **A9** block size | **Confirmed** 64 KiB default in `hyperblobs@2.12.1`; id shape `{byteOffset, blockOffset, blockLength, byteLength}`. | `docs/vendor/hyperblobs.md` |
| **Spike C** transcode | `bare-ffmpeg@1.5.0` cannot encode H.264 (no x264, GPL off), cannot write faststart MP4, has no seek, and no `bare-*` addon loads under Node. **L8 uses an external `ffmpeg` binary via `bare-subprocess` (desktop) / `child_process` (gateway).** `@sovit/core/media` is pure planning code with injected `ProcessRunner` + `FsAdapter` (`contracts/media.ts`). bare-media may serve probe/thumbnails in a Bare-only optional package later. | `docs/spikes/S-C-…` (runtime under Bare 1.31 and Node 22) |
| **Desktop shell shape** | The plan says "pear-electron shell". The current upstream shape (Pear docs `published` branch, `hello-pear-electron`, and the `pear-video-stream` reference app) is **plain Electron + electron-forge with `pear-runtime` inside a Bare worker**, packaged by `pear-electron-forge-maker-*`. The `pear-electron` npm package (1.7.28) is the older runtime. **L6 builds the upstream shape**, not `pear-electron`. Security posture is unchanged: `contextIsolation`, `sandbox`, no `nodeIntegration`, preload exposes only `NetworkAdapter`. | `docs/vendor/pear-desktop-architecture.md`, `docs/vendor/examples/video-stream/` |

Contracts bumped to `CONTRACTS_VERSION = 2` and **frozen** for the Stage 1 fan-out.

## Consequences

- The seeder's window accounting lives in the `upload` handler and must not `await` before
  deciding to cut. L2's definition of done includes runtime verification of the S-A claim.
- The web shell carries two small shims that must be tested against every Hypercore bump
  (`hypercore-storage` touches two private fields of the db object). `sodium-javascript`
  is old (0.8, 2021); audit before shipping or switch to `libsodium-wrappers-sumo`.
- Desktop transcoding depends on a shipped/static `ffmpeg` (open question: licensing and
  bundle size vs. gateway-side transcode only). If the player policy ever allows VP9/AV1,
  bare-ffmpeg becomes viable and the binary dependency disappears on desktop.
- The plan's `pear-electron` wording in §2.1 / L6 is superseded by this record; the plan
  files are left verbatim as the historical input.
