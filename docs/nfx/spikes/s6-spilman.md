# Spike S6 — Cashu Spilman channels as a second NFX pay rail: **PASS** (2026-11-03)

**Question** (ADR 0104 §5): would a Cashu Spilman payment channel make a viable second way to pay
a seeder (NFX-15)? The comparison is NFX-07's bearer `pay`, on a real mint, at the same price and
window.

**Answer: yes, with three conditions for NFX-15** (Findings 4–6).
- **The mint is out of the loop.** 500 per-file updates made **0 mint calls**. A channel's mint
  work is one funding swap and one closing swap.
- **A real CDK 0.18 mint enforces the channel.** It accepted the seeder's 2-of-2 `SIG_ALL` close.
  It refused the watcher's lone refund before expiry and accepted it after.
- **Fees are where the rails part.** At a mint charging 100 ppk input fees, 500 files at 1 sat
  cost the channel **5 sat** in fees and the bearer rail **163 sat**. Under the bearer rail the
  seeder netted 375 of 500 sat.
- **Break-even:** a channel is cheaper in fees after **13 files**. In mint calls it breaks even
  after **21 files** if the watcher gets its change from the seeder, or after 141 files if it has
  to probe for it, as nostr-vpn does today.
- **The update is small and cheap to check.** About 160 B per update on the wire, and about 1.5 ms
  of signing or verifying per update.

**Setup:**
- **Code:** `crates/spikes/s6-spilman`, its own Cargo workspace (outside `crates/`, its lock and
  CI). It names no money crate of nfx's.
- **The money code is nostr-vpn's** ([mmalmi/nostr-vpn](https://github.com/mmalmi/nostr-vpn), MIT),
  called the way its buyer and seller call it:
  - crates: `nvpn-cdk-spilman` =0.17.7, `nvpn-cashu-service` =0.4.11, `cdk`/`cashu` =0.18.0;
  - watcher: `CashuWalletService::open_streaming_route_cashu_spilman_channel`,
    `FileSpilmanPaymentSigner`, `restore_streaming_route_cashu_spilman_refund_with_wallet`;
  - seeder: `FileSpilmanPaymentReceiver` (`process_streaming_route_cashu_payment_with_receiver`,
    `close_cashu_spilman_channel`), then `import_payment_proofs`.
- **The mint:** `cashu_service::simulation::LocalMint`, a genuine CDK 0.18 mint on loopback HTTP
  with SQLite, NUT-03/07/09/11/12 and only Lightning simulated.
  - The spike reaches it through a second HTTP front on the same `Arc<Mint>` that counts every
    request and its bytes (`src/meter.rs`).
  - No step needed a fake signing mint.
- **The scenario:**
  1. Fund a watcher wallet with 2000 sat.
  2. Channel A (600 sat, 3 h): open, stream 500 updates at 1 sat per file, let the seeder close
     alone, and collect on both sides.
  3. Channel B (50 sat, 20 s): no updates; the watcher refunds alone after expiry.
  4. The NFX-07 bearer baseline: 125 `pay`s of 4 sat (window 8, so a `pay` every 4 files). Each
     is an unlocked `cashuB` token that the seeder checks (structure, mint, DLEQ, face value) and
     swaps before its `ack`. It uses plain CDK wallets, because NFX-07 makes the face value equal
     `chunks × price` and fees the seeder's.
- **Two passes:** the mint's default keyset (0 ppk), then a keyset rotated to 100 ppk input fees
  before any wallet existed, so the fees are real.
- **Where it ran:** a Kata guest on ubuntu-server (i5-10500T), through kata-run job 17653
  (2026-11-03). Total run time 326 s. Sum checks hold in both passes: minted = wallets + fees.

## Results (500 files, 1 sat each)

| | channel, 0 ppk | bearer, 0 ppk | channel, 100 ppk | bearer, 100 ppk |
|---|---:|---:|---:|---:|
| mint calls | 47 (fund 5, close 1, change 41) | 160 (seeder 128, watcher 32) | 48 (6, 1, 41) | 167 (129, 38) |
| mint calls, change handed back (modelled) | 7 | — | 8 | — |
| mint calls while streaming | **0** | 125 swaps, each before an `ack` | **0** | 125 |
| bytes to and from the mint | 37,135 | 262,042 | 42,442 | 302,649 |
| peer wire, watcher → seeder | open 4.5 KB + 500 × ~162 B (NDJSON model) = 86 KB | 125 `pay` lines = 87 KB | 87 KB | 77 KB |
| fees | 0 sat | 0 sat | **5 sat** (fund 2, close 1, stage-2 swaps 2) | **163 sat** (seeder 125, watcher 38) |
| seeder nets | 500 of 500 | 500 of 500 | 500 of 500 | **375 of 500** |

**Per update, channel A** (median / p95):

| | 0 ppk | 100 ppk |
|---|---|---|
| sign, crypto only (`create_signed_balance_update`) | 1.59 / 2.64 ms | 1.39 / 2.19 ms |
| verify, crypto only (`verify_sender_signature`) | 1.57 / 2.72 ms | 1.37 / 2.06 ms |
| sign, nostr-vpn path (durable JSON store write) | 14.6 / 22.9 ms | 14.6 / 24.1 ms |
| verify, nostr-vpn path (SQLite write) | 21.3 / 33.4 ms | 21.1 / 34.6 ms |

**On the wire, per update:**
- payment JSON 236–238 B;
- base64 316–320 B;
- nostr-vpn's envelope 518–526 B;
- a modelled NFX-15 NDJSON line `{"t":"bal","balance":N,"sig":…}` about 162 B.

