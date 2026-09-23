# NFX-09 — Split-mint extension (mint API)

**Status: Draft (target freeze: M3)** · form: a Cashu **NUT-extension**-style document;
upstream target: cashubtc once two mints implement it.

Everything a mint must add to serve NFX licensed mode. Written so it can be
implemented as a CDK-mint module by anyone without reading the rest of NFX.

## 1. Advertisement

Mints signal support in NUT-06 mint info:

```json
"nuts": { "3": { … }, "8": { … }, "11": { … }, "12": { … } },
"nfx": { "escrow": true, "split_redeem": true,
         "redeem_pubkey": "<33-byte compressed secp256k1 hex>" }
```

(NUT-03, NUT-08, NUT-11 and NUT-12 are the dependencies this extension builds on;
their own advertisement blocks are unchanged. NUT-08 contributes only its blank-output
mechanism, used by `redeem`.)

`redeem_pubkey` is the key licensed chunk payments are locked to (NFX-08 §4). Its
secret MUST be used for nothing else, and the mint MUST NOT expose any path other than
`redeem` that spends proofs locked to it. That is the whole enforcement of the split.
A mint that rotates `redeem_pubkey` MUST keep redeeming proofs locked to its earlier
redeem keys.

## 2. Endpoints

All endpoints are HTTPS+JSON. Authenticated calls use **NIP-98** (kind 27235 in the
`Authorization: Nostr <b64>` header).
- The NIP-98 event MUST carry the `payload` tag: the sha256 of the exact request body.
- Mints reject authentication without it, or with a mismatched one. Without the tag, a
  captured header could be replayed with a different body within NIP-98's time window.

Errors: `{ "code": "…", "detail": "…" }` with a fitting HTTP status (400/402/404/409).

**Every endpoint names a video by its manifest address**,
`a = "38504:<creator-pubkey>:<namespace>:<video-id>"`, never by `root` alone. Roots are
public, so anyone could copy one into a manifest of their own. The creator in `a` is the
only party the mint treats as that video's owner, and "the manifest" always means the
one at `a`.

**Fees come off the top.** The only fee a mint deducts under this extension is the
NUT-02 input fee of the proofs it receives (the `input_fee_ppk` of their keysets).
- On `redeem` it is deducted **before** the split, so creator and seeder bear it in
  proportion.
- On `license` the watcher pays exactly `key_price`, so the fee is deducted from the
  creator's accrual.
- A mint MUST NOT deduct anything else under this version. Any other fee needs a
  capability flag (§4).

### `POST /v1/nfx/escrow` (NIP-98 by the creator in `a`)

`{ a, root: hex64, key: hex64 }` → `200 {}` | `409 { code: "root-mismatch" }`.

The mint checks that the NIP-98 signer is the creator named in `a`, and that a manifest
at `a` (from its own lookup, or a signed one presented in a `manifest` field) names this
mint and carries this `root`. It then stores `a → (root, key)`.
- One escrow per `a`.
- The same `a` with a different `root` or `key` is `409 root-mismatch`. NFX-02 §2
  forbids reusing a video-id for different content.
- An impostor can only escrow under their own address, which no honest manifest names.

### `POST /v1/nfx/license`

Paid: `{ a, payment: token }`. Free: `{ a, voucher: obj, sig: hex128 }` **with NIP-98 by
the voucher's `seeder`**.

Responses:

| Case | Response |
|---|---|
| Success | `200 { key, root }` |
| No payment and no voucher | `402 { code: "payment-required" }` |
| Payment short of `key_price` | `402 { code: "underpaid" }` |
| Payment over `key_price` | `402 { code: "overpaid" }` (the mint never issues change inside this flow) |
| Voucher fails any check | `402 { code: "bad-voucher" }` |
| No escrow for `a` | `404 { code: "unknown-video" }` |

Payment is proofs totalling **exactly** the manifest's `key_price`.

On a paid success the mint accrues `key_price − fee` to the creator. If
`fee ≥ key_price` it accrues nothing, so creators SHOULD set `key_price` well above the
mint's input fee. The accrual is made as proofs
P2PK-locked (NUT-11) to the manifest `cashu_key` under `a`, exactly like step 6 of
`redeem` (NFX-08 §4). A voucher success accrues nothing.

### `POST /v1/nfx/redeem` (seeder-authed)

`{ a, proofs: [Proof…], outputs: [BlindedMessage…] }` →
`200 { signatures: [BlindSignature…], amount, fee, seeder, creator }`.

`outputs` are **blank outputs** in the sense of NUT-08: blinded messages the seeder made
from its own secrets, whose amounts the mint assigns. The seeder cannot know its exact
share in advance (the carry below moves it by up to 1 sat), so it sends at least
`max(1, ceil(log2(sum(proofs) + 1)))` of them.

As one atomic operation, the mint:

1. checks every input proof is P2PK-locked to its `redeem_pubkey` as NFX-08 §4
   (difference 3) requires, else `400 { code: "bad-lock" }`;
2. spends them, as a NUT-03 swap would, supplying the `redeem_pubkey` witness itself
   (spent or pending proofs: `400 { code: "spent" }`);
3. computes `amount = sum(proofs) − fee`, where `fee` is their NUT-02 input fee. If
   `amount ≤ 0` it rejects with `400 { code: "below-fee" }` before step 2 commits;
   seeders batch redemptions to avoid this;
