# Spike S5′ — a Rust HyperDHT for NFX-12: **FAIL** (2026-10-21)

**Question** (ADR 0101 §4): can nfx speak NFX-12 natively in Rust? The candidate is
`peeroxide` / `peeroxide-dht` 1.7.3, a pure-Rust HyperDHT, secret-stream and Protomux. It is
tested against Node `hyperdht` 6.34.0, `@hyperswarm/secret-stream` 6.9.1 and `protomux` 3.11.0,
the versions nutflix-pear locks. The answer gates nfx Phase 1.

**Answer: no, not with peeroxide 1.7.3.**
- Its Rust server is unreachable from Node clients, even with no NAT.
- Its client works against Node only without a NAT.
- Rust does not talk to Rust.
- It has remote-crash and key-validation bugs, an unmaintained dependency and one maintainer.

nfx Phase 1 is re-planned before it starts (ADR 0101 §4); the options are at the end.

**Setup:**
- Code: `crates/spikes/s5-hyperdht`, its own Cargo workspace. It names no money crate.
- Two peers with the same CLI and the same NFX-12 wire: `src/main.rs` (Rust) and `node/peer.js`
  (Node). The wire is `nfx/files/1` with types 0 get, 1 data, 2 end, 3 missing, and `nfx/pay/1`
  with type 0, both on Protomux with the video address as channel id.
- `nat/run.sh`: every server/client pairing in network namespaces, judged. Five topologies:
  - open/open: routed, no NAT;
  - consistent/consistent: nftables masquerade;
  - symmetric/symmetric: masquerade fully-random, without and with a Node blind relay;
  - consistent/symmetric.

  The HyperDHT testnet has 5 nodes. The client fetches 8 MiB, with a pay/1 round trip during
  the transfer and a `missing` reply after it.
- `run-local.sh`: the same pairings on a loopback testnet, plus firewall, keepalive and timeout
  checks. Informative only (below).
