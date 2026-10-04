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

A page pays from the user's NIP-60 wallet, encrypted to the user's key on the user's
relays, since proofs are never kept in browser storage (§3.2), and what it earns goes
there too. Other clients may pay from that wallet at the same time: the user's other
pages, sites and devices. A page's **partition** is the browser storage, with its Web
Locks, that it shares with other pages: that of one web origin (scheme, host and port)
in one browser profile, or, for a player embedded in another site's page, that of its
web origin under that site; a private browsing session has its own. What this section
says of a page holds for a worker it pays or earns from. Whether a page pays an origin
(§3.1) or a peer (§3.2), or earns from a peer (§3.2):

- **Its proofs are its own.** A page pays only with proofs of its own, as NFX-07 §3a
  says every client of a shared wallet does: proofs fresh from a swap it made for that
  payment (NUT-03), set aside in its record (below). It keeps no proofs between
  payments, so that is one swap per payment, and the swap's input fees (NUT-02) are the
  page's.
- **Every payment has a record, written before its swaps.** A payment a page makes or
  earns has a **record** in two parts:
  - its *secret part*, in the wallet, encrypted to the user's key as the wallet's token
    events are: the inputs of the payment's first swap (the swap that makes the
    payment's proofs, or, for a payment earned, the one that claims them), and a NUT-13
    seed drawn at random for the record. Every swap of the record derives its outputs
    from that seed (NFX-07 §3a). It names the page's partition (a random id kept in its
    storage), and only a page of that partition acts on it: it is no NIP-60 token event,
    so no client pays from it, and every other client, browser or not, leaves it alone;
  - its *plain part*, in the partition's storage, holding nothing that can spend: the
    payee or payer; the payment's **sending time**, by which the page sends the payment,
    if at all; the relays that accepted the secret part; the keyset and counters each
    swap's outputs use, none used twice; for a reclaim, which outputs are its inputs;
    which outputs are the payment's; and what each swap and the payment came to.

  A page sends a swap only once both parts name it: the secret part accepted by one of
  the wallet's relays, which the plain part names, and the swap written into the plain
  part. A retry of a swap reuses its outputs (NUT-19). The page notes what a swap came
  to in the plain part before it acts on it, so it sends a payment only once the
  payment's first swap is noted done. NFX-07's 180 s wait for an unanswered payment is
  counted from the sending time. What a record's swaps make stays in the record until
  the page writes it into the wallet: a swap's change, proofs a reclaim takes back and a
  payment earned as soon as the swap that made them is done, and a payment's own proofs
  only if the payment ends unsent. A payment made ends served or acked, settled by a
  quote, unsent, or with its reclaim ended; a payment earned, once its swap's outcome is
  learnt. A first swap that made nothing, because another client spent one of its inputs
  first, made no payment: the payment ends unsent, and no payee is judged by it. Beyond
  this, the record's form is the page's own.
- **One page acts on a record at a time.** Each record has a Web Lock of its own, named
  by the record. The page that makes a record takes its lock before anything names the
  record, and holds it until the record ends: its payment ended, what it came to in the
  partition's standing (below) for a payment made, and what it holds unspent in the
  wallet. A page acts on a record (sends its swaps or its payment, waits for an answer
  or a body, reclaims, learns what a swap did, or notes what it came to) only while it
  holds that lock. The browser frees a page's locks when the page closes (one kept
  frozen, in a back/forward cache or a background tab, holds them until it resumes or is
  discarded, and its payments wait with it). A page that cannot take Web Locks (outside
  a secure context) pays and earns nothing. Every page of the partition that pays or
  earns asks for the lock of each record not yet ended, so it takes the record up once
  the holder has closed, and only then. That page reads both parts again under the lock,
  the secret part from the relays that accepted it, and then:
  - a record whose plain part names no relay that accepted its secret part sent no
    swap: it ends with nothing;
  - otherwise it learns what each swap of the record did as NFX-07 says for that swap
    (§3 for a payment earned; §3a's reclaims for a payment made, its first swap too):
    it reads the swap's inputs (NUT-07) and restores its outputs (NUT-09), and calls no
    proof spent before that restore. A swap of a payment made whose outcome stays
    unknown is sent again, with the same outputs;
  - a payment made whose first swap was not noted done was never sent: once that swap
    is decided, what it made goes into the wallet, and the record ends with no payment.
    One whose first swap was noted done, and that has not ended, goes on as NFX-07
    says for what its record notes: refused, it is reclaimed; with no answer noted, it
    is in flight from its sending time, and reclaimed 180 s after it;
  - it writes into the wallet every output of the record's swaps that is unspent and not
    in the wallet already, a payment's own proofs only if the payment ends unsent, and,
    for a payment made, its first swap's inputs that are unspent and no longer in the
    wallet. A payment earned's inputs are the payer's: they reach the wallet only
    through the swap that claims them.

  Until a page can read the secret part, the record is incomplete, as a reclaim the mint
  cannot serve yet is. A page notes a record's end, and what it came to in the standing,
  in one transaction of the partition's storage, so it counts once. Once a record has
  ended, its secret part may be deleted (NIP-09).
- **A partition never opened again loses what its records hold.** A record that no page
  takes up again (its partition's storage cleared by the user or the browser, its site
  never visited again, or its secret part lost by every relay that accepted it) is no
  page's, and what it holds is lost: a payment in flight, and what a swap made that its
  page closed before writing into the wallet (a swap's change, proofs a reclaim took
  back, a payment earned). That is at most the value of its first swap's inputs for each
  such record. NFX-07 keeps one payment in flight to a payee at a time, so a partition
  loses at most one payment per payee it was paying, and the rest only from swaps whose
  pages closed before writing it. A stated concession. A page SHOULD ask that its
  partition's storage persist (`navigator.storage.persist()`), so the browser does not
  clear it to free space.
- **Its standings are its partition's.** NFX-07's client, §3a's watcher and §4's client
  alike, is the page's partition. Its pages keep its standings (§3a's per seeder, §4's
  per origin) in its storage, since they hold no proofs, and change them only under a
  Web Lock, so a stop, a try used or a back-off holds for them all, and one payment is
  in flight to a payee among them all, named by its record. A page holding that lock
  waits for no other lock. Two partitions are two clients, though they pay from one
  wallet, as two devices are: each keeps standings of its own, and storage cleared makes
  a new partition. So a lying payee takes one payment per name (a seeder's identity, an
  origin's base URL) from each partition that pays it (each web origin, browser
  profile, device and private session, and again after storage is cleared), each with
  its own payment in flight to it: a new partition gains it what a new name does
  (NFX-07 §3a, §4). A stated concession.
