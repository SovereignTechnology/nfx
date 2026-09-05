# 4. Contracts v3: release-notice kind, `hyper://` grammar, per-core PAY, `rebind`

Date: 2026-09-04

## Status

Accepted

## Context

Stage 1 Wave 1 (L9, L1, L10, L2, L8) merged against `CONTRACTS_VERSION = 2`. It produced one
formal contract request (`docs/contract-requests/L9.md`), one doc/code divergence (L1 and L8
both implement a `hyper://` grammar the contract comment does not describe), and two flags
from L2 (the lane report (not published) "Assumptions and decisions") that are not requests but describe
workarounds the seeder had to make inside the v2 shape. `docs/status.md` batched all of them
into one bump before Wave 2 so no Wave 2 lane is issued against a contract known to be wrong.

Constraint on the bump: `main` must stay green and every Wave 1 lane's merged code must still
compile, because re-issuing L2 and L10 is not in Wave 2's critical path. So v3 is **additive**.

## Decision

### (a) `NostrKind.ReleaseNotice = 30071`, not 30063

Build-plan §7 / threat T13 needs a Nostr kind for the reproducible-build hash event that the
org key signs. L9 asked for 30063 "from memory". The vendored `docs/vendor/NIP-51.md` defines
**30063 = "Release artifact sets"** with `d` = `<app-id>@<version>`, `e` tags pointing at
kind-1063 file-metadata events and an `a` tag to a kind-32267 software-application event.
Our event is a different shape (`d` = app id, `x` = sha256 of a dist *tree*, no 1063 events),
so reusing 30063 would collide with Zapstore-style consumers and mislead ours.

30071 is in the addressable range (30000–39999, so `d` makes it replaceable per app id) and
appears in no vendored spec (`grep -rhoE '\b3[0-9]{4}\b' docs/vendor/*.md`). Collision
policy: if a public registry assignment ever appears for 30071, the only two places to change
are `NostrKind.ReleaseNotice` and the `RELEASE_NOTICE_KIND` default in
`scripts/reproducible-build.mjs`; `scripts/__tests__/reproducible-build.test.ts` asserts the
two agree, because the `.mjs` cannot import the TS contracts. If Zapstore interop is ever
wanted, emit a real 30063 + 1063 pair *in addition*; L7 verifies against `ReleaseNotice`.

### (b) `hyperUrl` grammar is hex, and the contract now says so

