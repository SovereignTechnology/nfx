# NFX-12 — HyperDHT transport profile (optional)

**Status: Draft (target freeze: later, no milestone gates on it)** · depends on NFX-01/03/05/07,
and NFX-06 §2 for the paid-delivery rule

An optional transport that carries the same NFX-05 files between two peers on the Holepunch
stack. A watcher dials a seeder **by its Noise public key** over HyperDHT, and the two speak two
Protomux protocols on that one encrypted connection: `nfx/files/1` for bytes and `nfx/pay/1` for
NFX-07. Requests are for whole files, and every refusal is per request. It is a non-breaking
addition under NFX-01 §4: a new beacon endpoint type that readers who do not implement it skip
(NFX-03 §4).

The profile has **no Hypercore, Hyperdrive, Hyperbee or Hyperswarm topic in it**. It needs only
the HyperDHT wire, the secret-stream framing on top of it and Protomux (§8). No conformance level
requires it, and it requires no particular runtime: Node, Bare, Rust or anything else that speaks
those three wires can implement it. Pear is not involved (ADR 0101).

## 1. Roles and identities

- **Seeder.** A HyperDHT server listening on a Noise key pair, its **peer key** (an Ed25519 key
  pair, as HyperDHT uses). The peer key is a transport identity only, like an iroh EndpointId
  (NFX-06 §1). The long-term identity is the nostr key that signs the beacon advertising it.
- **Watcher.** It dials with a Noise key pair of its own. That key's public half is the NFX-07 §3
  **peer** of the account on this transport (one peer and one video).
- **One key pair per network.** Each side keeps its key pair per namespace (NFX-01), persistent
  across restarts, and never uses it on another namespace or for another protocol on the same
  DHT. A node that is both a seeder and a watcher keeps the two key pairs separate, so a seeder's
  peer key never identifies it as a watcher.
- **Bootstrap nodes and blind relays come from local configuration only**, per network. A node
  MUST NOT take a bootstrap node, a relay or any other address to dial from a beacon or from any
  other received data, so no beacon can make a node contact a host of the sender's choosing
  (NFX-06 §2). A network SHOULD run its own bootstrap nodes and blind relays, as it runs its own
  iroh relay (NFX-11 §4): public ones are a convenience whose policy is not the network's.

## 2. Beacon endpoint

```json
{ "t": "hyperdht", "peer": "<64-hex peer key>", "bind": "<128-hex Ed25519 signature>" }
```

It is added to `endpoints` in NFX-03 beacon content, beside any other endpoints.

- **`peer`** is the seeder's 32-byte peer key (§1), in lowercase hex.
- **`bind`** is the 64-byte Ed25519 signature (RFC 8032, pure Ed25519) made with `peer`'s secret
  key over the UTF-8 bytes of

  ```
  "nfx/hyperdht/1:" + seeder + ":" + namespace
  ```

  where `seeder` is the beacon event's `pubkey` (64 lowercase hex) and `namespace` is the value
  of its `n` tag. It is in lowercase hex.
- **Why `bind`.** Without it, one seeder's beacon could name another seeder's peer key, or any
  HyperDHT server, and steer watchers to it. `bind` proves that the holder of the peer key agreed
  to be advertised by this nostr key on this network. It depends on neither the video nor the
  time, so a seeder signs it once per network.
- **Size.** The endpoint takes 229 bytes of a gossip envelope's 4 KiB (NFX-06 §4). Beside it, an
  envelope still carries the iroh tickets of 17 renditions plus `meta`, against 18 without it
  (`beacon-hyperdht.json`, `gossip_budget`).
- **Strict parsing.** A reader that implements this profile parses the endpoint strictly, as it
  does every endpoint type it knows (NFX-03 §4): a `peer` that is not 64 lowercase hex, a `bind`
  that is not 128 lowercase hex, or a `bind` that does not verify against `peer` makes the
  **whole beacon** invalid. A reader that does not implement the profile skips the endpoint.
- **The `hyper` endpoint is deprecated.** The previous draft of this document defined
  `{"t":"hyper","drive":"<64-hex>"}`. It is never emitted. A reader that parses it keeps parsing
  it (the M1 beacon vector carries one) and never dials it.

## 3. The connection

- **Dial.** A watcher dials `peer` with HyperDHT `connect`, using its network's bootstrap nodes;
  holepunching, then a blind relay from its own configuration (§1), are HyperDHT's. The Noise IK
  handshake authenticates the dialed key end to end, through a blind relay too. A connection whose
  remote static key is not `peer` MUST be closed.
- **A peer key learned any other way MUST NOT be trusted for payment decisions.** A watcher pays
  only a peer key named in a valid beacon of a seeder serving the video (NFX-03 §5).