- **A closed page's payments to a seeder are settled by no quote.** A page's mesh
  identity (§3.2) is its own, since two pages cannot share one at a tracker, and so are
  its ledgers, which NFX-07 §3a keeps as long as the identity: a quote settles only
  payments made under it. So a payment that awaits a quote (NFX-07 §3a) when its page
  closes, or that a reclaim after it closes finds spent, awaits one no page can get, and
  the partition pays that seeder nothing more, as it pays an origin nothing more that
  kept a closed page's payment (§3.1). A stated concession, the cost of the one-payment
  bound.

### 3.1 HTTPS

When fetching from a paying origin or HTTPS seeder, the player pays as NFX-07 §4 says,
every client rule of it included, as the page's partition (§3). Each rule's form in a
browser is below: the request, the origin's answers, the load and its wait, and what
the page cannot see.

- **The request.** A paid request is a `fetch` of `<base>/<sha256>` over HTTPS (NFX-07
  §4), whichever of NFX-05 §6's paths the player asked for, with `X-NFX-Pay`,
  `mode: "cors"`, `redirect: "manual"`, `credentials: "omit"` and `cache: "no-store"`,
  and no other header a preflight would have to allow (a CORS-safelisted one, such as
  `Accept`, may go). So the token goes (under `no-cors` the browser drops the header
  unsent), and the preflight asks only for what NFX-07 §4's origin allows; no redirect
  is followed, and one shows as such (an `opaqueredirect` answer: a refusal, NFX-07 §4);
  no cookie goes, so `Access-Control-Allow-Origin: *` admits it; and no copy in the HTTP
  cache answers it or adds a conditional header. A service worker of the page's passes a
  request carrying `X-NFX-Pay` to the network untouched, so no copy it holds answers one
  either. It is never an `XMLHttpRequest`, which follows a redirect with the request's
  headers, the token included: whatever loads the file (hls.js, p2p-media-loader), a
  paid load goes through a loader that makes such a `fetch`.
- **What the origin sends.** A cross-origin paid request is preceded by a CORS
  preflight, which the browser passes only on a `2xx`, and a `402`'s `X-NFX-Price` and
  `X-NFX-Mints` are readable only if exposed. A browser can pay only an origin that
  sends what NFX-07 §4 says an origin serving browsers SHOULD.
