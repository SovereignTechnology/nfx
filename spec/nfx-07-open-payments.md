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
  least 2, so a watcher paying once half the window is unpaid, rounded up (§3a), never
  stalls the seeder, and at most 64, so one refusal makes a watcher pay ahead at most 32
  chunks (§3a). A seeder that serves for free does not quote; it serves without pay/1.
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
  the video refuses it with `unknown-video`, unless the peer is banned: a banned peer's
  `hello` is refused `banned`, whatever video it names (§3). One that has stopped serving
  the video still answers the `hello` of a peer it keeps an account for there, or a swap
  of one whose outcome is unknown, verifies that session's payments, and admits nothing of
  the video (§3).
- **`quote`** (seeder→watcher) replies with the *binding* price; the beacon's
  `price_hint` was advisory. It also carries the account's position, so a watcher can
  resume after a reconnect. A watcher takes one quote per session and refuses a second.
- **`quote.mints`** MUST be non-empty. The seeder accepts proofs only from a mint whose
  URL is **exactly** (byte for byte) one of those quoted, and swaps them at that URL.
  There is no "any mint".
- **`window`** is the unpaid chunks the seeder tolerates on one account, that is one peer
  and one video (recommended/default **8**).
- **`pay`** covers chunks `(accepted_upto, upto_chunk]` of the account. `token` is a
  NUT-00 token of **one** mint, a quoted one by its exact URL, in unit `sat`, whose proofs'
  face value MUST equal `chunks × price_per_chunk`, and which passes the seeder's structure
  check (§3 step 1): at most 64 proofs, none locked (a licensed video's are P2PK-locked
  instead, NFX-08 §4), each with its DLEQ proof. Input fees
  (NUT-02) are the seeder's cost: a seeder quoting a mint that charges fees prices them in.
  - A `pay` with `upto_chunk` at or below `accepted_upto` is **`stale`** (replayed or
    mis-ordered). It is refused without touching the accounting, and its proofs are not
    claimed.
  - `upto_chunk` may exceed the chunks served so far. Such pre-payment extends service on a
    video the seeder serves by exactly the chunks paid (§3: one it no longer serves admits
    nothing, a stated concession).
- **`ack`** means the payment's swap has **completed** (§3). `accepted_upto` is the new
  watermark, and `spent_total` is the face value accepted so far on the account.
- **`rej` `mint-unavailable`**: the seeder could not complete the swap in time, and its
  outcome may be unknown; or it did not swap at all, because an earlier payment's
  outcome on the account is still unknown, or the mint has no keyset it may swap to.
  It is not a ban, and nothing was credited by then; a swap that lands later is
  credited if it claimed the proofs and the seeder learns so before its outputs' keyset
  expires (§3).
- **`refuse`** (seeder→watcher): the seeder refused the watcher's request for `file`
  under this session, and served not one byte of it. That is how a refusal is told apart
  from a transfer the watcher aborted, which gets no `refuse`. One `refuse` answers one
  request.

## 3. Seeder duties

**Identity and scope.**
- A **peer** is the identity the transport gives it: the iroh endpoint id on
  `nfx/pay/1`, or the peer id on the WebRTC mesh (NFX-10 §3.2). Identities are free
  to create on every transport.
- A **seeder** is its long-term identity: the key its beacons are signed with (NFX-03
  §1), to which they bind its iroh endpoints (NFX-06 §1), or, where it announces none (the
  WebRTC mesh), the identity its transport gives it. Every endpoint it announces serves
  from its one set of state, accounts included, so a watcher's ledgers, kept per seeder
  (§3a), agree with the accounts at each; a seeder that runs separate engines announces
  each under an identity of its own. Identities are free for seeders too.
- An **account** is (peer, video). It numbers that peer's chunks of that video and
  holds its position: `served`, `accepted_upto` and `spent_total`, all per account.
  - It is created by its first admission or payment. A `hello` alone creates nothing,
    and the quote then reports zeros. Nothing refused creates one: a refused `hello`,
    request or `pay` leaves no account, nor does a `pay` dropped before its swap is sent.
    The one exception is a `pay` answered `mint-unavailable` whose swap is later learnt
    as a claim: the claim creates the account then (late outcomes, below). A refused
    `hello` also holds no place under the session cap and leaves no session id open.
  - It persists across the peer's sessions. A new `hello` continues the account; it
    never opens a fresh window.
  - A `hello` for an account with a payment in progress waits while a payment holds the
    account's turn: each holds it until it is answered, or dropped before its swap is
    sent (its connection closed: it is abandoned unswapped), at the latest at its own
    deadline (60 s from its arrival), and one that arrives meanwhile may take the turn
    next (§3). The turn is freed then: when its payment is answered or so dropped, or at
    its deadline if that comes first, however late after it the answer goes out, the
    swap's outcome comes, or an entry takes the turn over. Deadlines and the seeder's
    clock count whole seconds, so a turn freed at a deadline was freed as that second
    began: every read sent in it or later was sent after the freeing. The `hello` is
    answered then, plus the time its own reads of its account's unknown swaps take. It
    reads after that wait, which ended when the turn was last freed before the `hello`
    found it free: no read sent before then serves it, the payment's own included. A
    `hello` that takes the turn over reads so too, the abandoned swap included; one that
    comes after the deadline that freed the turn found it free, and did not wait. So a
    quote never misses an acknowledged payment, nor a claim that had reached the mint
    when the turn was so freed, the mint answering. A `hello` waiting so counts toward the
    peer's session cap.
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
- A seeder that stops serving a video keeps its accounts there, by the rules above. It
  answers a `hello` for that video from a peer it keeps an account for there, or a swap of
  one whose outcome is unknown, as it would before: its wait for a payment in progress,
  taking a dead turn over included, its reads after that wait, its ban and session-id
  checks as it arrives and again as it answers, the ban as it then stands, and the per-peer
  cap, waiting `hello`s counted. It verifies that session's payments as any others, and
  admits nothing of the video, pre-paid chunks included. Any other peer's `hello` for it is
  refused `unknown-video`, or `banned` (§2).
  So a payment there awaiting a quote (§3a) is still settled, and its watcher pays on the
  seeder's other videos. A stated concession: a watcher that asks for the video's files
  there is refused, and may pay ahead after that refusal (§3a). The seeder credits it as
  any pre-payment, and serves none of it while it does not serve the video: a cost to the
  watcher within the half window that §3a bounds a video's credit to.
- A ban expires after `ban_ttl`, and is recorded only for a peer with an account. A
  peer with none has been served nothing and owes nothing, so a ban would protect
  nothing: its refused `pay` is answered, and nothing is kept for it.
- Hellos waiting for a payment count toward the session cap.
- A swap whose outcome is unknown is kept until it is learnt, at most one per account.
  Unknown means sent with no answer: abandoned at the deadline while still in flight
  (whether or not its `pay` is still awaited), or answered and the answer lost (below).
  While one is unknown, the account's further payments are answered `mint-unavailable`
  without a swap, a new peer's pre-payments included. That account alone: other
  accounts, the same peer's included, pay as usual. An account holding one is not
  forgotten. One whose inputs still read unspent `account_ttl` after it became unknown
  is completed: the seeder sends its swap again, with the same outputs, and settles it
  as that answer says. Its payer has had the inputs back all that time and never spent
  them, so the payment goes through after all, and is credited late (below); an away
  watcher's next quote shows it. A completion is a retry: answered `spent`, a restore of
  its outputs settles it; refused as pending, or unanswered, the swap stays unknown and
  is completed again later. Refused for good, in a way that also stops the first
  request from ever signing, it is settled by a restore of its outputs too: signed, the
  claim; unsigned, nothing, since no request can sign those outputs any more. With CDK
  that is an inactive keyset for its outputs (12002), a keyset the mint does not know
  (12001: the inputs' or the outputs', with the same code and detail), or invalid
  inputs (10001). An expired keyset (12003) is one too, but CDK sends the same code and
  detail whether the inputs' keyset expired or the outputs', and an inputs' expiry does
  not stop a first request the mint reserved before it: every 12003 is therefore
  settled so only once a NUT-07 check shows an input spent, or none pending, and leaves
  the swap unknown while one is pending and none is spent. An input spent shows that the
  first request is not waiting to sign: a mint refuses a request holding a spent input
  whole, and one it has reserved spends all its inputs at once, when it signs. Any other
  answer leaves the swap unknown.
  Undecided swaps therefore end, and cost a payer who parks them its proofs.
- A seeder SHOULD keep a bounded cache of proofs it has seen spent. It then refuses a
  replayed one (`spent`, with a ban) without asking the mint.

**Admission.** Every request the seeder serves for a file of the session's video
counts as one chunk of the account **when it is admitted**: whole, ranged or aborted
alike. It is counted atomically, so concurrent requests cannot share a slot. A request
for a file of another video is not admitted under this session. A request that is not
admitted is answered with `refuse` naming its file, and not one byte of it is served.

**Service limit.** A chunk is **covered** while its own account's `served` is below
that account's `accepted_upto`, that is, pre-paid. Credit on one video never covers
another. A covered chunk of a video the seeder serves is admitted unless the peer is
banned (one it no longer serves admits nothing, bounded state above). An uncovered chunk is
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
(§3a), and covered chunks of a video it serves are served whatever the cap. **Size the cap** for the new
watchers expected at once. Each holds up to about `window`/2 unpaid chunks between its
payments, so a cap of C carries about C / (`window`/2) of them before they must pay
ahead.