`contracts/manifest.ts` said `hyper://<z32 core key>/<blob-id-encoded>`. What is actually
implemented — by L1 (`manifest/hyper-url.ts`), L8 (`media/hyper-url.ts`) and the fixtures the
contract told them to round-trip (`mocks/fixtures.ts`) — is
`hyper://<64-char lower-case hex core key>/<blockOffset>-<blockLength>[+<byteOffset>]`, with
`byteLength` taken from the imeta `size`. The code is consistent and tested; the comment was
wrong. Fixed the comment (and the `CoreKeyHex` primitive's remark). z32 is **not** accepted;
adding it later is a parser widening, not a contract change.

### (c) L2 flag 1 — `PayMessage` carries no core key → ACCEPTED: `BlockRange.core`

**The gap is real and it is a money-path gap, not an ergonomics one.** A Corestore
replication stream carries every core the two sides share over one `pay/1` channel; that is
how Corestore works and how a multi-video seeder or a gateway will always run. `PricePolicy`
is **per video** (`satsPerBlock`, `mints`, `split`, and above all `creatorP2pk` from the
creator's kind 10019). With no core in the `PAY`, the seeder cannot know which policy to
verify against, so:

- **T4 (stiff the creator)** is unverifiable: a viewer can lock the creator set to creator A's
  P2PK while downloading creator B's blocks, and the check passes if A's video is also seeded
  on that connection.
- **Invariant 2 (exact amount)** is unverifiable across videos with different
  `satsPerBlock`: pay the cheap video's price for the expensive video's blocks.
- **`range-not-uploaded` / `range-already-paid`** are per-core properties (block indexes are
  only meaningful inside a core), so a count-based aggregate check is all the engine can do.

L2's mitigation (one `PricePolicy` per seeder) is correct for a single-video seeder and wrong
for every other deployment, and it silently degrades to "cheapest price wins" as soon as an
operator seeds two videos. The alternative — one `pay/1` protomux channel per core, keyed by
discovery key like Hypercore's own channels — was considered and rejected: it multiplies
`HELLO` signatures and state machines by the number of cores, gives every core its own window
(weakening invariant 5's per-peer bound), and moves the identical information into a channel
id instead of a message field.

Change: `BlockRange.core?: CoreKeyHex`. `PayMessage.range.core` is therefore on the wire, the
viewer passes it through `pay()` unchanged in shape, and `recordUpload(peer, blocks, core?)`
lets the engine keep per-core upload counts. The window (invariant 5) stays **per peer summed
over cores** — that is the credit limit the seeder extends to one identity, and splitting it
per core would let a peer hold `window × cores` unpaid blocks.

**Optional at v3, required at the Stage 2 bump.** Optional only so that v2-issued L2/L10 code
compiles on `main` today (there are ~100 `{ fromBlock, toBlock }` literals in their tests).
The rule for the interim is written into the contract: a seeder that replicates more than one
core on a stream MUST reject a `PAY` without `core` as `malformed`. The mock applies the
per-core `range-not-uploaded` check whenever the PAY names a core for which uploads were
recorded, and the per-core replay check always (ranges on different cores never overlap).

### (d) L2 flag 2 — pre-`HELLO` accounting → ACCEPTED: `PaymentEngineSeeder.rebind(from, to)`

Hypercore starts serving blocks the instant the replication channel opens; `pay/1`'s `HELLO`
(which binds the Nostr pubkey) is a separate protomux channel and races it. Not serving before
`HELLO` is impossible (S-A: no per-peer pause) and cutting on the first pre-`HELLO` upload
would make the race unwinnable for honest viewers. So the transport must account pre-`HELLO`
uploads under a **provisional identity**. L2 uses the Noise static key as hex (same 32-byte
shape as a pubkey). That is sound: the Noise handshake authenticates it, the ban list already
persists Noise keys (invariant 6), a peer that never sends `HELLO` is cut and banned after
`window` blocks exactly like any non-payer, and a fresh Noise key per attempt buys at most
`window` blocks each — the same T3 residual as any anonymous peer, bounded by the per-key
connect-rate limit.

What is *not* sound is L2's replay: `recordUpload(pubkey, n)` on bind leaves the provisional
entry in place, so the engine's `windows()` double-counts `n` blocks, and once uploads are
tracked per core (c) a bare count cannot be replayed at all — the engine needs the per-core
breakdown. `rebind(from, to)` moves the whole accounting (uploaded, paid, paid ranges,
per-core counts, pending proofs, ban state) onto the real pubkey and deletes the provisional
entry. Merge semantics are **sum**: if `to` already has a window from another session, the
same identity now has both sessions' outstanding blocks, and if that sum crosses the window
the engine bans and fires `onWindowExceeded` synchronously — `rebind` is a window-changing
update and is held to the same rule as `recordUpload`. A ban on either side sticks to `to`.
Idempotent for an unknown `from`.

The seeder keeps the replay path until it is re-issued at v3 (it is contract-clean and
`n ≤ window` means it can never itself cut); the follow-up is listed in `docs/status.md`.

## Consequences

- `CONTRACTS_VERSION = 3`. All four changes are additive; `main` is green with every Wave 1
  lane's code untouched. the lane report (not published) and the lane prompt slot now say v3.
- **Wave 2 lanes (L3 first) are issued against v3** and must: put `core` in every `PAY` they
  construct, call `recordUpload(peer, blocks, core)` with the core, and use `rebind` for the
  provisional-identity bind. The gateway is *the* multi-core case, so L3 is the first real
  consumer of (c).
- **Follow-ups owed (orchestrator, not Wave 2 critical path):** re-issue L2 at v3 — resolve
  policy per `range.core`, pass `core` to `recordUpload`, replace replay-on-bind with
  `rebind`, reject core-less `PAY` on multi-core streams, and reconcile
  `renderSystemdUnit()` with the canonical `deploy/systemd` unit; re-issue L10 at v3 — named
  tests for the T4-across-cores and cheap-price-across-cores cases, per-core replay, and
  `rebind` merge/ban semantics.
- **Stage 2 bump (v4) will make `BlockRange.core` and the `core` argument of `recordUpload`
  required.** The `pay/1` codec (Stage 2) encodes `core` as a fixed 32-byte field.
- `mocks/fixtures.ts` and `MockNetworkAdapter.comment()` now emit NIP-22 `E`/`K`/`P` +
  `e`/`k`/`p` tags via `commentTags()` instead of the invented `['A', '21:<id>']`, so the
  fixtures match what L1's `fetchComments` (`#E` filter) and `parseComment` read. L1's lenient
  `A` parsing stays for now; it can be removed when nothing emits the legacy shape.
