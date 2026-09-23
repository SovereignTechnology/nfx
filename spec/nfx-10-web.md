# NFX-10 — Web transport profile

**Status: Draft (target freeze: M4)** · depends on NFX-02/03/05

Browsers can't speak QUIC-to-iroh, so the web player reaches the same segment economy
through WebRTC and plain HTTPS. The key design point: **the files are identical**
(NFX-05), so browser and native peers share one swarm economy with zero re-encoding.

## 1. Player stack

- **hls.js** on the master playlist (NFX-05 §§3,6 conventions; hash-named URIs).
- **p2p-media-loader** (v4, pinned in NFX-11 §4) as the WebRTC mesh layer. Two peer-source plug-ins, both
  conformant:
  1. **WebTorrent trackers** (wss) — primary; fast, mature;
  2. **scoped-relay signaling** (NFX-04) — censorship-resistant fallback: SDP offers/
     answers relayed as short-lived nostr ephemerals (profile TBD before freeze;
     never carry blob bytes).

## 2. Bridges

A **bridge seeder** is an NFX node that speaks iroh (NFX-06) *and* WebRTC — the only
required coupling between the native and web meshes. Bridges appear in beacons with an
extra endpoint `{ "t": "webrtc", "tracker_urls": [wss…], "infohash": "<t>" }` where
`infohash = hex( sha256(utf8(namespace + ":" + video-id))[0..20] )` — take the first
20 **bytes** of the digest, then hex-encode (40 lowercase hex chars). Native↔web chunk
accounting happens on the bridge's own books; it acts as a normal seeder upstream and
a normal p2p-media-loader peer downstream.

## 3. Payments in the browser

### 3.1 HTTPS

When fetching from a paying origin or HTTPS seeder, the player's HTTP request hooks
(hls.js / p2p-media-loader) attach the NFX-07 §4 `X-NFX-*` headers.

### 3.2 Paid browser mesh (M2)

Browser peers earn sats for serving other browsers. There is one rule set for the
mesh, and it is NFX-07's:

- **Messages.** The pay/1 messages of NFX-07 §2 (`hello`, `quote`, `pay`, `ack`,
  `rej`), byte-identical JSON, travel on the WebRTC data channel p2p-media-loader
  already holds open between two peers. There is one pay session per remote peer and
  video, as on iroh. A browser↔bridge link is the same (§2).
- **Unit and window.** The mesh accounts in **chunks, where one chunk is one NFX-05
  file**. That is a whole segment or init, never a WebRTC message fragment. `quote.window`
  is the number of chunks a peer will upload unpaid, default 8 (about 16 s of video at
  2 s segments). A chunk counts as delivered only once all its bytes have arrived and
  passed NFX-05 §4. An aborted or failed transfer counts for nothing, so a payer never
  owes for fragments, and the uploader's exposure to aborted transfers is bounded by
  `window`. An uploader MUST stop serving a session beyond `window` unpaid chunks.
  Licensed videos add the proof lock of NFX-08 §4.
- **Upload gate.** Upstream p2p-media-loader v4 (Apache-2.0) has no hook that can
  approve or refuse an individual upload request, and no application message channel
  on its data channel. A paid-mesh peer therefore runs a maintained fork of v4 that
  adds (a) a per-request upload gate driven by the pay/1 session state and (b) pay/1
  framing on the existing data channel. The fork changes no segment bytes and no
  tracker protocol, so it interoperates with upstream peers as a free peer.
- **Free peers coexist.** A peer without the fork, or one that is not charging,
  serves and fetches for free (the M1 mesh). A paid peer MUST NOT upload beyond
  `window` to a peer that does not speak pay/1, unless it has chosen to serve free.
- **Earnings.** Ecash a browser earns is written through to the user's NIP-60 wallet
  (encrypted to the user's key, on the user's relays) as soon as it is `ack`ed, and
  in licensed mode after `redeem` (NFX-09). Proofs MUST NOT be persisted in any
  browser storage (`localStorage`, IndexedDB, Cache API, cookies). A closed tab
  loses at most the earnings not yet written through.

### 3.3 Licensed mode

One `POST /v1/nfx/license` (NFX-08) per video per session; key kept in a Web Worker /
module scope only, never `localStorage`.

## 4. Product mapping

- "Ads mode" / free browsing = open manifests with `price_hint: 0` served by
  origins; the website is then a normal L1+L2 client with an origin of its own.
  For a licensed video the site operator buys the key once (NFX-08 §4) and its CDN
  caches the ciphertext (NFX-05 §6.3). The creator is paid `key_price`, funded by the
  ads.
- The website is an ordinary privileged participant: origin fleet + indexer +
  (optionally) operator of public scoped relays. No protocol privileges exist.

## 5. Non-goals

Browser-side iroh emulation, torrent protocol bridging, Subresource-Integrity CSP
policy of specific deployments (deployment concern), and anything that changes the
NFX-05 byte formats.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fix): infohash derivation made unambiguous (byte-slice
  then hex).
- Draft 2026-09-23 — wire token `nfx`: headers `X-NFX-*` (ADR 0008 §2). Plan
  amendment 5: §3 rewritten. Browser peers are paid over pay/1 on the
  p2p-media-loader data channel through a maintained v4 fork (per-upload gate). The
  mesh window is counted in whole NFX-05 files, and earnings are written through to
  NIP-60, never to browser storage. The earlier text left mesh payment to bridge
  policy. §4 maps ad mode onto licensed videos.
