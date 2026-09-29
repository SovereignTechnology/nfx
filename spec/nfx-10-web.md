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
- **Every segment is verified before use, whatever its source.** A player MUST check
  each segment, from a peer or over HTTPS, against the verified hash list (NFX-05 §4)
  before handing it to the media stack. With p2p-media-loader that means both
  `validateP2PSegment` and `validateHTTPSegment`: the library completes a segment only
  after its validator accepts it, and it drops a peer that sent a bad one. Playlists and
  init segments never travel over the mesh.
- **Finding trackers.** A page is configured with its network's tracker URLs, the same
  way it is configured with relays (NFX-04). A bridge's beacon `webrtc` endpoint (§2)
  names the trackers through which it can be reached.
- **Trackers admit only NFX swarms they can name.** A tracker SHOULD refuse any
  `info_hash` that is not the §2 infohash of a rendition it holds a verified hash list
  for, so it cannot be used as a general signalling service. It relays SDP only, never
  segment bytes.

## 2. Swarms and bridges

**One swarm per rendition.** A browser-mesh swarm carries exactly one rendition of one
video:

```
stream swarm ID  = "nfx/1/web/" + namespace + ":" + video-id + "/" + rendition-id
tracker infohash = base64( sha1( utf8(stream swarm ID) )[0..15] )
```

- `rendition-id` is the hash list's `renditions[].id` (NFX-05 §2).
- `base64` is the standard alphabet of RFC 4648 §4. Fifteen bytes encode to exactly 20
  characters, so there is no padding. The tracker infohash is that 20-character ASCII
  string, not a hex digest. It is exactly what the pinned p2p-media-loader v4 announces
  for a custom stream swarm ID (`computeInfoHash`, NFX-11 §4). A native bridge
  reproduces it with any sha1 and base64 library.
- **Mapping a player stream to its rendition.** Use the stream's playlist URL. Its last
  path element is `<sha256>.m3u8`, which names exactly one `files` entry of role
  `playlist`, and exactly one rendition lists that file as its `playlist` (NFX-05 §2).
  The mapping never uses bitrate or resolution. A stream that maps to no rendition
  joins no swarm and is fetched over HTTPS only.
- Why per rendition: mesh peers trade segments of the stream they are playing, so one
  swarm across renditions would pair peers with nothing to trade. p2p-media-loader also
  refuses two streams with one ID.

A **bridge seeder** is an NFX node that speaks iroh (NFX-06) *and* WebRTC. It is the
only required coupling between the native and web meshes. Bridges appear in beacons
with an extra endpoint:

```json
{ "t": "webrtc", "tracker_urls": ["wss://…"], "renditions": ["720p", "360p"] }
```

`renditions` lists the rendition ids whose swarms the bridge joins. Absent means every
rendition in the hash list. Swarm IDs and infohashes are always derived and never
carried. Native↔web chunk accounting happens on the bridge's own books: it acts as a
normal seeder upstream and a normal p2p-media-loader peer downstream.

- **Segment identity on the wire.** p2p-media-loader names a segment by a number: for
  VOD (`#EXT-X-ENDLIST`) it is the segment's 0-based position in its rendition playlist,
  not the media sequence number. A bridge maps that position to the playlist's content
  name and serves the file with that sha256. Init segments are never requested.
- **A bridge serves only verified bytes**: files it holds, checked against the hash
  list. It has no need to take bytes from browsers. If it does, they are verified like
  any peer's.
- **Protocol versions.** The stream swarm ID does not carry p2p-media-loader's peer
  protocol version. An incompatible future peer protocol therefore needs a new NFX swarm
  ID version (`nfx/2/web/…`), not a change to this one.

## 3. Payments in the browser

### 3.1 HTTPS

When fetching from a paying origin or HTTPS seeder, the player pays as NFX-07 §4 says,
every client rule of it included. In a browser that means:

- **The request.** A paid request is a `fetch` of `<base>/<sha256>` (NFX-07 §4), whichever
  of NFX-05 §6's paths the player asked for, with `X-NFX-Pay`, `redirect: "manual"`,
  `credentials: "omit"` and `cache: "no-store"`. So no redirect is followed, and one
  shows as such (an `opaqueredirect` answer: a refusal, NFX-07 §4); no cookie goes, so
  `Access-Control-Allow-Origin: *` admits it; and no copy in the HTTP cache answers it or
  adds a conditional header. A service worker of the page's passes a request carrying
  `X-NFX-Pay` to the network untouched, so no copy it holds answers one either. It is
  never an `XMLHttpRequest`, which follows a redirect with the request's headers, the
  token included: whatever loads the file (hls.js, p2p-media-loader), a paid load goes
  through a loader that makes such a `fetch`.
- **What the origin sends.** A cross-origin paid request is preceded by a CORS
  preflight, and a `402`'s `X-NFX-Price` and `X-NFX-Mints` are readable only if exposed.
  A browser can pay only an origin that sends what NFX-07 §4 says an origin serving
  browsers SHOULD.
- **What the page cannot see.** A `fetch` that fails (a network error, which is also how
  a failed preflight, a redirect under `redirect: "error"` and an answer without
  `Access-Control-Allow-Origin` look) is a paid request with no final status: the page
  reclaims 180 s after sending, as NFX-07 §4 says, never sooner. A `402` whose price or
  mints the page cannot read names none (NFX-07 §4).
