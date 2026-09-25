# 100. Two funding modes at publish: seeder-managed and creator-managed

Date: 2026-09-25

## Status

Proposed (sovtech's model, stated 2026-09-25; this record writes it down for sovtech's
review). Master-plan ADRs are numbered from 0100 so that a harvest merge of the demo's
0009 onward never collides.

## Context

The suite pays seeders from the watcher's wallet, per delivered chunk (NFX-07), and in
licensed mode the mint splits each redemption between seeder and creator (NFX-08/09).
That is one funding model, and it puts the watcher and the seeder on the money path
together, which is where the M2.0 audits found most of their 161 gaps: every lie a
watcher or seeder can tell about a delivery has to be priced so that the liar pays.

sovtech wants a second model available at publish time, chosen per video:

- watchers pay **the creator, and only the creator**;
- seeders are paid **by the creator, in batches**, on a period each seeder picks;
- a seeder earns for **delivering** (what a watcher would have paid it in the first
  model) and, if the creator hires it, for **retention and availability** over time;
- **anyone who watched may seed**, without the creator's say-so, and be paid the same
  way;
- because the creator is paid for everything, **the creator's software is the one
  verifier**, and a seeder holds proof of its work that anyone can check.

The question this record answers is whether that is cryptographically sound, what it
costs, and what changes where.

## Decision

### 1. `mode` is a manifest tag, chosen at publish

A manifest MAY carry one `mode` tag: `seeder` or `creator`. Absent means `seeder`.
NFX-02 §3 says unknown tags MUST be ignored, so M1 readers keep parsing; they see a
plain open or licensed video, and since every creator-managed seeder beacons
`free: true`, an M1 client never pays one. NFX-02 stays Frozen; this is a changelog
line, not a `specver` bump.

`mode` is orthogonal to `license`. All four combinations are meaningful:

| | `seeder` | `creator` |
|---|---|---|
| `open` | NFX-07 as built (M2.0) | free video; the creator pays retention only (§4) |
| `licensed` | NFX-08/09 as drafted | watchers pay the creator; seeders bill deliveries and retention (§3, §4) |

A revision may change `mode`. Bills and retainers of the old mode are settled to the
end of the period in which the revision was published, then stop.

### 2. Seeder-managed mode is NFX-07/08/09, unchanged

Nothing in this record edits the seeder-managed path. The M2.0 work on
`m2/contracts` is that mode's implementation and continues to its push and its
security stage on its own plan. The names are new; the design is not.

### 3. Creator-managed mode: one payee, one verifier

**Watchers pay the creator.** For a licensed video that is `key_price` at the video's
mint, accrued P2PK-locked to `cashu_key` and collected by `claim` (NFX-08 §4, §6),
exactly as today. For an open video watchers pay nothing. No watcher ever sends a
seeder a token: a client in this mode MUST NOT open `nfx/pay/1` for payment or send
`X-NFX-Pay`, whatever a beacon or quote says. The manifest's `mode` wins.

**Seeders bill the creator for deliveries.** Delivery runs on the pay/1 session
machinery of NFX-07 unchanged, with one substitution: where a watcher would send a
Cashu token in `pay`, it sends a **receipt**, a BIP-340 signature over
`canon({ a, seeder, upto_chunk })` by the watcher's license key (below). The seeder's
window, accounting, bans and bounded state are exactly NFX-07 §3; it stops serving when
receipts lag, as it stops today when payments lag. The adversary suite's 62 scenarios
apply with the instrument swapped.

**A receipt has weight only from a licensed key.** When a watcher buys a license it
sends a fresh, per-video pubkey `W` in the `license` request, and the mint's response
carries a **license certificate**: the mint's signature over `canon({ a, W })`. The
watcher presents it in `hello`; a seeder serves only certificate holders (which also
ends the leeching of encrypted bytes by non-buyers, an NFX-08 §1 cost until now). The
creator honours only receipts whose `W` is certified, and the mint lists certified `W`
per `a` to the creator alongside `claim`.