4. splits `amount` with the **carry rule** below;
5. signs the seeder share onto the seeder's blank outputs, decomposed into denominations
   as NUT-08 does. It returns those signatures with NUT-12 DLEQ proofs, and leaves unused
   outputs unsigned. **The mint never learns the seeder's secrets.**
6. accrues `creator` as proofs P2PK-locked (NUT-11) to the manifest `cashu_key`,
   indexed under `a`. The mint knows those secrets, but only the creator's key can
   spend them.

**Carry rule.** The mint keeps one integer `carry[a] ∈ [0, 9999]` per video, shared by
every seeder of that video, starting at 0:

```
c         = 10000 − split_bps                 # creator basis points
units     = amount × c + carry[a]             # amount is net of fees
creator   = floor(units / 10000)
carry'    = units mod 10000                   # persisted atomically with the redemption
seeder    = amount − creator
```

`carry` changes only on a successful redemption, and redemptions of one video are
serialized. The rule telescopes. Suppose all redemptions of a video total `T` sats net
of fees. Then the creator receives exactly `floor(T × c / 10000)`, which is less than
1 sat short of the exact share, however the seeders batch or split their redemptions.
The seeders receive the rest.

**Why one carry per video, not per seeder.** A per-seeder carry resets whenever a
seeder uses a fresh key, and keys are free. A seeder redeeming each 1-sat proof under a
new key would then keep the creator at 0 forever. A single carry per video is
sybil-proof. Individual seeders see at most 1 sat of noise per redemption, and none can
steer it.

> **Rounding history.** The 2026-09-16 text imported "seeder rounds up",
> `seeder = ceil(amount × split_bps / 10000)`, from the v0 prototype's ADR 0005 Q1,
> and applied it per redemption. That pays the creator 0 whenever `amount × c < 10000`:
> every 1-sat redemption at any split below 10000, for example. A seeder redeeming
> proof by proof therefore bypassed the split entirely. The prototype found the same
> defect in its own per-PAY split (its ADR 0005 erratum) and fixed it with a carry (its
> ADR 0007). This is that fix, moved to the mint, where the split happens.

A single redemption MAY sign no seeder output at all. That happens when
`carry[a] ≥ amount × split_bps`, e.g. a 1-sat redemption at 50/50 with the carry at
5000. That is expected, and seeders MUST NOT treat it as an error. Over a video's
lifetime the seeders together receive `T − floor(T × c / 10000)`, never less than their
exact share of the net.

### `POST /v1/nfx/claim` (NIP-98 by a creator)

`{ a? }` → `200 { payouts: [{ a, proofs: [Proof…] }] }` and clears them. With `a`, that
video only (the signer must be its creator); without it, every video owed to the
signer.

## 3. State and idempotency

- `escrow`: idempotent on identical `(a, root, key)`.
- `license`: safe to retry. The mint SHOULD issue the same response for the same
  proofs hash (or the same voucher and presenter) within 10 min, because clients can
  drop a response mid-flight.
- `redeem`: NOT idempotent, because it moves money. Double-submission of spent proofs
  just fails (`spent`), which is the protection. The proof spend, `carry[a]`, the
  signatures and the creator accrual commit together or not at all.
- `claim`: sweeps; a retried claim after success returns empty payouts.

## 4. Backwards/forwards rules

Unknown fields are ignored (NFX-01 §4 spirit). New endpoints, new fees, or breaking
field changes require a `{ "nfx": { "v": 2 } }` capability flag. There are no silent
upgrades.

## 5. Reference implementation note

Intended as a Rust module against cashu `cdk-mintd`: four tables (`escrow`, `accruals`,
`license_receipts`, `carry`), all keyed by `a`, and HTTP handlers only. No Cashu core
behavior is modified; this extension lives entirely above NUT-03/06/08/11/12.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): exact-amount license payment (`overpaid` code);
  `unknown-root`/`root-mismatch` codes defined; NUT-06 example shows the real
  dependencies (03/11); markdown typo fixed.
- Draft 2026-09-23 — wire token `nfx` (NUT-06 key `"nfx"`, ADR 0008 §2). Plan
  amendment 3: `redeem_pubkey` advertised, and `redeem` spends only proofs locked to it
  (`bad-lock`). The mint-side **carry rule** replaces per-redemption ceiling rounding,
  which let a seeder zero the creator's share by redeeming 1-sat proofs one at a time.
  Plan amendment 4: `key_price` accrues to the creator. NUT-12 listed as a dependency
  (seeders check DLEQ offline). Open issues listed (§6).
- Draft 2026-09-23 (sovtech's decisions after A1; ADR 0008 addendum). **Keyed by
  manifest address `a`**, not `root`: escrow needs NIP-98 by the creator in `a`, which
  ends root squatting; `unknown-root` becomes `unknown-video`. **Fees come off the
  top:** only NUT-02 input fees, before the split on `redeem` and from the creator's
  accrual on `license`; new code `below-fee`. **`redeem` takes the seeder's blank
  outputs** (the NUT-08 mechanism), so the mint never learns the seeder's secrets. The
  voucher path of `license` requires NIP-98 by the voucher's seeder, and every NIP-98
  auth must carry the `payload` body hash (replay binding). The open issues are closed
  and §6 is removed.
