# NFX-10 at M1: the free browser mesh — plan (2026-09-24)

**Status (2026-09-24): built on branch `nfx10/mesh`. Every item below is done, with
the bridge in M1 as decided.** Review: [`reviews/2026-09-24-nfx10-m1.md`](reviews/2026-09-24-nfx10-m1.md).
The e2e (`web/player/e2e-mesh.ts`) passes 3/3:
- a real player gets segments over WebRTC and rejects a tampered one;
- with its origin cut off, it plays on from the Rust bridge.

NFX-10 is Draft (freeze at M4). M1 is the *free* end-to-end slice (ADR 0008 §5). Spike S3
showed the free mesh runs on **upstream p2p-media-loader 4.0.0 unmodified**, with
validators rejecting a tampered peer ([`spikes/s3-web-mesh.md`](spikes/s3-web-mesh.md)).
The v4 fork (per-upload gate, pay/1 framing) belongs to M2, when peers get paid.

## What already exists

- `nfx-proto`: `VideoAddr::web_stream_swarm_id` / `web_tracker_infohash` (NFX-10 §2,
  cross-checked against the library), and the beacon `webrtc` endpoint (`tracker_urls`,
  optional `renditions`).
- `web/player`: hls.js behind a loader that verifies every file with `nfx-wasm` before
  hls.js sees it; resolution by manifest address over Nostr; origins from verified
  beacons.
- S3's reference tracker (`bittorrent-tracker` 11.2.3 with an allowlist `filter`).

## Work items

1. **`nfx-wasm` exports for the mesh**
   - The stream swarm ID for a playlist URL. It maps the URL to its rendition by the
     playlist's content name (NFX-10 §2), and returns nothing for a stream that maps to
     no rendition.
   - A segment validator. The content name must equal `sha256(bytes)`, and the name must
     be listed in the verified hash list. It uses WASM, not WebCrypto, so it needs no
     secure context (S3 finding).
2. **The player mesh** (`web/player`, opt-in with `&tracker=`)
   - Pin `p2p-media-loader-core` and `-hlsjs` 4.0.0 (Apache-2.0), installed with
     `--ignore-scripts`.
   - `streamSwarmIdBuilder` uses item 1. A stream with no rendition gets a unique
     per-session ID, so it meets no peers and stays HTTPS-only.
   - `validateP2PSegment` **and** `validateHTTPSegment` use the WASM validator. A peer
     that fails validation is destroyed (library behaviour, seen in S3). Playlists and
     inits keep going through the existing verifying loader.
   - Trackers come from `&tracker=wss://…` and from verified beacons' `webrtc`
     endpoints. They are sanitized like origins: `wss:` only (plus `ws://localhost` for
     tests), no credentials, no query, capped.
   - Mesh stats (P2P bytes down and up) are shown on the page for the e2e.
3. **A tracker for the network** (decision A below).
4. **e2e**: a tracker, an `nfxd` origin, and three fresh headless Chromium contexts:
   - A: honest, and seeds first.
   - B: honest viewer. Asserts P2P bytes > 0 and plays past its window.
   - T: tampered. Its origin flips a byte of one segment. B must reject exactly that
     file over P2P, drop T, and play on.
   - Plus a peer on an unmapped stream, or a foreign infohash, that the tracker refuses.
5. **Spec (NFX-10 is Draft, so edits are allowed):**
   - How a page learns the network's trackers when no bridge is announced (decision B);
   - that validation applies to HTTP as well as P2P;
   - the stream-with-no-rendition rule, as implemented.

## Decisions

**Decided (sovtech, 2026-09-24): A = embedded tracker in `nfxd`; C = build the bridge in M1.**
The bridge is a Rust WebRTC peer in `nfx-node`. So headless `nfxd` and the desktop app,
which embeds the same `Daemon`, can both bridge every video they store, not only the
stream in the window. The alternative, p2p-media-loader inside the desktop webview,
would bridge only what is playing. Order of work: items 1–4 (browser mesh + tracker),
then the bridge (item 6 below).

