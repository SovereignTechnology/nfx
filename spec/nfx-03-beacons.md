# NFX-03 — Availability beacons (kind 20464)

**Status: Draft (target freeze: M1)** · depends on NFX-01, NFX-02

High-churn "I have these bytes right now" announcements. Nostr is the
censorship-resistant fallback for swarm discovery; native mechanisms (iroh gossip,
NFX-06; WebRTC trackers, NFX-10) are faster and preferred when available.

## 1. Event shape

| Field | Value |
|---|---|
| `kind` | **20464** (ephemeral range 20000–29999; relays MUST NOT store per NIP-01) |
| `pubkey` | the seeder's identity key |
| `content` | JSON per §4 (schema: `schemas/beacon-content.schema.json`) |
| `created_at` | emission time; MUST be within ±15 min of now or clients discard |

Required tags:

```
["n", "<namespace>"]                                   # NFX-01 §3
["a", "38504:<creator-pubkey>:<namespace>:<video-id>"] # the manifest this serves
["expiration", "<created_at + TTL>"]                   # NIP-40; TTL ∈ [60, 120] s
```

Optional tags: `["t", "nutflix"]` (cosmetic), nothing else. No payments, no media.

## 2. Semantics

- Ephemerality is the retention policy: scoped relays (NFX-04) forward live and never
  persist; NIP-40's `expiration` prunes anything that leaked onto a storing relay.
- Ordering: under the §3 republish rule, up to two not-yet-expired beacons for the
  same `(seeder pubkey, a-tag)` pair are *expected* in steady state — this is normal,
  not an error. A client considers only the newest `created_at` among them.
- A seeder stops announcing by simply stopping. An explicit `["clear","1"]`-style
  tombstone is deliberately absent: 120 s of staleness is cheaper than anti-replay.

## 3. Publishing discipline (seeder)

- Republish at **TTL/2** (e.g. TTL 120 → every 60 s). Faster republish gains nothing
  and hits NFX-04 rate limits; slower causes dropouts.
- Publish only to the network whose namespace matches the manifest (NFX-01) and only
  for manifests whose hash list root you actually verified at pin time (NFX-05 §5).

## 4. Content schema (summary; schema file is normative)

```json
{
  "v": 1,
  "video": "<namespace>:<video-id>",
  "endpoints": [
    {
      "t": "iroh",
      "node": "<64-hex iroh NodeId>",
      "relay": "<iroh relay URL or empty>",
      "addrs": ["host:port", "…"],
      "tickets": { "720p": "<iroh BlobTicket for that rendition's HashSeq>", "…": "…" }
    },
    { "t": "https", "url": "https://seed.example/nfx" }
  ],
  "chunks": "all",
  "price_hint": 1,
  "accepts_mints": ["https://mint.example"],
  "free": false
}
```

- `video` MUST equal the `a` tag's d component (redundant on purpose: content is
  self-describing when mirrored off-relay).
- `endpoints[].t`: `iroh` (NFX-06), `https` (origin-style, NFX-05 §6 serves
  `GET <base>/<sha256>`). Both may be present; at least one MUST be.
- `chunks`: `"all"` or an integer count of hash-list entries currently held. Partial
  seeders are legal; clients prefer `"all"` but MAY fetch from partials.
- `tickets` key **`meta` is reserved** (the metadata collection, NFX-06 §2) and MUST
  NOT be a rendition id in the hash list; a hash list containing a rendition id
  `meta` is invalid.
- `price_hint`: integer sats per chunk this seeder charges right now (**non-binding**;
  the binding quote is the seeder's `quote` message in NFX-07 §2 — the hint exists for
  peer selection).
- `accepts_mints`: mints this seeder redeems against. Empty/absent means "any" —
  except for **licensed videos**, where chunk payments MUST be proofs of the video's
  escrow mint (NFX-08 §4); a seeder of licensed video MUST list exactly that mint.
- `free`: `true` = donation seeder (e.g. an NFX-02 `free_seeder` serving licensed
  video after a zero-cost voucher); clients MUST NOT send it payments. Defaults to
  `false`. `chunks` is REQUIRED (no default).

## 5. Client use

1. REQ `{ "kinds": [20464], "#n": [ns], "#a": [a-tag…] }` against scoped relays.
2. Keep live table; drop on `expiration`; verify content against §4 loosely (this is
   untrusted data) — endpoints come from it, trust never does.
3. Prefer iroh endpoints when a ticket for the wanted rendition exists; fall back to
   https; fall back to waiting (re-REQ) — beacons are hints, not promises.

## 6. Relay set discovery

Scoped relays self-announce per NFX-04 §6 (NIP-66 kind 30166 carrying the `n` tag).
Clients bootstrap from a small seed list and then follow 30166 announcements; no list
edit in this spec is ever required to grow the relay set.

## 7. Security notes

- A beacon cannot poison (all payloads verify per NFX-05) and cannot overcharge
  (quotes verified in NFX-07). The worst beacon bugs are *withholding* and *noise*.
- Do not bridge beacon volume onto general public relays: a busy network at TTL 60 is
  O(swarm) msgs/min, which public relays will rate-limit into uselessness. Beacons
  live on NFX-04 relays. This is the "split by churn" rule of the design.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): steady-state double-beacon is expected, not an
  error; `accepts_mints` gain the licensed-mode escrow-mint restriction; xref and
  default-value nits.
