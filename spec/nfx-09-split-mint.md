# NFX-09 — Split-mint extension (mint API)

**Status: Draft (target freeze: M3)** · form: a Cashu **NUT-extension**-style document;
upstream target: cashubtc once two mints implement it.

Everything a mint must add to serve NFX licensed mode. Written so it can be
implemented as a CDK-mint module by anyone without reading the rest of NFX.

## 1. Advertisement

Mints signal support in NUT-06 mint info:

```json
"nuts": { "3": { … }, "11": { … }, "12": { … } },
"nfx": { "escrow": true, "split_redeem": true,
         "redeem_pubkey": "<33-byte compressed secp256k1 hex>" }
```

(NUT-03, NUT-11 and NUT-12 are the dependencies this extension builds on; their own
advertisement blocks are unchanged.)

`redeem_pubkey` is the key licensed chunk payments are locked to (NFX-08 §4). Its
secret MUST be used for nothing else, and the mint MUST NOT expose any path other than
`redeem` that spends proofs locked to it. That is the whole enforcement of the split.
A mint that rotates `redeem_pubkey` MUST keep redeeming proofs locked to its earlier
redeem keys.

## 2. Endpoints

All endpoints are HTTPS+JSON. Authenticated calls use **NIP-98** (kind 27235 in the
`Authorization: Nostr <b64>` header). Errors: `{ "code": "…", "detail": "…" }` with a
fitting HTTP status (400/402/404/409).

### `POST /v1/nfx/escrow` (creator-authed)

`{ root: hex64, key: hex64 }` → `200 {}` | `409` on key mismatch for existing root.
Stores the bundle. One escrow per `root`; the manifest is the naming authority.

### `POST /v1/nfx/license`

`{ root, payment?: token }` or `{ root, voucher: obj, sig: hex128 }` →
`200 { key }` | `402 { code: "payment-required" }` | `402 { code: "bad-voucher" }`.
Payment = proofs totalling **exactly** `key_price` of the manifest this mint escrows
for `root`; absent payment is `402 payment-required`, short is
`402 { code: "underpaid" }`, over is `402 { code: "overpaid" }` (the
mint never issues change inside this flow). Unknown `root` anywhere: `404
{ code: "unknown-root" }`. Escrow key mismatch: `409 { code: "root-mismatch" }`.

On a paid success the mint accrues the whole `key_price` to the creator, as proofs
P2PK-locked (NUT-11) to the manifest `cashu_key` under `(root, creator)`, exactly like
step 5 of `redeem` (NFX-08 §4). A voucher success accrues nothing.

### `POST /v1/nfx/redeem` (seeder-authed)

`{ root, proofs: [Proof…] }` → `200 { seeder_proofs: [Proof…] }`.

As one atomic operation, the mint:

1. checks every input proof is P2PK-locked to its `redeem_pubkey` as NFX-08 §4
   (difference 3) requires, else `400 { code: "bad-lock" }`;
2. spends them, as a NUT-03 swap would, supplying the `redeem_pubkey` witness itself
   (spent or pending proofs: `400 { code: "spent" }`);
3. splits the amount with the **carry rule** below;
4. returns fresh `seeder_proofs` worth `seeder`;
5. accrues `creator` as proofs P2PK-locked (NUT-11) to the manifest `cashu_key`,
   indexed under `(root, creator)`.

**Carry rule.** The mint keeps one integer `carry[root] ∈ [0, 9999]` per root, shared by
every seeder of that root, starting at 0:

```
c         = 10000 − split_bps                 # creator basis points
units     = amount × c + carry[root]
creator   = floor(units / 10000)
carry'    = units mod 10000                   # persisted atomically with the redemption
seeder    = amount − creator
```

`carry` changes only on a successful redemption, and redemptions of one root are
serialized. The rule telescopes. Suppose all redemptions of a root total `T` sats.
Then the creator receives exactly `floor(T × c / 10000)`, which is less than 1 sat
short of the exact share, however the seeders batch or split their redemptions. The
seeders receive the rest.

**Why one carry per root, not per seeder.** A per-seeder carry resets whenever a seeder
uses a fresh key, and keys are free. A seeder redeeming each 1-sat proof under a new key
would then keep the creator at 0 forever. A single carry per root is sybil-proof.
Individual seeders see at most 1 sat of noise per redemption, and none can steer it.

> **Rounding history.** The 2026-09-16 text imported "seeder rounds up",
> `seeder = ceil(amount × split_bps / 10000)`, from the v0 prototype's ADR 0005 Q1,
> and applied it per redemption. That pays the creator 0 whenever `amount × c < 10000`:
> every 1-sat redemption at any split below 10000, for example. A seeder redeeming
> proof by proof therefore bypassed the split entirely. The prototype found the same
> defect in its own per-PAY split (its ADR 0005 erratum) and fixed it with a carry (its
> ADR 0007). This is that fix, moved to the mint, where the split happens.

A single redemption MAY now return an empty `seeder_proofs`: that happens when
`carry[root] ≥ amount × split_bps`, e.g. a 1-sat redemption at 50/50 with the carry at
5000. That is expected, and seeders MUST NOT treat it as an error. Over a root's
lifetime the seeders together receive `T − floor(T × c / 10000)`, never less than
their exact share.

### `POST /v1/nfx/claim` (creator-authed)

`{ root? }` → `200 { payouts: [{ root, proofs: [Proof…] }] }` and clears them.
With `root`, that video only; omitting sweeps all roots owed to the authed key.

## 3. State and idempotency

- `escrow`: idempotent on identical `(root, key)`.
- `license`: safe to retry; the mint SHOULD issue the same response for the same
  proofs hash within 10 min (clients can drop a response mid-flight).
- `redeem`: NOT idempotent — it moves money — but double-submission of spent proofs
  just fails (`spent`), which is the protection. The proof spend, `carry[root]`, the
  seeder outputs and the creator accrual commit together or not at all.
- `claim`: sweeps; a retried claim after success returns empty payouts.

## 4. Backwards/forwards rules

Unknown fields are ignored (NFX-01 §4 spirit). New endpoints *or* breaking field
changes require a `{ "nfx": { "v": 2 } }` capability flag; no silent upgrades.

## 5. Reference implementation note

Intended as a Rust module against cashu `cdk-mintd`: four tables (`escrow`,
`accruals`, `license_receipts`, `carry`) and HTTP handlers only. No Cashu core behavior is
modified — this extension lives entirely above NUT-03/06/11.

## 6. Open issues (must close before the M3 freeze)

- **Mint state is keyed by a bare `root`.** Escrow can be squatted, and "the
  manifest" is ambiguous once two manifests name one root. See NFX-08 §7.
- **`seeder_proofs` are minted with secrets the mint chose.** The mint (and anyone
  who reads the response) knows them until the seeder swaps. Candidate fix: `redeem`
  takes the seeder's blinded outputs, as NUT-03 does.
- **Fees.** Whose NUT-02 input fees on `redeem` and `license`, and whether they are
  deducted before or after the split.

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
