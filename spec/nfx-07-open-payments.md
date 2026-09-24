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
{ "t": "rej",   "code": "underpaid|overpaid|bad-mint|bad-token|spent|stale|banned|bad-session", "detail": "…" }
```

**Message rules.**
- One JSON object per line, UTF-8, at most 32 KiB including the newline. The object
  follows the value rules of NFX-11 §9: no duplicate keys, no fractions or exponents,
  no lone surrogates.
- `t` selects the message. An unknown `t` is an error; unknown fields are ignored.
- Integers are non-negative and at most 2^53−1, so JavaScript peers read them exactly.
  A writer MUST NOT emit a message its own reader would refuse.
- `session` is exactly 32 lowercase hex characters (128 bits).
- `video` is an NFX video address (NFX-01).
- `price_per_chunk` (in **sat**) and `window` are at least 1. A seeder that serves for
  free does not quote; it serves without pay/1.
- `mints` holds 1 to 16 URLs, each printable ASCII without `\` or `@`, `https://` with
  a non-empty host. `http://` on a loopback host (`127.0.0.1`, `localhost`, `[::1]`) is
  allowed only where a deployment explicitly permits it (tests).
- `upto_chunk` is at least 1: chunks are counted from 1 in admission order (§3).
- `token` is a NUT-00 token string (`cashuA…` or `cashuB…`); its contents are the
  engine's to check (§3).
- A `rej` carries `code`, 1 to 64 characters of `[a-z0-9-]`, and may carry `detail`, at
  most 1 KiB of UTF-8 with no control characters and no bidirectional overrides.
  Unknown codes MUST be tolerated (NFX-11 §6).
- Vectors: `test-vectors/pay1.json`.

**Messages.**
- `hello` (watcher→seeder) opens a session for a video. `quote` (seeder→watcher)
  replies with the *binding* price: the beacon's `price_hint` was advisory. A watcher
  takes one quote per session; a second quote is refused.
- `quote.mints` MUST be non-empty. The seeder accepts proofs only from a mint whose URL
  is **exactly** (byte for byte) one of those quoted, and swaps them at that URL. There
  is no "any mint".
- `window` is the unpaid chunks the seeder tolerates (recommended/default **8**).
- `pay` covers chunks `(last acked, upto_chunk]`. `token` is a NUT-00 token of **one**
  mint, in unit `sat`, whose proofs' face value MUST equal `chunks × price_per_chunk`.
  Input fees (NUT-02) are the seeder's cost: a seeder quoting a mint that charges fees
  prices them in.
  - A `pay` with `upto_chunk` at or below the last `ack.accepted_upto` is **`stale`**
    (replayed or mis-ordered). Reject it without touching the accounting; its proofs are
    not claimed.
  - `upto_chunk` may exceed the chunks admitted so far. Such pre-payment extends service
    by exactly the chunks paid.
- `ack.spent_total` is the face value accepted so far in this session.

## 3. Seeder duties

**Accounting is per (peer, video), not per session.** The peer is the transport's
authenticated identity: the iroh endpoint id on `nfx/pay/1`.
- The unpaid chunks a peer owes for a video persist across its sessions, for as long as
  the seeder keeps the account. A new `hello` continues the account; it never opens a
  fresh window.
- Bans are per peer.
- A `session` id is bound to the peer that first used it. Another peer presenting it is
  refused (`bad-session`), and a seeder caps the sessions one peer may hold.

**Admission.** Every request the seeder serves for a file of the session's video counts
as one chunk **when it is admitted**: whole, ranged or aborted alike. It is counted
atomically, so concurrent requests cannot share a slot. A request for a file of another
video is not admitted under this session. The watcher pays for every chunk it requested.

**Service limit.** The seeder admits a chunk only while:
- the peer's chunks admitted and not covered by a **confirmed** payment number fewer
  than `window`. A payment is confirmed once its NUT-03 swap has succeeded;
- the unpaid chunks across **all** peers stay under the seeder's global cap. Endpoint
  identities are free, so per-peer windows alone would give every new identity a free
  window.

So the seeder's loss is at most `window` chunks per peer and at most the global cap in
total, however swaps are delayed.

**Verifying a `pay`, in order:**
1. **Decode the token.** Unreadable, a unit other than `sat`, more than one mint, proofs
   locked to a spending condition (NUT-10/11/14), or an invalid DLEQ (NUT-12) is
   `bad-token`.
2. **The mint** is exactly a quoted URL, else `bad-mint`.
3. **The face value** exactly covers the new chunks. Short is `underpaid`, over is
   `overpaid`. A product above 2^53−1 is `underpaid`. Never extend credit on a
   miscount.
4. **`ack`** once these local checks pass, then swap at the quoted mint (NUT-03),
   possibly asynchronously. The ack advances `accepted_upto`; only the completed swap
   confirms (see the service limit).
   - A proof found **spent** by the mint means `rej` `spent` if still possible, and the
     peer is banned. Spend detection is by proof, not by token string.
   - A mint that cannot be reached is **not** a ban. The payment stays unconfirmed and
     the swap is retried.

Every refusal leaves the accounting untouched and the proofs unclaimed. A banned peer's
`hello` and `pay` are refused (`banned`), whatever it offers.

For licensed videos, step 4's swap is replaced by the offline checks of NFX-08 §4.1:
chunk proofs there are P2PK-locked and cannot be swapped by the seeder.

Bans are local policy, never global claims: no "bad payer list" events exist.

## 3a. Watcher duties

- Pay for every chunk requested, never ahead of need, and before the unpaid count
  reaches `window`, so the seeder need not stall.
- Refuse a quote above the watcher's price cap, or one naming no mint it holds tokens
  from.
- Check every `ack`: `accepted_upto` and `spent_total` must match what was paid. An
  inconsistent or unsolicited ack stops the watcher paying that seeder.
- **Reclaim** the proofs of a refused payment, and of one never acknowledged within a
  timeout, by swapping them back at the mint before the seeder can. A seeder that
  refuses and then claims gets nothing.

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
- Draft 2026-09-24 (M2.0 independent audit, `docs/nfx/reviews/2026-09-24-m2.0-independent-audit.md`).
  §2: NFX-11 §9 value rules (no duplicate keys); unit sat; one mint per token; stricter
  mint URLs (loopback `http` only where a deployment allows it); `rej.code` charset;
  `detail` without controls; pre-payment defined; `spent_total` defined; one quote per
  session.
  §3 rewritten, because the old text's "loss bounded by `window`" was false:
  - accounting is per (peer, video) and survives sessions;
  - admission counts every request (whole, ranged or aborted) atomically;
  - service is gated on **confirmed** swaps, not acks, and a global unpaid cap bounds
    free service across identities;
  - the verification order is decode, then mint, then amount;
  - new codes `bad-token`, `banned` and `bad-session`;
  - a mint outage is not a ban.
  New §3a, watcher duties, including reclaiming refused or unacknowledged proofs.
