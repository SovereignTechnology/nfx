# 5. Build-plan §9 open questions resolved for Stage 1/2 defaults

Date: 2026-09-05

## Status

Accepted (answers given by sovtech via the orchestrator's batched question, 2026-09-05)

## Context

`docs/plan/build-plan.md` §9 left several defaults open. Wave 1 + L3 built against
placeholders (`windowBlocks = 4`, several mints, flat gateway markup, verbatim uploads) and
L10 found a rounding gap that turns an honest 1-sat PAY into a rejection. None of these
block Wave 2, but Stage 2 writes contract text and the real engine against them, so they
were batched into one question and are recorded here. Items marked **contract text** land at
the Stage 2 bump (v4); items marked **config/lane** are ordinary code changes.

## Decisions

### Q1 — window size and split rounding → keep `windowBlocks = 4`; **round the seeder share UP**

- `windowBlocks` default stays **4** (contracts unchanged).
- **Rounding rule (contract text at v4):** for a PAY of `amount = blocks × satsPerBlock`
  sats and a split `{ seeder: s, creator: c }` (percent, `s + c = 100`):
  `seederSats = ceil(amount × s / 100)`, `creatorSats = amount − seederSats`.
  Consequences: when `amount ≥ 2` and both `s, c > 0`, both shares are ≥ 1 sat, so a
  1-block PAY at `satsPerBlock = 1` (amount 1) puts the whole sat on the **seeder** set and
  the creator set is legitimately empty for that PAY. The seeder verifies with the same
  formula (invariant 2: exact amounts, computed identically on both sides). `MockPaymentEngine`
  and `PaymentEngine` must apply exactly this; L10's `missing-seeder-set` expectation for an
  honest PAY becomes "creator set may be empty only when `creatorSats = 0` by this formula".
  Rejected alternatives: a minimum PAY of N blocks (needs an end-of-video special case) and a
  `satsPerBlock ≥ 2` floor (raises the minimum price for every video).
- Until the v4 bump, L10's property tests keep filtering to shares ≥ 1 (documented in
  the lane report (not published)); the mock is **not** changed mid-freeze.

### Q2 — mints per video → **several** (keep as is)

`PricePolicy.mints[]` / `HELLO.acceptedMints[]` stay lists. The viewer pays from whichever
listed mint it holds proofs for; the gateway (L3) already picks the seeder's first listed mint
it can pay with. No change.

### Q4 — gateway markup → **percentage**, not flat per-block (**config/lane change in `packages/gateway`**)

L3 shipped `markupSatsPerBlock` (flat, default 0). sovtech chose a percentage. Shape:
`markupPercent` (integer ≥ 0, default **0**) replaces `markupSatsPerBlock`;
`gatewaySatsPerBlock = ceil(policy.satsPerBlock × (100 + markupPercent) / 100)` — ceil so
the gateway never undercharges itself and the result is always an integer number of sats
(prices are integers on the wire). `HELLO` discloses the resulting `satsPerBlock` exactly as
today; the embedded seeder verifies downstream PAYs against the marked-up policy exactly as
today. This is a config-schema + `gatewayPrice()`/`gatewayPolicy()` change in
`packages/gateway/src/config.ts` and its tests, **not** a contract change (the wire carries
the final price). Owed as an orchestrator-issued follow-up lane (`L3-markup`, gateway package
only, no deps) — see `docs/status.md`.

### Q8 — gateway-side transcode of web uploads → **in scope for Stage 3**, not Stage 1

`PUT /upload` keeps storing bytes verbatim (BUD-02) through Stage 1/2; `allowedMimeTypes` is
the operator's lever. Stage 3 adds a gateway-side pipeline reusing `@sovit/core/media`
(pure planning) with a `child_process` `ProcessRunner`, producing the same rendition ladder
L8 produces on desktop. Not a Wave 2 task; do not start it in L7.