**A. The tracker.** Recommendation: **(1) embedded in `nfxd` (`--embed-tracker`)**.

1. **Embedded tracker in `nfxd`.** It is a minimal WebTorrent-tracker subset in Rust
   (announce, offer/answer relay, stop), behind `ConnLimits`.
   - **It admits only the swarms of videos this node holds**, because it already has
     their verified hash lists, so admission needs no allowlist file.
   - One binary, the same pattern as the embedded scoped relay (NFX-04 §7).
   - Cost: we implement the signalling protocol (~300–400 lines plus limits). The e2e
     against real p2p-media-loader clients proves compatibility.
2. **Node sidecar** (S3's `bittorrent-tracker`, pinned). Proven with this exact client,
   but it adds a second runtime and an npm server tree on the public edge. Its
   allowlist would have to be fed from `nfxd`.
3. **Open tracker for testnet.** The least code, but anyone can use it for any swarm.
   Acceptable only as a test fixture.

**B. How a page finds trackers without a bridge.** Recommendation: **configured, like
relays** (`&tracker=`, and a site's own config). Beacon `webrtc` endpoints are added
when bridges exist. There is no new beacon endpoint type: NFX-03 is frozen.

**C. The bridge seeder** (a native node that speaks iroh *and* joins the WebRTC swarms).
Recommendation: **defer to M2**, where it arrives with the fork and paid accounting.
- At M1, native and web meet over HTTPS: `nfxd`'s pull-through origin serves browsers
  bytes it pulls over iroh.
- A Rust WebRTC peer speaking p2p-media-loader's binary protocol is the largest piece
  of NFX-10, and it only pays off once the web mesh is paid.

## 6. The bridge seeder (decided for M1)

- **A Rust WebRTC peer in `nfx-node`.** It speaks p2p-media-loader 4.0.0's data-channel
  commands, answering and requesting segments and announcing which ones it has. It
  signals through WebTorrent trackers: its own embedded tracker, or any tracker in the
  configuration.
- It serves segments from the verified content store, and pulls misses over iroh
  through the same bounded, re-anchoring fetch the origin uses.
- It never trusts browser bytes: whatever it takes from a browser peer is checked
  against the hash list, like everything else.
- It is announced in beacons with the NFX-10 §2 `webrtc` endpoint (`tracker_urls` and
  `renditions`).
- **Library:** a maintained Rust WebRTC stack with data channels (`str0m` or
  `webrtc-rs`), chosen after a compatibility probe against Chromium. No hand-written
  crypto: DTLS and SCTP come from the library.
- **Probe (2026-09-24): str0m 0.23.1 interoperates with Chromium. PASS 3/3.**
  - Setup: `default-features = false`, `rust-crypto` backend (no C crypto). str0m
    answers a fresh headless Chromium context's data-channel offer over loopback.
  - ICE completes even though Chromium hides its host candidates as mDNS `.local`
    names: str0m learns the browser's address from its connectivity checks. So a
    bridge only needs its own candidate to be reachable.
  - 1 MiB in 16 KiB binary messages is echoed byte-identical.
  - Trap found: `Channel::write` returns `false` when the SCTP send buffer is full, and
    that data is not sent. A bridge needs a send queue that retries *after network
    input*, because the SACKs are what free the buffer. Retrying in a tight loop
    livelocks.
  - **str0m is the library.**
- **Tests:** a browser plays with the origin blocked mid-stream and gets its remaining
  segments from the bridge over WebRTC. A bridge offered tampered bytes by a browser
  rejects them.
- **Known risk:** S3 tested no real NATs or STUN/TURN. Across real home NATs a bridge
  may need STUN, and at worst TURN. At M1 the testnet is the tailnet and LAN.

## Not in M1

The paid mesh and fork (M2), licensed keys in the browser (M3), and scoped-relay
signalling (NFX-10 §1 fallback; its profile is still TBD).
