# NFX-07 — Payments, open mode

**Status: Draft (target freeze: M2)** · depends on NFX-01/02/03/05/06

Open mode: segments unencrypted; the manifest's `license` is `open`. Watchers pay
**seeders** per delivered chunk in Cashu ecash; creators earn from **zaps** (NIP-57)
on the manifest — the design's honest position is that open bytes can't be
payment-enforced after release, so no mechanism pretends otherwise.

## 1. Where payments flow

- **iroh**: separate connection, ALPN `nfx/pay/1`, newline-delimited JSON (NDJSON),
  one message ≤ 32 KiB.
- **HTTPS origins**: request/response headers (§4), one payment per request.

## 2. Messages (iroh channel)

```json
{ "t": "hello", "video": "nfx:mainnet:1:…", "session": "<128-bit hex>" }
{ "t": "quote", "price_per_chunk": 1, "mints": ["https://mint.example"], "window": 8,
  "served": 0, "accepted_upto": 0, "spent_total": 0 }
{ "t": "pay",   "upto_chunk": 17, "token": "cashuB…" }
{ "t": "ack",   "accepted_upto": 17, "spent_total": 17 }
{ "t": "rej",   "code": "underpaid|overpaid|bad-mint|bad-token|spent|stale|banned|bad-session|unknown-video|mint-unavailable", "detail": "…" }
{ "t": "refuse", "file": "<sha256 hex>" }
```

**Message rules.**
- **Lines.** One JSON object per line, UTF-8, at most 32 KiB including the newline.
  The object follows the value rules of NFX-11 §9: no duplicate keys, no fractions or
  exponents, no lone surrogates. No value nests deeper than 16 levels (the message
  object is level 1).
- **Types.** `t` selects the message. An unknown `t` is an error; unknown fields are
  ignored. Integers are non-negative and at most 2^53−1, so JavaScript peers read them
  exactly. A writer MUST NOT emit a message its own reader, under the same options,
  would refuse.
- **`session`** is exactly 32 lowercase hex characters (128 bits).
- **`video`** is an NFX video address (NFX-01).
- **`price_per_chunk`** (in **sat**) is at least 1, and **`window`** is 2 to 64: at
  least 2, so a watcher paying at half the window never stalls the seeder, and at most
  64, so one refusal makes a watcher pay ahead at most 32 chunks (§3a). A seeder that serves for
  free does not quote; it serves without pay/1.
- **`mints`** holds 1 to 16 URLs. A mint URL is:
  - printable ASCII without space, `\` or `@`;
  - `https://`, then a host, then optionally `:` and a port of 1 to 5 digits (1 to 65535);
  - then nothing, or a `/`, `?` or `#` and anything printable.

  The host is either 1 to 253 characters of `[A-Za-z0-9.-]`, or an IPv6 literal: `[`,
  2 to 45 characters of `[0-9A-Fa-f:.]`, then `]`. `http://` on a loopback host
  (`127.0.0.1`, `localhost` or `[::1]`) is allowed only where a deployment explicitly
  permits it (tests).
- **`upto_chunk`** is at least 1. Chunks are counted from 1 per account (§3).
- **`file`** in a `refuse` is 64 lowercase hex characters: a file's sha256.
- **`served`**, **`accepted_upto`** and **`spent_total`** in a `quote` are the account's
  position (§3). A new account quotes 0, 0 and 0.
- **`token`** is `cashuA` or `cashuB` followed by at least one character of
  `[A-Za-z0-9_=+/-]`. What it holds is the engine's to check (§3).
- **`rej`** carries `code`, 1 to 64 characters of `[a-z0-9-]`. It may carry `detail`, at
  most 1 KiB of printable ASCII (U+0020–U+007E). It is a diagnostic for logs and
  screens, and ASCII has no invisible or reordering characters to hide in. Unknown codes
  MUST be tolerated (NFX-11 §6).
- **Delivery.** A transport carrying pay/1 closes a connection on which a message it
  sent has gone unacknowledged for 60 s. So a message reaches its peer within 60 s of
  being sent, or never. The watcher's 180 s wait (§3a) covers the three legs of a
  payment: the `pay`'s delivery, the seeder's 60 s deadline, and the answer's delivery.
- **Vectors:** `test-vectors/pay1.json`.

**Messages.**
- **`hello`** (watcher→seeder) opens a session for a video. A seeder that does not serve
  the video refuses it with `unknown-video`.
