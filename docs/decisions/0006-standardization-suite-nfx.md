# 6. Protocol standardization suite (NFX): the iroh/CMAF redesign is normative; the TypeScript implementation is v0/legacy

Date: 2026-09-16

## Status

Accepted (decision by sovtech, 2026-09-16, after surfacing the divergence)

Amended 2026-09-23 by [ADR 0008](0008-multi-network-master-plan.md). The v0 prototype
is described in the present tense: it is **still being built** as the Pear-runtime-only
demo. The wire token is `nfx`, not `nutflix` (NFX-01 re-freeze). The text below is
otherwise the 2026-09-16 record.

## Context

Two designs for nutflix existed in parallel:

1. **The built system** (ADR 0002, contracts v3 FROZEN, Stage 0 + Wave 1 + L3 merged,
   ~530 tests): Hypercore/Hyperblobs over Hyperswarm, NIP-71 kind 21/22 manifests with
   extension tags, `pay/1` protomux payments, Blossom only at the gateway, TypeScript.
2. **The redesign note** (`a local design note`, 2026-09-04): iroh
   native-first (Rust), fMP4/CMAF content-addressed segments for *every* transport,
   a dedicated namespaced manifest kind, scoped availability relays with TTL beacons,
   and a licensed mode with key escrow + split-at-redemption at a Cashu mint.

Neither references the other: the repository contains no occurrence of `iroh`, no
beacon kinds, no network namespacing; the note contains no Hypercore. On 2026-09-16 a
standardization effort (turn the protocol into documents third parties can implement)
forced the question of which design the standard is normative *for*.

## Decision

sovtech chose: **the standard is normative for the redesign**. Concretely:

(a) **The protocol standard is the NFX suite in `spec/`, describing the redesign:**
iroh transport, fMP4/CMAF sha256 segments, dedicated manifest kind, scoped-relay
beacons, open + licensed payment modes. The document set, status model
(`Draft → Frozen@M<n> → Stable → Final`), freeze gates and conformance levels are
defined in `spec/README.md`.

(b) **The TypeScript implementation is the v0 prototype, and it is a Pear-runtime-only
  app that is still being built.** It is a desktop application (Electron shell + Bare
  worker) under its own plan. As of 2026-09-23 its L5 screens are merged and the
  L4/L5 fix lanes come next; L6 (the Electron + pear-runtime desktop shell) and L7 have
  not started, and the Stage 2 money path and Stage 3 lie ahead. It is the source of
  hard-won lessons (threat model in `SECURITY.md`, split-rounding rule in ADR 0005,
  idempotency and cheat-mode thinking in `core/src/payment`) that the NFX specs cite.
  Its contracts evolve under its own plan (v3 at this decision, v4 by 2026-09-23); it
  is not evolved toward NFX conformance piecemeal — any production implementation of NFX is a new codebase. The suite it is
  contrasted with is deliberately much larger than one runtime: NFX spans native
  (iroh), browser (WebRTC mesh), origin servers, scoped relays and mints, and no
  conformant implementation requires Pear or any specific runtime.

(c) **Kind allocations (provisional until registered):**
`38504` addressable video manifest, `20464` ephemeral availability beacon. Rationale
for a dedicated kind rather than extending NIP-71: the manifest's economics (license
flag, key price, split, escrow mint, free-seeder list) and the hash-list pointer have
no NIP-71 home, and an unused-tag soup on kind 21/22 makes the standard unreadable.
Both kinds are to be registered in `nostr-protocol/registry-of-kinds` once the suite
settles.

(d) **Network isolation needs an indexed tag, not a namespaced `d` alone.** Nostr REQ
filters cannot prefix-match `#d`, so the redesign note's "isolation at the query layer"
does not work as described. NFX-01 therefore defines an indexed `n` tag
(`["n","nutflix:mainnet:1"]` in the 2026-09-16 text; `["n","nfx:mainnet:1"]` since
the ADR 0008 re-freeze) on every NFX event; the namespaced `d` stays as
defense in depth. Clients MUST verify the two agree.

(e) **Segment integrity is sha256-only at the signed layer.** iroh addresses blobs by
BLAKE3, which nobody can derive without the bytes; the signed hash list (NFX-05)
therefore carries sha256 per file, beacons carry iroh tickets, and clients verify
sha256 post-fetch. Dual-digest hash lists were considered and rejected (doubles the
signed surface for zero trust gain — the sha256 check already catches poisoned bytes).

(f) **Spec text is public domain** (code stays AGPL-3.0-or-later). NIPs and Cashu NUTs
are public domain for the same reason: nobody will copy rights-encumbered prose into a
client.

## Consequences

- The repo now contains a standard (`spec/`) that nothing implements, beside an
  implementation (packages/) that implements something else. That is deliberate and
  temporary: M1+ build against `spec/`.
- The v0 prototype's operational lessons (MDWE results, `docs/status.md` findings,
  cheat-mode test corpus) remain load-bearing for any NFX implementer and are
  referenced, not deleted.
- Milestone freeze gates: NFX-01 frozen at M0; NFX-02..06 gate M1; NFX-07 gates M2;
  NFX-08/09 gate M3; NFX-10 gates M4; NFX-11 grows per milestone.
- Upstream path: kind-registry PR at M0 settlement; a single NIP document after two
  independent implementations; the split-mint extension (NFX-09) to cashubtc as a NUT
  extension after two mints run it. Upstream acceptance is not on the critical path —
  BUDs and NUTs both predated their formal recognition.
- The 2026-09-04 build plan and ADR 0002 remain the historical record of v0. They are
  superseded as forward-looking architecture by this record and `spec/`.
