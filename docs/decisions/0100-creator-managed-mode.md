# 100. Funding on standard mints: the keyholder, and two ways to pay a seeder

Date: 2026-09-25

## Status

Proposed (sovtech's model, reached 2026-09-25 across four revisions; this record is
the fourth and replaces the earlier three). Master-plan ADRs are numbered from 0100 so
that a harvest merge of the demo's 0009 onward never collides.

## Context

The suite's paid design (NFX-07/08/09) shares one payment between two parties: the
watcher pays per chunk, and for a licensed video the **mint** splits every redemption
between seeder and creator. Everything hard in that design exists to make a mint
enforce the split: chunk proofs P2PK-locked to a `redeem_pubkey`, offline DLEQ checks
by seeders, an atomic `redeem` with a carry rule, four mint tables, and a "compatible
mint" problem, because no mint anywhere implements NFX-09 and a creator's income would
depend on one that does.

sovtech's requirements:

- payments go to the creator, always;
- seeders are paid for retention and availability, in batches, on a period they pick;
- anyone who watched may seed, without the creator's say-so;
- the creator is paid for everything, so the creator's software is the one verifier,
  and a seeder can prove its work;
- a way for **both** parties to be paid that is simpler than the split.

The answer this record adopts: **pay the two parties for two different things, and
never share one payment.** Then there is nothing to split, nothing to lock, and no
mint needs to know NFX exists.

## Decision

### 1. The keyholder: the creator sells the key

A licensed video's key is sold by a **keyholder**, an HTTPS service the manifest
names. By default it is the creator's own `nfxd`; it may be any host the creator
trusts to hold the key and receive the money (a VPS, or a hosted keyholder someone
else runs). The trust is the escrow mint's trust of NFX-08 §1, moved to a plain web
service that needs no mint code.

`POST {keyholder}/v1/nfx/license` `{ a, watcher: W, payment }`:

- `payment` is an ordinary NUT-00 token from any mint the keyholder lists (the
  manifest carries the list; no "any mint", as NFX-03 §4 already rules), worth
  exactly `key_price`. The keyholder swaps it (NUT-03) before answering. Or a bolt11
  invoice flow, at the keyholder's option.
- `W` is a fresh per-video pubkey the watcher made.
- Success returns the key, `root`, and a **certificate**: a BIP-340 signature over
  `canon({ v: 1, type: "nfx-cert", a, watcher: W, not_after })` by the manifest's
  `cert_key`. `cert_key` is a pubkey the creator names in the manifest for exactly
  this, so a hosted keyholder holds a delegated key, never the creator's identity
  key; the creator may set it to its own key when it runs the keyholder itself.
  `not_after` is required (absent or 0 is an invalid certificate). Vouchers
  (NFX-08 §5) become certificates issued at zero cost.
- **Rules carried over from NFX-08/09, not optional:** `payment` is exact
  (`underpaid`/`overpaid`); the keyholder answers a retried request with the same
  proofs, or the same `W`, with the same response for 10 min, because a response can
  drop after the swap; `keyholder` and each `pay_mints` entry follow the mint URL
  grammar of NFX-07 §2 (`https`, no userinfo; loopback `http` only where a deployment
  allows it), and a manifest violating that is not a valid licensed manifest for M3
  readers, whatever M1 readers ignore. `key_price` 0 is allowed and means a
  registration wall: keys and certificates for free.

The creator has the money in hand when the response leaves. There is no accrual, no
`claim`, no escrow table. **This is the creator's entire income path**, in both
seeder modes below, plus zaps.

Open videos have no keyholder and no key; they are free, with zaps.

### 2. Seeders serve certificate holders