**The bill is bounded per key sold.** The manifest carries `delivery_price` (sats per
chunk the creator pays for a delivery) and `delivery_share` (basis points of
`key_price`). Receipts naming watcher `W` are paid across all seeders, first
submitted first paid, until `delivery_share × key_price / 10000` sats have been paid
for `W`; the rest of `W`'s receipts are worth nothing. Per key sold the creator keeps
at least `(1 − delivery_share) × key_price` and pays out at most the rest.

**Why that is sound.** A watcher and a seeder that collude pay `key_price` in and take
at most `delivery_share × key_price` out: a certain loss, however many identities
they make, because each identity must buy a key. The creator can never pay out more
than it took in. An honest seeder is paid for real deliveries to real buyers. No proof
of storage, no audit and no third party is needed on this path; it bounds itself.

**Batched.** Each seeder names a `period` (1 h to 30 d). At the end of each of its
periods it submits its receipts on `nfx/bill/1`, an NDJSON channel with the framing and
message rules of NFX-07 §2, to the creator's node. The creator's daemon verifies every
receipt (signature, certificate, chunk range against its own ledger of what that `W` has
already been paid for) and answers with one Cashu token from the video's mint. One
payment per seeder per period; a seeder's bill for a period is settled once. Daily is
the expected setting.

### 4. Retention and availability: the creator hires seeders

Delivery pay follows watching, so nothing above pays anyone to hold a cold video. For
that the creator may hire seeders on a **retainer**:

- A willing seeder adds an `ask` to the beacon it already publishes:
  `{ rate, period, mint }`, sats per period for holding and serving the video. The
  beacon is signed, so the ask is signed. (Beacon content admits extra fields, NFX-03
  §4 and `beacon-content.schema.json`.)
- The creator **assigns** by sending the seeder a signed assignment `{ a, seeder, rate,
  period, term }` copying the ask's terms. Ask plus assignment is the contract; neither
  side is bound to terms it did not sign. A seeder without the key gets a voucher with
  it (NFX-08 §5).
