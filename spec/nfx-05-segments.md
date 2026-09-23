# NFX-05 — Segments & content integrity

**Status: Draft (target freeze: M1)** · depends on NFX-01/02

The data plane. One content-addressed unit (a **file**) used identically by every
transport — iroh, HTTPS origin, and (NFX-10) WebRTC mesh — so all transports feed one
swarm economy and no implementation ever re-encodes between products.

## 1. Media profile

- Container: **fMP4/CMAF**. One **init segment** per rendition, then media segments.
- Baseline codecs (every publisher MUST offer): H.264 High (`avc1`) + AAC-LC (`mp4a`).
- Optional renditions: AV1 (`av01`) or VP9 (`vp09`) video, Opus (`opus`) audio —
  labelled in the hash list; players pick.
- Segment duration: target 2 s, allowed 1–6 s; every media segment starts at an IDR
  (SAP type 1/2). Master playlist SHOULD set `EXT-X-INDEPENDENT-SEGMENTS`.
- One rendition set per video. ABR by switching renditions at segment boundaries.

Rationale: `.m4s` chunks are range/segment friendly, play via hls.js/MSE in browsers
and `mpv`/ffmpeg natively, and hash-addressed chunks dedupe across renditions.

## 2. The hash list (signed-by-reference integrity anchor)

The manifest (NFX-02) anchors one document: the **hash list**, whose sha256 is the
manifest's `root` tag. The hash list is fetched by `root` (so it is itself
hash-verified on arrival) from any origin/seeder and MUST NOT be trusted from any
other source. Canonical address: `GET {origin}/{root-hex}`.

Format: UTF-8 JSON (schema: `schemas/hashlist.schema.json`). No canonicalization
rules are needed — `root` commits to the exact bytes.

```json
{
  "v": 1,
  "video": "nfx:mainnet:1:salt-flats-dusk",
  "files": [
    { "name": "master.m3u8", "role": "playlist-master", "sha256": "…", "size": 412 },
    { "name": "r720.m3u8",   "role": "playlist",       "sha256": "…", "size": 631 },
    { "name": "init-720.mp4","role": "init",           "sha256": "…", "size": 877 },
    { "name": "…",           "role": "segment",        "sha256": "…", "size": 481233, "dur_ms": 2000 }
  ],
  "renditions": [
    { "id": "720p", "playlist": "r720.m3u8", "bandwidth": 2500000,
      "codecs": "avc1.64001f,mp4a.40.2", "resolution": "1280x720" }
  ]
}
```

Rules:

- `v` = 1. `video` MUST equal the manifest's `<namespace>:<video-id>`.
- `files` covers **everything**: master playlist, per-rendition playlists, inits,
  segments, optional `thumb`/`subtitle` roles. `role` ∈
  {`playlist-master`,`playlist`,`init`,`segment`,`thumb`,`subtitle`}.
- Segment entries SHOULD carry `dur_ms`; playlist entries are generated content
  (§3), not fetched names — their *bytes* still ride the same hash-addressed plane.
- `segs` in the manifest MUST equal `len(files)`.
- `renditions[].id` values are unique, and `meta` is reserved (NFX-03 §4).
  `renditions[].playlist` MUST equal the `name` of a `files` entry whose role is
  `playlist`.
- Licensed mode: hashes are of **stored (ciphertext)** bytes per NFX-08 §2 — so §4
  verification always runs on stored bytes, identically in both modes. (Decryption
  later contributes its own AEAD authentication on open; the sha256 anchor is
  unchanged.)

## 3. Playlists are derived, segments are content-addressed

Within every playlist file, URIs MUST be content names:

- `EXT-X-MAP:URI="<init-sha256>.mp4"`
- segment lines: `<segment-sha256>.m4s`

A resolver maps `<hex>.<ext>` → the `files` entry with that sha256 (any transport).
Publishers MUST NOT use content names that are not in `files`. Playlists whose URIs
are path-like (`seg/0001.m4s`) are invalid. This keeps any hash-addressed source
sufficient to play from with zero rewriting.

## 4. Verification (the "Blossom rule")

Every consumer verifies **sha256(bytes) == files[i].sha256** for each file before
*use or storage*. Any peer serving a mismatch is discarded for the session. After
this rule, transport is fully untrusted: seeders can withhold, never poison — exactly
Blossom's property.

Two digests exist in the system and each has one job (**ADR 0006 (e)**):

- **sha256** — the signed, cross-transport trust anchor (this document);
- **BLAKE3** — iroh's wire addressing (NFX-06); verified on the wire by iroh itself,
  then re-anchored to sha256 on arrival.

## 5. Seeder duties

A seeder of a video MUST hold the hash list and every file it announces, MUST have
verified §4 against the manifest `root` before first serving, and MUST serve files
byte-identical to `files[]` entries. Partial seeders (NFX-03 `chunks` ≠ "all") MAY
serve a subset; the hash list is always served whole.