- CI only: `.github/workflows/spike-s5.yml`, runs 1–4 on 2026-10-21. Run 4 is
  [39663397861](https://github.com/SovereignTechnology/nfx/actions/runs/39663397861).
- Resolved versions: peeroxide 1.7.3, peeroxide-dht 1.7.3, libudx 1.7.3, tokio 1.54.0. The
  `.crate` sha256 equals the crates.io checksum.

## Results (run 4, NAT matrix; runs 2–3 agree where they overlap)

Node-to-Node is the control: it shows the topology works.

| Topology | node ← node | rust ← node | node ← rust | rust ← rust |
|---|---|---|---|---|
| open/open (no NAT) | ✓ direct, 579 Mbit/s | ✓ direct, 546 Mbit/s, pay RTT 15 ms | ✗ `HOLEPUNCH_ABORTED`, never delivered to the server | ✗ connects; channels die once the server streams |
| consistent/consistent | ✓ direct (holepunched), 493 Mbit/s | ✗ channel closed (run 3: stalled at ~4 of 8 MiB) | ✗ `HOLEPUNCH_ABORTED` | ✗ channel closed |
| symmetric/symmetric, no relay (must fail) | ✓ fails | ✓ fails | ✓ fails | ✓ fails |
| symmetric/symmetric, server names the relay | ✓ via relay, 417 Mbit/s | ✗ channel closed (run 3: stalled at 4 MiB) | ✗ `ETIMEDOUT` before the quote | ✗ channel closed |
| consistent/symmetric (informative) | ✓ direct after 12.5 s of random punching | ✗ no connection in 60 s | ✗ `HOLEPUNCH_ABORTED` | ✗ no connection in 60 s |

Columns read client ← server. The Rust server's log shows what happens:
- In "node ← rust" the swarm delivers no connection at all.
- In "rust ← rust" it delivers the connection, receives the `hello` and the `get`, and then the
  client closes.

Both stacks classify the NATs alike: peeroxide reports class 2 (consistent) and 3 (random)
where hyperdht reports `randomized` false and true.

**The loopback matrix is informative only.** On a 127.0.0.1 testnet even a 1 MiB Node-to-Node
fetch timed out before its first reply (run 3), so that environment cannot judge either stack.
Two of its results still hold:
- in run 2, on loopback, the Rust client fetched 64 MiB from the Node server at 1.28 Gbit/s
  with a 13 ms pay round trip;
- run 3 repeated that pairing and failed.

## Acceptance

| # | Criterion | Result |
|---|---|---|
| 1 | Connect by key, both directions | **Fail.** Rust → Node only, and only without a NAT. Node → Rust never connects. Rust → Rust connects only in the namespaces |
| 2 | Protomux pairs across the two; NFX-12 framing round-trips | **Partly.** Rust client ↔ Node server: yes (byte-exact sha256, `missing`, pay/1). With a Rust server: no |
| 3 | Listen and announce, keepalive, timeout, firewall API | **Fail.** No listen API on peeroxide-dht. No firewall callback, and a dropped connection stays open (`refused-*-by-rust`). No keepalive: a Node timeout drops an idle Rust peer (`keepalive-rust-to-node`). No timeout |
| 4 | Holepunching between two NATed hosts | **Fail** for every pairing with a Rust end. The Node control passes |
| 5 | Symmetric NAT → blind relay | **Fail** for every pairing with a Rust end. The Node control passes |
| 6 | Throughput | Rust client ← Node server without NAT: 546 Mbit/s (8 MiB, namespaces), 1.28 Gbit/s (64 MiB, loopback). The iroh baseline was not run: there is nothing to compare until the stack works |
| 7 | Noise and secret-stream review | **Fail as is** (below) |
| 8 | `cargo deny` / RustSec | **Fail:** RUSTSEC-2023-0037, `xsalsa20poly1305` unmaintained (renamed `crypto_secretbox`), which peeroxide uses for holepunch payloads. Bans, licences and sources pass (no ignores) |
| 9 | Release cadence; pin or fork | Eight releases from 2026-04-25 to 2026-07-12, none since. One human contributor (32 commits), 20 stars, 2 forks. Neither pin nor a light fork (below) |

## What the API lacks (read from the source, file:line in `peeroxide-dht-1.7.3`)

1. **No server on peeroxide-dht.** `run_server` (`src/hyperdht.rs:2184`) answers handshakes but
   never creates a stream. Accepting connections takes the umbrella crate's swarm, joined as a
   server to a topic, which also announces `hash(key)`. In the runs that path never delivered a
   Node client's connection.
2. **No firewall callback.** `ServerConfig.firewall` is a NAT class (`hyperdht.rs:429-441`), so a
   refusal can only come after the handshake. Dropping the `SwarmConnection` did not close the
   connection either.
3. **No keepalive or timeout,** and keepalives never reach the application:
   `SecretStream::read` drops empty messages (`src/secret_stream.rs:315-318`). NFX-12 §3's
   liveness rule cannot be met.
4. **No backpressure in Protomux.** Every queue is unbounded and there is no drain signal
   (`src/protomux.rs:442, 473-487, 554, 804`), so NFX-12 §4's 256 KiB cap cannot be held. A
   server queues a whole file at once; that is a plausible cause of the dying channels, but it
   is not proven.
5. **The client cannot ask for a relay;** it follows a server's `relay_through`
   (`hyperdht.rs:1452-1463`).
6. Protomux does not enforce unique channels, and it states wire compatibility with protomux
   3.10.1, not 3.11.

## Security review of the channel (read-only; bearer tokens ride it)

The core construction is right:
- Noise `IK_Ed25519_ChaChaPoly_BLAKE2b`: correct token order, and the dialed key is bound into
  the handshake (`src/noise.rs:642-661, 721-854`).
- secret-stream follows libsodium's secretstream construction, and the stream id is checked.
- Blind relays see only ciphertext.
- `#![forbid(unsafe_code)]`.

The findings that block carrying tokens over it:

| Sev | Finding | Where |
|---|---|---|
| High | One Protomux OPEN with remote channel id `0xFFFFFFFF` makes the receiver push about 4.3 × 10⁹ entries: an out-of-memory kill from any connected peer, or from a blind relay over the control mux. Node grows remote ids by one. **Verified in the source.** | `protomux.rs:1019-1032` |
| Medium | REJECT with id 0 underflows; an out-of-range REJECT index panics; a REJECT on an open channel double-frees its id; a batch length can wrap and then panic. Each kills the mux task. | `protomux.rs:1113-1124, 330-335` |
| Medium | Ed25519 DH does no point validation: no small-order, torsion or identity checks, which libsodium's `crypto_scalarmult_ed25519_noclamp` does. A peer with a low-order key makes session keys predictable, and keys become malleable by a torsion point. **Verified in the source.** | `noise.rs:124-142` |
| Medium | Unauthenticated allocation up to 16 MiB from a 3-byte prefix; no handshake deadlines; unbounded holepunch secrets and Protomux buffers. | `secret_stream.rs:247-256, 497-498`; `hyperdht.rs:2315` |
| Low | Poly1305 tag compared with `!=`, not in constant time; a failed decryption does not poison the stream. | `secretstream.rs:203, 310-312` |
| Low | No zeroisation; `Debug` on `NoiseWrapResult` and `ConnectResult` prints session keys. | `noise_wrap.rs:43`, `hyperdht.rs:355` |
| Low | FINAL is ignored, so truncation looks like a clean close (Node does the same); `relay_through` recursion is unbounded. | `secret_stream.rs:313`; `hyperdht.rs:1452-1470` |

Not reviewed: `libudx` 1.7.3, which does the UDX parsing; constant-time behaviour of dalek and
RustCrypto.

**Upstream.** H1, M1 and M2 are security bugs in a public crate. Reporting them to its maintainer
is sovtech's decision.

## Verdict and what it means for ADR 0101

**S5′ fails.**
- **Pinning peeroxide is out:** its server role does not work against Node, its client fails
  behind NATs, and it has the security findings above.
- **A light fork is out too:** the fixes are the server accept path, Protomux (bounds, panics,
  backpressure), DH validation, keepalive and timeout, a firewall callback, the NAT and relay
  failures with a Rust end, and a dependency swap. That is ownership of most of a 30,000-line
  stack.
- **Porting only the thin layers is not enough:** Noise, secret-stream and Protomux are the easy
  part. The HyperDHT routing, holepunching and relays are what failed here, and they are the
  bulk of it.

ADR 0101 §4 says to revisit before nfx Phase 1. The realistic courses:

1. **Fork peeroxide and rebuild what failed,** with this harness as the acceptance test (Node
   is the control in every cell). It keeps "nfx stays Rust", and it is the largest piece of
   work in the plan.
2. **A JavaScript HyperDHT process beside `nfxd`,** speaking NFX-12 through the reference stack.
   This is the course ADR 0101 voided: it is the smallest, and it gives up decision 2's "no JS
   sidecar".
3. **nutflix-pear speaks iroh as well** (ADR 0101 out of scope), so the networks meet on iroh
   and NFX-12 stays the TypeScript side's own profile.

Only the nfx half of Phase 1 waits on this. nutflix-pear's NFX work (formats, catalog, studio,
its own NFX-12 over the reference stack) does not depend on it.

## Not covered

- The iroh throughput baseline (nothing to compare yet).
- Why the Rust stack's channels die and its server never receives Node's connections: that is
  for course 1, with the harness.
- NFX-07 payments (the pay/1 messages here are stand-ins), partial seeders, soak.
