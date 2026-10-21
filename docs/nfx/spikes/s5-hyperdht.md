# Spike S5′ — a Rust HyperDHT for NFX-12: **running** (2026-10-21)

**Question** (ADR 0101 §4): can nfx speak NFX-12 natively in Rust? The candidate is
`peeroxide` / `peeroxide-dht` 1.7.3, a pure-Rust HyperDHT, secret-stream and Protomux. It is
tested against Node `hyperdht` 6.34.0, `@hyperswarm/secret-stream` 6.9.1 and `protomux` 3.11.0,
the versions nutflix-pear locks. The answer gates nfx Phase 1.

**Setup:**
- Code: `crates/spikes/s5-hyperdht`, its own Cargo workspace. It names no money crate.
- Two peers with the same CLI and the same NFX-12 wire: `src/main.rs` (Rust) and `node/peer.js`
  (Node). The wire is `nfx/files/1` with types 0 get, 1 data, 2 end, 3 missing, and
  `nfx/pay/1` with type 0, both on Protomux with the video address as channel id.
- `run-local.sh`: every server/client pairing on a loopback testnet.
- `nat/run.sh`: the same pairings behind nftables NATs in network namespaces.
- Both run in CI only (`.github/workflows/spike-s5.yml`), as does `cargo deny`.
- Resolved versions: peeroxide 1.7.3, peeroxide-dht 1.7.3, libudx 1.7.3, tokio 1.54.0.
  `.crate` sha256 equals the crates.io checksum.

## Acceptance

| # | Criterion | Result |
|---|---|---|
| 1 | Connect by key, both directions | CI: `fetch-*-from-*` in `local.jsonl` |
| 2 | Protomux channels pair across the two; NFX-12 framing round-trips | CI: same rows (`sha_ok`, `missing_ok`, pay/1 quote and ack) |
| 3 | Listen and announce, keepalive, timeout, firewall API | **Partly missing, by reading** (below); CI: `refused-*`, `keepalive-*`, `timeout-*` |
| 4 | Holepunching between two NATed hosts | CI: `consistent-consistent-*` in `nat.jsonl` |
| 5 | Symmetric NAT → blind relay | CI: `symmetric-symmetric-*` without and with `--relay` |
| 6 | Throughput | CI: `mbit_s` per pairing (loopback 64 MiB, NAT 8 MiB). The iroh baseline is not in this run (below) |
| 7 | Noise and secret-stream review | **Done by reading: not suitable as is** (below) |
| 8 | `cargo deny` / RustSec | **Advisories fail:** RUSTSEC-2023-0037, `xsalsa20poly1305` unmaintained (renamed `crypto_secretbox`), which peeroxide uses for holepunch payloads. Bans, licences and sources pass (CI run 1, `results/deny.txt`; no ignores) |
| 9 | Release cadence; pin or fork | **Done** (below) |

## What the API lacks (read from the source, file:line in `peeroxide-dht-1.7.3`)

1. **No server on peeroxide-dht.** `run_server` (`src/hyperdht.rs:2184`) answers handshakes but
   never creates a stream. Accepting connections takes the umbrella crate's swarm: a server joins
   a topic as server, which also announces `hash(key)`, where `connect(key)` looks. The spike
   joins the NFX-12 §3 topic.
2. **No firewall callback.** `ServerConfig.firewall` is a NAT class (`hyperdht.rs:429-441`).
   Node refuses an unwanted key inside the handshake; peeroxide can only drop the connection
   after it. The `refused-*` rows say which kind each refusal was.
3. **No keepalive or timeout settings, and keepalives never reach the application.**
   `SecretStream::read` drops empty messages (`src/secret_stream.rs:315-318`), and Rust never
   sends any. NFX-12 §3's liveness rule cannot be met without changes.
4. **No backpressure in Protomux.** Every queue is unbounded and there is no drain signal
   (`src/protomux.rs:442, 473-487, 554, 804`). A sender cannot hold NFX-12 §4's 256 KiB cap, so a
   pay/1 message waits behind every queued frame (`pay_rtt_ms`), and a fast peer can make a
   receiver buffer without limit.
