# Security Policy

## Supported versions

The project is pre-release. There is no released version yet, so there is nothing to
backport fixes to. Once a `1.0.0` ships, this table gets filled in.

## Reporting a vulnerability

**Do not open a public issue.** Email <git@sovit.xyz> with:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- affected commit or version
- any suggested remediation

You should get an acknowledgement within 7 days. Please allow a reasonable window for a
fix to be prepared and released before disclosing publicly. Reporters are credited in the
release notes unless they ask not to be.

## Scope

In scope: anything in this repository. Out of scope: the hosting infrastructure, and
issues that require an already-compromised machine or physical access.

---

## Guiding rule

**Bound the loss of any single interaction to a block's worth of sats, verify before you
pay, and never trust a peer or a server for anything you can check yourself.**

## Threat model

This table is the normative source for the adversary test suite
(`packages/core/src/payment/__tests__/`, `packages/core/src/pay-protocol/__tests__/`,
`packages/gateway/src/auth/__tests__/`). Every row has a named test. It is reproduced
verbatim from `docs/plan/build-plan.md` §1; change it there first.

| # | Actor | Attack | Control | Residual loss |
|---|-------|--------|---------|---------------|
| T1 | Malicious seeder | Serves wrong bytes | Hypercore Merkle proof per block, before `download` fires | 0 |
| T2 | Malicious seeder | Stalls | Hypercore already multi-sources; per-peer timeout, drop | Time |
| T3 | Malicious viewer | Downloads, never pays | Window (4 blocks), then stream destroy + ban | ~4 blocks of sats |
| T4 | Malicious viewer | Pays seeder, stiffs creator | Seeder requires both proof sets | 0 |
| T5 | Malicious viewer | Double-spends | DLEQ offline check; async swap at mint; ban on failure | ≤ window |
| T6 | MITM | Steals proofs in flight | Noise secret-stream + P2PK lock to recipient | 0 |
| T7 | Any peer | Forged proofs | NUT-12 DLEQ against cached mint keyset | 0 |
| T8 | Mint | Rug / compromise | Small balances, creator-chosen mint, one-click melt-out, mint shown in UI | Balance at that mint |
| T9 | Impostor creator | Fake video under real title | Signed NIP-71 event; UI shows verified pubkey/NIP-05, not just display name | Reputation |
| T10 | Sybil seeders | Join topic, serve nothing | Pay-after-verify makes them unprofitable; peer reputation | Time |
| T11 | Internet | DoS seeder/gateway | Per-pubkey rate limits, max streams, OS hardening | Availability |
| T12 | npm | Compromised dep | Lockfile, `npm ci --ignore-scripts`, exact pins, native module audit | Depends |
| T13 | Portal operator | Malicious JS | Open source, reproducible build, hash in signed Nostr event, SRI, CSP. **Not fully fixable in a browser — say so in the UI.** | Web session |
| T14 | Host | Keys read from disk/logs | Encrypted at rest, secure memory, log redaction | Keys on host |
| T15 | Content | XSS via titles/descriptions/comments | Render as text or sanitized markdown; CSP no-inline; Electron `contextIsolation`, no `nodeIntegration`, sandboxed renderer | 0 |
| T16 | Content | Malicious thumbnail/blob | Thumbnails are Blossom blobs with `x` hash in imeta; verify before display; images decoded in renderer only | 0 |

## Non-negotiable invariants of the money path

Specified in `docs/plan/build-plan.md` §1–§3 and enforced by the adversary tests:

1. **Pay after verify.** A viewer pays only for blocks Hypercore has emitted `download`
   for from that specific peer. Hypercore does not emit `download` for a block that failed
   its Merkle proof.
2. **Exact amounts.** A `PAY` must cover exactly `blocks × price` split per the video's
   `split` tag. Underpayment and overpayment are both rejected.
3. **Two locked sets.** Every `PAY` carries a seeder proof set and a creator proof set,
   each P2PK-locked (NUT-11) to its recipient, each carrying DLEQ (NUT-12).
4. **Offline verification before `ACK`.** DLEQ against the cached mint keyset, P2PK target
   check, amount check, mint allowlist — all before the seeder acknowledges.
5. **Window then cut.** `uploaded − paid` per peer may not exceed the window (default 4
   blocks). Past it the seeder destroys the stream and bans the pubkey.
6. **Ban on double-spend.** An async swap at the mint that reports an already-spent proof
   bans the paying pubkey; the ban list is persisted.
7. **No key or proof in a log, ever.** A redaction layer sits in front of every logger.
8. **No browser persistence of proofs or keys.** The web shell holds NIP-60 state in memory
   only.

## Locked directories {#locked}

These directories are the audit surface. Until Stage 2 of the execution plan (not published) they
contain **only** interfaces, re-exports and tests (`MockPaymentEngine` lives in
`packages/core/src/mocks/`, outside the lock). CODEOWNERS plus
`scripts/check-locked-dirs.sh` fail any change that adds implementation there.

```
packages/core/src/payment/
packages/core/src/signer/
packages/core/src/pay-protocol/
packages/core/src/wallet/spend.ts
packages/gateway/src/auth/
```

## No model writes crypto

Hashing, signatures, blinding, DLEQ, key derivation and secure memory come from
`@cashu/cashu-ts`, `sodium-native` / `sodium-universal`, `nostr-tools` and `hypercore`.
Any contributor — human or agent — who finds themselves implementing one of these stops
and reports.