**Verifying a `pay`.** One account's payments are processed one at a time, in no set
order: each waits while another holds the account's turn, which that one holds until it
is answered, or dropped before its swap is sent (then abandoned unswapped), at most to
its own deadline: a turn held to a deadline is freed there, however late the answer goes
out, the swap's outcome comes, or an entry takes the turn over (the deadline, below).
Bans are checked when a payment's turn comes, not when it arrives, a turn it takes over
included, and before any other check: a banned peer's payment is refused `banned`,
whatever it offers. The checks run in this order:
1. **Structure.** A token is `bad-token` if it is:
   - unreadable;
   - not in unit `sat`;
   - of more than one mint;
   - holding more than 64 proofs (input fees grow with the proof count, and fees are
     the seeder's);
   - holding proofs locked to a spending condition (NUT-10/11/14): in open mode, which this
     document covers; a licensed video's proofs are P2PK-locked, and checked as NFX-08 §4
     says;
   - holding a proof that lacks a DLEQ proof (NUT-12).
2. **The mint** is exactly a quoted URL, else `bad-mint`. Nothing is fetched from any
   mint before this check.
3. **DLEQ.** Every proof's DLEQ proof verifies against the keys of that quoted mint for
   the keyset the proof names, else `bad-token`. The keys are fetched from that mint,
   then cached: the seeder uses keys it holds without asking the mint, and keys cached
   for another mint or another keyset serve no proof they are not for.
   - **Keysets it does not hold.** The seeder asks the mint for a keyset's keys only if
     the mint's keyset listing (NUT-02) names it: one the mint started since, say, or an
     older one a wallet still spends. It caches the listing per mint, and asks a mint
     for it only at its own start or where a check needs one, here or the outputs'
     keyset of step 5, and at most once a second: a payment refused by an earlier check
     asks for none. Each mint's listing is its own: it names no keyset of another
     mint's, and asking one mint for it delays asking no other. A payment naming a
     keyset that the listing does not name, the listing asked for before the payment
     arrived, makes it ask again; if it last asked in the same second, the payment waits
     for the next second's listing.
   - A keyset that a listing asked for after the payment arrived does not name is
     `bad-token`, without a ban, whichever entry asked for it and in whichever second,
     the payment's own included. So is one whose keys the mint answers 12001 (a keyset it
     does not know). A token naming keysets the mint never had so costs the mint at most
     a listing a second, whoever sends it.
4. **The face value** exactly covers the new chunks. Short is `underpaid`, over is
   `overpaid`. A product above 2^53−1 is `underpaid`. An exact payment that would take
   the account's `spent_total` above 2^53−1 is `overpaid`: no `ack` or quote could carry
   it (§2), so the account takes no more. Never extend credit on a miscount.
5. **Swap, then acknowledge.** All the token's proofs go into one swap (NUT-03) at the
   quoted mint. The swap is atomic, and the seeder never swaps a subset. The account's
   watermark is read again as the swap is sent, after the payment's own read (below): a
   late outcome may have moved it during step 3's key fetch, or that read may have learnt
   one. A payment it no longer fits is refused, `stale` or by amount, and nothing is
   swapped.
   - **The swap is not tied to the `pay`'s connection.** If the connection drops, a
     swap that completes is still credited, and the watcher learns of it from a quote.
   - **Outcomes:**
     - on success, `ack`: `accepted_upto` becomes `upto_chunk`, and `spent_total`
       grows by the face value;
     - if any proof is **spent**, `rej` `spent` and ban the peer. Nothing is claimed,
       and spend detection is by proof, not by token string;
     - if the mint refuses the proofs as invalid, `rej` `bad-token` and ban the peer;
     - if the mint cannot be reached, or the outcome stays unknown, `rej`
       `mint-unavailable`. That is not a ban, and nothing is credited. A request that
       never reached the mint has a known outcome, nothing; one that reached it and got
       no answer has an unknown one.
   - **Retries.** The seeder retries the same swap request (NUT-19), with the same
     outputs, while it still has time. Those outputs are derived for this swap alone
     (NUT-13), so a NUT-09 restore of them finds this swap and no other. A retry answered
     `spent` may be its own earlier attempt that succeeded unseen: a restore that finds
     the outputs signed settles it as a claim, and one that does not makes it
     `mint-unavailable` with nothing to learn, since its inputs are spent: it leaves
     nothing unknown. A retry's `spent` is never a ban. A retry refused as pending
     (below) may be refused because of the first attempt, still being processed: the
     outcome stays unknown. A retry refused as invalid (CDK 10001) is answered as a first
     attempt refused so is, `bad-token` and a ban: validity is the proofs' own, so the
     first attempt was refused the same way. 12001 (a keyset the mint does not know) is
     not invalid: it may name the seeder's own outputs, and the seeder checked the
     inputs' DLEQs against that keyset's keys.
   - **The outputs' keyset.** The seeder derives a swap's outputs only from an active
     keyset whose `final_expiry` (NUT-02), as the mint lists it, is absent or at least
     twice `account_ttl` away by the seeder's own clock. With none, it does not swap:
     `mint-unavailable`, its own keyset error (below), and it reads nothing for it. So a
     swap outlives its outputs only if it stays undecided that long (below). It judges by
     the mint's keyset listing of step 3, one asked for in the second the payment's turn
     came or later, by whichever entry, before the payment arrived or after. If it holds
     none, or one asked for before that second, it asks for the listing then; one asked
     for and not yet answered it waits for, and a listing that comes at the deadline or
     later is not used (the deadline, below). A mint's listing names what the mint lists
     as it answers: a `final_expiry` listed since is judged at the next listing.

   - **Pending.** A mint may reserve a request's inputs before it signs (NUT-07
     `PENDING`; CDK does). A swap of reserved inputs is refused as pending (CDK 11002).
     A first attempt refused so did nothing, and another request holds the inputs,
     possibly the payer's own other payment: `mint-unavailable`, never a ban.
   - **Other errors.** Any other swap error, a fee or keyset error of the seeder's own
     making included (outputs derived from a keyset since rotated out, say), is
     `mint-unavailable`, never a ban, and leaves nothing unknown: the request did
     nothing. So is a first attempt refused because a keyset expired (12003) or is not
     known (12001): the payer's inputs' or the seeder's own outputs', which the code does
     not say. A retry refused for good otherwise is settled by a restore of its outputs,
     as a completion is, a 12003 only once no input is pending (bounded state, above); a
     retry left unanswered leaves the outcome unknown.
   - **The deadline.** The seeder answers every `pay` within **60 s of its arrival**,
     that is of the transport receiving it, not of the engine reading it: the wait for
     the account's turn, the key fetch and the swap all count. A payment whose outcome
     the seeder has by then is answered with it, even at the deadline: a refusal its
     checks reached by then, or its swap's outcome. Otherwise it answers
     `mint-unavailable`, however its checks would have ended, abandons the swap (it sends
     no further swap request for those proofs), and releases the account's turn to
     whichever payment takes it next. Deadlines and the seeder's clock count whole
     seconds, and a deadline is as its second began: what comes in the deadline's second
     came after it. So a payment whose turn comes then or later runs none of its checks,
     the ban's included; keys or a keyset listing that come then or later are not used,
     and nothing that needs them (DLEQ, amount, the outputs' keyset) is judged; a swap's
     outcome the seeder settles then is late (below); and a payment whose swap is not
     sent by then is not rechecked against the watermark (step 5). Each is answered
     `mint-unavailable`. The turn is freed at the deadline, however late that answer goes
     out, the swap's outcome comes, or an entry takes the turn over: a read sent in the
     deadline's second or later was sent after the freeing. A payment dropped before its
     swap is sent (its connection closed) is abandoned unswapped, and frees the turn
     then; one dropped after is settled as its swap completes (step 5). The payment that
     takes the turn, once its checks pass, reads the abandoned swap (below), whether it
     waited for the turn or came after the deadline; while that outcome is still unknown,
     it is answered `mint-unavailable` without a swap (bounded state, above). A payment's
     own reads and completions (below) count too, and so do the reads and requests that
     settle a retry or a completion: all end at its deadline, however late they start
     (after a wait for the account's turn, or a slow key fetch). One still unanswered
     then is abandoned, proves nothing, and the payment is answered `mint-unavailable` at
     the deadline.
   - **Late outcomes.** A swap the seeder has answered `mint-unavailable` for, at the
     deadline or earlier, is still settled when its outcome becomes known. The seeder
     MUST learn it: from a late response, or, when none comes, by reading the swap's
     state while the mint is reachable, first its inputs (NUT-07), then its own outputs
     (NUT-09 restore), which it derives deterministically (NUT-13) for this. In that
     order, a swap processed between the two reads shows as signed. A watcher waiting
     on that payment (§3a) waits on this.
     - Outputs signed: a claim, whatever the first read said, an unanswered one included.
     - Outputs unsigned with an input spent: nothing. The swap is atomic, so it can no
       longer go through.
     - Outputs of a keyset that has expired: a restore no longer shows them (CDK skips an
       expired keyset's signatures), so a claim not learnt before then reads as unsigned,
       and with its inputs spent as nothing. That is a stated concession: nothing else can
       prove the claim, since spent inputs may as well be the payer's own reclaim or a
       double spend, and the seeder never extends credit it cannot prove; its expired
       outputs are worth nothing to it either. The payer's watcher, finding the proofs
       spent, awaits a quote that never comes and stops paying that seeder (§3a). Both
       keep their bounds. The outputs' keyset rule above keeps this to a swap undecided
       for twice `account_ttl`.
     - Anything else proves nothing, and the swap is read again later: every input
       unspent (the request may yet be processed), an input pending (reserved by a
       request the mint is still processing, which may yet go through or be rolled
       back), or either read unanswered.
     - An honest watcher reclaims a payment answered `mint-unavailable` (§3a), and so
       spends its inputs: a request the mint holds before reserving them is then learnt
       as nothing, and the account pays again at once. One whose inputs the mint has
       reserved refuses the reclaim as pending until the mint finishes it (a claim) or
       rolls it back (the reclaim then goes through).
     - Each unknown swap is decided on its own: one still unknown delays no other.
     - An account's own `hello` and `pay` read that account's unknown swaps, and no other
       account's, not even the same peer's on another video: a read left unanswered costs
       only its own account's payments, and never past their deadline. A `pay` reads
       once, after its checks (its peer's ban first, then `stale`, structure, mint, DLEQ
       and amount), just before its swap: a payment the seeder refuses anyway costs the
       mint nothing.
       Admission and the other synchronous checks read nothing.
     - An account's own reads are at most two a second, counted against that account
       alone. A read counts from when it is sent, in the second it is sent (an entry
       that waited into a new second included), whatever becomes of it. An entry takes
       its read's place in the same step that finds a place free, before sending it, so
       entries at once, on however many threads, cannot all find a place and all read.
       No read is sent at or past its entry's deadline, judged at every look (an entry
       that waited into its deadline included): none is sent then, and none counted.
     - What a read covers is fixed as its place is taken: the account's swaps undecided
       then, an answer lost or a swap abandoned in flight alike, and exactly those are
       sent. So an entry that looks while it is under way waits for it, if it covers what
       that entry needs.
     - A read serves an entry of its account when it covered every swap undecided for
       the account as the entry comes: not one sent before a swap became unknown. And it
       is the entry's own proofs' read, or any read for a `hello`, or any read once two
       were sent that second; but for a `hello` that waited for a payment, only a read
       sent after its wait ended (when the account's turn was last freed before the
       `hello` found it free; at a deadline, as that second began), past two or not. The
       reads sent before still count toward the second's two. So two entries at once
       share one read, and its result, hellos woken by one payment included; a `hello`
       that waited for a payment reads after it; a watcher paying again after its
       reclaim, with other proofs, reads afresh; and a flood of hellos, or of payments
       whatever their proofs, costs the mint two reads a second.
     - An entry reuses a read that serves it and is back; waits for one under way that
       would serve it, and for no other; and otherwise reads itself, while the second's
       two are not spent. Once they are, it reads in the next second. A read abandoned
       before it is back (its entry dropped) still counts, but has no result. An entry
       whose read has not come back when its second ends reads itself, as a read of the
       new second. Its wait ends at its own deadline in any case.
     - A background sweep reads every account's, periodically, in as few requests as the
       mint's limits allow: a read the mint refuses as too large (CDK 11014 for a NUT-07
       check, 11015 for a restore; its `max_inputs` and `max_outputs`) is split, and
       every swap the mint once took fits in one request alone. A read left unanswered is
       not split. A read refused or unanswered proves nothing for the swaps it covered,
       and nothing more.
     - Once learnt, an outcome is final: a response that comes later changes nothing.
       The converse holds too: the reads are round trips, and a response that lands
       while they are made has settled the swap, so their result then changes nothing.
     - A claim is credited to the account, whether or not its peer has been banned
       since, and the watcher's next quote shows it (§3a). It frees from the global count
       exactly the chunks it covers: the account's chunks beyond it are still unpaid.
     - A spent or invalid outcome bans nobody.
     - A late outcome is never an `ack`: the payment was already answered.

Every refusal leaves the accounting untouched and the proofs unclaimed, except that
after `mint-unavailable` the swap's outcome may be unknown (§3a says how the watcher
settles that). A banned peer's `hello` and `pay` are refused (`banned`), whatever it
offers, and nothing of it is admitted. A `hello` checks the ban as it arrives, before any
wait or read, and again as it answers, after its wait and its reads: a ban earned
meanwhile refuses it.