- **`quote`** (seeder→watcher) replies with the *binding* price; the beacon's
  `price_hint` was advisory. It also carries the account's position, so a watcher can
  resume after a reconnect. A watcher takes one quote per session and refuses a second.
- **`quote.mints`** MUST be non-empty. The seeder accepts proofs only from a mint whose
  URL is **exactly** (byte for byte) one of those quoted, and swaps them at that URL.
  There is no "any mint".
- **`window`** is the unpaid chunks the seeder tolerates on one account, that is one peer
  and one video (recommended/default **8**).
- **`pay`** covers chunks `(accepted_upto, upto_chunk]` of the account. `token` is a
  NUT-00 token of **one** mint, in unit `sat`, whose proofs' face value MUST equal
  `chunks × price_per_chunk`. Input fees (NUT-02) are the seeder's cost: a seeder quoting
  a mint that charges fees prices them in.
  - A `pay` with `upto_chunk` at or below `accepted_upto` is **`stale`** (replayed or
    mis-ordered). It is refused without touching the accounting, and its proofs are not
    claimed.
  - `upto_chunk` may exceed the chunks served so far. Such pre-payment extends service
    by exactly the chunks paid.
- **`ack`** means the payment's swap has **completed** (§3). `accepted_upto` is the new
  watermark, and `spent_total` is the face value accepted so far on the account.
- **`rej` `mint-unavailable`**: the seeder could not complete the swap in time, and its
  outcome may be unknown. It is not a ban, and nothing was credited by then; a swap that
  lands later is credited if it claimed the proofs (§3).
- **`refuse`** (seeder→watcher): the seeder refused the watcher's request for `file`
  under this session, and served not one byte of it. That is how a refusal is told apart
  from a transfer the watcher aborted, which gets no `refuse`. One `refuse` answers one
  request.

## 3. Seeder duties

**Identity and scope.**
- A **peer** is the identity the transport gives it: the iroh endpoint id on
  `nfx/pay/1`, or the peer id on the WebRTC mesh (NFX-10 §3.2). Identities are free
  to create on every transport.
- An **account** is (peer, video). It numbers that peer's chunks of that video and
  holds its position: `served`, `accepted_upto` and `spent_total`, all per account.
  - It is created by its first admission or payment. A `hello` alone creates nothing,
    and the quote then reports zeros.
  - It persists across the peer's sessions. A new `hello` continues the account; it
    never opens a fresh window.
  - A `hello` for an account with a payment in progress is answered once that payment
    has been answered, at the latest at its deadline (60 s from its arrival). So a quote
    never misses an acknowledged payment. A `hello` waiting so counts toward the peer's
    session cap.
- Bans and the global cap belong to the **seeder**: one set of state for all its
  videos. The window belongs to the account.
- A `session` id names one **open** session. A `hello` naming a session id that is open
  is refused (`bad-session`). A seeder caps the sessions one peer may hold open at once,
  across all videos (recommended 8, also `bad-session`). A session closes with its
  connection.

**Configuration.** A seeder refuses to start outside these:
- `price_per_chunk` 1 to 2^53−1, and 1 to 16 mints, each a valid mint URL (§2): its quote
  must be one the pay/1 writer emits;
- `window` 2 to 64 (§2);
- a global cap of 1 to 1,000,000 unpaid chunks. A larger one bounds nothing (size it as
  below);
- `debt_ttl` 10 min to 24 h (recommended 1 h). A zero one would switch the cap off, and a
  longer one would let a cap filled once lock out new watchers for that long;
- `account_ttl` from `debt_ttl` to 30 days (recommended 24 h). A shorter one would let an
  account be forgotten, and start afresh, while its debt still counted; a longer one
  would void the bound on state below;
- `ban_ttl` from `debt_ttl` to 30 days (recommended 24 h).

**Bounded state.** Identities are free, so everything kept per identity is bounded:
- An account whose `accepted_upto` is 0 (nothing ever paid) may be forgotten once it has
  had no open session for `account_ttl`, counted from its last session's close. An
  account with an open session is never forgotten. A forgotten account's unpaid chunks
  are lost, within the bounds below.
- An account with payments is kept. Forgetting it would contradict the watcher's ledger
  (§3a), which would then stop paying.
