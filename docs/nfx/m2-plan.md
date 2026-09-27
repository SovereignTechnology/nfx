# M2 plan: paid delivery, open mode (2026-09-24)

M2 is "paid delivery (open mode) on every transport, browser peers earning sats"
(ADR 0008 §5). The rules are in NFX-07:
- viewers pay **seeders** per chunk in Cashu ecash, over `nfx/pay/1` on iroh and with
  the `X-NFX-*` headers on HTTPS;
- creators earn from zaps (NIP-57), not from the delivery path.

Open mode needs **no mint extension**: seeders take ordinary tokens and swap them at a
quoted mint (NUT-03). NFX-09 (the split mint) belongs to licensed mode, M3.

ADR 0008 §4 puts money code under the demo's **locked-directory rule, with a dedicated
security stage**. In the demo (the execution plan (not published) §0 rule 3 and §3):
- locked paths hold only interfaces, a mock engine and tests until the security stage;
- a CI check fails anything else;
- the real engine is then written in **one serial session** (one worktree, no
  subagents), against adversary tests written beforehand;
- sovtech reads every diff in the locked paths.

## Progress

**M2.0 built (2026-09-24, branch `m2/contracts`), then reworked after each of twenty-one
independent audits** ([first](reviews/2026-09-24-m2.0-independent-audit.md),
[second](reviews/2026-09-24-m2.0-second-audit.md),
[third](reviews/2026-09-24-m2.0-third-audit.md),
[fourth](reviews/2026-09-24-m2.0-fourth-audit.md),
[fifth](reviews/2026-09-24-m2.0-fifth-audit.md),
[sixth](reviews/2026-09-24-m2.0-sixth-audit.md),
[seventh](reviews/2026-09-24-m2.0-seventh-audit.md),
[eighth](reviews/2026-09-24-m2.0-eighth-audit.md),
[ninth](reviews/2026-09-24-m2.0-ninth-audit.md),
[tenth](reviews/2026-09-24-m2.0-tenth-audit.md),
[eleventh](reviews/2026-09-24-m2.0-eleventh-audit.md),
[twelfth](reviews/2026-09-24-m2.0-twelfth-audit.md),
[thirteenth](reviews/2026-09-24-m2.0-thirteenth-audit.md),
[fourteenth](reviews/2026-09-24-m2.0-fourteenth-audit.md),
[fifteenth](reviews/2026-09-24-m2.0-fifteenth-audit.md),
[sixteenth](reviews/2026-09-24-m2.0-sixteenth-audit.md),
[seventeenth](reviews/2026-09-24-m2.0-seventeenth-audit.md),
[eighteenth](reviews/2026-09-24-m2.0-eighteenth-audit.md),
[nineteenth](reviews/2026-09-24-m2.0-nineteenth-audit.md),
[twentieth](reviews/2026-09-24-m2.0-twentieth-audit.md),
[twenty-first](reviews/2026-09-24-m2.0-twenty-first-audit.md),
[twenty-second](reviews/2026-09-24-m2.0-twenty-second-audit.md),
[twenty-third](reviews/2026-09-24-m2.0-twenty-third-audit.md),
[twenty-fourth](reviews/2026-09-24-m2.0-twenty-fourth-audit.md),
[twenty-fifth](reviews/2026-09-24-m2.0-twenty-fifth-audit.md),
[twenty-sixth](reviews/2026-09-24-m2.0-twenty-sixth-audit.md),
[twenty-seventh](reviews/2026-09-24-m2.0-twenty-seventh-audit.md)). sovtech's bar for the push
is zero findings, confirmed after the sixth:
- **Spec (NFX-07, Draft):**
  - The seeder swaps before it acks.
  - Bans and the global cap are seeder-wide, and windows are per account. The global cap
    is a rate (`debt_ttl`) that refuses unpaid service, never paid service: a refused
    watcher pays ahead.
  - Credit covers only its own video.
  - `quote` carries the account's position. Unsettled payments survive a dropped
    connection (a 180 s wait, then the next quote or a reclaim settles them).
  - A reclaim that finds a proof spent leaves that payment awaiting a quote, and the
    watcher pays that seeder nothing until one shows it, so a lying seeder gets at most
    one payment.
  - Configuration minimums and bounded per-identity state.
  - At most 64 proofs per payment; `detail` is printable ASCII; `window` is 2 to 64.
  - HTTPS origins take one payment per request, and a lying origin at most one payment
    per name the client pays, at a price within the client's price cap.
- **Vectors:** `pay1.json` holds 22 valid lines, 3 loopback-only and 74 invalid, each
  checked by the reference reader `spec/test-vectors/pay1.py`. It and the Rust reader
  agreed on every one of 244,149 probe and fuzz cases in the ninth audit.