A `hello` on `nfx/pay/1` (NFX-07 §2) carries the certificate and a signature by `W`
over `canon({ type: "nfx-hello", a, session, seeder })`, where `seeder` is the
transport identity the watcher is talking to (the iroh endpoint id, or the peer id on
NFX-10). A certificate alone is bearer; binding `W` to the session **and** the seeder
is what stops a captured `hello` being replayed to another seeder or session. For a
licensed video a seeder serves only a presenter whose certificate verifies against the
manifest's `cert_key`, is not past `not_after`, and whose `hello` signature verifies
under `W`; anyone else gets `refuse`. Verifiers check the `type` field: a certificate
and a voucher are both creator-family signatures over canonical JSON, and the type is
their domain separation. That ends the
leeching of encrypted bytes by non-buyers, an NFX-08 §1 cost the split design could
not close. A watcher sharing its key can still share it; that is physics (NFX-08 §1)
and unchanged.

### 3. `mode`: two ways to pay a seeder

The manifest carries one `mode` tag, chosen at publish. NFX-02 §3 says unknown tags
MUST be ignored, so M1 readers keep parsing and no frozen document is bumped.

**`mode: seeder` (default when absent) — decoupled.** The seeder sells delivery to
the watcher, per chunk, over pay/1 exactly as M2.0 built and audited it: the watcher
pays from its own wallet, at the seeder's `quote`, in tokens of any mint the seeder
names. The creator never touches delivery money and takes no percentage of it.

**`mode: creator` — retainers.** Seeders serve free and are paid by the creator for
holding and serving the video, in batches:

- A willing seeder adds an `ask` to the beacon it already publishes:
  `{ rate, period, mint }`, sats per period (`rate` ≥ 1; `period` 1 h to 30 d;
  `mint` by the NFX-07 §2 URL grammar). The beacon also carries the seeder's iroh
  tickets, so the ask binds the seeder's Nostr key to the transport identities the
  creator will challenge and pay on `nfx/bill/1`; a payout goes only to a peer whose
  transport identity the signed beacon named. The beacon is signed, so the ask is signed. Beacon content admits
  extra fields (NFX-03 §4, `beacon-content.schema.json`).
- The creator **assigns** with a signed `{ a, seeder, rate, period, term }` copying
  the ask. Ask plus assignment is the contract; neither side is bound to terms it did
  not sign. Anyone holding the key may ask, a watcher included; a seeder without the
  key gets a certificate with the assignment.
- Each period the creator's daemon **challenges**: `{ nonce, file, offset, length }`
  for a random file among those the ask claims to hold (a partial seeder is
  challenged on its renditions only), and compares the bytes returned with its own
  copy. A challenge is signed by the creator in `a`, so nobody else can make a seeder
  serve on demand; `length` is 1 to 64 KiB and never 0, `offset + length` is within
  the file, and a seeder answers at most one challenge per file per period, so a
  challenge is neither trivially passed nor a bandwidth drain. The creator holds the files, so verification is a byte comparison against
  sha256-named content: no Merkle proof, no second hash tree, no public randomness.
  It also fetches from the seeder's advertised endpoints under throwaway identities.
- A period that passes is paid `rate` as one ordinary token, from the mint the ask
  named, over `nfx/bill/1` (NDJSON, the framing and message rules of NFX-07 §2).
  One payment per seeder per period; daily is the expected setting.

A creator may run both on one video: retained seeders serve free, volunteers quote a
price, and the watcher's client prefers free beacons (NFX-03 §5 already prefers by
price). A revision may change `mode`; retainers settle to the end of the period in
which the revision was published, then stop.

### 4. Why it is sound, with no new cryptography

- **The seeder cannot cheat the creator.** The creator was paid before a chunk moved
  and never handles delivery money.
- **The watcher cannot cheat the seeder** beyond `window` chunks per account,
  rate-capped seeder-wide: the M2.0 bound, unchanged.
- **The seeder cannot cheat the watcher.** Every byte is verified against the hash
  list (NFX-05), and a lying seeder is paid at most once (M2.0).
- **A retained seeder that stops** loses one period's `rate`; **a creator that stops
  paying** loses one period of service. The seeder chose the period, so it priced
  that bet.
- **Nobody drains anybody by collusion**, because every party pays for what it
  itself receives. There is no shared payment to steer.
- **A retained seeder's claim is checkable by anyone**: the assignment, the challenge
  and the answer are all signatures, so a creator that refuses an honest bill is
  provably in the wrong to whoever the seeder shows it to.

