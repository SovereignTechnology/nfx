# 104. Channel payments and seeder ratings, after nostr-vpn's paid exits

Date: 2026-11-03

## Status

Accepted 2026-11-03, with sovtech's answers in §6. Those answers set the channel defaults (§1),
drop credit by trust (§2) and settle §4 from spike S6.

Touches nothing in M2. NFX-07 and its frozen readers, `nfx-pay`, `nfx-pay-wire` and the locked
paths (`crates/ci/check-locked.sh`) stay as they are. Everything here is additive and comes
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

## Decision

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
  payments. The defaults (when to open a channel, its lifetime and capacity) are in §6.2.
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
- **No credit by trust** (§6.4). A seeder's credit never depends on a watcher proving who it is.
  Ratings choose seeders; they never price watchers.

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

Spike S6 answered whether a watcher can see verified ranges: on iroh, yes. iroh-blobs 0.103 counts
only leaves that passed BLAKE3 verification, 16 KiB at most each. So NFX-15 bills per verified
range on iroh. A watcher that cannot observe verified ranges keeps the whole-file rule: that is
nutflix-pear's iroh helper (an untrusted pipe, ADR 0103) and NFX-12.

### 5. Order

**Spike S6 ran on 2026-11-03: PASS** ([`spikes/s6-spilman.md`](../nfx/spikes/s6-spilman.md)). It
used a real CDK 0.18 mint and nostr-vpn's own channel code, with 500 files at 1 sat:
- **Mint calls while streaming: 0.** The mint accepted the 2-of-2 close, and accepted the watcher's
  lone refund only after expiry.
- **Fees at a 100 ppk mint:** 5 sat for the channel, 163 sat for NFX-07 bearer payments at window
  8, which left the seeder 375 of 500 sat.
- **Break-even:** 13 files on fees, and 21 files on mint calls once the seeder hands the watcher
  its change.
- **Per update:** about 162 B and about 1.5 ms to sign or verify.
- **§4 is feasible on iroh:** iroh-blobs 0.103 counts only verified leaves (16 KiB), so a Rust
  watcher can bill per verified range.
- **Conditions it sets for NFX-15:**
  - the seeder hands back the watcher's change, since probing NUT-09 cost 41 calls and 78 s;
  - cutoffs absorb clock skew, since the mint checks the locktime on its own wall clock;
  - the latest balance may be persisted lazily.


1. **Spike S6** (done, above; `crates/spikes/s6-spilman`): its own workspace, outside CI and the money closure.
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

- **Capital is locked** until the channel closes. nostr-vpn's channels live 24 h, with
  collection at 12 h. NFX-15's defaults are 6 h and at most an hour of playback (§6.2). A
  seeder that vanishes holds the watcher's funds until expiry, but cannot spend them.
- **A seeder must be online to collect** before expiry, or the watcher reclaims the funds. That
  suits always-on seeders (desktop daemons, pull-through origins) and penalises a laptop seeder
  that sleeps. Bearer payments remain for it.
- **Mints must support NUT-11** multisig with locktime and `SIG_ALL`. CDK 0.18's mint enforced
  both in S6. A watcher checks a mint's NUT-06 info for NUT-11 before funding a channel there, and
  stays on bearer payments if it is missing. No deployed `cdk-mintd` has been checked yet; NFX-15's
  adversary suite does that.
- **One dependency question:** `nvpn-cdk-spilman` (mmalmi's maintained fork of the published
  0.17.6) against the original author's newer, unpublished line, which changes channel IDs and
  derivation. Take whichever is maintained and audited when NFX-15 is written, and pin it inside
  the money closure.
- **Ratings add a privacy surface**, which is why they are opt-in (§2). They do nothing against
  sybil watchers; only the channel's price on identities does.
- **Nothing changes for M2**, its audits, its pins or its exit run.

## 6. sovtech's answers (2026-11-03)

1. **Direction: accepted, §1 to §4, in §5's order.** S6 is done. NFX-16 may start at any time.
   NFX-15 waits for NFX-07 to freeze and M2.1 to ship.
2. **Defaults: set now from S6's numbers.** NFX-15 writes them as defaults that a seeder's
   quote or a watcher's policy may change; its adversary suite may revise them.
   - **When to open a channel:** after 32 files paid to one seeder by bearer payments in a
     session, about a minute of video at NFX-05's 2 s segments. That is past both break-evens S6
     measured: 13 files on fees, 21 on mint calls once the seeder hands back change.
   - **Lifetime:** 6 h, against nostr-vpn's 24 h. It covers a long film, and caps how long a
     vanished seeder can hold the watcher's funds.
   - **Seeder's cutoff:** it collects at ½ lifetime (3 h), or 10 minutes after the last update,
     whichever comes first. The 3 h margin absorbs clock skew between mint, seeder and watcher
     (S6 Finding 5). The watcher refunds only after expiry and retries while the mint's clock says
     no.
   - **Capacity:** at most an hour of playback at the current rendition at the quoted price, and
     never more than the seeder's quoted maximum. Overfunding costs locked capital only, since the
     change comes back at close.
   - **Renewal:** the watcher funds the next channel when half the capacity or half the lifetime
     is used, whichever comes first. The 6–8 s funding (S6 Finding 8) then runs well ahead of need,
     and the old channel closes cooperatively.
   - **Credit:** at most what is in flight. For whole files the watcher signs before each
     request (§1). On iroh, where NFX-15 bills per verified range (§4), it signs as each range
     verifies, so the seeder carries only the ranges in flight.
   - **Change:** the seeder hands back the watcher's change at close. NUT-09 probing is the
     fallback only (S6 Finding 4).
   - **Persistence:** both ends persist the latest balance at least every 30 s and at close, not
     after every update (S6 Finding 6).
3. **Ratings: reuse kind 7368 with scope `nfx.seeder`, and keep publishing off by default.**
   - One kind shares the WoT data and readers nostr-vpn already has. The scope keeps the two
     apart, and a kind of our own would add a second schema for nothing.
   - NFX-16 restates the fields it uses (subject, scope, score) with its own test vectors. A
     change in `nostr-social-memory` then cannot change nfx's wire format silently.
   - Off by default stands. A published rating says which seeders an npub used, while local
     measurements steer selection without one.
4. **Credit by trust: no.**
   - Channels already make credit unnecessary: an update costs nothing, so the credit can be zero.
     They also put a price on each identity, which answers sybil watchers; ratings do not (see
     Consequences).
   - A larger window for a proven identity would reward watchers for revealing what they watch. It
     would also invite seeders to squeeze strangers until they identify themselves. That is a
     privacy cost to every watcher, to solve what channels already solve.
   - Revisit it only in a new ADR, and only with evidence: bearer-only seeders (ones that cannot
     stay online to collect) stalling in ways a channel cannot fix.

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