- **The load and its wait.** NFX-07 §4's client waits 180 s from sending for a final
  status and for a `200`'s whole body, so nothing but the page's own end stops a paid
  `fetch` before it ends or 180 s after its sending time (§3). No loader timeout applies
  to it (hls.js's load policies, p2p-media-loader's `httpNotReceivingBytesTimeoutMs`). A
  load the player drops (a seek, a level or ABR switch, its `destroy`) leaves it
  running, detached: the page still reads and verifies its body, which decides whether
  it was served, then keeps the file or drops it. It fetches the whole file, never the
  rest of one loaded in part (as p2p-media-loader does, with `Range`). While it runs,
  and while its reclaim does, no load from that origin is a paid request: a loader's
  retry, or a second load at once (p2p-media-loader's `simultaneousHttpDownloads`,
  hls.js's main and audio streams), waits, fails, or goes to another source. A page
  that closes or navigates away stops waiting: a payment the origin had swapped is then
  lost, and the partition pays that origin nothing more (NFX-07 §4's stated
  concession); the reclaim falls to another page of the partition (§3).
- **What the page cannot see.** It cannot see when the browser sends the `GET`, which
  may be later than its `fetch`: after the preflight, or once a connection to the
  origin is free. The page calls `fetch` by the sending time its record names (§3) and
  counts NFX-07 §4's 180 s from that time; a `GET` the browser sends later is a request
  that comes late (NFX-07 §4's stated concession). A `fetch` that fails before a status
  (a network error, which is also how a failed preflight, a redirect under
  `redirect: "error"` and an answer without `Access-Control-Allow-Origin` look) is a
  paid request with no final status: the page reclaims 180 s after its sending time, as
  NFX-07 §4 says, never sooner. A `200` whose body stream fails is a `200` cut short
  (NFX-07 §4). A browser may send a `GET` again by itself when its connection failed
  early; the copy carries the same token, so it takes no second payment, and its answer
  is the request's. A `402` whose price or mints the page cannot read names none
  (NFX-07 §4).

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
  (encrypted to the user's key, on the user's relays) as soon as the swap that claims it
  is done (an ack follows that swap, NFX-07 §3), and in licensed mode after `redeem`
  (NFX-09). Proofs MUST NOT be persisted in any browser storage (`localStorage`,
  IndexedDB, Cache API, cookies). A payment earned has a record, written before its
  swap (§3), so what a closed tab earned and had not written through is its
  partition's to write, and lost only with a partition never opened again (§3). An
  earning page's swaps derive their outputs from their records' seeds, so their late
  outcomes (NFX-07 §3) are learnt, by that page or, once it closes, by another page of
  its partition.

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
  `docs/nfx/reviews/2026-09-24-m2.0-twenty-ninth-audit.md`).
  - §3: a page pays from the user's NIP-60 wallet, which other clients share, only with
    proofs fresh from a swap of its own, as NFX-07 §3a now says of every client of a
    shared wallet. Every payment a page makes or earns has a record, written before any
    swap of it is sent: the first swap's inputs and a NUT-13 seed of the record's own in
    the wallet, encrypted as its token events are and accepted by one of its relays; the
    rest (the payee or payer, the sending time from which NFX-07's 180 s wait counts, the
    relays, each swap's keyset and counters, what each swap came to) in the page's
    storage partition, nothing there able to spend. What the swaps make stays in the
    record until it is in the wallet. Each record has a Web Lock, which the page that
    made it holds until the record ends; another page of the partition takes the record
    up only once that page has closed, reads it again, learns what each swap did as
    NFX-07 says (restoring its outputs, NUT-09, before calling any proof spent), and
    writes what the record holds into the wallet. A partition never opened again loses
    what its records hold, at most one payment per payee and the rest only from swaps
    whose pages closed before writing it: a stated concession. NFX-07's client, a
    watcher (§3a) or an origin's client (§4), is the partition: its pages keep its
    standings in its storage and change them under a Web Lock, so a lying payee takes
    one payment per name per partition: a stated concession. A page's mesh identity and
    ledgers are its own, so a closed page's payment that awaits a seeder's quote is
    settled by none, and the partition pays that seeder nothing more: a stated
    concession. (Was: nothing said where a page keeps its standings, its proofs in
    flight or what its outputs derive from, which pages share them, which page acts on
    a payment in flight, or how a swap's outcome is learnt once its page closes.)
  - §3.1 says how a browser pays an origin under NFX-07 §4, rule by rule. A paid request
    is a `fetch` of `<base>/<sha256>` in `cors` mode, with no other header a preflight
    must allow, that follows no redirect (a redirect is a refusal), sends no credentials
    and is answered from no cache, the page's service worker's included; never an
    `XMLHttpRequest`. The page pays only an origin that sends what NFX-07 §4 now says (a
    preflight answered `204` allowing `X-NFX-Pay`, `Access-Control-Allow-Origin: *` on
    every answer, `X-NFX-Price` and `X-NFX-Mints` exposed). No loader timeout or dropped
    load stops a paid `fetch` before 180 s from its sending time; it fetches the whole
    file, never a `Range` resume; and no retry or second load from that origin is paid
    while it or its reclaim runs. A `GET` the browser sends after the sending time (a
    slow preflight, a busy connection) comes late, as NFX-07 §4 concedes. A failed
    `fetch` is a paid request with no final status, reclaimed 180 s after its sending
    time, and a `402` the page cannot read names no price. (Was: the request hooks
    attach the headers, which a browser could not send or read across origins; hls.js's
    default loader follows a redirect with the token; the loaders' timeouts, aborts,
    retries and `Range` resumes each broke a rule of NFX-07 §4.)
  - §3.2: a payment earned has a record too (§3), so what a closed tab earned and had
    not written through is its partition's to write (was: lost with the tab), and an
    earning page's swaps derive their outputs from their records' seeds.
