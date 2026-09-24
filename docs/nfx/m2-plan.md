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

**M2.0 built (2026-09-24, branch `m2/contracts`), then reworked after two independent
audits** ([first](reviews/2026-09-24-m2.0-independent-audit.md),
[second](reviews/2026-09-24-m2.0-second-audit.md)):
- **Spec (NFX-07, Draft):**
  - §2 message rules:
    - the NFX-11 §9 value rules and a nesting limit;
    - unit `sat`;
    - mint URLs with a parsed authority, and base64 tokens;
    - limits on `rej` codes and details;
    - a `quote` that carries the account's position.
  - §3: **swap before ack**.
    - Windows, bans and the global cap are seeder-wide, and the window is per peer
      across its videos.
    - Pre-paid chunks are served whatever the cap.
    - Unpaid chunks count toward the cap for `debt_ttl`, so the bound is a rate.
    - One account's payments are serialised.
    - The checks run structure, mint, DLEQ, amount, swap. New code `mint-unavailable`.
  - §3a: the watcher's ledger across sessions, with reclaim after every refusal.
  - §4: HTTPS origins take one payment per request, swapped before the response, with no
    credit.
  - NFX-10 §3.2 and NFX-11 §5/§6 follow.
- **Vectors:** `pay1.json` holds 18 valid lines, 3 valid only with loopback allowed, and
  66 invalid lines. The generator checks every verdict against its own reference reader.
  The Rust reader agrees with that reference on all 4,141 cases tried: the second
  audit's 141 probes and 4,000 fuzzed lines.
- **Wire:** `nfx_proto::pay` parses pay/1 through `canon`. Its writers refuse what a
  reader with the same options would. It is pure, so the web wallet can use it through
  WASM.
- **Contracts:** `nfx_pay::session` defines `SeederEngine` (one seeder), `SeederSession`,
  `Viewer` (one watcher's ledger with one seeder) and `Harness`.
- **Mock:** `nfx_pay::mock` has:
  - a proof-based mock mint network: multi-proof tokens, atomic swaps that can be held,
    an outage switch and a record of dialled URLs;
  - honest seeder and viewer engines on a harness clock, with plantable flaws.
- **Suite:** `nfx_pay::adversary` has 35 scenarios, run through `adversary_suite!`.
  - They pass against the honest mock.
  - **Each of 61 planted defects fails its scenario** (`tests/mutants.rs`). The defects
    include every mutant both audits ran.
- **Locked paths:** `crates/ci/check-locked.sh` runs first in `check.sh`, then again last
  with `--compiled`. It pins, from git by mode and content (`locked.sha256`):
  - the locked stubs;
  - all of `crates/nfx-pay`;
  - the pay/1 parser and the modules it rests on;
  - the workspace manifest's profile, patch, replace and lints sections;
  - the check, its helper `locked.py`, `check.sh` and the CI config.

  After the build it also verifies (`locked-compiled.txt`):
  - every file the compiler read for nfx-pay is pinned;
  - nfx-node's library reads nothing from outside its crate;
  - only locked paths name `nfx_pay`;
  - nfx-pay's resolved dependency closure, the crates allowed to depend on it, and the
    workspace's build scripts and proc-macros.

  It also refuses tracked Cargo configuration. Re-pinning needs `LOCKED_DIRS_UNLOCKED=1`,
  and neither is allowed in CI. 23 bypass attempts were refused, each for its intended
  reason.

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
