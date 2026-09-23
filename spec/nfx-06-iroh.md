# NFX-06 — iroh transport profile

**Status: Draft (target freeze: M1)** · depends on NFX-01/03/05

iroh is the native transport: QUIC connections with hole-punching, relay fallback,
and hash-verified blob transfer built in. This profile pins *how* NFX uses it; it
does not restate iroh's own specs.

## 1. Roles and identities

- A seeder's (or watcher's) **iroh NodeId** is a transport identity only. The
  long-term identity is the nostr key of the beacon/manifest (NFX-01); beacons bind
  the two by signature.
- NAT traversal (dialback, relay servers) is iroh's job. NFX defines no
  rendezvous protocol and every implementation MUST NOT invent one.
- **Relays are the network's own.** Every network SHOULD run its own `iroh-relay`
  servers from the pinned series (NFX-11 §4) and advertise them in beacons
  (`endpoints[].relay`, NFX-03 §4). Public relays run by iroh's developers are a
  convenience, never a dependency: they drop out-of-series clients on their own
  schedule.

## 2. Bytes: iroh-blobs, one HashSeq per rendition

- Blobs are served with the **iroh-blobs protocol using its standard ALPN** from the
  pinned iroh series (register: NFX-11). No custom ALPN for video bytes.
- A provider forms, per rendition, an iroh **collection (HashSeq)** whose members are,
  in order: the rendition's `init` file, then its `segment` files in playlist order
  (hash-list order). The collection root (BLAKE3) is embedded in the **BlobTicket**.
- Beacons (NFX-03) carry one ticket per held rendition. A watcher dials by ticket,
  streams the sequence, and then re-anchors every file to the sha256 in the hash list
  (NFX-05 §4) — a ticket found in a stale or lying beacon can waste time, not bytes.
- **Metadata rides a separate collection.** The hash list plus all playlist files form
  their own HashSeq (order: hash list first, then playlists in `files` order), offered
  under the beacon's `tickets.meta` entry. Per-rendition collections therefore contain
  only `init` + `segment` files and their ordering invariant is trivially checkable.

## 3. Payment channel: ALPN `nfx/pay/1`

Payments ride a **separate iroh connection** with ALPN `nfx/pay/1` (NFX-07),
newline-delimited JSON. Blob traffic stays strictly on the standard ALPN so any iroh
tooling can inspect/store/copy NFX blob traffic without NFX semantics.

## 4. Discovery augmentation: iroh-gossip

Optional, recommended for warm swarms:

- ALPN `nfx/gossip/1`, iroh-gossip wire protocol as pinned (NFX-11).
- Topic for a video's swarm:

  ```
  TopicId = sha256( utf8( "nfx/1/swarm/" + namespace + "/" + video-id ) )   (hex)
  ```

- Messages are self-signed envelopes (JSON, ≤ 4 KiB):

  ```json
  { "v": 1, "op": "here" | "bye", "pubkey": "<64-hex nostr pubkey>",
    "beacon": { <NFX-03 content object> },
    "created_at": <unix>, "sig": "<128-hex schnorr>" }
  ```

  `sig` is a BIP-340 signature by `pubkey` over the 32-byte digest
  `sha256(utf8(canon(body)))`, where `body` is the message without `sig` and `canon`
  is the suite's canonical JSON (NFX-11 §9). `pubkey` is the seeder's nostr key, the
  same key that signs its on-relay beacons (NFX-03), so the gossip identity binds to
  the beacon identity. A receiver verifies against `pubkey` and nothing else: the
  delivering iroh node is a transport identity, not a signer. `beacon.video` MUST
  belong to the topic's swarm (same namespace and video-id); anything else is
  discarded.
  Freshness: peers evict an entry when `now - created_at > 2×120 s` and reject
  `created_at` skew beyond ±15 min. There is no replay protection beyond that —
  a replayed `here` announces presence, which is all gossip ever asserts.
- Gossip is *in-network* presence; beacons on scoped relays remain the
  censorship-resistant fallback (NFX-03 §7). Bytes never travel over gossip.

## 5. Pinned versions

The iroh/iroh-blobs/iroh-gossip series pin lives in NFX-11 (single place to bump). A
client MUST NOT assume wire compatibility outside the pinned series; mismatched
series simply fail to connect (ALPN mismatch is the designed no-cross-talk
mechanism).

## 6. Failure and fallback ladder (normative order)

1. iroh by ticket (fastest, in-swarm);
2. https endpoints from the same beacons (NFX-03);
3. origin per NFX-05 §6 (always exists);
4. re-query beacons after TTL elapse.

A client that skips 1 entirely (e.g. a minimal CLI) is conformant as long as it
lands on 2/3 and verifies NFX-05 §4.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): metadata now a separate `meta` collection with a
  defined member order (per-rendition order stays pure); gossip envelope fully
  specified (signed canonical-JSON body, expiry rule).
- Draft 2026-09-23 — wire token `nfx`: ALPNs `nfx/pay/1`, `nfx/gossip/1` (ADR 0008
  §2). Gossip envelope gains `pubkey`. Without it a receiver had no key to verify
  `sig` against, since iroh-gossip only exposes the delivering node's id. `canon` now
  points at its single definition in NFX-11 §9. Networks run their own `iroh-relay`
  (plan amendment 9; pin in NFX-11 §4).