- Each period the creator's daemon **challenges** the seeder: `{ nonce, file, offset,
  length }` for a random file of the hash list, and compares the bytes returned to its
  own copy. The creator holds the plaintext and ciphertext, so verification is a byte
  comparison against sha256-named files; no Merkle proof, no second hash tree, no
  public randomness. It also fetches from the seeder's advertised endpoints under
  throwaway identities. A period that passes is paid `rate` in the same batch as the
  seeder's delivery bill.
- **Retention is the only pay on an open creator-managed video.** With no key sale a
  delivery receipt costs nothing to forge, so open videos have no delivery bills.

**Bounds.** A seeder that stops holding or serving loses one period's `rate`. A creator
that stops paying loses one period of service; the seeder drops the video. That
symmetry is why the seeder picks the period: a long period is a larger bet on the
creator, and the seeder prices it.

**Sybils are the creator's policy, not the protocol's problem.** The creator pays only
whom it assigns, so its outlay is what it chose. A client MAY offer "assign every
asker up to N slots"; the spec says to cap slots and rate when it does. The retainer
proves possession before a deadline, not a unique copy; several identities may share
one disk. That is stated, not solved.

### 5. Trust statement

- **The mint** custodies `key_price` accruals and mints the tokens the creator pays
  with, as today. In this mode it adds one thing: signing license certificates. It
  verifies nothing about deliveries or retention and holds no pool.
- **The creator** is trusted by seeders for one period at a time, and can be shown
  wrong: a seeder's bill is a bundle of third-party-checkable signatures (receipts,
  certificates, answered challenges), so a creator that refuses an honest bill is
  provably dishonest to anyone the seeder shows it to.
- **Watchers** are trusted for nothing. A receipt from an uncertified key is noise; a
  certified key's receipts are capped by what that key paid.
- **The creator must run a node** with a hot wallet, up once per period. `nfxd` is that
  node. A creator that publishes and leaves cannot run this mode; a mint-held pool
  with creator-signed payouts could serve that case later, and is out of scope here.
- **The creator learns one pubkey per licensed watcher**, fresh per video and not
  linkable across videos. Who bought a license is no longer anonymous to the creator.
  That is the price of a receipt weighing anything.

### 6. What changes where

| Document | Change | Frozen? |
|---|---|---|
| NFX-02 | changelog: `mode`, `delivery_price`, `delivery_share` (additive, ignored by M1 readers) | yes, no bump needed |
| NFX-03 | `ask` beacon field | yes, additive content field |
| NFX-07 | a `receipt` instrument in `pay` for creator mode; `hello` carries the certificate | Draft (M2) |
| NFX-08 | `license` takes `watcher`, returns `certificate`; certified-`W` list with `claim` | Draft (M3) |
| NFX-13 (new) | creator-managed mode: receipts, `nfx/bill/1`, retainers, challenges, the bounds above | new Draft |
| NFX-11 | ALPN `nfx/bill/1`, error codes, vectors | Living |
| `generate.py` | vectors: receipt, certificate, ask, assignment, challenge, bill | — |

Money code (the creator daemon's biller and payer, the receipt verifier) is under the
locked-directory rule of ADR 0008 §4 like the rest.

### 7. Milestones

Creator mode depends on licensing for its certificates, so it ships with **M3**
(licensed mode), not before. M2 (seeder-managed open) is unchanged. Open +
creator-managed retention needs no certificate and MAY ship earlier if wanted.

### 8. The two modes side by side, at publish

| At publish | Seeder-managed (`mode: seeder`, default) | Creator-managed (`mode: creator`) |
|---|---|---|
| What the creator sets | `license`; if licensed `key_price`, `split`, `mint`, `cashu_key`; optional `price_hint`, `free_seeder` | the same, plus `delivery_price` and `delivery_share`; `split` is carried and ignored |
| What the watcher pays | licensed: `key_price` to the creator **plus** per chunk to each seeder; open: per chunk to seeders | licensed: `key_price` to the creator, nothing else; open: nothing |
| Who sets the delivery price | each seeder, in its `quote` | the creator, in the manifest |
| How seeders are paid | per chunk, as they serve, in ecash from the watcher; the mint splits with the creator if licensed | in batches from the creator on the seeder's period: receipts for deliveries, plus a retainer if hired |
| Who can seed | anyone | anyone holding the key (bought or vouchered), and anyone the creator hires |
| Who verifies | the seeder checks each token; the mint checks the swap and applies the split | the creator's daemon checks receipts, certificates and challenges |
| Creator's downside | none | at most `delivery_share × key_price` per sale, plus retainers it chose |
| Seeder's downside | ≤ `window` unpaid chunks per watcher, rate-capped seeder-wide | one period's pay |
| Collusion | watcher+seeder drain nobody: the watcher pays for its own lies | watcher+seeder lose: `key_price` in, ≤ share × `key_price` out |
| Watcher anonymity | to everyone | the creator sees one fresh pubkey per licensed watcher per video |
| Creator online | no | once per period |
| Mint needs | NFX-09: escrow, redeem, claim | escrow, claim, license certificate; no split, no redeem |
| Cold retention | none | retainers; the only pay on open videos |

## Consequences

- Creators get a mode in which no watcher money ever passes through a seeder, and in
  which their maximum payout per sale is a number they set.
- Seeders in that mode are paid in batches on their own schedule, with proof in hand,
  and never handle a watcher's token.
- The M2.0 pay/1 work is reused by both modes; the instrument is a token in one and a
  receipt in the other.
- The suite grows one document (NFX-13) and no frozen document is bumped.

## Open questions for sovtech

1. `delivery_price` is set by the creator (the payer), so seeders' asks apply to
   retainers only. Confirm.
2. `delivery_share` default: 5000 (half of every sale may go to delivery) is the
   proposal.
3. Whether the certified-`W` list should reach the creator from the mint (proposed) or
   ride the receipt itself (the watcher attaches the certificate to every receipt, so
   the creator needs nothing from the mint after the sale). The second is more
   self-contained; the first lets the creator refuse a revoked buyer.
4. ADR numbering from 0100 on the master-plan side (this record).