For licensed videos, step 5's swap is replaced by the offline checks of NFX-08 §4.1:
chunk proofs there are P2PK-locked and cannot be swapped by the seeder.

Bans are local policy, never global claims: no "bad payer list" events exist.

## 3a. Watcher duties

- **Know a seeder by its long-term identity** (§3), never by an endpoint or another
  transport identity: the endpoints one seeder announces share its ledgers and its standing.
- **Keep a ledger per (seeder, video):** chunks requested, `accepted_upto`,
  `spent_total`, and any payment not yet settled. It lasts as long as the watcher's
  identity toward that seeder, by which the seeder keeps the account (§3). The watcher
  keeps that identity, and the ledger, while a payment of the ledger is not yet settled
  (in flight, left unsettled, being reclaimed or awaiting a quote): only a quote to that
  identity can show it. A watcher that loses the identity anyway (one its transport does
  not keep across a restart, say) while a payment of it awaits a quote can never settle
  that payment: its standing pays that seeder nothing more, on any video, for as long as
  it keeps the wallet. A stated concession: the cost falls on the watcher, and on an honest
  seeder that credited the payment late; a lying seeder still takes that one payment and
  no more.
- **Keep one standing per seeder**, shared by that seeder's ledgers, for as long as the
  watcher keeps the wallet it pays from, whatever identity it takes toward the seeder:
  - whether the watcher has stopped paying it;
  - reclaims not yet complete;
  - payments awaiting a quote (below);
  - the one payment in flight toward it, a payment a closed session left unsettled
    included;
  - how many `mint-unavailable` answers came in a row.

  Every rule below that says "pays that seeder nothing" holds for all its videos, and any
  of its videos' ledgers does the standing's catching up (the 180 s reclaim below).
  Identities are free, a seeder's as a watcher's (§3): a lying seeder takes one payment per
  seeder identity the watcher pays, however many identities the watcher takes toward it,
  as a lying origin takes one per standing the client keeps (§4).
- **Take a quote only if it is honest about the account:**
  - its `served` is at most the chunks requested of its video and not refused, whatever
    the watcher has paid for: credit it holds, or a payment the quote settles; nothing a
    ledger for another of the seeder's videos holds counts;
  - its `accepted_upto` and `spent_total` equal the ledger, or the ledger plus the
    unsettled payment, which the quote thereby settles as accepted;
  - a quote **below** the ledger is refused, and the watcher never resyncs down to it;
  - a quote above the watcher's price cap is refused, on every session, a resumed one
    included, and so is one naming no mint it holds tokens from, by the mint's exact URL
    (§2): a lookalike names none;
  - so is a quote whose `window` is above the watcher's own ceiling, at most 64 (§2):
    `window` bounds what one refusal makes it pay ahead.

  A quote dishonest about the account stops the watcher paying that seeder; one refused
  for its price, its `window` or its mints does not, nor a second quote on an open
  session, refused (§2) whatever it claims: its price and `window` change nothing.
- **Owe every request sent,** except one the seeder answers with `refuse`. A refused
  request is always un-owed; if it was already paid for, that payment becomes credit. A
  request the watcher abandons stays owed; if the seeder never saw it, the payment
  becomes pre-payment.