**Bearer, per `pay`:**
- the seeder's checks take 0.3–0.4 ms median;
- its swap takes **74 ms median** (p95 98–108 ms), on an in-process loopback mint, so there is
  no network round trip in it;
- the token is 366 B median, 1,246 B max.

## Findings

1. **Channel streaming never touches the mint.** The counter delta over all 500 sign-and-verify
   rounds is 0 in both passes. A mint outage cannot stall a funded channel; under the bearer rail
   every `pay` waits on a swap before its `ack`.
2. **The mint enforces the 2-of-2 and the expiry refund.**
   - The close swap carried two signatures on its first input (watcher and seeder, `SIG_ALL`) and
     was accepted, with 4–5 inputs becoming 9–10 outputs.
   - Before expiry, a swap signed by the watcher's refund key alone was refused: HTTP 400, code
     20008, "P2PK spend conditions are not met".
   - After expiry the same kind of swap was accepted with one signature.
3. **Replay is bounded by the balance.**
   - The genuine update for file 10, resent after file 500, was accepted as a no-op.
   - An update claiming balance 10 under file 500's signature was refused (invalid signature).
   - The seeder's store only moves the balance up (`configurable_host/storage.rs:375-389` in
     `nvpn-cdk-spilman`), and the close settled at 500.
4. **Condition: the seeder hands the watcher its change.** nostr-vpn's watcher recovers change
   from a close it did not see by probing NUT-09 restore. That cost 41 mint calls (35 `restore`)
   and **78 s** per channel, which is most of the channel's mint calls. If the seeder sends the
   close's change outputs (or the watcher's signatures) back over the channel, it drops to about
   7 calls. NFX-15 should specify that, and keep probing only as the fallback.
5. **Condition: the expiry runs on wall clocks.** CDK checks the NUT-11 locktime against the
   mint's own clock (`cashu-0.18.0/src/nuts/nut11/mod.rs:291` → `util::unix_time()`), and
   `cashu-service`'s refund worker reads `SystemTime::now()`. NFX-15's cutoff margins (when the
   seeder must close, when the watcher may refund) must absorb clock skew between mint, seeder and
   watcher. nostr-vpn's ½-lifetime collection cutoff does that generously.
6. **Condition: persist less often than every update.** The crypto costs about 1.5 ms per update.
   nostr-vpn's durable path costs 15–21 ms, because every update writes its JSON store and SQLite
   synchronously. That is affordable at one update per 2–6 s segment, but NFX-15 should allow
   persisting the latest balance on a timer or on close. Losing an update only loses the seeder
   that one file's credit.
7. **Fees decide the economics.** NFX-07 makes swap fees the seeder's (§3). With 4-sat payments
   at a 100 ppk mint, each 1–2 proof swap costs 1 sat, a quarter of the payment. The bearer rail
   only stays viable at fee-charging mints with a wider window or a higher price. The channel
   pays fees twice per channel, not once per payment.
8. **The funding swap is the slow part.** It took 6.0–7.9 s for the watcher, mostly wallet work
   outside the mint (the mint handled it in 28–57 ms). Checking the funding is offline and took
   38–54 ms. The hybrid start ADR 0104 §1 sets (bearer first, a channel for seeders the
   watcher keeps using) hides this latency from playback start.

## Can a getter bill per verified range on iroh? Yes

Read in iroh-blobs 0.103.0, the version nfx pins:

- In the low-level getter, `get::fsm::AtBlobContent::next` (`src/get.rs:731-748`) adds to
  `payload_bytes_read` only for an `Ok(BaoContentItem::Leaf)`.
  - bao-tree's response decoder has already checked each leaf against the BLAKE3 tree.
  - A leaf that fails comes back as `Err(LeafHashMismatch)` and is not counted.
  - Each verified leaf carries its offset and data, at most `IROH_BLOCK_SIZE` = 16 KiB
    (`src/store/mod.rs:18`, chunk log 4).
- The high-level `Remote::execute_get` emits `GetProgressItem::Progress(u64)` ("progress on the
  payload bytes read", `src/api/remote.rs:73-76`). `get_blob_ranges_impl` sends it after it has
  unwrapped each decoded item, so a decode error ends the request before any progress is sent for
  it (`src/api/remote.rs:913-919`).
- **So a Rust watcher can count verified payload bytes at 16 KiB granularity**, and could sign a
  channel update per verified range. NFX-15 can bill partial transfers fairly on iroh.
- **This does not hold for nutflix-pear,** whose iroh helper is an untrusted pipe (ADR 0103). It
  would need BLAKE3 verification on the JS side to bill per range; until then the whole-file rule
  stands there.
- **NFX-12 (HyperDHT) has no equivalent.**

## Limits

- **One run per pass, on one machine,** with the mint in process over loopback. A remote mint adds
  a network round trip to every bearer swap and to a channel's two swaps only.
- **"Change handed back" is modelled** from the measured calls minus the probing ones; it is not
  implemented.
- **The NDJSON line size is a model** of an NFX-15 message, not a specified wire format.
- **No adversarial run.** A seeder withholding the close and a watcher racing the refund at expiry
  are covered by nostr-vpn's own suites, not exercised here. NFX-15 needs its own adversary suite
  in both engines (ADR 0104 §5).
- **The crates are a maintained fork** of `cdk-spilman` 0.17.6, with a focused review and no formal
  cryptographic audit (`README.nvpn.md`).

## Reproduce

```sh
cd crates/spikes/s6-spilman
cargo run --release --locked    # prints the markdown report; progress on stderr
```
