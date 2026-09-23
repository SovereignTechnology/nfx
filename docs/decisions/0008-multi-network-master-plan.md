# 8. The multi-network master plan (nfx): a second track beside the Pear demo, add-only until a harvest gate

Date: 2026-09-23

## Status

Accepted (decisions by sovtech, 2026-09-23). The number 0008 is reserved for this
record in both repositories; the demo's own ADRs are 0001–0005, 0007 and 0009 onward.
The demo's ADR 0007 (contracts v4 and the per-PAY split) is a different record.

## Context

ADR 0006 made the NFX suite (`spec/`) normative for the redesign: iroh, content-
addressed CMAF segments, scoped-relay beacons, open and licensed payment modes. That
decision left two things open:

1. **Who builds NFX, and where.** The TypeScript repository (the private demo repository) is a
   Pear-runtime-only desktop demo that is **still being built** under its own plan:
   its L5 screens are merged, and the L4/L5 fix lanes, L6 (Electron + pear-runtime
   shell), L7, the Stage 2 money path and Stage 3 all lie ahead. sovtech wants the demo
   finished first and expects to reuse most of it.
2. **Whether the frozen and draft texts survive first contact with an implementation.**
   Nothing implemented NFX yet, and the suite still used the brand `nutflix` in wire
   identifiers. That contradicts build plan §9.11, under which a forced product rename
   should touch only the icon and README.

## Decision

### 1. Two tracks, one of them untouched

- **Track 1, the demo** (a local clone, the private demo repository) finishes as the
  Pear-runtime-only app, untouched by this plan: no merges into it, no banners, no
  freeze, no archive.
- **Track 2, the master plan** lives in a new repository, **the private GitLab project** on
  `gitlab.example.invalid` (a local clone). It was cloned from the demo at branch
  `spec/nfx-suite-m0` (`8f3b9bd`) with full history, then merged with demo `main`
  (`0e35347`). In the public repository the demo's history ends at the tag `demo-base`; later demo
commits are scrubbed like the rest before they are merged.

### 2. Brand-neutral wire token: `nfx`

NFX-01 is re-frozen at M0 with the token `nfx`: namespaces `nfx:mainnet:1`,
`nfx:testnet:1`, `nfx:regtest:1`; ALPNs `nfx/pay/1` and `nfx/gossip/1`; HTTP headers
`X-NFX-*`; capability keys `"nfx"` in NIP-11 and NUT-06. Nothing implemented or
published the old token, so the re-freeze replaced it in place instead of bumping
`specver`. `nutflix:*` namespaces are void. The test vectors were regenerated.

### 3. Add-only until the harvest gate

Master-plan work goes only in `spec/`, `crates/`, `web/` and `docs/nfx/`, plus this
record, the ADR 0006 amendment note and the repository's working notes (not published). The mirrored demo paths
(`packages/`, `docs/plan`, `docs/lanes`, `docs/handoff`, `docs/status.md`, `scripts/`)
are never edited here. So `git merge demo/main` stays conflict-free, and the invariant
is checkable: `git diff demo/main...HEAD -- <those paths>` is empty (three-dot:
changes on this side since the merge base).

**Harvest gate.** When the demo reaches its own finish line, i.e. its Stage 1 exit
plus the Stage 2 security pass or whatever sovtech declares done: tag a demo release,
`git merge demo/<tag>`, then reshape. The demo's UI screens (behind a contracts v4
`NetworkAdapter` shaped for NFX), its Nostr layer, the audited TypeScript money path
and its cheat-mode corpus, the Hypercore seeder (as the NFX-12 sidecar) and its
supply-chain CI move into the master-plan layout. Only then are mirrored paths
edited.

### 4. Stack

| Topic | Decision |
|---|---|
| Transports | iroh (native), WebRTC via p2p-media-loader v4 + hls.js (browser), HTTPS origins behind a CDN (required by NFX anyway), and Hypercore as an optional NFX-12 profile with no Pear dependency |
| Media | One stored format: CMAF fMP4 segments named by sha256 (NFX-05); playlists are tiny derived text; no progressive MP4 |
| Runtime | Tauri 2 + a Rust core: one `nfx-node` library behind the desktop app, the headless `nfxd` and the pull-through origin |
| Verification in the browser | `nfx-proto` compiled to WASM, so manifest and hash-list verification has one implementation |
| Money code | `nfx-wallet`, pay/1, the mint extension and the web wallet follow the demo's locked-directory rule and get a dedicated security stage |
| Crypto | Libraries only (iroh, CDK, nostr-sdk, RustCrypto, libsodium); nothing hand-written |

### 5. Milestones

- **Phase A (now, needs no demo code):** A0 repository, this record and the spec
  amendments; A1 spikes S1 iroh, S2 Tauri playback, S3 web mesh, S4 CMAF packaging; A2
  the Rust M1 data plane (`nfx-proto`, `nfx-media`, `nfx-node`, `nfxd`, scoped relay,
  test player page).