- A ban expires after `ban_ttl`, and is recorded only for a peer with an account. A
  peer with none has been served nothing and owes nothing, so a ban would protect
  nothing: its refused `pay` is answered, and nothing is kept for it.
- Hellos waiting for a payment count toward the session cap.
- A seeder SHOULD keep a bounded cache of proofs it has seen spent. It then refuses a
  replayed one (`spent`, with a ban) without asking the mint.

**Admission.** Every request the seeder serves for a file of the session's video
counts as one chunk of the account **when it is admitted**: whole, ranged or aborted
alike. It is counted atomically, so concurrent requests cannot share a slot. A request
for a file of another video is not admitted under this session. A request that is not
admitted is answered with `refuse` naming its file, and not one byte of it is served.

**Service limit.** A chunk is **covered** while its own account's `served` is below
that account's `accepted_upto`, that is, pre-paid. Credit on one video never covers
another. A covered chunk is admitted unless the peer is banned. An uncovered chunk is
admitted only while both of these hold:
- the account's unpaid chunks number fewer than `window`;
- the unpaid chunks admitted by the seeder within the last `debt_ttl`, across **all**
  peers and videos, number fewer than the seeder's global cap. Per-peer windows alone
  would give every new identity a free window. A banned or forgotten peer's unpaid
  chunks still count until they age out. Credit on one account never offsets another's
  debt.

So the seeder's loss is at most the global cap per `debt_ttl`, however many identities
an attacker makes. An account that never pays gets at most `window` chunks, and another
window only once it has been forgotten, after `account_ttl` with no open session. A
peer's open accounts owe at most `window` each. An acknowledged payment is always swapped
(below), so no delay at the mint widens any bound.

A full cap refuses unpaid service, never paid service. A watcher it refuses pays ahead
(§3a), and covered chunks are served whatever the cap. **Size the cap** for the new
watchers expected at once. Each holds up to about `window`/2 unpaid chunks between its
payments, so a cap of C carries about C / (`window`/2) of them before they must pay
ahead.

**Verifying a `pay`.** One account's payments are processed one at a time, in order
of arrival. Bans are checked when a payment's turn comes, not when it arrives. The
checks run in this order:
1. **Structure.** A token is `bad-token` if it is:
   - unreadable;
   - not in unit `sat`;
   - of more than one mint;
   - holding more than 64 proofs (input fees grow with the proof count, and fees are
     the seeder's);
   - holding proofs locked to a spending condition (NUT-10/11/14);
   - holding a proof that lacks a DLEQ proof (NUT-12).
2. **The mint** is exactly a quoted URL, else `bad-mint`. Nothing is fetched from any
   mint before this check.
3. **DLEQ.** Every proof's DLEQ proof verifies against the keys of that quoted mint
   (fetched from it, then cached), else `bad-token`.
4. **The face value** exactly covers the new chunks. Short is `underpaid`, over is
   `overpaid`. A product above 2^53−1 is `underpaid`. Never extend credit on a
   miscount.
5. **Swap, then acknowledge.** All the token's proofs go into one swap (NUT-03) at the
   quoted mint. The swap is atomic, and the seeder never swaps a subset. The account's
   watermark is read again as the swap is sent: a late outcome (below) may have moved it
   during step 3's key fetch. A payment it no longer fits is refused, `stale` or by
   amount, and nothing is swapped.
   - **The swap is not tied to the `pay`'s connection.** If the connection drops, a
     swap that completes is still credited, and the watcher learns of it from a quote.
   - **Outcomes:**
     - on success, `ack`: `accepted_upto` becomes `upto_chunk`, and `spent_total`
       grows by the face value;
     - if any proof is **spent**, `rej` `spent` and ban the peer. Nothing is claimed,
       and spend detection is by proof, not by token string;
     - if the mint refuses the proofs as invalid, `rej` `bad-token` and ban the peer;
     - if the mint cannot be reached, or the outcome stays unknown, `rej`
       `mint-unavailable`. That is not a ban, and nothing is credited.
   - **Retries.** The seeder retries the same swap request (NUT-19) while it still has
     time. A retry answered `spent` may be its own earlier attempt that succeeded
     unseen. The seeder settles that with NUT-09 restore and never bans on it.

   - **Other errors.** Any other swap error, a fee or keyset error of the seeder's own
     making included, is `mint-unavailable`, never a ban.
   - **The deadline.** The seeder answers every `pay` within **60 s of its arrival**,
     that is of the transport receiving it, not of the engine reading it: the wait for
     the account's turn, the key fetch and the swap all count. A payment
     whose outcome the seeder has by then is answered with it, even at the deadline.
     Otherwise it answers `mint-unavailable`, abandons the swap (it sends no further
     swap request for those proofs), and releases the account for its next payment.
   - **Late outcomes.** A swap the seeder has answered `mint-unavailable` for, at the
     deadline or earlier, is still settled when its outcome becomes known. The seeder
     MUST learn it: from a late response, or, when none comes, by NUT-09 restore of its
     own outputs, which it derives deterministically (NUT-13) for this, retried while the
     mint is reachable. A watcher waiting on that payment (§3a) waits on this.
     - A claim is credited to the account, and the watcher's next quote shows it (§3a).
     - A spent or invalid outcome bans nobody.
     - A late outcome is never an `ack`: the payment was already answered.

Every refusal leaves the accounting untouched and the proofs unclaimed, except that
after `mint-unavailable` the swap's outcome may be unknown (§3a says how the watcher
settles that). A banned peer's `hello` and `pay` are refused (`banned`), whatever it
offers, and nothing of it is admitted.