- **Pay exactly the quoted price** for requested chunks, with a token that passes the
  seeder's structure check (§3 step 1): of one quoted mint, by its exact URL (§2), in unit
  `sat`, of at most 64 proofs, none locked to a spending condition (in open mode: a
  licensed video's are P2PK-locked as NFX-08 §4 requires), each carrying its DLEQ
  proof (NUT-12). A wallet whose selection would hold more than 64 proofs swaps to fewer
  first. CDK 0.18.1 sends an exact selection as it is, whatever its count, unless
  `SendOptions::max_proofs` is set, so a watcher built on it sets it to 64. Every payment
  meets it, however it is made (due, ahead after a refusal, or at a session's end), on
  whichever of the seeder's ledgers, and whatever came before it: an `ack`, a
  `mint-unavailable` answer, a reclaim (its proofs back in a session or not, late, or less
  those lost to the expiry), a quote that settled a payment, a resumed session, or credit
  held. A token the
  seeder refuses `bad-token` stops the watcher (below).
  - Pay once the account's unpaid count reaches half of `window`, rounded up (3 of a
    `window` of 5), for each payment, on whichever of the seeder's ledgers and whatever
    came before it (as for the token's shape, above), so the seeder need not stall while a
    payment is in flight. The `window` is the session's quote's: a seeder may quote
    another on a later session.
  - Never pay ahead of need, except right after a refusal. Then pay ahead up to half of
    `window`, rounded down, less any credit the video's ledger already holds, so too on
    whichever ledger and whatever came before, which the seeder serves whatever its cap. Credit on a video never grows beyond half its window, so a seeder
    that refuses everything takes at most half the watcher's ceiling, for each video the
    watcher asks it for.
  - Keep one payment in flight toward a seeder at a time, across its videos. One sent on a
    live session holds that place until it is answered or its 180 s are up (below): a
    second quote, a request refused or new, a timeout before then, a ledger made for
    another video, or a quote on one, taken or refused, frees nothing.
  - After three `mint-unavailable` answers to its payments in a row, pay that seeder
    nothing more until a new session's accepted quote. Each answer costs the watcher a
    reclaim and a new token at the mint, whose input fees are the watcher's; only those
    answers count. Nothing else uses a try: not a reclaim, retried while the mint is down
    or not, a closed session's payment reclaimed with every proof back or lost to the
    expiry, a refused `hello` (whatever its code, `mint-unavailable` included) or quote, a
    session's end, nor a timeout. An `ack` resets the count, as a new session's accepted
    quote does, and nothing else does: not a refused quote, a refused `hello`, another
    video's session ending, a timeout, or a reclaim completing, in a session or not. Out
    of tries, it still finishes its incomplete reclaims and reclaims a closed session's
    payment after the wait: reclaiming is not paying. A watcher SHOULD back off before
    reopening sessions with a seeder whose sessions keep ending so, since each new
    session's accepted quote restores the three tries.
- **Pay only with proofs of its own.** Other clients may pay from the watcher's wallet at
  the same time: the user's other devices, or browser partitions (NFX-10 §3). Proofs
  that two clients spend at once are refused to one of them as spent, and that one would
  take it for the seeder's claim (below) and stop paying an honest seeder. So the
  watcher pays only with outputs of a request of its own at the mint (a swap, NUT-03,
  or a mint, NUT-04), kept where no other client takes them until it pays with them or
  puts them back in the wallet. A proof another client may spend (one in a shared
  NIP-60 wallet's token events, or one received from someone else) is swapped first.
  Every output it derives, for such a request or a reclaim (below), comes from a seed
  and counters no other client derives outputs from (NUT-13): no other client can
  spend those outputs, or have them signed first so that the mint refuses them to the
  watcher. It writes down the seed, and the keyset and counters each request uses,
  before that request is sent, and keeps them until its outcome is learnt, so its
  restores (NUT-09) find its own requests' outputs, after a restart too.
- **Answers belong to their session.** A `rej` answers the payment sent on its session.
  One that answers no payment is unsolicited, and stops the watcher paying that seeder,
  as an unsolicited `ack` does. A refused `hello` opens no session and answers no
  payment: `banned` stops the watcher, and any other code, known or not,
  `mint-unavailable` included, changes nothing. A payment an earlier session left
  unsettled is settled only by a quote or by the 180 s reclaim below. A quote the watcher
  refuses (for its price, its `window` or its mints, or a second quote on an open
  session) is not taken, so it settles nothing, and neither does a refused request or
  `hello`, nor a ledger made for another video. A quote settles only
  its own video's payments: taken, refused or dishonest, it settles nothing of another
  video's, even one showing that video's payment in both fields. Each of these leaves the
  payment in flight, a payment awaiting a quote and an incomplete reclaim as they were,
  and undoes no stop.
- **Check every `ack`.** `accepted_upto` must equal the payment's `upto_chunk`, and
  `spent_total` the ledger plus its face value. An inconsistent or unsolicited ack stops
  the watcher paying that seeder. An `ack` settles only the payment sent on its session:
  an unsolicited one settles nothing, even one showing another video's payment in both
  fields.
- **Reclaim the proofs of every refused payment,** whatever the code, known or not, by
  swapping them back at the mint, to outputs the watcher derives deterministically
  (NUT-13). A reclaim left without an answer is retried, and a retry can find the proofs
  spent by that reclaim itself: before calling any proof spent, the watcher restores its
  own outputs (NUT-09). Proofs it took back itself are back, not lost.
  - If the reclaim finds any proof already spent, the payment **awaits a quote**. The
    watcher pays that seeder nothing more until a quote, from a new session and at any
    later time, shows it: `accepted_upto` and `spent_total` both equal to the ledger plus
    the payment, which settles it as accepted. A quote equal to the ledger leaves it
    waiting. Any other quote is dishonest (above). A mint refuses a swap holding a spent
    proof whole, so the reclaim checks the proofs' states first (NUT-07) and takes back
    the inputs left, every one unspent (after a 12003, those not lost to the expiry: the
    case below), in a reclaim of their own. While any of those inputs is pending, the
    reclaim is incomplete (below) until the mint finishes the request that reserved it or
    rolls it back, and the payment awaits a quote once the reclaim completes. CDK
    0.18.1's own revoke (`SendSaga::revoke`) does not do this: finding a proof spent, it
    takes nothing back, so a watcher built on it must.
  - So a seeder that keeps a payment without crediting it has taken that one payment,
    and gets nothing more under that seeder identity: the standing pays it nothing more. This holds whether it refuses and then
    claims, or answers `mint-unavailable` after a swap that went through. A seeder that
    credits it late (§3) loses the watcher nothing: its quote for the payment's video shows
    the payment, even once it no longer serves that video (§3).
  - A reclaim refused as pending (the mint is still processing a request that reserved
    the proofs, §3) has neither taken them back nor found them spent: it is incomplete,
    and retried.
  - A reclaim refused because a keyset has expired (CDK 12003, the same code whether it is
    the proofs' keyset or the reclaim's outputs', checked before anything else) is
    decided by a NUT-07 check. An input pending, or the check unanswered: incomplete. An
    input spent: the watcher restores its own outputs, and decides each spent input on
    its own. One its own earlier reclaim took back (that reclaim's answer lost) is back,
    not lost; any other makes the payment as a reclaim that found proofs spent (above).
    Whatever the spent inputs were, the inputs left, every one unspent, are decided per
    proof, by the `final_expiry` the mint lists for each proof's keyset against the
    watcher's own clock (a wallet spends an older keyset's proofs first, so one token may
    hold both):
    those past it are lost to the expiry, not taken by the seeder, and the rest are taken
    back in a reclaim of their own; then, if every spent input was its own, the watcher
    pays again (otherwise the payment awaits a quote, above). That reclaim, refused
    in turn because the mint's active keyset has expired too, leaves the whole reclaim
    incomplete, retried once the mint has a keyset to take them back to. With no input
    past it, the expired keyset is the reclaim's outputs' (a CDK mint keeps an expired
    active keyset active), and the reclaim is incomplete in the same way. A watcher's
    clock ahead of the mint's, by some skew, calls proofs lost that the mint takes for
    that long; one behind holds a reclaim incomplete for that long.
  - Proofs the mint lists under an expired keyset (past its `final_expiry`, by the
    watcher's clock) are worth nothing: the watcher drops them, those its wallet still
    holds and those left from a payment alike, whatever became of that payment, and never
    pays with them. A wallet that spends an older keyset's proofs first with no expiry
    filter (CDK's does) would otherwise pay with them, and each such payment would be
    refused (12003) and answered `mint-unavailable`, costing the seeder a swap request and
    the watcher one of its three tries.
  - A reclaim's outputs are of the mint's active keyset, the only one a mint signs to.
    The watcher reclaims to it at once, however soon its listed `final_expiry` and
    whatever the proofs' own keysets' (an active keyset already expired is the incomplete
    case above): it cannot apply the seeder's margin (§3), not knowing the seeder's
    `account_ttl`, and a reclaim held for a later keyset would pay that seeder nothing for
    as long. So a reclaim can move the value of proofs of a longer-lived keyset (an older
    one, which CDK's wallet spends first) into the active keyset, whose `final_expiry` may
    come sooner. As for any proofs it holds, the wallet must move them out of a keyset
    before its `final_expiry`.
  - A reclaim whose answer is lost can outlive its outputs' keyset, and a restore then
    no longer shows its outputs: the watcher cannot tell its own reclaim from the
    seeder's claim, and treats the proofs as found spent, whatever their own keyset was.
    A stated concession, as the seeder's (§3): it keeps the watcher's bound, and
    whichever it was, the value is gone from the watcher, to the seeder or with the
    outputs' keyset. Its cost falls on an honest seeder that never claimed them: this
    watcher pays it nothing more, on any of its videos, and no quote can settle it.
  - Until the reclaim completes (the mint may be down), the watcher pays that seeder
    nothing more. A quote showing the ledger plus that payment, both fields, settles it
    as accepted in the meantime, and the reclaim is dropped: the seeder has the proofs. A
    quote equal to the ledger leaves the reclaim incomplete. The watcher retries the
    reclaim whether or not it holds a session with the seeder, so a seeder that refuses
    its `hello`s or its quotes cannot hold the reclaim off and claim the proofs meanwhile.
    A reclaim done with no session, or from another video's ledger, ends as one done in
    a session on the payment's own, by every rule of this bullet: proofs found spent
    (after a restore of its own outputs) leave the payment awaiting a quote on its own
    ledger, a mint that cannot serve it yet or a proof pending leaves it incomplete, and
    with every proof back or lost to the expiry the watcher pays again at its next
    session.
  - After `mint-unavailable` the watcher pays again once every proof is confirmed
    reclaimed or lost to the expiry (the 12003 case above), or the payment is settled by
    a quote. After any other code, known or not, it stops paying that seeder: one pay/1
    sends only for a `hello` (`unknown-video`), or another spec's (NFX-11 §6), included.
- **Wait 180 s from sending before reclaiming an unanswered payment**: a leg each for
  the `pay`'s delivery, the seeder's 60 s deadline and the answer's delivery (§2). The
  wait counts from the payment's own sending, never from an input before it: the
  session's quote, the answer to the payment before (a payment that became due while that
  one was in flight is sent only after its answer), the request that made it due, or the
  refusal it pays ahead after, a reclaim completing, or a quote that settled a payment.
  So it does for every payment, however it is made, on whichever ledger and whatever came
  before it (as for the token's shape, above), and wherever it is counted: on the
  payment's live session, or by whichever of the seeder's ledgers catches a closed
  session's payment up, with a session open or not (a new one, or one held since before
  the payment was sent), stopped or not.
  - On a live connection, for the payment sent on it, the seeder was unresponsive: 180 s
    after sending it, whatever came since (a second quote, a request refused or new, a
    timeout before then, or anything on another video), the watcher reclaims and stops. A
    reclaim the mint cannot serve yet is incomplete, and finished once it can, though the
    watcher has stopped.
  - A dropped connection does not shorten the wait. A quote for the payment's video
    settles it as accepted only if its `accepted_upto` **and** `spent_total` both equal
    the ledger plus the payment. Otherwise the watcher reclaims it 180 s after sending
    it, whatever came since (the drop, a new session, a refused quote, request or
    `hello`, another video's ledger), from whichever of the seeder's videos it is still
    watching, with a session open or not, and carries on if every proof came back. Until
    then it is the standing's payment in flight.
  - A reclaim that finds proofs spent leaves the payment to a quote that shows it, as
    above. After a dropped connection the watcher awaits that quote, and pays again once one
    shows the payment, unless it has stopped (below). On a live connection it has stopped:
    a quote that shows the payment settles it into the ledger and nothing more, and the
    watcher awaits no quote and pays nothing (below). A `pay` still buffered on a dropped
    connection can reach the seeder after the watcher's next `hello`, and be credited after
    that session's quote.
- **Pay nothing after stopping,** at the end of a session included, nor ahead after a
  refusal. Nothing undoes a stop: not a later `ack` that matches its payment, a refused
  request or `hello`, a `mint-unavailable` answer with every proof taken back, the
  session's end, a second quote on an open session, a new session's quote on any of the
  seeder's videos (a new video's first included), taken or refused (for its price, its
  `window` or its mints), one that settles a payment included, nor a ledger made for
  another video. A stop holds whatever the watcher waits on when it comes: a payment
  awaiting a quote, an incomplete reclaim, a closed session's payment, or its tries used.
  A watcher that has stopped awaits no quote: a quote that shows a payment, whose proofs
  were found spent before it stopped, as it stopped or since, or which a closed session
  left unsettled, or whose reclaim is incomplete, settles that payment into the ledger and
  nothing more. Reclaiming is not paying: whatever stopped it, a stopped watcher still
  reclaims a live session's payment that is refused, or unanswered after the wait,
  finishes its incomplete reclaims, from whichever of the seeder's videos it is watching,
  and reclaims a closed session's unsettled payment after the wait, counted from sending.
  A stop shortens no wait: whatever stopped it, and whatever came after, it reclaims no
  unanswered payment, live or left by a closed session, before 180 s from sending.

## 4. HTTPS (origin) payment surface

Every paid request pays for itself. An origin extends no credit, keeps no counters and
therefore loses nothing. An origin is its **base URL**: scheme, host, port and path,
any trailing `/` dropped, as a beacon's `https` endpoint names one (NFX-03 §4, which
serves NFX-05 §6's paths under it) or the client is given one otherwise. A URL with a
query, a fragment or credentials names no origin, and the client pays it nothing. Two
paths on one host are two origins.

- `GET <base>/<sha256>` with header `X-NFX-Pay: cashuB…`, a token worth exactly one chunk
  at the origin's price that passes the origin's structure check (§3 step 1): of one
  mint, in unit `sat`, of at most 64 proofs (a wallet whose selection would hold more
  swaps to fewer first), none locked to a spending condition, each carrying its DLEQ
  proof (NUT-12). A paid request is a `GET` for the whole file, with no `Range` or
  conditional (`If-…`) header, and the client follows no redirect with it. It is sent
  over HTTPS only, since anyone who reads a token can spend it (plain HTTP to a loopback
  host only where a deployment permits it, as for a mint, §2).
- The client pays only at a price within its own price cap, and only with a token of a
  mint the origin names, by its exact URL (§2), as it takes a quote (§3a): it pays no
  price above the cap, whether a beacon's `price_hint` or a `402` names it. Its token
  holds only proofs of its own, and it derives and keeps its outputs as a watcher does
  (§3a).
- The origin runs the checks of §3 (structure, mint, DLEQ, exact amount), swaps, and
  only then responds. It SHOULD hold the file's verified bytes before it swaps (from its
  store, or pulled and verified, NFX-05 §6.2), and answer a miss with nothing swapped (a
  `404` or a `5xx`, NFX-05 §6.1), so that the client's reclaim finds every proof back.
  It answers within 60 s of the request's arrival, its pull and its swap included, as a
  seeder answers a `pay` (§3): a swap with no outcome by then it abandons (it sends no
  further swap request for those proofs) and answers `503`. So that its swap has time
  and its answer a way back, it SHOULD start its swap by 30 s after the request's
  arrival, and only while the request's connection (or stream) is open; otherwise it
  swaps nothing, and answers with a `5xx` if it still can. Once it has swapped, it SHOULD
  keep the connection open until the whole `200` is sent, or until 180 s after the
  request's arrival if that comes first, whatever limit it sets on a connection's life.
  It answers:
  - `200` with the file once the swap has succeeded;
  - `402` with `X-NFX-Price` and `X-NFX-Mints` (below; proofs from other mints are
    refused) when payment is missing or refused;
  - `503` when the mint cannot be reached, or the swap has no outcome by the deadline.

  The headers' values, each read as the whole field value (several field lines of one
  name are joined by commas, RFC 9110 §5.3):
  - `X-NFX-Pay`: one token, as `pay.token` (§2), of at most 32 KiB, as a `pay` line is.
    An origin SHOULD accept a field that long, whatever limit its server or a proxy in
    front of it sets on other header fields, so that it refuses no token for its size.
  - `X-NFX-Price`: the price of one chunk in sat, as `price_per_chunk` (§2): a decimal
    integer from 1 to 2^53−1, digits only, the first not `0`.
  - `X-NFX-Mints`: 1 to 16 mint URLs (§2), each written with every `%` in it as `%25`
    and every `,` as `%2C`, then joined with commas (the list syntax of RFC 9110
    §5.6.1: spaces or tabs around a comma are allowed, and empty items are ignored).
    The client reads each item back in one pass, left to right, each `%2C` giving `,`
    and each `%25` giving `%`, and compares the URL it gets byte for byte (§2). The
    header does not parse if an item holds any other `%` or reads back as no mint URL
    (§2), or if it has no item or more than 16. So a list is read only as it was
    written: `https://m.example/?k=a,b` and `https://n.example` are sent as
    `https://m.example/?k=a%2Cb, https://n.example`; the value
    `https://m.example/?k=a,https://n.example` is two items, and the one URL with that
    comma is sent as `https://m.example/?k=a%2Chttps://n.example`.

  An origin sends these headers only in this form. A `402` whose `X-NFX-Price` or
  `X-NFX-Mints` is missing or does not parse names no price and no mint, as a `503`
  does: it is a refusal like any other (below).

  A paid request is **served** only by a `200` whose body, any content coding removed,
  is the requested file, whole: its sha256 is the one requested (NFX-05 §4). Any other
  answer is a refusal: a `200` that does not verify, one cut short included (its
  connection dropped during the body, or the client stopped waiting for it), a `402`, a
  `503`, a redirect, or any other final status, known or not (a `1xx` is not one). A
  paid request left with no final status by 180 s after it was sent, its connection
  dropped before one included (a drop does not shorten the wait), is refused too, and
  reclaimed then, as §3a reclaims an unanswered payment: a status that comes later
  changes nothing. The client waits for a `200`'s whole body at least that long, and
  longer as it chooses. On any refusal the client reclaims its proofs, as in §3a, and
  pays that origin nothing until every proof is confirmed reclaimed, lost to the expiry
  (§3a) or found spent; a reclaim the mint cannot serve yet is retried. The client keeps
  one paid request in flight to an origin at a time, as toward a seeder (§3a).
  - If the reclaim finds any proof spent, that payment is lost, though the proofs left
    unspent are still taken back (§3a), and the client pays that origin nothing more. It
    pays it nothing more after a `200` that does not verify either, whatever the reclaim
    finds: that origin answered as if it had taken the payment. An origin sends no quote,
    so nothing settles that payment later: an origin that claims a payment and does not
    serve it takes that one payment, at a price within the client's cap.
  - Every other refusal, by any answer but a `200` or by none, whose reclaim ends with
    every proof back or lost to the expiry (none spent), uses one of three tries. With a
    try left, the client may pay again: after a `402`, at the price that `402` names, if
    within its cap.
  - Out of tries, the client pays that origin nothing until a back-off of its choosing,
    never zero, has passed, and then has three tries again. It SHOULD at least double the
    back-off each time its tries run out. A served paid request resets the tries and the
    back-off, and nothing else does. So an origin that refuses with nothing spent, by any
    answer but a `200` or by none (an honest one whose mint is down, or that lacks a file
    for now, NFX-05 §6.1), is never dropped for good: it costs the client a reclaim per
    refusal, at most three in a row before each back-off.
  - Even from an honest origin, a payment its swap took is lost when the client does not
    get its `200` whole within its wait, whatever the cause: among them, the client's
    own connection drops, or it stops waiting for the body; the request or the answer
    comes after the wait, since HTTPS bounds no delivery as pay/1's transport does (§2);
    a proxy in front of the origin answers first or cuts the body short (a proxy SHOULD
    wait out the origin's deadline and pass the whole `200` on); a swap the origin
    abandoned at its deadline lands later; or the origin fails between its swap and its
    answer. Nothing tells the client it was served, since an origin sends no quote. A
    stated concession, as §3a's, and the cost of the one-payment bound: the client keeps
    its bound, and pays that origin nothing more.
- The client keeps a standing per origin (per base URL) for as long as it keeps the
  wallet it pays from: whether it has stopped paying it, the paid request in flight and
  its reclaim, the tries left and the back-off. So one origin's answers change nothing
  of another's standing, on the same host or not. Names are free, as identities are
  (§3): a lying origin takes one payment per base URL the client pays, and a new path
  costs it no more than a new host. Two spellings of one base URL (a host's letter case,
  an explicit default port) may be kept as one standing or two: a second name gains a
  lying origin nothing a new path would not. Clients that pay from one wallet keep a
  standing each, as two devices do, or two browser partitions (NFX-10 §3), and each pays
  with proofs of its own (§3a): a lying origin takes one payment per base URL from
  each.
- NFX-05 §6's `Access-Control-Allow-Origin: *` is on every answer to a hash-addressed
  `GET`, paid or not, whatever its status, a `402` and a `503` included. An origin
  serving browsers (NFX-10 §3.1) SHOULD also:
  - answer a paid request's CORS preflight (an `OPTIONS` asking for a `GET` with
    `X-NFX-Pay`) with a `204` carrying `Access-Control-Allow-Origin: *`,
    `Access-Control-Allow-Methods: GET` and `Access-Control-Allow-Headers: X-NFX-Pay`.
    A preflight carries no token and is no paid request: it takes no payment and is
    never answered `402`, since a browser sends nothing after a preflight answered with
    anything but a `2xx`;
  - send `Access-Control-Expose-Headers: X-NFX-Price, X-NFX-Mints` on every `402`.

  Without these a page cannot send the token, see the answer, or read a `402`'s price
  and mints.
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
- Draft 2026-09-25 (M2.0 ninth audit, `docs/nfx/reviews/2026-09-24-m2.0-ninth-audit.md`).
  - §3a:
    - a new session's *accepted* quote restarts the `mint-unavailable` count, and the
      things that do not are named;
    - reclaims use NUT-13 outputs, and a watcher restores them (NUT-09) before calling a
      proof spent;
    - a stopped watcher still reclaims a live session's refused or unanswered payment.
- Draft 2026-09-25 (M2.0 tenth audit, `docs/nfx/reviews/2026-09-24-m2.0-tenth-audit.md`).
  - §3:
    - a swap request that never reached the mint has a known outcome;
    - retries reuse the swap's own outputs, and a restore finds that swap alone;
    - at most one swap of unknown outcome per account.
  - §3a:
    - pay-ahead is half the window, rounded down;
    - a quote settles a payment whose reclaim is incomplete.
- Draft 2026-09-25 (M2.0 eleventh audit, `docs/nfx/reviews/2026-09-24-m2.0-eleventh-audit.md`).
  - §3: a swap abandoned at the deadline while still in flight is of unknown outcome:
    it counts toward the one-per-account bound, and the account's next payment is
    answered at once, without a swap, until it is learnt.
- Draft 2026-09-25 (M2.0 twelfth audit, `docs/nfx/reviews/2026-09-24-m2.0-twelfth-audit.md`).
  - §3:
    - a late outcome is learnt by reading the inputs (NUT-07), then the outputs (NUT-09);
    - unsigned outputs are nothing only once an input is spent, and still unknown
      while every input is unspent;
    - an outcome, once learnt, is final;
    - a swap abandoned in flight counts whether or not its `pay` is awaited, a new
      peer's pre-payments included;
    - a late claim is credited to a peer banned since.
- Draft 2026-09-25 (M2.0 thirteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-thirteenth-audit.md`).
  - §2: `mint-unavailable` also answers a payment refused without a swap while an
    earlier outcome on the account is unknown.
  - §3:
    - a pending input (NUT-07 `PENDING`) is not spent; a first attempt refused as
      pending did nothing and bans nobody, and a retry refused so leaves the outcome
      unknown;
    - an unanswered read proves nothing, and signed outputs are a claim whatever the
      first read said;
    - each unknown swap is decided on its own, and SHOULD be read in one batch;
    - a response that lands while the state is read has settled the swap;
    - an unknown swap whose inputs read unspent `account_ttl` after it became unknown is
      dropped.
  - §3a: a reclaim refused as pending is incomplete, and retried.
- Draft 2026-09-25 (M2.0 fourteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-fourteenth-audit.md`).
  - §3:
    - an account's own `hello` and `pay` read only that account's unknown swaps;
      admission reads nothing; a background sweep reads every account's;
    - a read refused as too large for the mint is split;
    - an unknown swap whose inputs read unspent `account_ttl` after it became unknown is
      completed (sent again, with the same outputs), not dropped.
- Draft 2026-09-25 (M2.0 fifteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-fifteenth-audit.md`).
  - §3 (identity and scope): a `hello`'s answer may come later than a payment's
    deadline by its own reads.
  - §3:
    - a completion is a retry: `spent` is settled by restore, pending or unanswered
      leaves the swap unknown, and outputs refused for good are settled by restore;
    - own reads exclude the same peer's other videos, come after the ban check, and are
      at most one a second, reused by a `hello` and by a `pay` of the same proofs;
    - an oversized restore is CDK 11015; an unanswered read is not split.
- Draft 2026-09-25 (M2.0 sixteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-sixteenth-audit.md`).
  - §3:
    - a payment's own reads and completions end at its deadline;
    - a `pay` reads once, after its checks; an account's own reads are at most two a
      second, whatever the proofs;
    - a completion refused for good is so only if the first request can never sign
      either, and the CDK codes are listed; any other answer leaves the swap unknown;
    - a retry refused for good is settled by restore; a retry left unanswered, or a
      first attempt refused for the seeder's own stale keyset, is not a ban and leaves
      nothing wrongly known.
- Draft 2026-09-25 (M2.0 seventeenth audit, `docs/nfx/reviews/2026-09-24-m2.0-seventeenth-audit.md`).
  - §3 (identity and scope): a `hello` reads after the payment it waited for.
  - §3:
    - CDK's code for invalid inputs is 10001, not 10003;
    - every 12003 is settled only once no input is pending: the code does not say whose
      keyset expired; a first attempt refused so is not a ban and leaves nothing unknown;
    - a retry refused as invalid is `bad-token` and a ban, as a first attempt is;
    - the watermark is read again after a payment's own read; its reads end at its
      deadline however late they start; a `stale` payment reads nothing;
    - a read counts from when it is sent, so two entries at once share one.
- Draft 2026-09-25 (M2.0 eighteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-eighteenth-audit.md`).
  - §3:
    - a restore does not show outputs of an expired keyset: the NUT-07 check alone then
      decides, an input spent being the claim; the seeder derives outputs only from a
      keyset at least twice `account_ttl` from its `final_expiry`;
    - 12001 does not say whose keyset either: never a ban; invalid inputs are 10001;
    - the reads and requests that settle a retry or a completion end at the payment's
      deadline too, as do reads after a wait for the account's turn;
    - an entry reusing a read still under way waits for its result.
  - §3a: a reclaim refused because the proofs' keyset expired is decided by a NUT-07
    check; every input unspent, the watcher pays again.
- Draft 2026-09-25 (M2.0 nineteenth audit, `docs/nfx/reviews/2026-09-24-m2.0-nineteenth-audit.md`).
  - §3:
    - withdrawn: an input spent is not the claim once the outputs' keyset has expired
      (it may be the payer's reclaim or a double spend); such a claim reads as nothing,
      a stated concession that keeps the seeder's loss bound;
    - the outputs' keyset rule is judged by the mint's listed `final_expiry` and the
      seeder's own clock, and a refusal under it reads nothing;
    - a reused read's wait ends with its second, and at the entry's deadline; an
      abandoned read leaves its waiters to read themselves.
  - §3a: a reclaim whose outputs' keyset expires before the watcher can restore them is
    treated as found spent, a stated concession.
- Draft 2026-09-25 (M2.0 twentieth audit, `docs/nfx/reviews/2026-09-24-m2.0-twentieth-audit.md`).
  - §2: `mint-unavailable` names the keyset refusal, and the expiry concession.
  - §3: an abandoned read still counts; an entry waits only for a read that would serve
    it, reads itself when its second ends, and reads in the next second once the
    second's two are spent without a result for it.
  - §3a: a reclaim refused 12003 with its proofs unspent is lost to the expiry only if
    the mint lists the proofs' own keyset as expired; otherwise it is incomplete and
    retried. The concession names its cost to an honest seeder.
- Draft 2026-09-25 (M2.0 twenty-first audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-first-audit.md`).
  - §3: a read serves only entries whose undecided swaps it covered; reads count against
    their own account alone; the reuse rules restated as three bullets.
  - §3a: a reclaim refused 12003 with its proofs unspent is decided per proof, by each
    keyset's listed `final_expiry` against the watcher's clock, whose skew is named.
- Draft 2026-09-26 (M2.0 twenty-second audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-second-audit.md`).
  - §3: an entry takes its read's place in the step that finds one free, so threads cannot
    all read; no read is sent, or counted, at or past the entry's deadline; what a read
    covers is fixed when it is sent; a `hello` that waited for a payment is served only by
    a read sent after its wait ended.
  - §3a: after a 12003, spent inputs that a restore shows the watcher's own are back, and
    the rest are decided per proof; a reclaim of the good proofs refused for want of an
    active keyset leaves the whole reclaim incomplete; proofs listed expired are dropped,
    never paid with.
- Draft 2026-09-26 (M2.0 twenty-third audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-third-audit.md`).
  - §3: a read's coverage is fixed as its place is taken, and exactly those swaps are sent;
    time left is judged at every look; a waited `hello` is served only by a read sent after
    its wait ended, past two or not, and the reads before still count; signed outputs are
    a claim even with the NUT-07 check unanswered; a late claim frees exactly the chunks
    it covers.
  - §3a: after a 12003, each spent input is decided on its own; the unspent ones are
    decided per proof whatever the spent ones were; an unanswered NUT-07 check leaves the
    reclaim incomplete.
- Draft 2026-09-26 (M2.0 twenty-fourth audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-fourth-audit.md`).
  - §3: a waited `hello`'s wait ends when the turn was last freed before it found the turn
    free, and the claim promise is stated from then; it waits while any payment holds the
    turn, each to its own deadline; one account's payments are processed one at a time,
    in no set order (the rule "in order of arrival" withdrawn).
  - §3a: after a 12003, the watcher pays again only if every spent input was its own;
    proofs lost to the expiry count, with those reclaimed, toward paying again.
- Draft 2026-09-26 (M2.0 twenty-fifth audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-fifth-audit.md`).
  - §3: a turn held to its payment's deadline is freed at that deadline, however late the
    answer goes out, the swap's outcome comes, or an entry takes the turn over, so a read
    sent in the deadline's second or later was sent after the freeing and may serve a
    `hello` that waited; while an abandoned swap's outcome is unknown, the payment that
    takes its turn is answered without a swap after its own read of it, not "at once".
  - §3a: proofs listed expired are dropped whether the wallet still holds them or they are
    left from a payment; a reclaim goes to the mint's active keyset at once, however soon
    its `final_expiry` and whatever the proofs' own keysets', so it can move value into a
    keyset that expires sooner, and the wallet must move proofs out of a keyset before its
    `final_expiry`; the expiry concession holds whatever the proofs' own keyset, and its
    premise "its proofs would be lost to the expiry anyway" is withdrawn.
- Draft 2026-09-26 (M2.0 twenty-sixth audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-sixth-audit.md`).
  - §3: a payment dropped before its swap is sent is abandoned unswapped and frees the
    turn then; a `hello` that takes the turn over reads as one that waited, and one that
    comes after the deadline that freed the turn did not wait; a payment's ban is checked
    before any other check, on a turn taken over too, and a `hello`'s as it arrives,
    before any wait or read, and again as it answers, after its wait and its reads; a
    refusal is the answer only if the checks reached it by the deadline: keys that come
    in the deadline's second or later are not used, a swap's outcome settled in it is
    late, and a payment not sent by then is not rechecked; a retry's `spent` with its
    outputs unsigned leaves nothing unknown.
  - §3: a swap refused 12003 is settled once a NUT-07 check shows an input spent, or none
    pending (was: "no input pending"): an input spent shows that the first request is not
    waiting to sign.
  - §3a: a reclaim that finds a proof spent checks the proofs' states first (NUT-07), a
    swap holding a spent proof being refused whole, and takes back the inputs left, every
    one unspent (after a 12003, those not lost to the expiry); an input pending keeps it
    incomplete until the mint finishes or rolls back its request; CDK 0.18.1's
    `SendSaga::revoke` does not do this.
  - §3a: a quote names the watcher's mint only by its exact URL; a dishonest quote stops
    the watcher, and one refused for its price, `window` or mints does not, nor a second
    quote on an open session, whatever it claims; a quote equal to the ledger leaves an
    incomplete reclaim incomplete; a stopped watcher pays nothing ahead after a refusal,
    awaits no quote, and nothing undoes its stop: not a later matching `ack`, a refused
    request or `hello`, `mint-unavailable` with every proof taken back, the session's end,
    nor a new session's quote, on any of its videos.
  - §4: after a proof found spent, the client still takes back the proofs left unspent.
  - §2: a banned peer's `hello` is refused `banned` whatever video it names, one the
    seeder does not serve included.
  - §3: nothing refused creates an account: a refused `hello`, request or `pay` leaves
    none, except a `pay` answered `mint-unavailable` whose swap is later learnt as a
    claim, which creates it then; and a refused `hello` holds no place under the session
    cap and leaves no session id open.
  - §3: an exact payment that would take its account's `spent_total` above 2^53−1 is
    `overpaid`, since no `ack` or quote could carry it.
- Draft 2026-09-27 (M2.0 twenty-seventh audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-seventh-audit.md`).
  - §3: a `pay` dropped before its swap is sent leaves no account, as a refused one does.
  - §3: a payment whose turn comes in its deadline's second or later runs none of its
    checks, the ban's included, and is answered `mint-unavailable`: what the deadline rule
    implied, now said.
  - §3a: a quote the watcher refuses (for its price, `window` or mints, or a second quote on
    an open session) is not taken and settles nothing, and a quote, taken or refused,
    settles nothing of another video's; these, a refused request or `hello`, and a ledger
    made for another video leave the payment in flight, a payment awaiting a quote and an
    incomplete reclaim as they were, and undo no stop (a second quote, a quote refused, a
    new video's first quote and a new video's ledger are now named among what does not
    undo one).
  - §3a: the watcher retries an incomplete reclaim, and reclaims a closed session's
    payment after the wait, whether or not it holds a session with the seeder; whatever
    stopped the watcher, it still reclaims; a reclaim done with no session or from another
    video's ledger ends as one done in a session on the payment's own; a closed session's
    payment is reclaimed 180 s after sending, whatever came since (was: "after 180 s").
  - §3a: each new session's accepted quote (was: each new session) restores the three
    tries; only `mint-unavailable` answers use them, a reclaim retried while the mint is
    down none; out of tries, the watcher still reclaims.
  - §4: a refusal is any answer but `200` to a paid request (a `402`, a `503`, or any
    other status, known or not), and a paid request left with no answer is reclaimed 180 s
    after it was sent and is then refused like any other; the client keeps one paid
    request in flight to an origin at a time. A refusal whose reclaim finds a proof spent
    loses that payment, and the client pays that origin nothing more, so a lying origin
    takes one payment (was: after a `503` only, and nothing said after a `402`, another
    status or none). With every proof back, confirmed reclaimed or lost to the expiry, it
    may pay again (after a `402`, at the price that `402` names); a `503` or no answer,
    with every proof back, uses no try, and the client pays again later, backing off;
    after three paid requests in a row refused otherwise, it stops paying that origin, and
    only a `200` to a paid request resets the count.
- Draft 2026-09-27 (M2.0 twenty-eighth audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-eighth-audit.md`).
  - §4: a paid request is served only by a `200` whose body, any content coding removed,
    is the requested file, whole (its sha256); one that does not verify, cut short
    included, is a refusal after which the client pays that origin nothing more,
    whatever its reclaim finds (was: any `200` was no refusal, and reset the count).
    Every other refusal, by any answer but a `200` or by none, whose reclaim ends with
    every proof back or lost to the expiry, none spent, uses one of three tries (was: a
    `503` or no answer with every proof back used none). Out of tries, the client pays
    that origin nothing until a back-off of its choosing, never zero, has passed, then
    has three tries again, and SHOULD at least double the back-off each time (was: it
    stopped paying that origin for good); only a served request resets the tries and the
    back-off. A lying origin takes one payment per name (host and port) the client pays,
    at a price within its cap (was: one payment, with nothing said of names or price):
    the client pays only within its price cap, with a token of a mint the origin names
    (was: at whatever price a `402` named), and keeps a standing per origin for as long
    as it keeps the wallet it pays from. A paid request asks for the whole file, with no
    `Range` or conditional header, over HTTPS only, and the client follows no redirect
    with it: a redirect is a refusal by the origin paid. A `1xx` is not a final status.
    The client waits 180 s from sending for a final status, and one that comes later
    changes nothing; it waits at least as long for a `200`'s whole body. The origin
    answers within 60 s, abandoning a swap with no outcome by then (`503`). It SHOULD
    hold the file's verified bytes before it swaps and answer a miss with nothing
    swapped, start its swap by 30 s and only while the request's connection is open,
    and, once it has swapped, keep the connection open for the whole `200`. A payment an
    honest origin's swap took is lost when the client does not get its `200` whole
    within its wait, whatever the cause, its causes named: a stated concession.
  - §3: step 3 checks each proof's DLEQ against its quoted mint's keys for the keyset the
    proof names, cached per mint and per keyset: keys cached for another mint or keyset
    serve no proof they are not for, and a keyset a proof names that the cache does not
    hold (one the mint started since, or an older one a wallet still spends) is fetched.
    What "the keys of that quoted mint" implied, now said.
  - §2: `window` is at least 2 so that a watcher paying once half of it is unpaid, rounded
    up, never stalls the seeder (was: "paying at half the window").
  - §3a: the watcher pays once the account's unpaid count reaches half of `window`, rounded
    up (was: "before the unpaid count reaches `window`"), as `Viewer::due` now says and the
    suite has required.
  - §3a: a quote, taken, refused or dishonest, and an unsolicited `ack` settle nothing of
    another video's payment, even one showing it in both fields; a second quote's price
    and `window` change nothing.
  - §3a: a live session's payment is reclaimed 180 s after sending, whatever came since,
    and holds the one place in flight until it is answered or its 180 s are up; a reclaim
    at 180 s the mint cannot serve yet stays incomplete. A stopped watcher reclaims no
    unanswered payment, live or left by a closed session, before 180 s from sending,
    whatever stopped it and whatever came after, and finishes its incomplete reclaims from
    whichever of the seeder's videos it is watching.
  - §3a: only a `mint-unavailable` answer to a payment uses a try, and only an `ack` or a
    new session's accepted quote restores them: not a refused `hello` (`mint-unavailable`
    included) or quote, a session's end, a timeout, or a closed session's payment
    reclaimed with every proof back or lost to the expiry.
  - §3a: after a payment refused with any code but `mint-unavailable`, known or not, one
    pay/1 sends only for a `hello` or one of another spec's included, the watcher stops
    paying that seeder; a `hello` refused with any code but `banned`, known or not, changes
    nothing.
- Draft 2026-09-29 (M2.0 twenty-ninth audit, `docs/nfx/reviews/2026-09-24-m2.0-twenty-ninth-audit.md`).
  - §4: an origin is its base URL (scheme, host, port and path), as a beacon's `https`
    endpoint names one or the client is given one otherwise; a URL with a query, a
    fragment or credentials names none. A paid request is `GET <base>/<sha256>`. The
    client keeps a standing per base URL, so one origin's answers change nothing of
    another's on the same host, and a lying origin takes one payment per base URL (was:
    a standing per host and port, and `GET /<sha256>`, so one lying tenant stopped
    payments to every origin on its host, used their tries and held their one place in
    flight). Clients that pay from one wallet (devices, NFX-10 §3's browser partitions)
    keep a standing each, and a lying origin takes one payment per base URL from each.
  - §4: the client's token passes the origin's structure check (§3 step 1): one mint,
    `sat`, at most 64 proofs, none locked, each with its DLEQ proof (was: only "worth
    exactly one chunk", so a client could send a token every origin refuses, one whose
    DLEQ proofs its wallet left out, say, and send it again on every try).
  - §4: the headers have a grammar: `X-NFX-Pay` one token, as `pay.token`, of at most
    32 KiB, which an origin SHOULD accept whatever its other header limits;
    `X-NFX-Price` a decimal integer from 1 to 2^53−1; `X-NFX-Mints` 1 to 16 mint URLs in
    RFC 9110's list syntax, each URL's `%` written `%25` and its `,` written `%2C` (was:
    `<sat>` and `<comma list>`, which a mint URL holding a comma made ambiguous, and no
    size, so a server's usual 8 KiB header limit refused a token of many proofs). A
    `402` whose headers are missing or do not parse names no price and no mint, and is a
    refusal like any other.
  - §4: NFX-05 §6's `Access-Control-Allow-Origin: *` is on every answer to a
    hash-addressed `GET`, whatever its status. An origin serving browsers SHOULD answer
    a paid request's CORS preflight with a `204` allowing `X-NFX-Pay`, never a `402`,
    taking no payment, and expose `X-NFX-Price` and `X-NFX-Mints` on every `402`.
    NFX-10 §3.1 says how a browser pays (was: nothing, so no browser could make a paid
    request or read a `402`).
  - §3a: a watcher whose wallet other clients may share pays only with outputs of a
    request of its own at the mint (a swap or a mint), kept where no other client takes
    them, and derives every output from a seed and counters no other client derives
    from, written down before each request is sent and kept until its outcome is learnt;
    §4's client likewise (was: nothing, so a client paying straight from a shared wallet
    could spend a proof another client of it was paying with, and the one refused took
    it for the payee's claim and stopped paying an honest payee for good; and clients
    deriving outputs from one seed could spend or block each other's).
  - §3: in step 3 the seeder uses the keys it holds without asking the mint, and asks for
    a keyset's keys only if the mint's keyset listing (NUT-02) names it. It caches the
    listing per mint and asks for it at most once a second: a payment that finds it asked
    for in the same second, before the payment arrived, waits for the next second's. A
    keyset that a listing asked for after the payment arrived does not name, or whose
    keys the mint answers 12001, is `bad-token` without a ban (was: a keyset a proof named
    that the cache did not hold was fetched, with no bound, and one the mint did not know
    had no stated outcome). A listing that comes at the payment's deadline or later is not
    used, as keys that come then are not.
  - §3: step 5's outputs' keyset is judged by the same per-mint listing, one asked for in
    the second the payment's turn came or later; the seeder asks for it then if the one it
    holds was asked for before that second, within the same once a second, and waits for
    one not yet answered, to the deadline (was: `final_expiry` as the mint lists it, with
    no word on when the listing is asked for). The seeder asks a mint for its listing only
    at its own start or where step 3 or step 5 needs one. Each mint's listing names only
    that mint's keysets and bounds only asks of that mint, and a listing any entry asked
    for after a payment arrived judges its keysets, in the payment's own second too.
  - §3: a seeder that stops serving a video keeps its accounts there. It answers the
    `hello` of a peer it keeps an account for there, or a swap of one whose outcome is
    unknown, as before, with a quote: its wait for a payment in progress (a dead turn taken
    over included), its reads after that wait, its ban and session-id checks as it arrives
    and again as it answers (the ban as it then stands), and the per-peer cap, waiting
    `hello`s counted. It verifies that session's payments as any others, and admits
    nothing of the video, pre-paid chunks included; any other peer's is refused
    `unknown-video` (a banned one's `banned`), as §2's `hello` now says. So a payment there
    awaiting a quote is still settled (was: every `hello` for it was refused
    `unknown-video`, and a payment there credited late left the watcher paying that seeder
    nothing, on any video, for good). A stated concession: a watcher asking for the video
    there may pay ahead after the refusal, which the seeder credits and does not serve,
    within the half window §3a bounds a video's credit to. §2's pre-payment and §3's
    service limit now say a covered chunk is served on a video the seeder serves.
  - §3: a seeder is its long-term identity: the key its beacons are signed with, to which
    they bind its iroh endpoints, or on the mesh the identity its transport gives it. Every
    endpoint it announces serves from its one set of state; a seeder that runs separate
    engines announces each under an identity of its own.
  - §3a: the watcher keys its ledgers and its standing by the seeder's long-term identity,
    never by an endpoint. A ledger lasts as long as the watcher's own identity toward the
    seeder, which the watcher keeps while a payment of the ledger is not yet settled, and
    the standing as long as the wallet it pays from, whatever identity it takes. A stated
    concession: a watcher that loses that identity anyway while a payment of it awaits a
    quote pays that seeder nothing more, for as long as it keeps the wallet. A lying seeder
    takes one payment per seeder identity the watcher pays, as a lying origin takes one per
    standing the client keeps (§4) (was: nothing said of what identifies a seeder or how
    long the standing lasts, and "gets nothing more" unqualified).
  - §2, §3 step 1 and §3a: the watcher pays with a token that passes the seeder's structure
    check: of one quoted mint by its exact URL, in `sat`, of at most 64 proofs, none locked
    (open mode: a licensed video's are P2PK-locked, NFX-08 §4), each with its DLEQ proof. A
    selection that would hold more than 64 proofs is swapped to fewer first (with CDK
    0.18.1, `SendOptions::max_proofs` set to 64). Every payment meets it, however it is made
    (due, ahead, at a session's end), on whichever of the seeder's ledgers, whatever came
    before it (an `ack`, `mint-unavailable`, a reclaim, a settling quote, a resumed session,
    credit held). What step 1 implied, now said.
  - §3a: a quote's `served` is at most the chunks requested of its video and not refused,
    whatever the watcher has paid for: credit it holds, or a payment the quote settles;
    nothing a ledger for another of the seeder's videos holds counts.
  - §3a: the 180 s count from the payment's own sending, never from an input before it: the
    session's quote, the answer to the payment before, the request that made it due, the
    refusal it pays ahead after, a reclaim completing or a settling quote; for every
    payment, however made, on whichever ledger and whatever came before it, and wherever
    the wait is counted, on the live session or by whichever ledger catches a closed
    session's payment up, with a session open (new, or held since before the payment) or
    not, stopped or not. What "from sending" said, now spelled out.
  - §3a: a live payment unanswered at 180 s whose reclaim finds a proof spent leaves the
    watcher stopped: a quote that shows it settles it into the ledger and nothing more, as
    for any payment found spent before the watcher stops, as it stops or since, or left
    unsettled or being reclaimed, whenever it stops; a stop holds whatever the watcher waits
    on when it comes (was: "Either way, a reclaim that finds proofs spent leaves the payment
    awaiting a quote", which read as leave to pay again, and "as it stopped or since" left
    a payment found spent before the stop out).
  - §3a: half of `window`, rounded up, is the due point of each payment (3 of 5), the
    `window` being the session's quote's, and a pay-ahead is half of it, rounded down, less
    the credit held, on whichever ledger and whatever came before the payment. What
    "rounded up" said, now shown.