- **Wire:** `nfx_pay_wire::pay` (re-exported as `nfx_proto::pay`), pure, with writers that
  refuse what a reader with the same options would. It lives in its own crate,
  `nfx-pay-wire`, with the modules it rests on, so that no unpinned module shares its
  crate.
- **Contracts:** `nfx_pay::session`:
  - `SeederEngine` (one seeder), with sessions that are `Send`;
  - `SeederSession`, whose `pay` is cancel-safe;
  - `Viewer` (one watcher's ledger with one seeder, on a clock);
  - `Harness`.
- **Mock:** `nfx_pay::mock` has:
  - a proof-based mock mint: multi-proof tokens, atomic swaps, held swaps or held
    responses, lost responses, requests the swapper gave up on, requests held after
    reserving their inputs (NUT-07 `PENDING`) and their rollback, NUT-07 checks and
    NUT-09 restores of each swap's own outputs under a per-request limit, partial
    claims, mint, restore and state-check outages, unanswered reads that cost time,
    keyset rotation and expiry as CDK has it (the mint's keyset, outputs included, or
    an older one of the payer's; restores blind to an expired keyset), events just
    before the next swap (given-up requests processed or starting, the mint or its
    restores going down, a rotation after the outputs were derived, an expiry), reads
    answered on the reader's next poll, dial records;
  - honest seeder and viewer engines, with a validated configuration.
- **Suite:** `nfx_pay::adversary` has 63 scenarios, each on its own thread under a
  real-time timeout, three of them threaded, run twice (the second time with reads as
  round trips), and **each of 782 planted defects fails a named check in its scenario**
  (a hang, a panic raised outside the suite, a runtime panic of Rust's own, or a bare
  unwrap, is not a catch), every surviving mutant from all twenty-seven audits among them.
- **Since the twenty-seventh audit:**
  - a payment whose turn comes in its deadline's second runs no checks; a `pay` dropped
    before its swap, at any stage, leaves no account and frees the turn only if it held
    it, waking what waits; so does every refusal; a `hello` refused or dropped on any
    path keeps nothing (NFX-07 §3);
  - nothing but its quote or the reclaim settles what the watcher waits on, whatever
    comes between rounds or on another video; it reclaims with or without a session, a
    stopped watcher included, 180 s after sending (NFX-07 §3a);
  - NFX-07 §4: a lying origin takes one payment; a `503` with every proof back uses no
    try;
  - the lock job refuses untracked build output and builds in a fresh directory; the
    runner refuses `unwrap` in any form.
- **Since the twenty-sixth audit:**
  - deadlines on one clock: a refusal is the answer only if the checks reached it by the
    deadline, keys that come in its second are not used, an outcome settled then is late,
    and a payment dropped before its swap frees the turn at once (NFX-07 §3);
  - a takeover is checked for the ban first and reads the abandoned swap; a `hello` checks
    the ban as it arrives and as it answers;
  - refusals keep nothing (no account, place or session id), a banned peer is refused
    before all else, and `spent_total` stays within 2^53−1;
  - the watcher refuses acks at or below its ledger, nothing undoes its stop, it names its
    mint only by the exact URL, and it takes back the inputs left outside a 12003 too;
  - the runner counts only named checks, and the suite has no bare unwrap.
- **Since the twenty-fifth audit:**
  - a turn held past its deadline is freed at the deadline, however late its answer, its
    swap's outcome or a takeover (NFX-07 §3); a payment that takes a dead turn reads the
    abandoned swap first;
  - NFX-07 §3a: the watcher reclaims to the active keyset at once, whatever the proofs'
    own keysets, and the expiry concession is restated on a true premise;
  - the mock's third-party claims are made as a mint allows them, and an older keyset's
    proofs can be held expired;
  - the suite pins short acks, a late "nothing" keeping its chunks in the cap, refused
    requests counting nothing, bans expiring for every first entry, and payments and
    `hello`s behind several payments;
  - the runner no longer counts Rust's own runtime panics in the suite as catches, and
    the lock refuses `#[track_caller]` outside the suite.
- **Since the twenty-fourth audit:**
  - NFX-07 §3 says what the mock does: a `hello` waits while any payment holds its
    account's turn, each to its own deadline; payments take the turn in no set order; a
    waited `hello`'s wait ends at the turn's last freeing before it found it free;
  - NFX-07 §3a: the watcher pays again after a 12003 only if every spent input was its
    own, and proofs lost to the expiry count toward paying again;
  - older-keyset proofs survive a rotation in the mock, as in CDK;
  - one runner for the suite and the mutants, which counts only a failed assertion of the
    suite as a catch; a harness hook that ignores a request fails its scenario.
- **Since the twenty-third audit:**
  - a waited `hello`'s floor is taken as it finds the turn free; a read's coverage is fixed
    as its place is taken, and exactly those swaps are sent;
  - after a 12003, each spent input is decided on its own and the unspent ones per proof,
    whatever the spent ones were; an unanswered NUT-07 check leaves the reclaim incomplete;
    an honest watcher never pays with proofs listed expired;
  - the mock's keysets follow CDK: an expired active keyset takes the proofs already
    issued with it, and expired inputs are refused before anything is reserved;
  - deterministic meeting points for outcomes racing a deadline and for split admissions;
    a blocked engine fails its scenario rather than hanging CI.
- **Since the twenty-second audit:**
  - an entry takes its read's place in the step that finds one free, so entries on
    threads cannot all read; no read is sent or counted at an entry's deadline; a
    `hello` that waited for a payment is served only by a read sent after its wait;
  - after a 12003, spent inputs a restore shows the watcher's own are back, and the rest
    are decided per proof; proofs listed expired are never paid with;
  - the payment side of coverage, reads of swaps in flight, and a mixed token under an
    expired active keyset are pinned.
- **Since the twenty-first audit:**
  - a read serves only entries whose undecided swaps it covered, fixed as it is sent;
    reads count against their own account alone; a round-trip read reaches the mint
    when sent;
  - the payment side of the read rules is pinned;
  - a watcher's reclaim refused 12003 is decided per proof, by each keyset's listed
    expiry against its own clock.
- **Since the twentieth audit:**
  - each read of a second is under way, back or abandoned: an abandoned read counts;
    an entry waits only for a read that would serve it, and reads itself when its
    second ends;
  - a watcher's reclaim refused 12003 is lost to the expiry only if the mint lists the
    proofs' own keyset as expired;
  - the outputs' keyset rule is pinned at its exact margin, before the read, in step 5.
- **Since the nineteenth audit:**
  - withdrawn: "an input spent is the claim" for expired outputs. A claim not learnt
    before its outputs' keyset expires is nothing, a stated concession that keeps the
    seeder's loss bound; the watcher's counterpart is stated in §3a;
  - the outputs' keyset rule is pinned (`Harness::keyset_expires_in`); nothing decides
    by the mint's own expiry state;
  - a reused read's wait ends with its second and at the entry's deadline, and an
    abandoned read leaves its waiters to read themselves.
- **Since the eighteenth audit:**
  - a swap whose outputs' keyset has expired is decided by its inputs alone (a restore
    cannot show it): spent is the claim; the seeder derives outputs only from a keyset
    at least twice `account_ttl` from expiry;
  - 12001 is never a ban; a retry's and a completion's settling reads end at the
    deadline, as do reads after a wait for the turn; a reused read's result is waited
    for;
  - a watcher's reclaim of expired proofs is decided by NUT-07: unspent, it pays again.
- **Since the seventeenth audit:**
  - a payment's reads and completions end 60 s from its arrival however late they
    start, and the watermark is read again after its own read;
  - a read counts in the second it is sent, so two entries at once share one; the
    record of an account's reads counts as held state;
  - a retry refused as invalid is `bad-token` and a ban; every 12003 (an expired
    keyset) is settled only once no input is pending, and CDK's invalid-input code is
    10001.
- **Since the sixteenth audit:**
  - a `pay` reads its account's unknown swaps once, after its checks, and its reads and
    completions end at its deadline;
  - an account's own reads are at most two a second, whatever the proofs;
  - the in-deadline retry goes through the mint's request model, and a retry or first
    attempt refused for good is settled as NFX-07 §3 now lists.
- **Since the fifteenth audit:**
  - a completion is a retry through the mint's request model: `spent` or refused for
    good is settled by restore, pending or unanswered stays unknown;
  - own reads exclude the peer's other videos, follow the ban check, and are at most one
    a second per account (reused by a `hello`, and by a `pay` of the same proofs);
  - an unanswered read is not split, and split answers stay with their swaps.
- **Since the fourteenth audit:**
  - an account's own `hello` and `pay` read only its own unknown swaps; admission reads
    nothing; `SeederEngine::sweep`, a background task in a real engine, reads the rest;
  - a read the mint refuses as too large is split;
  - an unknown swap whose inputs read unspent `account_ttl` after it became unknown is
    completed (sent again, with the same outputs) and credited, not dropped.
- **Since the thirteenth audit:**
  - the mock reads swap state as a real engine must: outside its lock, in one batch,
    applying each decision only to a swap still undecided, and deciding each on its own;
  - a `PENDING` input is not spent; a first attempt refused as pending bans nobody, a
    retry refused so leaves the outcome unknown, and a watcher retries a reclaim refused
    so;
  - an unanswered read proves nothing; a decided swap releases only its own turn, and
    wakes what waits for it;
  - an undecided swap whose inputs read unspent `account_ttl` after it became unknown is
    dropped.
- **Since the twelfth audit:**
  - a swap with no answer, lost or abandoned in flight, is decided by reading its inputs
    (NUT-07), then its outputs (NUT-09): signed is a claim, unsigned with an input spent
    is nothing, and unsigned with every input unspent stays unknown. An honest watcher's
    reclaim spends the inputs, so a request the mint holds (before reserving its inputs,
    as the thirteenth audit found) no longer stalls the pair;
  - a decided swap's record goes, with any turn it holds, and a later answer changes
    nothing;
  - the harness can have the seeder's client give up on a request that stays queued at
    the mint, and have the mint process it between the seeder's two reads;
  - the refusal's scope for a swap in flight, a new peer's pre-payments, a takeover from
    an unpolled holder and a late claim for a peer banned since are pinned.
- **Since the eleventh audit:**
  - a swap abandoned at the deadline while in flight is of unknown outcome: it counts
    toward the bound and keeps its account, and the next payment is answered at once,
    without a swap;
  - the refusal's scope, unanswered restores on both sides, and a quote settling an
    incomplete reclaim only on both fields and its own video, are pinned.
- **Since the tenth audit:**
  - a request that never reached the mint has a known outcome, and at most one swap per
    account is of unknown outcome;
  - a restore finds the swap's own outputs and no other swap's;
  - a quote settles a payment whose reclaim is incomplete;
  - pay-ahead is half the window, rounded down;
  - `check.sh` runs the lock's steps under `env -i`, as the lock job does, so the CI
    `check` job can pass;
  - the desktop and spike lock files include `nfx-pay-wire`.
- **Since the ninth audit:**
  - the pay/1 wire is its own crate, `nfx-pay-wire`, pinned whole; `nfx-pay` depends on
    no other workspace crate;
  - the harness can lose a swap's or a reclaim's response: the seeder retries and
    restores, and never bans on its own swap; the watcher restores before it calls a
    proof spent;
  - a stopped watcher reclaims a live session's refused or unanswered payment, and more
    of what may not restore the `mint-unavailable` tries is tested;
  - a CI-mode run deletes extracted sources only from the job's own `CARGO_HOME`.
- **Since the eighth audit:**
  - the suite covers a ban across videos, a late claim freeing the global cap, a stopped
    standing's catch-up, refused hellos and the `mint-unavailable` count, unknown and
    `banned` hello refusals, and a blocked catch-up's owner;
  - nfx-proto's tests may read only the vectors outside their crate.
- **Since the seventh audit:**
  - the lock is re-scoped to the money crates, failing closed on any target without
    dep-info;
  - `window` is 2 to 64 on the wire;
  - the watcher waits 180 s;
  - arrival is the transport's receipt;
  - bans apply only to peers with an account;
  - a stopped watcher still reclaims.
- **Since the sixth audit:**
  - a watcher's window ceiling;
  - three `mint-unavailable` answers a session;
  - answers belong to their session;
  - the standing reclaims a closed session's payment;
  - path crates outside the workspace are refused;
  - binaries and examples are dep-info checked (in the money crates only since the
    seventh audit);
  - `bash -p`.
- **Since the fifth audit:**
  - one lock decides each payment, with its deadline counted from arrival;
  - a late claim is credited, and a late outcome bans nobody;
  - the watcher keeps one standing per seeder, and a payment found spent awaits a quote;
  - bans expire;
  - the lock job reads its facts before any build and compiles only the money crates.
- **Since the fourth audit:**
  - a `refuse` message;
  - windows per account;
  - a `hello` that waits for a payment in flight;
  - the seeder's 60 s deadline, which abandons a swap;
  - pay-ahead capped by the credit held;
  - `account_ttl`;
  - a separate CI lock job under `env -i`.
- **Locked paths:** `crates/ci/check-locked.sh` runs first, before the build
  (`--sources`) and last (`--compiled`). It pins:
  - the locked stubs;
  - all of `crates/nfx-pay`, and all of `crates/nfx-pay-wire` (the pay/1 parser, the
    modules it rests on, and its vector test): every tracked file, and no untracked one;
  - the vectors and their reference reader;
  - the workspace manifest's build-shaping sections;
  - the check, its helper `locked.py`, `check.sh` and the CI config.

  It refuses a `CARGO_*`/`RUST*` variable outside an allow-list, and any Cargo config
  or toolchain file where cargo reads one. It checks every cached `.crate` against
  `Cargo.lock`. After the build it verifies:
  - every file each money crate's targets compiled (tracked, and in its own crate);
  - the money crates' dependency closure with its unified features, holding no workspace
    crate but themselves;
  - who depends on nfx-pay, and who names it;
  - build scripts and proc-macros;
  - that the money tests ran, all of them.

  Every bypass route the audits found was re-run against the lock of its time: each is
  refused, or out of scope as the check states.

**Before M2.1 writes code in nfx-node's locked paths** (`crates/nfx-node/src/pay/`,
`origin_pay.rs`, stubs today): they move into a money crate of their own, pinned whole.
Inside unpinned nfx-node, any module could change how they compile (tenth audit, #13).
Their code imports the wire from `nfx_pay_wire` directly, not through nfx-proto's
re-export.

## Proposed stages

**M2.0: contracts, mock and adversary tests (unlocked work, any session).**
- A new crate `nfx-pay`:
  - message types and `rej` codes (NFX-07 §2, NFX-11);
  - the `PaymentEngine` traits: `pay` for the viewer, `verify` for the seeder;
  - the `Wallet` trait;
  - a `MockPaymentEngine` with cheating modes: underpay, overpay, foreign mint,
    double spend, stale replay, window overrun.
- The adversary suite, written first and run against the mock: every NFX-07 §3 duty,
  every `rej` code, session isolation, the 32 KiB message cap, and the window gate.
- The **locked paths**, interface-only, plus `crates/ci/check-locked.sh` in CI. It fails
  on any implementation there unless `LOCKED_DIRS_UNLOCKED=1`.
- A testnet mint for development: CDK `cdk-mintd` with its fake Lightning backend,
  in-process in tests.

**M2.1: the security stage (one serial session).** It implements the locked paths
against the suite:
- the real engine on CDK, with exact amounts, a mint allowlist, DLEQ, and async NUT-03
  swap with ban on a double spend;
- the viewer wallet: proof selection and storage, the key file, no plaintext proofs;
- pay/1 over iroh, and the **per-session window gate on blob serving** (the
  "per-member window gate" carried from A2);
- the HTTPS 402 surface on the origin.

Its outputs:
- the suite green against the real engine;
- a security review in `docs/nfx/reviews/`;
- an independent audit;
- **sovtech reads every locked-path diff.**

**M2.2: the paid browser mesh** (NFX-10 §3.2).
- A maintained p2p-media-loader v4 fork: a per-upload gate plus pay/1 framing.
- A web wallet with NIP-60 write-through: proofs never in browser storage.
- The bridge charges browsers like any seeder.
- Its own locked paths and review.

**M2 exit run:** a paying viewer on each transport, across hosts, with a real mint
(testnet, fake Lightning).

## Proposed locked paths

- `crates/nfx-pay/src/engine/`: verification, swap, bans.
- `crates/nfx-pay/src/wallet/`: proof selection, storage, spend.
- `crates/nfx-pay/src/protocol/`: the pay/1 state machine and window accounting.
- `crates/nfx-node/src/pay/`: the transport glue, i.e. the pay/1 ALPN and the window
  gate on blob serving.
- `crates/nfx-node/src/origin_pay.rs`: the 402 surface.
- M2.2: `web/wallet/` and the fork's upload gate.

## Decided (sovtech, 2026-09-24)

- **The demo's staging:** M2.0 is contracts, mock and adversary tests. M2.1 is one
  serial security session whose locked-path diffs sovtech reads.
- **The testnet mint is persistent:** CDK `cdk-mintd` with its fake Lightning backend,
  on private infrastructure. Tests still use an in-process mint.
- The locked paths and the order (iroh, HTTPS, then the mesh) stand as proposed.

## The testnet mint

A persistent testnet mint (CDK `cdk-mintd` with its fake Lightning backend and SQLite)
runs on private infrastructure. Its deployment and its audits are recorded privately.

## Decisions (as asked)

1. Adopt the demo's staging for M2 (mock and adversary tests first; the real money path
   in one serial security session whose locked diffs you read)?
2. The locked paths above?
3. Where the development and exit-run mint runs:
   - in-process for tests plus a transient mint on host-b for the exit run
     (recommended);
   - a persistent testnet mint;
   - a public test mint. Not recommended: a third party in the money path.
4. The order: iroh first, then HTTPS, then the browser mesh last (recommended; the
   mesh needs the fork and a web wallet)?