For licensed videos, step 5's swap is replaced by the offline checks of NFX-08 §4.1:
chunk proofs there are P2PK-locked and cannot be swapped by the seeder.

Bans are local policy, never global claims: no "bad payer list" events exist.

## 3a. Watcher duties

- **Keep a ledger per (seeder, video):** chunks requested, `accepted_upto`,
  `spent_total`, and any payment not yet settled. It lasts as long as the watcher's
  identity toward that seeder.
- **Keep one standing per seeder**, shared by that seeder's ledgers:
  - whether the watcher has stopped paying it;
  - reclaims not yet complete;
  - payments awaiting a quote (below);
  - the one payment in flight toward it, a payment a closed session left unsettled
    included;
  - how many `mint-unavailable` answers came in a row.

  Every rule below that says "pays that seeder nothing" holds for all its videos, and any
  of its videos' ledgers does the standing's catching up (the 180 s reclaim below).
- **Take a quote only if it is honest about the account:**
  - its `served` is at most the chunks requested;
  - its `accepted_upto` and `spent_total` equal the ledger, or the ledger plus the
    unsettled payment, which the quote thereby settles as accepted;
  - a quote **below** the ledger is refused, and the watcher never resyncs down to it;
  - a quote above the watcher's price cap is refused, on every session, a resumed one
    included, and so is one naming no mint it holds tokens from;
  - so is a quote whose `window` is above the watcher's own ceiling, at most 64 (§2):
    `window` bounds what one refusal makes it pay ahead.
- **Owe every request sent,** except one the seeder answers with `refuse`. A refused
  request is always un-owed; if it was already paid for, that payment becomes credit. A
  request the watcher abandons stays owed; if the seeder never saw it, the payment
  becomes pre-payment.
- **Pay exactly the quoted price** for requested chunks.
  - Pay before the account's unpaid count reaches `window`, so the seeder need not
    stall.
  - Never pay ahead of need, except right after a refusal. Then pay ahead up to half of
    `window`, less any credit the video's ledger already holds, which the seeder serves
    whatever its cap. Credit on a video never grows beyond half its window, so a seeder
    that refuses everything takes at most half the watcher's ceiling, for each video the
    watcher asks it for.
  - Keep one payment in flight toward a seeder at a time, across its videos.
  - After three `mint-unavailable` answers in a row, pay that seeder nothing more until a
    new session's quote. Each answer costs the watcher a reclaim and a new token at the
    mint, whose input fees are the watcher's; an `ack` resets the count, and nothing else
    does. A watcher SHOULD back off before reopening sessions with a seeder whose
    sessions keep ending so, since each new session restores the three tries.
- **Answers belong to their session.** A `rej` answers the payment sent on its session.
  One that answers no payment is unsolicited, and stops the watcher paying that seeder,
  as an unsolicited `ack` does. A refused `hello` opens no session and answers no
  payment: `banned` stops the watcher, and any other code changes nothing. A payment an
  earlier session left unsettled is settled only by a quote or by the 180 s reclaim
  below.
- **Check every `ack`.** `accepted_upto` must equal the payment's `upto_chunk`, and
  `spent_total` the ledger plus its face value. An inconsistent or unsolicited ack stops
  the watcher paying that seeder.
