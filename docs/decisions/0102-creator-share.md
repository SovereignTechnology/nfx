# 102. A creator share on open videos: the creator's receipt before `ack`

Date: 2026-10-21

## Status

Accepted 2026-10-21 (sovtech's decisions, below). This record is the decision only. The mechanism
is specified later, in a new additive Draft, NFX-14, after NFX-07 freezes (ADR 0101, Phase 3).
Open: paying the creator while it is offline ([issue #1](https://github.com/SovereignTechnology/nfx/issues/1),
also on Nostr).

Amends ADR 0100 §1 ("Open videos have no keyholder and no key; they are free, with zaps") and
answers its §10 objection to the two-token split. ADR 0100 §8 ("M2 is unchanged") still holds:
nothing here touches M2.

## Context

ADR 0100 made the keyholder a creator's entire income path, plus zaps. Open videos have no key,
so on NFX-07 the watcher pays the seeder per chunk and the creator gets nothing it can enforce.
ADR 0100 §10 lists the designs that tried to share a payment, and why each fell. The nearest one,
the **two-token split** (one token to the seeder, one P2PK-locked to the creator), fell because
"nobody is obliged to deliver it: a seeder drops it at no cost".

ADR 0101 makes `nutflix-pear` an NFX implementation. Its legacy protocol already pays creators a
share of every payment: two P2PK-locked proof sets, seeder and creator, with a carry split. For its
creators to move to NFX without losing that, NFX needs a creator share that answers the objection.

Two candidates were weighed:

| | (a) Default-on tip | (b) Creator receipt before `ack` |
|---|---|---|
| What the watcher does | Attaches a creator-locked token to its payment | Sends the creator's part to the creator's receipt endpoint |
| What happens to that part | The seeder delivers it, best-effort | The endpoint takes it and returns a receipt |
| What the seeder checks | The token, offline | The receipt, before `ack` |
| What it guarantees | Enforced only by default software | Delivery is a precondition of the seeder being paid |
| Cost | — | The creator runs, or rents, an always-on endpoint |

(a) restates the "sound because" column of the two-token split without answering its "fell
because": the seeder still holds the creator's token and can drop it.

## Decision

### 1. The creator's receipt before `ack` (b)

For a video whose manifest declares a share, each payment has two parts:

- **The creator's part goes from the watcher straight to the creator's receipt endpoint**, which
  the manifest names together with a **receipt key**. As with ADR 0100's `cert_key`, that key is
  delegated for exactly this job, so an endpoint the creator rents never holds the creator's
  identity key. The endpoint takes the token and returns a receipt signed by the receipt key over
  (the proofs' Ys, seeder, `a`, peer, `upto_chunk`).
- **The seeder's part goes in the NFX-07 `pay`, with the receipt.** The seeder checks the receipt
  against the manifest's receipt key, and its binding to this seeder, video, peer and
  `upto_chunk`, before it swaps and acknowledges. A payment without a valid receipt is refused, and
  its token is not claimed.

The creator's token never passes through the seeder, so a seeder cannot drop it. A watcher cannot
skip the creator either: an NFX-14 seeder will not `ack` without the receipt.

### 2. An offline creator stalls its videos

If the receipt endpoint cannot be reached, no receipt comes back, the seeder does not `ack`, and
the video stalls once the watcher has used up the seeder's `window`. This is accepted for now.

The other course, a seeder that serves on without a receipt, would make the share optional, which
is (a) again. Making the creator payable while it is offline, with the video still playing, is
[issue #1](https://github.com/SovereignTechnology/nfx/issues/1). Its leading direction is a
mailbox that holds tokens P2PK-locked to the creator, which the mailbox can store and sign
receipts for but never spend.

### 3. The share is a carve-out of the price

The watcher pays the seeder's quoted price per chunk **in total**. The creator's part is taken out
of it, and the seeder receives the rest. The seeder's `quote` stays the total price. So a watcher
pays the same whether a video declares a share or not, and gains nothing by avoiding one.

### 4. Rules NFX-14 must keep

- **No Nostr events in the money path** (NFX-07 §6). Nutzaps would also publish who watched what.
- **A refused token is never burned.** The seeder refuses a `pay` before claiming anything, as for
  `stale`. A creator's part that the endpoint refuses, for `stale`, `mint-unavailable` or anything
  else, stays the watcher's to reclaim.
- **Replay is bounded by position, not memory.** The receipt binds (seeder, `a`, peer,
  `upto_chunk`), so a monotonic `stale` rule replaces an unbounded set of seen receipts.
- **Additive to frozen documents.** Frozen NFX-02 forbids the `split` and `cashu_key` tags in open
  mode (`spec/nfx-02-manifest.md`), so the share and the receipt endpoint get **new** tag names.
  The `quote` and `pay` gain fields that M2 readers ignore (NFX-07 §2), and the frozen `pay1.json`
  and `nfx-pay-wire` stay untouched.
- **NFX-07 §6's "no client-side split logic" stays true for videos without a share.** NFX-14
  states the exception for videos that declare one.

### 5. What it guarantees, and what it does not

- **Guaranteed:** against a seeder that implements NFX-14, the creator's part is delivered before
  the seeder is paid, and neither the seeder nor the watcher can skip it.
- **Not guaranteed:** that a seeder implements NFX-14. A seeder that ignores receipts can serve a
  video that declares a share and keep the whole price. The watcher pays the same either way
  (§3), so default watcher software pays only seeders whose `quote` honours the share. Against
  seeders, the share is enforced by watcher software, as anything is on open videos. Licensed
  videos (ADR 0100) remain the path where the creator controls who serves.
- **Cost:** the receipt endpoint learns which peer paid for which video, through which seeder. The
  mailbox direction of issue #1 has to weigh that too.

### 6. Left to NFX-14

- the share's range and how the manifest states it;
- rounding: the creator's part of each payment, and the carry of what rounds away, per account;
- the creator's mints: the creator's part is paid at a mint the manifest names for the creator,
  which may differ from the seeder's quoted mints;
- the receipt's wire form and the refusal code for a missing or invalid one;
- the adversary suites: replay, withholding, collusion and the burn of a refused token, in both
  engines.

## Consequences

- **Phase 2** (paid NFX, ADR 0101) has no share. A creator chooses per video between "paid on NFX
  without a share" and "legacy-only until Phase 3".
- **Phase 3** writes NFX-14 and implements it in both engines, after NFX-07 freezes.
- A creator who wants the share on NFX runs, or rents, an always-on receipt endpoint until issue #1
  is solved.
- ADR 0100 §1's "free, with zaps" now reads: free with zaps, paid to seeders under NFX-07, or paid
  to seeders with a creator share under NFX-14.