Primitives: XChaCha20-Poly1305 for files (NFX-08 §2, unchanged), BIP-340 signatures
(certificates, asks, assignments, challenges), ordinary bearer ecash (NUT-03 on any
mint). Every one is a library call the suite already makes. No P2PK, no DLEQ checks
by seeders, no split, no carry, no mint extension.

### 5. What it removes, and what it shelves

| Removed from the plan | It existed to |
|---|---|
| NFX-09 as a requirement (escrow, license, redeem, claim, carry, `redeem_pubkey`) | make a mint split per-chunk pay |
| NFX-08 §3 escrow at a mint; §4 differences 1–3; §4.1 offline verification; `bad-lock` | same |
| "compatible mints" as a concept | same |
| the `split` and `cashu_key` tags' meaning (still required by frozen NFX-02 for licensed videos; carried and ignored, and this record says so) | same |

NFX-09 is **shelved as a Draft**, not deleted: a mint operator who someday wants to
sell "the creator takes X % of delivery" as a service has the design, with its carry
rule and its audit history. Nothing above depends on it.

**Delivery receipts** (the creator paying seeders per delivery, bounded by
`delivery_share × key_price` per certificate) were the third revision of this record.
They are sound and they bolt onto §2's certificate without changing anything above;
they are deferred until flat retainers prove insufficient for popular videos.

### 6. Trust statement

- **The keyholder** sees the key and receives the money. By default it is the
  creator. A hosted keyholder is the old escrow mint's trust in a plain web service.
- **Mints** are ordinary. Any NUT-03 mint with NUT-07, 09, 12 and 13 serves every
  role; none needs to know NFX exists.
- **The creator** must run a node for sales (always, for a licensed video) and for
  retainers (once per period). A creator that publishes and leaves can sell keys only
  through a hosted keyholder, and can pay no retainers.
- **The creator learns one fresh pubkey per licensed watcher, per video.** Who bought
  a license is not anonymous to the creator; it is not linkable across videos.
- **Retainers prove possession before a deadline, not a unique copy**; several
  identities may share one disk, and an auditor's fetches can be fingerprinted by IP.
  Both are stated, not solved. Sybils on retainers are the creator's policy: it pays
  only whom it assigns.

### 7. What changes where

| Document | Change | Frozen? |
|---|---|---|
| NFX-02 | changelog: `mode`, `keyholder` (URL), `pay_mints` (list), `cert_key` (pubkey); `split`/`cashu_key` carried and ignored (`cashu_key` may be any valid point, e.g. `cert_key`) | yes; additive, no bump |
| NFX-03 | `ask` beacon content field | yes; additive |
| NFX-07 | `hello` carries a certificate; licensed pointer now to the keyholder | Draft (M2) |
| NFX-08 | §3 escrow → the keyholder; §4 becomes the license call above; §4 differences 1–3 and §4.1 removed; §5 vouchers → certificates; §6 removed | Draft (M3) |
| NFX-09 | status: shelved Draft, with a note pointing here | Draft |
| NFX-13 (new) | `mode: creator`: asks, assignments, challenges, `nfx/bill/1`, the bounds of §4 | new Draft |
| NFX-11 | ALPN `nfx/bill/1`, the keyholder HTTP surface, codes, vectors | Living |
| `generate.py` | vectors: certificate, ask, assignment, challenge, bill | — |

Money code (the keyholder, the pay/1 engine, the biller and payer) stays under the
locked-directory rule of ADR 0008 §4.

### 8. Milestones

- **M2** is unchanged: open, `mode: seeder`, pay/1 on every transport, any mint.
- **M3** becomes: the keyholder and certificates (licensed, `mode: seeder`), then
  `mode: creator`. It needs no mint work, so it is smaller than the M3 of ADR 0008 §5.

### 9. The two modes side by side, at publish

