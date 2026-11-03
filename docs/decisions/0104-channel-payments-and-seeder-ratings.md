# 104. Channel payments and seeder ratings, after nostr-vpn's paid exits

Date: 2026-11-03

## Status

Proposed 2026-11-03. Nothing here is decided until sovtech accepts it; the questions sovtech owes
are in §6.

Touches nothing in M2. NFX-07 and its frozen readers, `nfx-pay`, `nfx-pay-wire` and the locked
paths (`crates/ci/check-locked.sh`) stay as they are. Everything proposed is additive and comes
after NFX-07 freezes, like NFX-14 (ADR 0102).

## Context

### What nostr-vpn does

[nostr-vpn](https://github.com/mmalmi/nostr-vpn) (MIT) is a Tailscale-style mesh VPN. It has an
experimental market where nodes sell internet exit bandwidth by the byte for Cashu ecash
("Paid Exits"). Everything below was read at upstream `827bcee7` (2026-11-02):

- **Offer.** A seller publishes a kind 37196 parameterized replaceable event every 15 minutes. It
  lives for 1 h and carries a NIP-40 expiration. Its fields are:
  - `price_msat_per_gb`, and one `mint` tag per accepted mint;
  - `max_channel_capacity_sat` (default 1000), `channel_expiry_secs` (default 24 h);
  - `free_probe_units` (1 MiB) and `grace_units` (256 KiB);
  - a Spilman receiver key that is not the seller's Nostr key;
  - coarse location and self-declared quality fields.

  (`crates/nostr-vpn-core/src/paid_routes.rs`, `paid_routes/events.rs`)
- **Selection.** A buyer picks an offer by hand or automatically. Candidates are ranked by:
  1. payment available;
  2. probe health;
  3. the buyer's own vote;
  4. local probe measurements;
  5. a trusted rating score;
  6. probe count;
  7. lower price;
  8. newer offer.

  A known failed probe cannot be rescued by a vote. Before funding anything, the buyer runs an
  HTTPS health probe through a free trial route. Trials are rationed per buyer key, per source IP
  and per seller (`paid_route_store/automatic_selection.rs`, `free_probe.rs`).
- **Rail: a Cashu Spilman channel** (`vendor/cdk-spilman`, MIT: a maintained fork of
  SatsAndSports' `cdk-spilman` 0.17.6, on CDK 0.18; `vendor/cashu-service`).
  - **Funding.** The buyer swaps tokens once at the mint into NUT-11 P2PK outputs. Before expiry,
    spending them needs both the buyer's and the seller's keys (`SIG_ALL`). After the expiry
    locktime, the buyer alone can refund them.
  - **Checking the funding.** The seller checks the keyset, the NUT-12 DLEQ proofs, the total and
    the terms offline.
  - **Paying.** From then on the buyer signs a cumulative `BalanceUpdate`, its amount due plus
    1 sat. That costs **no mint call**. Updates travel on the mesh's authenticated control
    channel, never as Nostr events, from a durable outbox that resends until the seller acks.
  - **Collection.** The seller holds the latest update and collects at min(½ lifetime, 12 h). It
    marks the channel collected only after the proceeds are imported into its wallet.
  - **Renewal and change.** The buyer funds a fresh channel at half credit and closes the old one
    cooperatively. It recovers change by NUT-09 restore, or by the refund path after expiry.
  - **Retries.** Two fixes hardened the retry paths: an outbox entry is dropped only on the
    seller's ack or a newer duplicate, never by age (upstream #139), and the refund worker waits
    for the funding expiry instead of polling the mint (#140).
- **Metering.** Both ends count in userspace, and the seller gates on its own count.
  - Buyer-to-exit traffic is billed at once.
  - Exit-to-buyer UDP is billed only on flows the buyer started.
  - TCP downloads are billed when the buyer acknowledges them, so a retransmit is never billed
    twice (`paid_route_accounting.rs`; `docs/protocol.md`, "Paid Exits").
- **Ratings.** Ratings are kind 7368 facts from mmalmi's `nostr-social-memory`:
  - scope `vpn.exit`, score −100…100, with no metrics, IPs or payment data in the event;
  - a manual vote is allowed only after a successful probe through that provider;
  - automatic ratings come from probe results, and a negative one is published only while another
    provider is healthy at the same time;
  - a buyer counts only its own ratings, its direct follows' and configured trusted authors'.

  (`paid_route_ratings.rs`)
- **Limits.** Upstream calls the feature experimental. Its Spilman fork says it has had a focused
  review, "not a formal cryptographic audit". It is IPv4 only, and quality claims in offers are
  self-declared.

### Where nfx and nutflix-pear stand

| | nostr-vpn | nutflix-pear legacy pay/1 | NFX-07 (M2) |
|---|---|---|---|
| Unit | byte, billed when acknowledged | 64 KiB Hyperblobs block | one NFX-05 file; an admitted request counts whole |
| Rail | Spilman channel: fund once, sign updates, collect | P2PK-locked proofs per PAY (seeder set + creator set) | unlocked bearer token per `pay`, swapped by the seeder before `ack` |
| Mint calls | funding + collection | one per seeder flush | one per `pay` (about every ⌈window/2⌉ files) |
| Credit | locked capacity, 1 sat ahead | serve first, 4 blocks | serve first, `window` files, plus a global cap per `debt_ttl` |
| Choosing a peer | probes + WoT ratings + price | stall failover, bans | none specified; identities are free (NFX-07 §3) |

Three costs NFX-07 accepts are what a channel would change:

- **The mint is in the hot loop.** Every `pay` is a swap, so a slow or down mint shows up in the
  middle of a video as `mint-unavailable`. That is never a ban, but each one costs the watcher a
  reclaim, and after three in a row it stops paying that seeder (§3a). The mint also sees one swap
  per payment, which shows how often each peer pays.
- **Sybil credit.** A fresh identity costs nothing, so the seeder's loss is bounded only by the
  global cap per `debt_ttl` (§3). nutflix-pear's threat model accepts the same residual (its T3).
- **A request is a whole file.** Every admitted request counts as one chunk, whether whole,
  ranged or aborted (§3). That stops a peer aborting at 99 % to avoid paying. The cost: an honest
  transfer that the network cuts short is paid as if it were complete.

Neither project has a way to choose seeders by reputation. nutflix-pear's SECURITY.md names "peer
reputation" as the control for its T10, with no code behind it.

## Decision (proposed)

### 1. A channel rail, as a new additive Draft (NFX-15)

A second way to pay a seeder, beside NFX-07 and not replacing it:

- **Its own ALPN** (working name `nfx/chan/1`), because pay/1 treats an unknown `t` as an error. A
  seeder advertises it with a new beacon field that M2 readers ignore.
- **Funding.** The watcher funds one Spilman channel per seeder at a mint the seeder accepts, in
  the shape above: 2-of-2 until expiry, then the watcher alone.
- **Paying.** For each file, the watcher signs the cumulative balance up to the file it is about
  to request. Updates cost nothing, so a seeder can quote a credit of 0 or 1 file instead of half
  a window.
- **Collection.** The seeder collects at its cutoff and imports before it marks the channel
  collected. The watcher's change and refund paths are nostr-vpn's.
- **Hybrid start.** A watcher starts on NFX-07 bearer payments, and opens a channel to a seeder
  it keeps using once the channel's funding fee is worth it. One-off seeders stay on bearer
  payments. Default thresholds are the spike's to set (§5).
- **What it changes:**
  - **The mint leaves the loop.** It sees a funding and a collection per channel, not a swap per
    payment. A mint outage stalls nothing that is already funded.
  - **Deferred redemption is safe.** The funds are locked 2-of-2, so the watcher cannot spend
    them elsewhere first. The seeder's risk shrinks to the unpaid lead.
  - **An identity has a price.** A sybil needs a funded channel (fees plus locked capital) for
    anything beyond the bearer window, which shrinks T3.
- **Rules NFX-15 must keep** (ADR 0102 §4's spirit):
  - no Nostr events in the money path;
  - a refused update never burns funds;
  - replay is bounded by the cumulative balance, not by memory;
  - NFX-14's creator receipt works per update as it does per `pay`.

### 2. Seeder ratings, as a separate small Draft (NFX-16)

Ratings are not money, so they need not wait for NFX-15:

- **Publishing.**
  - A watcher's software may publish kind 7368 facts with scope `nfx.seeder` about a seeder's
    identity.
  - Inputs: an honest `quote` and `ack`, throughput, stalls, and refusals of files the seeder's
    beacon claimed.
  - Scores run −100…100. The event never names a video, a file, an amount or an address.
- **Reading.** A watcher counts only its own ratings, its follows' and configured trusted authors'.
  It ranks the beacons it may use by health, then its own vote, then local measurements, then the
  trusted score, then price, as nostr-vpn does.
- **Privacy.** A rating says "this npub used that seeder". Publishing is therefore **off by
  default**. Local measurements still steer selection when it is off.
- **Credit by trust.** A seeder may, but need not, quote a larger `window` to a watcher that
  proves a Nostr identity close to it in its WoT. Proving one ties the watcher's npub to what it
  watches, toward that seeder only. So it is the watcher's choice per seeder, never required.

### 3. Cross-mint transfer in the watcher's wallet

When the watcher's wallet shares no mint with a seeder's quote, the wallet may move an exact amount
between two mints over Lightning. It does so with an idempotency key, a persisted saga and a fee
ceiling, as `cashu-service`'s `transfer_between_mints` does.

- Both mints must be ones the watcher already approved. A mint a seeder names is never trusted
  because the seeder named it.
- This is wallet policy, not wire protocol: it goes into the M2.1 wallet and nutflix-pear's
  MoneyPlane, not into a spec.

### 4. Fairer partial billing on iroh

iroh-blobs verifies BLAKE3 ranges on the wire, and channel updates cost nothing. So NFX-15 could
bill per verified range instead of per admitted request. An honest transfer cut short would then
be paid for what it carried, and an abort at 99 % would still pay 99 %.

Whether a watcher can observe verified ranges from iroh-blobs' progress events precisely enough is
for the spike (§5) to answer. If it cannot, NFX-15 keeps the whole-file rule.

### 5. Order

1. **Spike S6** (`crates/spikes/s6-spilman`): its own workspace, outside CI and the money closure.
   - Fund a channel against an in-process CDK mint with fake Lightning (`cashu-service`'s
     `simulation` feature).
   - Stream per-file updates, collect, and refund after expiry.
   - Measure update size, sign and verify time, mint calls and fees, against NFX-07 bearer
     payments at the same price and window.
   - Record the results in `docs/nfx/spikes/s6-spilman.md`.
2. **NFX-16 ratings**, any time after acceptance.
3. **NFX-15**, after NFX-07 freezes and M2.1 ships, in the same security discipline as M2: an
   adversary suite in both engines before any real mint.
4. **nutflix-pear** follows the specs.
   - It needs a TypeScript channel path, since ADR 0103 keeps money out of the iroh helper.
     `cashu-ts` has NUT-11 multisig and locktime refunds; the Spilman construction on top is
     unported.
   - It can take ratings for its legacy seeder selection earlier, against its T10.

## Consequences

- **Capital is locked** for a channel's life (nostr-vpn defaults to 24 h, with collection at
  12 h). A video session is shorter than a VPN session, so NFX-15 likely wants shorter lifetimes
  and a smaller capacity. The spike's fee numbers decide by how much.
- **A seeder must be online to collect** before expiry, or the watcher reclaims the funds. That
  suits always-on seeders (desktop daemons, pull-through origins) and penalises a laptop seeder
  that sleeps. Bearer payments remain for it.
- **Mints must support NUT-11** multisig with locktime and `SIG_ALL`. CDK does; the testnet
  `cdk-mintd` will be checked in the spike.
- **One dependency question:** `nvpn-cdk-spilman` (mmalmi's maintained fork of the published
  0.17.6) against the original author's newer, unpublished line, which changes channel IDs and
  derivation. Take whichever is maintained and audited when NFX-15 is written, and pin it inside
  the money closure.
- **Ratings add a privacy surface**, which is why they are opt-in (§2). They do nothing against
  sybil watchers; only the channel's price on identities does.
- **Nothing changes for M2**, its audits, its pins or its exit run.

## 6. Questions for sovtech

1. **Direction.** Accept §1–§3 as the direction, and the spike S6 as the next step?
2. **Defaults.** Channel lifetime and capacity for video, or leave them to the spike's numbers?
3. **Ratings.** Reuse kind 7368 (`nostr-social-memory` facts, shared with nostr-vpn) or a kind of
   our own; and off by default, as proposed?
4. **Credit by trust.** Allow it at all (§2), given what proving an identity reveals?

## Sources (read 2026-11-02 and 2026-11-03)

- **nostr-vpn** at `827bcee7`:
  - docs: `README.md` ("Paid Exits"), `docs/protocol.md` ("Paid Exits");
  - `crates/nostr-vpn-core/src/`: `paid_routes.rs`, `paid_routes/events.rs`,
    `paid_route_store/` (automatic selection, buyer session, free probe, persistence),
    `paid_route_accounting.rs`, `paid_route_ratings.rs`;
  - vendored crates: `vendor/cdk-spilman/README.nvpn.md`, `vendor/cashu-service/README.md`;
  - upstream PRs #139 and #140.
- **Spilman channels for Cashu:** SatsAndSports' `cashu_spilman_channels` and `cdk-spilman` 0.17.6
  on crates.io.
- **nfx:**
  - `spec/nfx-07-open-payments.md` §2, §3, §3a, §6;
  - `spec/nfx-06-iroh.md` (BLAKE3 on the wire);
  - ADR 0100, 0102 and 0103.
- **nutflix-pear:**
  - `SECURITY.md` (T3, T10);
  - ADR 0010 (pay/1 windows);
  - ADR 0020 (paid NFX after M2.1);
  - `packages/app-desktop/src/host/money.ts`.
