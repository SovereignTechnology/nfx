# Spike S1 — iroh for NFX-06: **PASS** (2026-09-23)

**Question:** can iroh 1.2 + iroh-blobs 0.103 + iroh-gossip 0.101 do what NFX-06 needs?
And is the "not production quality" note in the iroh-blobs README still current?

**Setup:**
- Code: `crates/spikes/s1-iroh`, its own Cargo workspace, run with
  `cargo run --release`.
- One process, using the test-vector video from `spec/test-vectors/`.
- One self-hosted relay: an in-process `iroh_relay::server::Server`, the same code as
  the `iroh-relay` binary, dev-style plain HTTP.
- Provider A. Fetchers B (paying), C (banned), D (free mirror) and F (control) are all
  built with `clear_ip_transports()`, so they have no UDP/IP path.
- Resolved versions: iroh 1.2.0, iroh-relay 1.2.0, iroh-blobs 0.103.0, iroh-gossip
  0.101.0. One iroh in the lock file: blobs and gossip both require `iroh ^1`.
- Result: 7/7 PASS on 4 consecutive runs.

## Pass criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Serve a per-rendition HashSeq + the `meta` collection | **PASS.** The rendition is a raw `HashSeq` (init + 3 segments, hash-list order); meta is hash list + 2 playlists. No `Collection` is used, since its metadata blob would sit first and break NFX-06 §2's member order. |
| 2 | Fetch by ticket, re-anchor to sha256 | **PASS.** D parses the ticket strings and fetches both collections over the relay. `nfx-proto` then checks the hash list against the manifest `root`, checks the playlists, and re-anchors every member to its sha256 in order. |
| + | Tampered segment rejected on iroh | **PASS.** A HashSeq over a bit-flipped segment transfers fine, because BLAKE3 is consistent with the bad bytes. sha256 re-anchoring rejects member 2. This is Phase A exit criterion 5 for the iroh leg. |
| 3 | `RequestMode::Intercept` can refuse per request (M2 window gate) | **PASS.** Detailed below. |
| 4 | `nfx/pay/1` on the same endpoint | **PASS.** One `Router` serves the blobs ALPN, `nfx/pay/1` and `nfx/gossip/1`. `Connection::remote_id()` on pay/1 equals `ClientConnected.endpoint_id` on blobs, so payments correlate with blob requests. |
| 5 | Gossip topic works | **PASS.** Custom ALPN via `Gossip::builder().alpn(b"nfx/gossip/1")`. B joins topic `sha256("nfx/1/swarm/…")` via A over the relay. A signed envelope with two real tickets is 879 bytes against the 4096-byte default cap, and `nfx-proto` verifies it on receipt. |
| 6 | Self-hosted relay works | **PASS**, with a negative control: once the relay is shut down, a relay-only peer's fetch times out (15 s). |

## The window gate

`EventMask { connected: Intercept, get: Intercept }` gives one decision per connection
and one per request. The decision is a oneshot the handler may hold. What worked:

1. The watcher fetches the rendition HashSeq **blob alone** (`HashAndFormat::raw(seq)`,
   `ranges.is_blob()`), which is the member list, and it is free.
2. It then fetches **one member per request** (`raw(member)`), the way a player pulls
   segments.
3. The gate counts chunks per `EndpointId`:
   - chunks 1–2 are served unpaid (`window` 2);
   - chunk 3's decision is **held** until `pay upto 2` arrives on `nfx/pay/1`, then
     released;
   - chunk 4 is served;
   - a replayed `pay` gets `stale`.
4. A **bulk** HashSeq request (children included) from a paying peer is refused with
   `Permission`, because otherwise one request would pull the whole rendition past the
   gate. Free peers (mirrors) may bulk-fetch.
5. A banned peer is refused at `ClientConnected`. The client sees
   `closed by peer: permission (code 1)`.

`throttle: ThrottleMode::Intercept` (a callback per ~16 KiB) is the finer-grained
alternative. It was not needed.

## Findings that change the spec (adopted 2026-09-23, ADR 0008 addendum 2b)

- **NFX-06 §2 — the paid-delivery unit.** Paid sessions fetch the rendition's HashSeq
  blob, then one member per request. Seeders MAY refuse whole-collection requests from
  peers that are not free seeders. Without this rule, "window" has no meaning on iroh.
- **Ticket encoding (NFX-11 §4).** The string form of iroh-blobs 0.103 `BlobTicket` is
  `blob…` base32, 152 chars with a relay-only address. It embeds the provider's
  `EndpointAddr` (id + relay URL + any direct addrs) plus hash and format. Tickets are
  opaque to NFX; beacons keep `node`/`relay` because pay/1 must dial the same endpoint.
  The vector tickets can stay placeholders, since `nfx-proto` never parses tickets.
- **`EndpointId` is 64 lowercase hex** when displayed, which matches NFX-03's `node`.
- **iroh-gossip exposes `delivered_from` (the last hop), not the author.** That
  confirms NFX-06 §4's `pubkey` field (added in A0) is required.

## "Not production quality"

The README of **iroh-blobs 0.103.0** still says, verbatim: *"this version of iroh-blobs
is not yet considered production quality. For now, if you need production quality, use
iroh-blobs 0.35"*. There is no escape through 0.35: it predates iroh 1.x, so it cannot
talk to 1.x peers, and n0's public relays stop serving pre-1.0 clients on 2026-09-30.
**Recommendation: keep the 0.103 pin and contain the risk:**

- Integrity is ours anyway (sha256 re-anchoring).
- Keep the blob store behind an `nfx-node` trait, so the store can be swapped (e.g. a
  plain file store, with iroh-blobs as transport only) without touching NFX wire.
- Re-check the README at every bump. A1 does not block on it.

## Not covered by S1

- TLS/ACME and QUIC address discovery on a public `iroh-relay`. Only dev HTTP on
  loopback was tested.
- Real NAT traversal between hosts (Phase A exit test 2).
- Throughput on real CMAF segments, which is S4's material.
- A persistent `FsStore` (MemStore only).
- Real ecash in pay/1 (M2).