- **M1:** free end-to-end slice on testnet. **M2:** paid delivery (open mode) on every
  transport, browser peers earning sats. **M3:** licensed mode, which is how creators
  get paid. Later: freeze NFX-10 and NFX-12, a BitTorrent v2 profile, nsite hosting,
  upstream kind registration. Spike S5 (Bare vs Node sidecar) runs at the harvest.

### 6. Spec amendments made with this record

| # | Where | Change |
|---|---|---|
| 1 | ADR 0006 | Present tense for the demo; amendment note |
| 2 | NFX-01, all docs, schemas, vectors | Wire token `nfx`; NFX-01 re-frozen at M0; exactly one `n` tag per event |
| 3 | NFX-08 §4, §4.1; NFX-09 §§1–2 | Licensed chunk proofs P2PK-locked (NUT-11) to the mint's advertised `redeem_pubkey`; seeders check the lock and DLEQ (NUT-12) offline before `ack` (`bad-lock`). Closes the bypass where a seeder swapped bearer proofs directly and kept 100% |
| 3b | NFX-09 §2 | Mint-side **carry** per root replaces per-redemption ceiling rounding. Under ceiling rounding a seeder redeeming 1-sat proofs one at a time kept the creator at 0 for any split. The fix follows the demo's own ADR 0005 erratum / ADR 0007; per root rather than per seeder because keys are free |
| 4 | NFX-08 §4, NFX-09 §2 | `key_price` accrues to the creator's `cashu_key`, P2PK-locked, claimable |
| 5 | NFX-10 §3 | Paid browser mesh: pay/1 on the p2p-media-loader data channel through a maintained v4 fork with a per-upload gate; window counted in whole NFX-05 files; earnings written through to NIP-60, never to browser storage |
| 6 | NFX-12 (new) | Draft Hypercore profile: a Hyperdrive per seeder per video, a `hyper` beacon endpoint, a per-video Hyperswarm topic, pay/1 over Protomux, sha256 re-anchoring |
| 7 | NFX-05 §6 | `immutable` caching and its limits, the pull-through origin role, public caching of licensed ciphertext |
| 8 | NFX-04 §7 | A seeder node MAY embed a scoped relay |
| 9 | NFX-06 §1, NFX-11 §4 | iroh pinned to the 1.x series (iroh/iroh-relay 1.x, iroh-blobs 0.103, iroh-gossip 0.101); each network runs its own `iroh-relay` |

Implementation-driven fixes found while writing `nfx-proto` and the vectors. All are
in Draft documents except the single-`n` rule, which rode the NFX-01 re-freeze:

- **Canonical JSON made exact and moved to NFX-11 §9.** It covers escaping, the
  integer-only domain, and rejecting `-0`, duplicate keys and lone surrogates. It also
  pins code-point key order, which JavaScript's default sort gets wrong. New
  `canon.json` vectors.
- **NFX-02:** single-valued tags at most once, and a pinned integer grammar.
  **NFX-03:** unknown endpoint types are skipped. The schema previously enumerated
  them, which made every new transport a breaking change.
- **NFX-05 §6:** origins serve `/<root>/<sha256>.<ext>`. That is the path a player
  pointed at `/<root>/master.m3u8` actually requests, and it was undefined. §2 now
  states the rendition rules.
- **NFX-06 §4:** the gossip envelope carries `pubkey`. Without it there was nothing to
  verify `sig` against.
- New vectors: invalid manifests (signed), open-mode manifest, invalid beacons,
  invalid hash lists and playlists, voucher, gossip envelope, derived identifiers.

**Open issues recorded, not decided** (NFX-07 §7, NFX-08 §7, NFX-09 §6):
- mint state is keyed by a bare `root`, which allows escrow squatting and leaves "the
  manifest" ambiguous;
- the voucher path of `license` is unauthenticated;
- `accepts_mints` absent means "any";
- fee handling is unspecified;
- `redeem` mints `seeder_proofs` with secrets the mint chose.

All must close before their document's freeze.

## Consequences

- The demo is never blocked by, merged into, or reshaped for this plan. Its handoff is
  not a resume point here, and the repository's working notes (not published) and `docs/nfx/status.md` say so.
- The private GitLab project was first pushed on 2026-09-23.
- Demo progress can be merged in at any time without conflicts. The same holds for
  ADR numbers: 0008 is reserved in the demo, as 0006 was.
- `nfx-proto` reproduces every vector byte for byte, natively and in WASM. It is the
  conformance oracle for later TypeScript and Rust code.
- Implementing M3 before the open issues close would build on an ambiguous mint API.
  The issues are therefore gates, not notes.