- **Topic (MAY).** A seeder MAY also announce on the per-video topic

  ```
  topic = sha256( utf8( "nfx/1/hyper/" + namespace + "/" + video-id ) )    (32 bytes)
  ```

  for in-network discovery. A watcher MAY look it up, but a peer key found there carries no trust
  until a beacon names it (above). A watcher that only dials by key announces nothing, and SHOULD
  run as a client-only DHT node.
- **Framing.** The connection is a secret-stream over the HyperDHT socket (§8). Protomux
  multiplexes it. Both protocols below use the channel id `utf8(<namespace>:<video-id>)`, the
  video's NFX-01 address. One connection may carry channels for several videos.
- **Message-type indices are pinned.** Protomux numbers a channel's message types in the order
  they are added, and silently drops a type the receiver did not add. So each protocol's types are
  pinned by index below, and a new type is never added to a protocol: it gets a new protocol name
  (`nfx/files/2`). Every message's encoding is its raw bytes (compact-encoding `raw`).
- **Liveness.** Each side sends a keepalive at most every 25 s and closes the connection when it
  has received nothing for 60 s. A side also closes the connection when a pay/1 message it wrote
  has not been acknowledged by the transport within 60 s. That is NFX-07 §2's delivery rule, on
  which the watcher's 180 s wait rests (NFX-07 §3a).

## 4. `nfx/files/1`

Message types, by index:

| Index | Name | Direction | Bytes |
|---|---|---|---|
| 0 | `get` | watcher → seeder | `req` (u32 LE) ‖ `sha` (32) — exactly 36 bytes |
| 1 | `data` | seeder → watcher | `req` (u32 LE) ‖ 1 to 65,536 bytes of the file |
| 2 | `end` | seeder → watcher | `req` (u32 LE) — exactly 4 bytes |
| 3 | `missing` | seeder → watcher | `req` (u32 LE) — exactly 4 bytes; free mode only |

A message of another length, or of an index not in this table, is a protocol error: the receiver
closes the channel.

**Requests.**

- A watcher asks for one file by its sha256 with `get`. It picks `req`, unique among its open
  requests on the channel, and never has two open requests for the same `sha` there, so a pay/1
  `refuse`, which names the file and not the request, is never ambiguous.
- The seeder answers with the file's bytes in order, in `data` frames tagged with `req`, then
  `end`. Frames of different requests may interleave.
- A seeder serves only files listed in the hash list of **the channel's video** that it holds and
  verified (NFX-05 §5), and the hash list itself as `sha` = the manifest `root`. Any other `sha`
  is refused (below), even one it holds for another video, so a channel is never an oracle for
  the rest of a seeder's store.
- There is no cancel. A watcher that abandons a transfer closes the channel. In paid mode the
  abandoned request stays owed (NFX-07 §3a).

**Refusal.**

- **Free mode** (the seeder serves without pay/1, NFX-07 §2): a file the seeder will not or
  cannot serve is answered with `missing`.
- **Paid mode** (a pay/1 session is open on the same channel id, §5): every refusal, "I do not
  have it" included, is a pay/1 **`refuse`** naming the file, and nothing on `nfx/files/1`. The
  watcher closes the request when the `refuse` arrives. A seeder in paid mode never sends
  `missing`: NFX-07 §3a makes a watcher owe every request not answered with `refuse`, and the
  web profile does the same (NFX-10 §3).

**Receiver duties.**

- Spool each file to disk, not to memory, and cap it at its `files[].size` from the hash list; the
  hash list itself at 16 MiB. A source that sends more bytes than the cap, or `end` before the
  size, has served a mismatch.
- Verify `sha256(bytes) == sha` before use or storage (NFX-05 §4). A mismatch discards the source
  for the session (NFX-05 §4). Nothing here verifies bytes as they arrive, so a lying seeder
  wastes at most one file's `size` per request before it is caught: the bound NFX-06 §2 also
  relies on, kept small by the segment duration of NFX-05 §1.

**Flow control.**

- The sender queues at most **256 KiB** of `nfx/files/1` data per connection ahead of the
  transport, and writes more only once the stream has drained.
- A pay/1 message is written ahead of any `nfx/files/1` data not yet written. With the cap above,
  a pay/1 message never waits behind more than 256 KiB, so the 60 s rule of §3 holds on any link
  above about 35 kbit/s. Without the cap, a seeder streaming a large file would delay the watcher's
  `pay` and the seeder's `ack` past NFX-07's deadlines (NFX-07 §2, §3, §3a).

**Limits** (per connection; a peer that exceeds one is closed):

- at most 16 videos, so 32 channels;
- in free mode at most 8 open requests per channel; in paid mode see §5;
- the 60 s inactivity rule of §3.

## 5. `nfx/pay/1`

Message types, by index:

| Index | Name | Bytes |
|---|---|---|
| 0 | `msg` | one NFX-07 §2 message: UTF-8 JSON, no newline, at most 32,767 bytes |

- **Messages** are those of NFX-07 §2, unchanged, under the same value rules. 32,767 bytes is
  NFX-07's 32 KiB line less its newline.