| At publish | `mode: seeder` (default) | `mode: creator` |
|---|---|---|
| Creator sets | `license`; if licensed `key_price`, `keyholder`, `pay_mints`; optional `price_hint` | the same |
| Watcher pays | licensed: `key_price` to the keyholder, then per chunk to seeders from its own wallet; open: per chunk only | licensed: `key_price` to the keyholder, nothing else; open: nothing |
| Seeder paid by | the watcher, per chunk, at its own `quote` (M2.0) | the creator, per period, at its own `ask` |
| Who can seed | anyone with the key (certificate holders only are served) | anyone with the key who asks and is assigned; volunteers may also serve free |
| Verifies | seeder checks tokens; watcher checks bytes | creator's daemon checks challenges; watcher checks bytes |
| Creator's downside | none | retainers it chose, one period at risk |
| Seeder's downside | ≤ `window` unpaid chunks per account | one period's `rate` |
| Creator online | for key sales only (or a hosted keyholder) | for key sales and once per period |
| Mint needs | standard | standard |
| Cold retention | none | yes |

### 10. Paths considered, and why they fell

Recorded so nobody re-derives them.

| Model | Watcher pays | Sound because | Fell because |
|---|---|---|---|
| Free + zaps (M1) | nothing | nothing to protect | creators unpaid |
| Open, seeder-managed (NFX-07) | seeder per chunk | the watcher pays for its own lies; `window` bounds the seeder | creator gets nothing enforceable; kept as `mode: seeder` on open videos |
| **Decoupled** (this record, `mode: seeder`) | key + seeder per chunk | two products, nothing shared | — |
| **Retainers** (this record, `mode: creator`) | key only | one period at risk each side; creator verifies against its own copy | — |
| Delivery receipts | key only; the creator pays per delivery | receipts count only from certified keys, capped at `delivery_share × key_price` per key, so colluders always lose | more money code than retainers need; deferred. Full design: commit `bb3618e` of this file |
| Split mint (NFX-08/09 as drafted) | key + one token per window, locked to the mint | P2PK to `redeem_pubkey`, atomic split with carry | needs a custom mint module nobody runs; "compatible mints" would be ours only; shelved |
| Two-token split, no mint code | one token to the seeder, one P2PK to the creator | the creator's part is unstealable | nobody is obliged to deliver it: a seeder drops it at no cost |
| Pledge to unlock | refundable pledges until a target | NUT-11 refund locktimes make an assurance contract | refund race after locktime; nothing moves before a target; not the model wanted |
| Pooled watcher pass | a period pass split by watch time | economics only | pool steering by fake watchers and seeders; not sound |
| Mint-verified retention (this record's first draft) | key; the creator funds a pool at the mint | mint checks storage proofs | needed a creator-signed sha256→BLAKE3 mapping (NFX-05 names files by sha256, bao proofs verify BLAKE3 roots) and public randomness; the creator holding the bytes needs neither |

Two constraints shaped every row. A **new Nostr kind** was ruled out because frozen
NFX-04 §1 makes scoped relays refuse every kind but 38504, 20464 and NIP-09
deletions, so anything new rides existing events as additive fields. And the mint
requirements per mode are: `mode: seeder` and `mode: creator` alike need only a
standard mint (NUT-03, 07, 09, 12, 13; NUT-11 nowhere), which our testnet mint
(`cdk-mintd` 0.18.1) already is; only
the shelved split needed a module.

## Consequences

- Creators are paid for everything they sell, in hand, on any mint, with no custom
  mint anywhere in the system.
- Seeders are paid either by the watcher per chunk (already built) or by the creator
  in batches on their own schedule, with proof in hand.
- The suite loses a mint extension and gains one small document (NFX-13) and one
  HTTP surface (the keyholder). No frozen document is bumped.
- The M2.0 pay/1 work ships as planned and is the whole of `mode: seeder`.

## Open questions for sovtech

1. Keyholder payment: ecash only, or bolt11 as well (needs a Lightning backend at the
   keyholder)?
2. Certificate lifetime: bound to the license forever, or `not_after` renewable at
   zero cost (lets a creator revoke by not renewing)?
3. Whether `mode: creator` ships in M3 with the keyholder, or as M3.5 after it.
4. ADR numbering from 0100 on the master-plan side (this record).
