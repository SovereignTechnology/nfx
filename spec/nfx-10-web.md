# NFX-10 — Web transport profile

**Status: Draft (target freeze: M4)** · depends on NFX-02/03/05

Browsers can't speak QUIC-to-iroh, so the web player reaches the same segment economy
through WebRTC and plain HTTPS. The key design point: **the files are identical**
(NFX-05), so browser and native peers share one swarm economy with zero re-encoding.

## 1. Player stack

- **hls.js** on the master playlist (NFX-05 §§3,6 conventions; hash-named URIs).
- **p2p-media-loader** as the WebRTC mesh layer. Two peer-source plug-ins, both
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

- **Open mode**: p2p-media-loader request hooks attach the NFX-07 §4
  `X-Nutflix-Pay` headers when fetching from paying peers/origins; payment between
  browser mesh peers is per-bridge policy (bridges MAY subsidize mesh traffic).
- **Licensed mode**: one `POST /v1/nfx/license` (NFX-08) per video per session; key
  kept in a Web Worker / module scope only, never `localStorage`.

## 4. Product mapping

- "Ads mode" / free browsing = open manifests with `price_hint: 0` served by
  origins; the website is then a normal L1+L2 client with an origin of its own.
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
