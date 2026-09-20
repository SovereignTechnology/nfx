# NFX-09 — Split-mint extension (mint API)

**Status: Draft (target freeze: M3)** · form: a Cashu **NUT-extension**-style document;
upstream target: cashubtc once two mints implement it.

Everything a mint must add to serve nutflix licensed mode. Written so it can be
implemented as a CDK-mint module by anyone without reading the rest of NFX.

## 1. Advertisement

Mints signal support in NUT-06 mint info:

```json
"nuts": { "3": { … }, "11": { … } },
"nutflix": { "escrow": true, "split_redeem": true }
```

(NUT-03 and NUT-11 are the dependencies this extension builds on; their own
advertisement blocks are unchanged.)

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

### `POST /v1/nfx/redeem` (seeder-authed)

`{ root, proofs: [Proof…] }` → `200 { seeder_proofs: [Proof…] }`.

The mint (1) swaps the input proofs per NUT-03, (2) splits the swept amount by the
manifest's `split` (basis points to seeder; remainder to creator) — split
**rounding: seeder share rounds UP** (ceiling), creator takes the rest; when the
creator's share computes to 0, the creator set is simply empty for that redemption —
(3) returns fresh `seeder_proofs`, and (4) accrues the creator share as proofs
P2PK-locked (NUT-11) to the manifest `cashu_key`, indexed under `(root, creator)`.

> Rounding rule imported from the v0 prototype's L10 finding (ADR 0005 Q1): without
> an explicit rule, a 1-sat redemption at 50/50 makes an honest seeder's set empty and
> fails verification. Formula: `seeder = ceil(amount × split_bps / 10000)`.

### `POST /v1/nfx/claim` (creator-authed)

`{ root? }` → `200 { payouts: [{ root, proofs: [Proof…] }] }` and clears them.
With `root`, that video only; omitting sweeps all roots owed to the authed key.

## 3. State and idempotency

- `escrow`: idempotent on identical `(root, key)`.
- `license`: safe to retry; the mint SHOULD issue the same response for the same
  proofs hash within 10 min (clients can drop a response mid-flight).
- `redeem`: NOT idempotent — it moves money — but double-submission of spent proofs
  just fails NUT-03 (`spent`), which is the protection.
- `claim`: sweeps; a retried claim after success returns empty payouts.

## 4. Backwards/forwards rules

Unknown fields are ignored (NFX-01 §4 spirit). New endpoints *or* breaking field
changes require a `{ "nutflix": { "v": 2 } }` capability flag; no silent upgrades.

## 5. Reference implementation note

Intended as a Rust module against cashu `cdk-mintd`: three tables (`escrow`,
`accruals`, `license_receipts`) and HTTP handlers only. No Cashu core behavior is
modified — this extension lives entirely above NUT-03/06/11.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): exact-amount license payment (`overpaid` code);
  `unknown-root`/`root-mismatch` codes defined; NUT-06 example shows the real
  dependencies (03/11); markdown typo fixed.
