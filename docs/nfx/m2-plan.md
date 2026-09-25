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

**M2.0 built (2026-09-24, branch `m2/contracts`), then reworked after four independent
audits** ([first](reviews/2026-09-24-m2.0-independent-audit.md),
[second](reviews/2026-09-24-m2.0-second-audit.md),
[third](reviews/2026-09-24-m2.0-third-audit.md),
[fourth](reviews/2026-09-24-m2.0-fourth-audit.md),
[fifth](reviews/2026-09-24-m2.0-fifth-audit.md),
[sixth](reviews/2026-09-24-m2.0-sixth-audit.md),
[seventh](reviews/2026-09-24-m2.0-seventh-audit.md)). sovtech's bar for the push is zero
findings, confirmed after the sixth:
- **Spec (NFX-07, Draft):**
  - The seeder swaps before it acks.
  - Bounds and bans are seeder-wide. The global cap is a rate (`debt_ttl`) that refuses
    unpaid service, never paid service: a refused watcher pays ahead.
  - Credit covers only its own video.
  - `quote` carries the account's position. Unsettled payments survive a dropped
    connection (a 120 s wait, then the next quote or a reclaim settles them).
  - A reclaim that finds a proof spent loses that payment and stops the watcher, so a
    lying seeder gets at most one payment.
  - Configuration minimums and bounded per-identity state.
  - At most 64 proofs per payment; `detail` is printable ASCII; `window` ≥ 2.
  - HTTPS origins take one payment per request.
- **Vectors:** `pay1.json` holds 20 valid lines, 3 loopback-only and 83 invalid, each
  checked by the reference reader `spec/test-vectors/pay1.py`. It and the Rust reader
  agree on 20,141 probe and fuzz cases.
- **Wire:** `nfx_proto::pay`, pure, with writers that refuse what a reader with the same
  options would.
- **Contracts:** `nfx_pay::session`:
  - `SeederEngine` (one seeder), with sessions that are `Send`;
  - `SeederSession`, whose `pay` is cancel-safe;
  - `Viewer` (one watcher's ledger with one seeder, on a clock);
  - `Harness`.
- **Mock:** `nfx_pay::mock` has:
  - a proof-based mock mint: multi-proof tokens, atomic swaps, held swaps or held
    responses, outages, dial records;
  - honest seeder and viewer engines, with a validated configuration.
- **Suite:** `nfx_pay::adversary` has 62 scenarios, each under a timeout, one of them
  threaded, and **each of 174 planted defects fails its scenario**, every surviving mutant
  from all seven audits among them.
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
  - all of `crates/nfx-pay`;
  - the pay/1 parser with nfx-proto's `lib.rs`, `error.rs`, manifest and the modules the
    parser rests on;
  - the parser's tests, vectors and reference reader;
  - the workspace manifest's build-shaping sections;
  - the check, its helper `locked.py`, `check.sh` and the CI config.

  It refuses a `CARGO_*`/`RUST*` variable outside an allow-list, and any Cargo config
  or toolchain file where cargo reads one. It checks every cached `.crate` against
  `Cargo.lock`. After the build it verifies:
  - every file every workspace target compiled (tracked, and in its own crate);
  - nfx-pay's dependency closure with its unified features;
  - who depends on nfx-pay, and who names it;
  - build scripts and proc-macros;
  - that the money tests ran, all of them.

  37 bypass attempts were refused.

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
