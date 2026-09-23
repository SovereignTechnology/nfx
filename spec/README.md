# The NFX protocol suite

NFX documents are the standard for a Nostr-identified, peer-seeded video network where
seeders are paid per delivered chunk in Cashu ecash, with an optional per-video
licensing mode. Anyone can implement a watcher, seeder, relay, mint, or indexer
against these documents alone. The first product built on NFX is called nutflix; no
wire identifier carries that name (the wire token is `nfx`, NFX-01 §2), so a product
rename never touches the protocol.

The suite is normative for the architecture described in ADR 0006, and ADR 0008 sets
the multi-network build plan. The TypeScript monorepo in `packages/` is a different
design: a Pear-runtime-only desktop demo that is **still being built** under its own
plan (its web-shell lane is out of scope there). It is not an NFX implementation and is
not evolved toward one piecemeal; the specs cite it only where its operational lessons
are normative.

**Scope:** NFX is a multi-platform protocol. Implementations include native clients
(iroh), browsers (WebRTC mesh), origin HTTPS servers, scoped relays, mints and an
optional Hypercore profile (NFX-12). No
conformance level (L1–L5) requires Pear — or any specific runtime, app framework, or
desktop shell.

## Reading order

| Doc | Title | Status | Freezes |
|---|---|---|---|
| NFX-01 | Networks & versions | **Frozen** (re-frozen 2026-09-23) | M0 |
| NFX-02 | Catalog manifest (kind 38504) | Draft | M1 |
| NFX-03 | Availability beacons (kind 20464) | Draft | M1 |
| NFX-04 | Scoped relay profile | Draft | M1 |
| NFX-05 | Segments & content integrity | Draft | M1 |
| NFX-06 | iroh transport profile | Draft | M1 |
| NFX-07 | Payments — open mode | Draft | M2 |
| NFX-08 | Payments — licensed mode & vouchers | Draft | M3 |
| NFX-09 | Split-mint extension (mint API) | Draft | M3 |
| NFX-10 | Web transport profile | Draft | M4 |
| NFX-11 | Registry, schemas, test vectors, conformance | Living | per-milestone |
| NFX-12 | Hypercore transport profile (optional) | Draft | later |

Lower numbers are dependencies of higher numbers. NFX-01 and NFX-05 are the two every
implementation needs.

## Status model

- **Draft** — under construction; anything may change in place.
- **Frozen@M\<n\>** — normative for that milestone's implementations. Changes to a
  frozen document require a namespace/spec-version bump per NFX-01 §4, never an edit in
  place. Typos and clarifications that change no behavior may be fixed in place and are
  listed in the doc's changelog section.
- **Stable** — two independent implementations interoperate against it.
- **Final** — submitted upstream (NIP for the nostr documents, NUT extension for the
  mint API) or explicitly declared self-standing.

## Conformance

L1 reader · L2 watcher · L3 seeder · L4 mint · L5 scoped relay — checklists in
NFX-11. "NFX-compatible" without a level means nothing; claim a level.

## Style

Key words **MUST/SHOULD/MAY** per RFC 2119. Every wire format has a worked example and,
where signatures are involved, a regenerable test vector in `test-vectors/`
(`test-vectors/generate.py` is the source of truth). JSON payloads have schemas in
`schemas/`.

## License

Specification text in this directory is public domain (CC0). Code referencing it keeps
the repository license. Rationale and full context: `docs/decisions/0006-*` (f).

## Changelog

- 2026-09-16 — initial suite (ADR 0006).
- 2026-09-23 — brand-neutral wire token `nfx` and NFX-01 re-freeze; NFX-12 added as
  Draft; the demo described in the present tense (it is still being built). ADR 0008.