- **One channel is one session.** A `hello` opens it (NFX-07 §2), on the channel of the video it
  names; a `hello` naming another video is refused `unknown-video`. A second `hello` on a channel
  whose session is open is refused `bad-session`. Protomux pairs one channel per protocol and id
  on a connection, so a connection holds at most one session per video.
- **Admission.** In paid mode a `get` is admitted only while the pay/1 channel of the same id, on
  the same connection, has an open session whose `quote` has been sent. A `get` on a channel with
  no such session, from a seeder that does not serve for free, is a protocol error and closes the
  `nfx/files/1` channel; nothing was served, so nothing is owed.
- **The unit is one file.** Paid delivery maps to NFX-06 §2, one member per request, not to the
  origin surface of NFX-07 §4: one admitted `get` is one chunk (`window`, `pay.upto_chunk`),
  whole or aborted, as in the web mesh (NFX-10 §3). `get` for the hash list (`sha` = `root`)
  counts as a chunk, as the meta collection's members do on iroh (NFX-06 §2).
- **Concurrency (provisional).** In paid mode a watcher keeps at most **one** request outstanding
  per session, and a seeder closes the channel of a watcher that sends a second. NFX-07 §3a's
  half-window credit bound holds with one request outstanding and not with two (sovtech's open
  decision, `docs/nfx/status.md`). This rule is relaxed only by that decision.
- **The account's peer** is the watcher's Noise public key (§1). Licensed videos add the proof
  lock of NFX-08 §4, as on every transport.

## 6. Integrity: re-anchor to sha256

The Noise handshake proves which peer key sent the bytes. That is transport identity only; it
says nothing about the bytes. Every file fetched over this profile MUST be verified as
`sha256(bytes) == files[i].sha256` (NFX-05 §4) before use or storage, and the hash list against
the manifest `root`. After that, as on every transport, a seeder can withhold but never poison.

## 7. Place in the fallback ladder

A client that implements this profile and NFX-06 tries iroh by ticket first, then this profile,
then the rest of NFX-06 §6's ladder (https endpoints, the origin, re-querying beacons). A client
without iroh starts here. A seeder that advertises only `hyperdht` is unreachable from a watcher
that only speaks iroh, and the reverse: the price of an optional transport.

## 8. Pinned wire

NFX-11 §4 pins **wire behaviour and golden fixtures**, not package versions:

- the HyperDHT wire (dial by key, holepunching, blind relays), the secret-stream framing and the
  Protomux framing, as spoken by `hyperdht` 6, `@hyperswarm/secret-stream` 6 and `protomux` 3
  (6.34, 6.9.1 and 3.11 at pinning, 2026-10-21);
- this document's message layouts, pinned by `test-vectors/files1.json` and
  `test-vectors/beacon-hyperdht.json`.

An implementation is conformant when it passes those fixtures and the cross-implementation run
(Node against Rust) of NFX-11 §8, whatever library it is built on.

## 9. Security notes

- **The channel carries money.** Open-mode tokens are bearer ecash, so the secret-stream's
  confidentiality is what keeps a token from being spent by an observer. An implementation MUST
  NOT carry pay/1 over anything but the authenticated, encrypted stream of §3.
- **The watcher's peer key is linkable** across every video it watches on one network, as an iroh
  EndpointId is. A watcher MAY rotate it, which forfeits the credit of its accounts.
- **Announcing is public.** A seeder that announces on the per-video topic (§3) lets anyone list
  the seeders of that video, as its beacons already do. A watcher that dials by key reveals itself
  only to the seeder it dials.
- **A seeder is no content oracle** (§4): it answers only for files of the channel's video.

## 10. Open issues (before any freeze)

- **Paid concurrency** (§5): one outstanding request per session until sovtech decides the
  half-window credit bound.
- **Partial seeders.** A seeder whose NFX-03 `chunks` is not `"all"` answers requests for files it
  lacks with `missing` or `refuse`. Whether it should also say which files it holds is open.
- **Verification while streaming.** A later `nfx/files/2` could carry incremental proofs, so a lie
  is caught before a whole file arrives. That needs a digest other than the signed sha256
  (NFX-05 §4), as BLAKE3 is for iroh.

## Changelog

- Draft 2026-09-23 — initial (plan amendment 6, ADR 0008): a Hyperdrive per seeder per video,
  replicated over a per-video Hyperswarm topic, with a `hyper` endpoint.
- Draft 2026-10-21 — rewritten (ADR 0101): files over Protomux on HyperDHT. A watcher dials the
  seeder by its peer key, requests whole files over `nfx/files/1`, and every refusal is per
  request. The `hyperdht` endpoint and its `bind` replace `hyper`, which is deprecated. The
  Hyperdrive storage is gone, and the per-video topic becomes MAY. The open issues of the first
  draft (upload gating, the sidecar's runtime, partial drives) are void with it.
