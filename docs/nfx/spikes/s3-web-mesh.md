# Spike S3 — web mesh for NFX-10: **PASS**, with one spec break found (2026-09-23)

**Question:** does p2p-media-loader v4 + hls.js work on NFX hash-named playlists with our
own tracker? Does a sha256 `validateP2PSegment` reject a tampered segment? Can
`streamSwarmIdBuilder` produce the NFX-10 infohash? And where must a fork hook in for
the M2 paid mesh?

**Setup:**
- Code: `web/spikes/s3-mesh/` (`tracker.ts`, `mesh.html`, `run.ts`). It reuses S4's
  origin and a 60 s S4 package (`NFX_DURATION=60`).
- Pinned: p2p-media-loader-core/-hlsjs **4.0.0** (Apache-2.0, released 2026-09-17),
  hls.js 1.7.3, bittorrent-tracker 11.2.3 (MIT), playwright 1.63.0, all installed with
  `--ignore-scripts`.
- Three fresh headless Chromium contexts on one host:
  - **A** is a malicious seed. It loads from an origin that flips the last byte of 360p
    segment #5, and it runs no validation.
  - **B** is an honest viewer. It uses the clean origin with sha256 validators on.
  - **C** is a control that uses p2p-media-loader's default swarm IDs.
- Result: 4/4 PASS on 3 consecutive runs, with identical numbers each time.

## Criteria

| Criterion | Result |
|---|---|
| p2p-media-loader v4 + hls.js on hash-named playlists, own tracker | **PASS.** B reached A through our tracker and received **672 352 bytes over P2P** (plus 1.55 MB over HTTP). A reports the same 672 352 bytes uploaded. The upstream libraries are unmodified. |
| sha256 `validateP2PSegment` rejects a tampered segment | **PASS.** B rejected exactly the tampered file `765c171b…`, and no other P2P segment. p2p-media-loader then **destroyed that peer** (`p2p/peer`: `#destroyOnPeerError("validation-failed")`). B re-fetched #5 over HTTP and played on past it with no fatal errors. |
| `streamSwarmIdBuilder` produces the NFX-10 infohash | **PASS for an NFX swarm ID, but the NFX-10 §2 infohash as specified cannot be produced.** See below. The builder yields `nfx/1/web/<ns>:<video-id>/<rendition-id>`, one swarm per rendition. |
| (added) Own tracker admits only NFX swarms | **PASS.** bittorrent-tracker's `filter` holds an allowlist computed server-side with p2p-media-loader's own `computeInfoHash`. Control C's announce was refused and C found 0 peers. |

## The spec break: NFX-10 §2's infohash

NFX-10 §2 says a bridge announces `infohash = hex(sha256(namespace:video-id)[0..20])`,
one per video. p2p-media-loader v4 does not work that way, and there is no option to
make it:

1. **Swarms are per stream (rendition), not per video.** Two different streams with one
   swarm ID fail registration.
2. **The announced infohash is derived, not set.** `streamSwarmIdBuilder` only returns
   the *pre-hash* string. The library announces
   `base64(sha1(streamSwarmId)[0..15])`, 20 ASCII characters
   (`p2p-media-loader-core/server`: `computeInfoHash`).

**NFX-10 §2 replacement** (adopted 2026-09-23, ADR 0008 addendum 2a; the stream→rendition mapping uses the playlist content name, and the S3 run re-passed 4/4 with it):

- **Stream swarm ID** = `nfx/1/web/<namespace>:<video-id>/<rendition-id>`.
- **Tracker infohash** = `computeInfoHash(stream swarm ID)` of the pinned
  p2p-media-loader v4. Bridges (Rust) reproduce it with sha1 + base64.
- The beacon `webrtc` endpoint's `infohash` becomes a per-rendition map, or is dropped
  because it is derivable. `nfx-proto`'s beacon check would change to match.
- **Mapping a stream to its rendition id.** The spike matched on `BANDWIDTH` +
  `RESOLUTION` from the verified hash list. It is more robust to use the rendition
  playlist's content name (the last path element of the stream URL, identical on
  every origin), or to require those tuples to be unique within a hash list (an
  NFX-05 §2 rule).

## Other findings

- **The validator is five lines, and no PeerTube code was needed.** An NFX content name
  *is* its sha256, so validating is just `sha256(bytes) == last path element` plus
  "is listed". Nothing AGPL was copied, so there is no NOTICE entry for S3.
- **HTTP segments are validated too.** With `validateHTTPSegment`, the browser meets
  NFX-05 §4 on every path, not only P2P.
- **WebCrypto needs a secure context.** `crypto.subtle` exists on `https://` and on
  `localhost`, but not on `http://100.64.0.1`. The web client must be HTTPS, which
  production is anyway. The alternative is to hash with `nfx-proto`'s WASM build, which
  has no secure-context requirement.
- **The tracker sees the infohash as hex of the 20 ASCII characters** (bittorrent-tracker
  converts it), so the allowlist is `hex(latin1(computeInfoHash(id)))`.
- **Only the playing rendition announces.** With `currentLevel` pinned, one of the three
  swarms was active.

## Fork points for the M2 paid mesh (p2p-media-loader-core 4.0.0 `lib/`)

| Need (NFX-10 §3.2) | Where | Today |
|---|---|---|
| Per-request upload gate (the window) | `p2p/loader.js`, `onSegmentRequested(peer, externalId, requestId, byteFrom)` | The only gate is the global `isP2PUploadDisabled` → `sendSegmentAbsentCommand`. The fork asks the pay/1 session whether this peer is within `window`: serve, hold, or send absent. |
| pay/1 messages on the data channel | `p2p/commands/types.js` (`PeerCommandType` 0–5 used), `binary-command-creator.js` / `binary-serialization.js`, and the command `switch` in `p2p/peer.js` | Add command types carrying the NFX-07 JSON (`hello`/`quote`/`pay`/`ack`/`rej`). |
| Delivery accounting (downloader side) | `p2p/peer.js`, the `SegmentDataSendingCompleted` path, right after `validateP2PSegment` succeeds | Count one chunk per validated file and emit `pay` per window. Failed validation already destroys the peer. |
| Session identity | The WebTorrent peer id (random per session) | Key pay sessions per peer connection. The nostr/NIP-60 identity stays in the page. |

Everything else, including stats, bans, the tracker and swarm IDs, needs no fork. **The
M1 free mesh can ship on upstream 4.0.0 unmodified**, as this spike did.

## Not covered

- Real NATs, STUN/TURN, or more than two peers.
- Firefox or Safari as mesh peers (Chromium only).
- Mesh peers across hosts.
- Tracker load.
- A bridge peer speaking both iroh and WebRTC.
- Churn behaviour, and whether a destroyed peer is re-admitted later.
