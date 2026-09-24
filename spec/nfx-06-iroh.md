# NFX-06 — iroh transport profile

**Status: Draft (target freeze: M1)** · depends on NFX-01/03/05

iroh is the native transport: QUIC connections with hole-punching, relay fallback,
and hash-verified blob transfer built in. This profile pins *how* NFX uses it; it
does not restate iroh's own specs.

## 1. Roles and identities

- A seeder's (or watcher's) **iroh endpoint id** (an ed25519 public key; "NodeId" before
  iroh 1.0) is a transport identity only. The
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
  in order: the rendition's `init` file, then its `segment` files in the order its
  playlist lists them. Membership and order come from the playlist, never from the
  hash list's file order. The collection root (BLAKE3) is embedded in the **BlobTicket**.
- Beacons (NFX-03) carry one ticket per held rendition. A watcher dials by ticket,
  then re-anchors every file to the sha256 in the hash list (NFX-05 §4). A ticket from
  a stale or lying beacon can waste time, not bytes, and only if the watcher never
  downloads more than the hash list allows:
  - It fetches the collection's HashSeq blob **alone**, capped at 32 bytes per member
    the manifest (`segs` + 1 for `meta`) or the rendition's playlist allows.
  - It then fetches members one at a time, each capped at its `files[].size`. A member
    larger than that never completes and is refused.
  - Streaming a whole collection in one request would let a lying seeder push
    unbounded bytes before any check.
- A watcher dials only a ticket's direct addresses and the relays of its own network
  (§1, NFX-11 §4). A relay URL named by an untrusted ticket is dropped, so a beacon
  cannot make a node contact a host of the sender's choosing.
- **Paid delivery is one member per request.** A watcher in a paid session (NFX-07)
  first fetches the rendition collection's HashSeq blob **alone**: a raw request for
  the collection root, which yields the member list. It then requests one member per
  request.
  - On iroh, one chunk (NFX-07 `window`, `pay.upto_chunk`) is one member request, i.e.
    one NFX-05 file. The member-list request is not a chunk.
  - A seeder MAY refuse, with iroh-blobs' permission error, any request that spans
    members (a whole or partial collection including children) from a peer that is not
    a free seeder (NFX-08 §5) or otherwise exempt by local policy.
  - Without this rule a single request could pull a whole rendition past the payment
    window (spike S1).
- **Tickets** are the string form of the pinned iroh-blobs `BlobTicket` (NFX-11 §4),
  pinned at M1 with vectors (`tickets.json`). They embed the provider's endpoint address
  (id, relay URL, direct addresses), the hash and the format:

  ```
  bytes  = 0x00                                   variant 0
           endpoint_id[32]                        ed25519 public key
           relay:  0x00 | 0x01 uvarint(len) utf8  the URL in normal form (trailing "/")
           uvarint(n), then n direct addresses, sorted and unique, each
             0x00 ipv4[4] uvarint(port) | 0x01 ipv6[16] uvarint(port)
           uvarint(format)                        0 raw, 1 hash_seq (collections)
           hash[32]                               BLAKE3 of the blob
  string = "blob" || lowercase(base32(bytes))     RFC 4648 alphabet, no padding
  ```

  `uvarint` is unsigned LEB128. A collection's hash is the BLAKE3 of its HashSeq: the
  concatenation of its members' 32-byte BLAKE3 hashes, in the order below. Beacons
  still carry `node` and `relay`, because `nfx/pay/1` must dial the same endpoint.
  Every ticket's endpoint id MUST equal the endpoint's `node`, and a watcher ignores an
  iroh endpoint whose tickets name another node.
- **Metadata rides a separate collection.** The hash list plus every playlist, thumb and
  subtitle file form their own HashSeq (order: hash list first, then those files in
  `files` order), offered under the beacon's `tickets.meta` entry. Thumbs and subtitles
  belong to no rendition, so without this an iroh-only fetcher could never obtain them. Per-rendition collections therefore contain
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

- Messages are self-signed envelopes (JSON, at most 4 KiB on the wire; a larger one is
  refused before it is parsed):

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
- Draft 2026-09-23 (spike S1; sovtech's decision, ADR 0008 addendum). Paid delivery
  fetches the member list and then one member per request, and seeders may refuse
  spanning requests from paying peers. Tickets are the pinned iroh-blobs `BlobTicket`
  string form.
- Draft 2026-09-23 (A2 `nfx-node`): the `meta` collection also carries thumb and
  subtitle files, which otherwise rode no iroh collection.
- Draft 2026-09-23 (A2 pre-push audit): §2 bounded fetching (HashSeq alone, then each
  member capped at its hash-list size) and dialling only the network's own relays.
- Draft 2026-09-24 (M1 freeze candidate): the ticket byte layout, collection hashing and
  the ticket/`node` agreement rule are stated normatively, with vectors (`tickets.json`).
- Draft 2026-09-24 (M1 freeze candidate): "endpoint id" for iroh 1.x; collection order
  comes from the playlist alone; the 4 KiB envelope limit is enforced before parsing.