### Shipped `ffmpeg` → **require a system `ffmpeg`**, do not bundle

The desktop bundle does not ship an ffmpeg binary. L6 resolves `ffmpeg` from `PATH` (and an
optional explicit path in Settings), injects it into L8's pipeline, and when it is absent the
Studio upload screen shows a clear "ffmpeg not found" state with per-OS install instructions
(L5 Studio screen gets that state; L6 provides the probe). L8's design is unaffected
(injected path). `media/FFMPEG-PIN.md` remains the dev/CI pin only.

### L3 Blossom defaults → **all confirmed as built**

- `GET /list/<pubkey>` served unauthenticated (public descriptors, hashes only).
- `PUT /mirror` off by default; enabled only via `blossom.allowMirror` + `mirrorAllowedHosts`.
- `DELETE` → 405 (deletion is an operator action).
- `--dev-mocks` kept, loopback-fenced (exit 78 on a non-loopback `listen.host`), for L7
  development before Stage 2.

### L6 dependency approval → **Electron pinned**

`electron@44.2.0` approved as a devDependency of `packages/app-desktop` (orchestrator pins it
on `main` before L6 fan-out; the binary download is run once by hand because `.npmrc` has
`ignore-scripts`). Together with `pear-runtime@1.3.1`, `hypercore-blob-server@1.15.0`
(app-desktop), `sodium-javascript@0.8.0`, `@noble/curves@1.9.7`, `esbuild@0.28.2` (app-web,
per spike S-B), `playwright-core@1.63.0` (ui screenshots against the local browser).

### L4 theme default → **light + dark, follow system**

Both themes exist as tokens; `prefers-color-scheme` picks the default; Settings offers a
toggle. Recorded alongside the design brief in `docs/design/README.md`.

## Consequences

- Stage 2 (v4) contract text: Q1 rounding formula on `PricePolicy.split` / `PAY` verification;
  `BlockRange.core` + `recordUpload` `core` required (ADR 0004); `PRICE` gains `core`
  (L3 observation).
- Orchestrator follow-up lane: `L3-markup` (percentage markup in `packages/gateway`).
- L6 brief: no bundled ffmpeg; system-ffmpeg probe + "not found" state.
- L5 Studio brief: an "ffmpeg not found" state with install instructions.
- `docs/status.md` "Inputs still needed from sovtech" is now empty for Wave 2.

## Erratum (2026-09-23) — Q1's stated consequence is wrong; the rule itself is unchanged

Found by lane L5-Studio, verified by the orchestrator. Q1 says "when `amount ≥ 2` and both
`s, c > 0`, both shares are ≥ 1 sat". That is false. The rule above is untouched; only the
consequence was misstated. Correctly:

- `creatorSats = amount − ceil(amount × s / 100) = floor(amount × c / 100)`, so
  **`creatorSats = 0` exactly when `amount × c < 100`**, not only when `amount = 1`.
- `seederSats ≥ 1` whenever `amount ≥ 1` and `s > 0`.
- Counter-examples to the old text: `amount 2, split 99/1 → 2/0`; `amount 2, 51/49 → 2/0`;
  `amount 3, 70/30 → 3/0`.

**Economic consequence (open for sovtech, not decided here):** with the default window of 4
blocks at `satsPerBlock = 1`, a PAY is 4 sats, so any split with `c < 25` pays the creator
nothing on every PAY. At `c = 10` the creator only earns on PAYs of ≥ 10 sats. Round-up
favours the seeder by up to 1 sat per PAY, and at small PAYs that 1 sat is the whole creator
share. Options include carrying the creator's fractional remainder across PAYs, rounding
the creator share up instead, or a minimum PAY size. The v4 contract text must state
whichever rule is chosen.

Unaffected: L10's honest-PAY expectation ("the creator set may be empty only when
`creatorSats = 0` by this formula") was already stated in terms of the formula and remains
correct. Studio's split UI shows the formula's real output, including the zero case.
