# NFX-07 — Payments, open mode

**Status: Draft (target freeze: M2)** · depends on NFX-01/02/03/05/06

Open mode: segments unencrypted; the manifest's `license` is `open`. Watchers pay
**seeders** per delivered chunk in Cashu ecash; creators earn from **zaps** (NIP-57)
on the manifest — the design's honest position is that open bytes can't be
payment-enforced after release, so no mechanism pretends otherwise.

## 1. Where payments flow

- **iroh**: separate connection, ALPN `nfx/pay/1`, newline-delimited JSON (NDJSON),
  one message ≤ 32 KiB.
- **HTTPS origins**: request/response headers (§4).

## 2. Messages (iroh channel)

```json
{ "t": "hello", "video": "nfx:mainnet:1:…", "session": "<128-bit hex>" }
{ "t": "quote", "price_per_chunk": 1, "mints": ["https://mint.example"], "window": 8 }
{ "t": "pay",   "upto_chunk": 17, "token": "cashuB…" }
{ "t": "ack",   "accepted_upto": 17, "spent_total": 17 }
{ "t": "rej",   "code": "underpaid|bad-mint|spent|stale", "detail": "…" }
```

**Message rules.**
- One JSON object per line, UTF-8, at most 32 KiB including the newline.
- `t` selects the message. An unknown `t` is an error; unknown fields are ignored.
- Integers are non-negative and at most 2^53−1, so JavaScript peers read them exactly.
- `session` is exactly 32 lowercase hex characters (128 bits).
- `video` is an NFX video address (NFX-01).
- `price_per_chunk` and `window` are at least 1. A seeder that serves for free does not
  quote; it serves without pay/1.
- `mints` holds 1 to 16 URLs. Each is `https://`, or `http://` on a loopback host (tests
  only).
- `upto_chunk` is at least 1: chunks are counted from 1 in delivery order.
- `token` is a NUT-00 token string (`cashuA…` or `cashuB…`); its contents are the
  engine's to check (§3).
- A `rej` carries `code` and may carry `detail` (at most 1 KiB). Unknown codes MUST be
  tolerated (NFX-11 §6).
- Vectors: `test-vectors/pay1.json`.

- `hello` (watcher→seeder) opens accounting for a video; `quote` (seeder→watcher)
  replies with the *binding* price (the beacon `price_hint` was advisory). `quote.mints`
  MUST be non-empty, and the seeder accepts proofs only from mints it quoted
  (`bad-mint`); there is no "any mint".
  `window` = unpaid chunks the seeder tolerates (recommended/default **8**).
- `pay` covers chunks `(last_ack, upto_chunk]`; `token` is a NUT-00 token whose proofs'
  total MUST equal `chunks × price_per_chunk`. A `pay` with `upto_chunk` less than or
  equal to the last successful `ack.accepted_upto` is **`stale`** (replayed or
  mis-ordered): reject it without touching accounting; its proofs are not claimed.

## 3. Seeder duties (verification, in order)

1. amount exactly covers the new chunks: short is `underpaid`, over is `overpaid`,
   and a product that overflows is `underpaid`; never extend credit on miscount;
2. proofs well-formed per NUT-00, from a mint in its accepted set (`bad-mint`);
3. offline DLEQ check when present; then **async NUT-03 swap** at the mint; a spent
   or failed proof → `rej` `spent`, stop serving, ban the session identity;
4. `ack` only after local checks pass (the swap may finish async; loss on mint failure
   is bounded by `window`).

For licensed videos, step 3 is replaced by the offline checks of NFX-08 §4.1: chunk
proofs there are P2PK-locked and cannot be swapped by the seeder.

A seeder exceeding `window` unpaid chunks MUST stop serving that session. Bans are
local policy; never global claims (no "bad payer list" events exist).

## 4. HTTPS (origin) payment surface

- `GET /<sha256>` with header `X-NFX-Pay: cashuB…` (token covering this chunk).
- Paying sessions open with `X-NFX-Session: <16–32 lowercase hex chars>` on the
  first request, client-chosen per (video, play); all counters are per session id.
  Absent session → the request is anonymous: the origin MUST either require exact
  per-chunk payment on every request, or serve gratis — never grant credit.
- Response: `200` + `X-NFX-Accepted: <chunks credited so far in this session>`.
- Payment required but absent/insufficient: `402` with `X-NFX-Price: <sat>` and
  `X-NFX-Mints: <comma list>` (non-empty; proofs from other mints are refused). Origins MAY serve gratis (`price_hint` 0 or `free`
  beacons) — the website's ad/default mode is exactly this (origin at price 0).

## 5. Creator income in open mode

- Zaps target the manifest event directly (NIP-57). Nothing NFX-specific.
- `price_hint` exists so volunteering seeders can quote sanely; it never restricts
  any seeder's `quote`.

## 6. What this document forbids

- Payments as nostr events (volume + latency; keep nostr out of the money path).
- Lightning invoices per chunk (too heavy; ecash streams batch at redemption).
- Any client-side split logic — there is nothing to split in open mode.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): `stale` now has a defined trigger;
  `X-NFX-Session` gives HTTP counters an identity (previously uncorrelated).
- Draft 2026-09-23 — wire token `nfx`: ALPN `nfx/pay/1`, headers `X-NFX-*` (ADR 0008
  §2). Licensed-mode pointer to NFX-08 §4.1. Open issue on `accepts_mints` (§7).
- Draft 2026-09-23 (sovtech's decision, ADR 0008 addendum): `quote.mints` and
  `X-NFX-Mints` are non-empty and binding. The `accepts_mints` open issue is closed and
  §7 removed.
- Draft 2026-09-24 (M2.0). §2 message rules: size, `t`, integer range, `session`,
  `mints`, `price_per_chunk`/`window` ≥ 1 (free seeders do not quote), `upto_chunk` ≥ 1,
  `token` prefix, `rej.detail`. §3: over-payment is `overpaid` (the exact-amount rule).
  New vectors `pay1.json`.