- **Reclaim the proofs of every refused payment,** whatever the code, known or not, by
  swapping them back at the mint.
  - If the reclaim finds any proof already spent, the payment **awaits a quote**. The
    watcher pays that seeder nothing more until a quote, from a new session and at any
    later time, shows it: `accepted_upto` and `spent_total` both equal to the ledger plus
    the payment, which settles it as accepted. A quote equal to the ledger leaves it
    waiting. Any other quote is dishonest (above).
  - So a seeder that keeps a payment without crediting it has taken that one payment,
    and gets nothing more. This holds whether it refuses and then claims, or answers
    `mint-unavailable` after a swap that went through. A seeder that credits it late (§3)
    loses the watcher nothing.
  - Until the reclaim completes (the mint may be down), the watcher pays that seeder
    nothing more.
  - After `mint-unavailable` the watcher pays again once every proof is confirmed
    reclaimed, or the payment is settled by a quote. After any other code it stops paying
    that seeder.
- **Wait 180 s from sending before reclaiming an unanswered payment**: a leg each for
  the `pay`'s delivery, the seeder's 60 s deadline and the answer's delivery (§2).
  - On a live connection, for the payment sent on it, the seeder was unresponsive: after
    180 s the watcher reclaims and stops.
  - A dropped connection does not shorten the wait. A quote for the payment's video
    settles it as accepted only if its `accepted_upto` **and** `spent_total` both equal
    the ledger plus the payment. Otherwise the watcher reclaims it after 180 s, from
    whichever of the seeder's videos it is still watching, and carries on if every proof
    came back. Until then it is the standing's payment in flight.
  - Either way, a reclaim that finds proofs spent leaves the payment awaiting a quote,
    as above. A `pay` still buffered on a dropped connection can reach the seeder after
    the watcher's next `hello`, and be credited after that session's quote.
- **Pay nothing after stopping,** at the end of a session included. Reclaiming is not
  paying: a stopped watcher still finishes its incomplete reclaims, and reclaims a
  closed session's unsettled payment after the wait.

## 4. HTTPS (origin) payment surface

Every paid request pays for itself. An origin extends no credit, keeps no counters and
therefore loses nothing:

- `GET /<sha256>` with header `X-NFX-Pay: cashuB…`, a token worth exactly one chunk at
  the origin's price.
- The origin runs the checks of §3 (structure, mint, DLEQ, exact amount), swaps, and
  only then responds:
  - `200` with the file once the swap has succeeded;
  - `402` with `X-NFX-Price: <sat>` and `X-NFX-Mints: <comma list>` (non-empty; proofs
    from other mints are refused) when payment is missing or refused;
  - `503` when the mint cannot be reached.

  On any refusal the client reclaims its proofs, as in §3a. After a `503` it pays again
  only once every proof is confirmed reclaimed, and a proof found spent means that
  payment is lost.
- Bans do not apply: the payer is anonymous, and spent proofs simply earn a `402`.
- Origins MAY serve gratis (`price_hint` 0 or `free` beacons). The website's ad/default
  mode is exactly this (origin at price 0).

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
- Draft 2026-09-24 (M2.0 second audit, `docs/nfx/reviews/2026-09-24-m2.0-second-audit.md`).
  **The seeder swaps before it acks**, so an ack means the payment is confirmed. The
  answer deadlines are 60 s for the seeder and 120 s for the watcher. New code
  `mint-unavailable`.
  - §2:
    - `quote` carries the account's position (`served`, `accepted_upto`,
      `spent_total`), so a watcher can resume;
    - `spent_total` is per account;
    - the mint URL authority is parsed;
    - `token` is base64 after its prefix, `detail` refuses a listed set of invisible
      characters, and nesting is limited to 16 levels;
    - `window` is one value per seeder.
  - §3:
    - windows, bans and the global cap are seeder-wide, and the window is per peer
      across its videos;
    - covered (pre-paid) chunks are served whatever the cap;
    - unpaid chunks count toward the cap for `debt_ttl`, so the bound is a rate;
    - sessions are counted while open, and accounts may be forgotten after
      `account_ttl`;
    - payments on one account are serialised;
    - new verification order: structure, mint, DLEQ, amount, swap;
    - a missing DLEQ, or a proof the mint calls invalid, is `bad-token`, and the
      invalid proof is also a ban;
    - swaps are atomic.
  - §3a: a ledger across sessions; quotes checked against it; refused requests are not
    owed; reclaim after every refusal code; a failed reclaim means the payment was lost,
    not repaid.
  - §4: one payment per request, swapped before the response. No sessions, no credit,
    no counters.