## 6. Origin (HTTPS) serving

An **origin** is an HTTPS host serving hash-addressed bytes; every network needs ≥1
(manifest mirroring, browser genesis, censored-shutdown backstop):

- `GET /<sha256-hex>[.<ext>]` → file bytes. The extension is optional and ignored for
  lookup (as in BUD-01), so the content names of §3 (`<hex>.m4s`, `<hex>.mp4`,
  `<hex>.m3u8`) resolve directly. `Content-Type` per role (playlists
  `application/vnd.apple.mpegurl`, segments `video/iso.segment`, inits `video/mp4`);
  MUST support `HEAD`. Range support OPTIONAL (files are small).
- `GET /<root-hex>` → the hash list itself.
- `GET /<root-hex>/master.m3u8` → the master playlist (same bytes as its sha256
  address; convenience so players can be pointed at one URL).
- `GET /<root-hex>/<sha256-hex>.<ext>` → the same bytes as `GET /<sha256-hex>`, for
  any file listed in that root's hash list. This is what a player pointed at the
  convenience URL actually requests, because playlist URIs are relative (§3). Origins
  MAY answer `404` for hashes that the named hash list does not contain.
- CORS: origins MUST send `Access-Control-Allow-Origin: *` on hash-addressed GETs
  (the browser mesh depends on it).

### 6.1 Caching: content addresses are immutable

The bytes behind a content address never change, so every successful response to a
hash-addressed GET above MUST carry

```
Cache-Control: public, max-age=31536000, immutable
```

and MUST NOT vary on request headers. A CDN or any shared cache in front of an origin
is therefore always correct, and origins SHOULD use one. The rule has three limits:

- **Errors are not content.** `404`, `5xx` and any response that is not the file
  itself MUST carry `Cache-Control: no-store` (or `max-age` ≤ 60). A pull-through
  origin (§6.2) that lacks a file now will usually have it seconds later.
- **Paid bytes are not cacheable.** A response to a request that carries payment
  (NFX-07 §4 `X-NFX-Pay`), and every `402`, MUST carry `Cache-Control: private,
  no-store`. Paid serving and shared caching are mutually exclusive on a path: an
  origin behind a CDN serves those paths at price 0 (the ad mode of NFX-10 §4), or it
  serves licensed ciphertext (§6.3).
- **Verification still runs.** A cache changes where bytes come from, never whether
  they are checked. Clients verify §4 on bytes from a CDN exactly as on bytes from a
  peer.

### 6.2 Pull-through origin

An origin MAY be backed by the swarm instead of its own storage. On a miss, a
**pull-through origin** fetches the file as a normal watcher over any transport
(NFX-06, NFX-10, NFX-12). From M2 on, that includes paying seeders per NFX-07 out of
the operator's funds. It then serves the file over HTTPS and lets the CDN cache it.

- It MUST verify every file against §4, using a hash list it fetched by `root` from a
  manifest it verified (NFX-02 §4), **before** serving or storing it. It MUST NOT
  stream unverified bytes to a client. Behind a CDN, one poisoned response would
  otherwise be cached for a year under an `immutable` header.
- It serves only hashes that appear in hash lists it holds. It is not an open proxy
  for arbitrary sha256 values.
- It is an ordinary swarm peer (a seeder too, if its operator chooses). It holds no
  protocol privilege.

### 6.3 Licensed ciphertext is publicly cacheable

In licensed mode the stored bytes are ciphertext (NFX-08 §2) and the hash list
anchors ciphertext. An origin and any CDN MAY therefore cache and serve licensed
`init` and `segment` files publicly, at price 0 and without a license check: they are
useless without the key, and only the escrow mint releases the key (NFX-08 §4).
Playlists, the hash list and thumbs are cleartext in both modes. Selling access is the
mint's job, not the origin's.

An origin is Blossom-*shaped* (hash in path) but is an NFX role; a BUD-01 Blossom
server generalizes to an origin when its admin pins NFX-05 content.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): ciphertext-hash wording; "Recommendations" →
  "Playlists". Test-vector master playlist now sets `EXT-X-INDEPENDENT-SEGMENTS`
  (matches §1's SHOULD).
- Draft 2026-09-23 — wire token `nfx` (ADR 0008 §2). §6 (plan amendment 7): origins
  accept an optional extension and serve `/<root>/<sha256>.<ext>`, the path a player
  pointed at `/<root>/master.m3u8` actually requests (previously undefined, so
  playback from the convenience URL would 404); `immutable` caching with its limits
  (§6.1); the pull-through origin role (§6.2); public caching of licensed ciphertext
  (§6.3). §2: rendition ids unique with `meta` reserved, and a rendition's `playlist`
  must name a playlist file (implied before, now stated; `hashlist-invalid.json`).