- **Standings.** NFX-07 §4's standings belong to the wallet the page pays from, and last
  as long as it: every page paying from one wallet shares them, with one paid request in
  flight to an origin among them all. They hold no proofs, so browser storage MAY keep
  them. A paid request's proofs stay in the wallet, not in the page alone, set aside so
  that no page spends them, until the request is served or its reclaim ends; so a page
  closed with one in flight leaves the reclaim to the next page that opens the wallet,
  180 s after sending or later. Browser storage cleared while the wallet lives
  loses the standings: a lying origin the page had stopped paying then takes one payment
  more, as a new name would (NFX-07 §4). A stated concession.

### 3.2 Paid browser mesh (M2)

Browser peers earn sats for serving other browsers. There is one rule set for the
mesh, and it is NFX-07's:

- **Messages.** The pay/1 messages of NFX-07 §2 (`hello`, `quote`, `pay`, `ack`,
  `rej`, `refuse`), byte-identical JSON, travel on the WebRTC data channel
  p2p-media-loader already holds open between two peers. A peer opens a pay session per
  remote peer and video it watches, as on iroh, and NFX-07 §3 allows several open at once
  on one account, up to the per-peer cap. The channel meets NFX-07 §2's delivery rule:
  a message unacknowledged for 60 s closes it. A browser↔bridge link is the same (§2).
- **Unit and window.** The mesh accounts in **chunks, where one chunk is one NFX-05
  file**. That is a whole segment or init, never a WebRTC message fragment. `quote.window`
  is the number of chunks a peer will upload unpaid, default 8 (about 16 s of video at
  2 s segments). As on iroh (NFX-07 §3), every upload request counts as one chunk when
  it is admitted, whole or aborted, and the payer pays for every chunk it requested
  and was not refused. Counting only whole deliveries would let a peer abort each
  transfer at 99% and never owe anything. An uploader serves under NFX-07 §3's service
  limit: `window` per account, and a global cap per `debt_ttl`. A refused upload request
  is answered with pay/1 `refuse` on the data channel, so the requester can tell it from
  an aborted transfer.
- **Identity.** A mesh peer's id is self-chosen, so a ban on the mesh holds only until
  the peer takes a new id. The global cap is what bounds an uploader's loss here, as on
  every transport (NFX-07 §3).
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
  (encrypted to the user's key, on the user's relays) as soon as it is `ack`ed (an ack
  follows the completed swap, NFX-07 §3), and
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
- Draft 2026-09-23 (spike S3; sovtech's decision, ADR 0008 addendum). One swarm per
  rendition: stream swarm ID `nfx/1/web/<namespace>:<video-id>/<rendition-id>`, tracker
  infohash `base64(sha1(id)[0..15])` (p2p-media-loader v4 `computeInfoHash`), streams
  mapped to renditions by playlist content name. The `webrtc` endpoint drops `infohash`
  and gains an optional `renditions`. The old per-video `hex(sha256(…)[0..20])` could not
  be announced by any p2p-media-loader v4 peer.
- Draft 2026-09-24 (M1 mesh built). §1: every segment is verified whatever its source;
  pages are configured with trackers like relays; trackers admit only swarms they can
  name. §2: the external segment id is the VOD playlist position; bridges serve only
  verified bytes; the swarm ID carries no p2p-media-loader protocol version. Evidence:
  `web/player/e2e-mesh.ts` (a real player, the embedded tracker and the Rust bridge, PASS
  3/3).
- Draft 2026-09-24 (M2.0 audit): §3.2 counts every admitted upload request, not only
  whole deliveries. The old rule let aborted transfers go unpaid without bound.
- Draft 2026-09-24 (M2.0 second audit): §3.2 follows NFX-07 §3 as reworked. The service
  limit is per peer across videos, plus the global cap. Refused requests are not owed,
  and earnings are written through after the ack, which now follows the swap. Mesh
  identities are self-chosen, so the global cap is the bound.
- Draft 2026-09-24 (M2.0 fourth audit): §3.2 follows NFX-07 as revised. The window is
  per account, and a refused upload request is answered with pay/1 `refuse`.
- Draft 2026-09-24 (M2.0 sixth audit): §3.2 lists `refuse`, allows several pay sessions
  on one account as NFX-07 does, and holds the data channel to NFX-07 §2's delivery rule.
- Draft 2026-09-29 (M2.0 twenty-ninth audit,
  `docs/nfx/reviews/2026-09-24-m2.0-twenty-ninth-audit.md`): §3.1 says how a browser
  pays an origin under NFX-07 §4. A paid request is a `fetch` of `<base>/<sha256>` that
  follows no redirect (a redirect is a refusal), sends no credentials and is answered
  from no cache, the page's service worker's included; never an `XMLHttpRequest`. The
  page pays only an origin that sends what NFX-07 §4 now says an origin serving browsers
  SHOULD (the preflight allowing `X-NFX-Pay`, `Access-Control-Allow-Origin` on every
  answer, `X-NFX-Price` and `X-NFX-Mints` exposed). A failed `fetch` is a paid request
  with no final status, reclaimed 180 s after sending; a `402` it cannot read names no
  price. The standings belong to the wallet, shared by its pages and kept as long as it,
  and a paid request's proofs stay set aside in the wallet until it ends. Browser storage
  cleared while the wallet lives costs one payment more per lying origin: a stated
  concession. (Was: the request hooks attach the headers, which a browser could not send
  or read across origins, and hls.js's default loader follows a redirect with the token.)