5. **The client cannot ask for a relay.** It follows a server's `relay_through` automatically
   (`hyperdht.rs:1452-1463`); there is no client-side `relayThrough`. The NAT matrix therefore has
   the server name the relay, which both stacks support.
6. Protomux does not enforce unique channels, and pairs same protocol+id channels first in,
   first out (`protomux.rs:818-882`). It states wire compatibility with protomux 3.10.1, not 3.11.

## Security review of the channel (read-only; bearer tokens ride it)

The core construction is right:
- Noise `IK_Ed25519_ChaChaPoly_BLAKE2b` follows the right token order, and the dialed key is
  bound into the handshake (`src/noise.rs:642-661, 721-854`).
- secret-stream follows libsodium's secretstream construction, and the stream id is checked.
- Blind relays see only ciphertext.
- `#![forbid(unsafe_code)]`.

The findings that block carrying tokens over it:

| Sev | Finding | Where |
|---|---|---|
| High | One Protomux OPEN with a remote channel id of `0xFFFFFFFF` makes the receiver push about 4.3 × 10⁹ entries: an out-of-memory kill from any connected peer, or from a blind relay over the control mux. Node grows remote ids by one. **Verified in the source.** | `protomux.rs:1019-1032` |
| Medium | REJECT with id 0 underflows, an out-of-range REJECT index panics, a REJECT on an open channel double-frees its id, and a batch length can wrap and then panic. Each kills the mux task. | `protomux.rs:1113-1124, 330-335` |
| Medium | Ed25519 DH does no point validation: no small-order, torsion or identity checks, which libsodium's `crypto_scalarmult_ed25519_noclamp` does. A peer with a low-order key makes the session keys predictable, and keys become malleable by a torsion point (deny lists by key can be dodged). **Verified in the source.** | `noise.rs:124-142` |
| Medium | Unauthenticated allocation up to 16 MiB from a 3-byte length prefix; no handshake deadlines; unbounded holepunch secrets and Protomux buffers. | `secret_stream.rs:247-256, 497-498`; `hyperdht.rs:2315` |
| Low | Poly1305 tag compared with `!=`, not in constant time; a failed decryption does not poison the stream. | `secretstream.rs:203, 310-312` |
| Low | No zeroisation; `Debug` on `NoiseWrapResult` and `ConnectResult` prints session keys. | `noise_wrap.rs:43`, `hyperdht.rs:355` |
| Low | FINAL is ignored, so truncation at a message boundary looks like a clean close (Node does the same); unbounded `relay_through` recursion. | `secret_stream.rs:313`; `hyperdht.rs:1452-1470` |

Not verified by reading: byte-exact interop (CI answers that), constant-time behaviour of dalek
and RustCrypto, and `libudx` 1.7.3, which does the UDX parsing and was not reviewed.

## Cadence and maintenance

- Eight releases from 2026-04-25 to 2026-07-12, none since.
- One human contributor (32 commits); 20 stars, 2 forks, 2 open issues.
- A bus factor of one.

## Provisional verdict (before CI)

**peeroxide 1.7.3 cannot be pinned as is.** The blocking findings are H1 and the Medium rows,
plus gaps 2–4, which NFX-12 needs. Whether to **fork** it or **port** the thin layers waits on
the CI interop result:
- If the Rust and Node peers interoperate, including the relay case, fork it into a SovTech
  crate and patch: Protomux id bounds and index checks, DH point validation, a constant-time
  tag compare with poisoning, frame and handshake bounds, a bounded queue with a drain signal,
  keepalive and timeout, and a pre-handshake firewall callback. Review every upstream release
  before taking it.
- If they do not interoperate, port the Noise, secret-stream and Protomux layers onto
  RustCrypto against Node's test vectors, and re-plan Phase 1 (ADR 0101 §4).

**Upstream.** H1, M1 and M2 are security bugs in a public crate. Reporting them to its
maintainer is sovtech's decision.

## Not covered by this run

- **The iroh throughput baseline.** It needs iroh's dependency tree in this workspace; it is
  the next addition, once interop is known.
- **NFX-07 payments.** The pay/1 messages here are fixed stand-ins, not an engine.
- Partial seeders, many connections per seeder, and the long-running soak.