- Draft 2026-09-24 (M2.0 third audit, `docs/nfx/reviews/2026-09-24-m2.0-third-audit.md`).
  - §2: `window` ≥ 2; `detail` is printable ASCII.
  - §3:
    - accounts are created by admission or payment, and only never-paid accounts may be
      forgotten;
    - configuration minimums (a zero `debt_ttl` would switch the cap off);
    - bounded per-identity state, and a spent-proof cache;
    - credit covers only its own video;
    - a full cap refuses unpaid service, never paid service, with cap sizing;
    - bans checked at a payment's turn;
    - at most 64 proofs per payment;
    - the swap is not tied to the `pay`'s connection;
    - a retry answered `spent` is settled by restore, never banned on.
  - §3a:
    - unsettled payments are settled by the next quote or reclaimed after 120 s, even
      across a dropped connection;
    - a quote below the ledger is refused;
    - refused requests are always un-owed;
    - pay ahead after a refusal;
    - the threshold counts across videos;
    - a reclaim that finds proofs spent loses that payment and stops the watcher, and
      nothing more is paid until a reclaim completes. That closes an unbounded drain
      through `mint-unavailable`.
  - §4: the same rule after `503`.
- Draft 2026-09-24 (M2.0 fourth audit, `docs/nfx/reviews/2026-09-24-m2.0-fourth-audit.md`).
  - §2: new message `refuse`, which tells a refusal apart from an aborted transfer. The
    window is per account.
  - §3:
    - a `hello` waits for a payment in progress, so its quote never misses one;
    - at the 60 s deadline the seeder abandons the swap, releases the account, and
      neither credits nor bans on a late outcome;
    - the seeder's own swap errors are never a ban;
    - `account_ttl` ≥ `debt_ttl` explained;
    - loss bounds per account.
  - §3a:
    - pay-ahead is capped by credit already held;
    - settling an unsettled payment needs both fields to match;
    - an unanswered payment on a live connection stops the watcher, and one on a dropped
      connection does not if every proof comes back.
- Draft 2026-09-24 (M2.0 fifth audit, `docs/nfx/reviews/2026-09-24-m2.0-fifth-audit.md`).
  - §3:
    - the deadline counts from a `pay`'s arrival, and an outcome known by then is the
      answer;
    - a late outcome of an abandoned swap is credited if a claim, and never banned on,
      whoever still awaits the `pay`;
    - configuration ranges, including a global-cap ceiling and `ban_ttl`;
    - bans expire;
    - accounts are idle from their last session's close;
    - waiting hellos count toward the session cap;
    - loss bounds restated.
  - §3a:
    - one standing per seeder across its videos, with one payment in flight;
    - a payment whose proofs are found spent awaits a quote instead of stopping the
      watcher for good;
    - pay ahead only right after a refusal, per video.
- Draft 2026-09-24 (M2.0 sixth audit, `docs/nfx/reviews/2026-09-24-m2.0-sixth-audit.md`).
  - §2: the delivery rule behind the 120 s wait.
  - §3:
    - mint URLs are validated as the writer would;
    - the watermark is read again as a swap is sent.
  - §3a:
    - a watcher's `window` ceiling bounds pay-ahead;
    - three `mint-unavailable` answers in a row end paying for the session;
    - answers belong to their session, and a refused `hello` is not a payment's answer;
    - any ledger of a standing reclaims a closed session's payment after 120 s.
- Draft 2026-09-24 (M2.0 seventh audit, `docs/nfx/reviews/2026-09-24-m2.0-seventh-audit.md`).
  - §2: `window` is 2 to 64; the delivery rule covers the answer's leg too, so the
    watcher waits 180 s.
  - §3:
    - arrival is the transport's receipt;
    - late outcomes MUST be learnt (NUT-09 restore of NUT-13 outputs);
    - ceilings on `debt_ttl`, `account_ttl` and `ban_ttl`;
    - bans only for peers with an account.
  - §3a:
    - reclaiming continues after a stop;
    - only an `ack` resets the `mint-unavailable` count;
    - back off from a seeder whose sessions keep ending in it.
