# NFX-01 — Networks & versions

**Status: Frozen (M0)** · 2026-09-16 · re-frozen at M0 2026-09-23 (wire token `nfx`, ADR 0008 §2)

The constitution every other NFX document defers to. Everything here is a load-bearing
rule, not a convention.

## 1. Terminology

Key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** per RFC 2119.

- **Network** — an isolated universe of manifests, beacons, relays, mints and swarms.
- **Namespace** — the string that names a network and a spec version inside it.
- **Spec version** — the integer that bumps when any frozen rule changes.

## 2. Namespace grammar

```
namespace  = "nfx" ":" network ":" specver
network    = "mainnet" | "testnet" | "regtest" | custom
specver    = "0" | (NONZERO-DIGIT *DIGIT)  ; integer, no leading zeros
custom     = 2*32(lower-alpha / DIGIT / "-")  ; lowercase only;
                                             ; MUST NOT collide with reserved words
```

Reserved networks today: `mainnet` (production), `testnet` (interoperability testing,
valueless tokens), `regtest` (fully local). A private network MUST use a `custom`
network name, e.g. `nfx:acme-cdn:1`.

The literal `nfx` is the only wire token. The 2026-09-16 text used `nutflix`; no
implementation or published event ever used it, so the M0 re-freeze replaced the
token instead of bumping `specver` (ADR 0008 §2). `nutflix:*` namespaces are void:
implementations MUST NOT write them and MUST treat events carrying them as foreign.

The namespace is present in three places per video, which MUST agree:

1. the **`n` tag** of every NFX event — `["n", "<namespace>"]` (§3);
2. the **`d` tag** of addressable NFX events — `["d", "<namespace>:<video-id>"]`
   (NFX-02 §3);
3. the **`video` field** of hash lists and beacon content
   (`<namespace>:<video-id>`), and the **`network` field** of voucher payloads
   (NFX-08 §5).

## 3. The indexed network tag (normative fix)

Nostr REQ filters cannot prefix-match a tag. `{"#d": ["nfx:mainnet:1:*"]}` is not
expressible; without a dedicated tag, a mainnet query returns testnet manifests and
isolation differs only by client discipline — i.e., by nothing.

Therefore every event defined by this suite MUST carry **exactly one** `n` tag:

```
["n", "<namespace>"]
```

An event with no `n` tag, or with more than one, is invalid and MUST be discarded —
otherwise one event could match the REQs of two networks.

- On events that carry a `d` tag **of the form `<namespace>:<video-id>`**, the `n`
  value MUST equal that `d` with its final `:<video-id>` component removed.
  Ephemeral events without `d` (beacons) carry `n` alone.
- **Exemption:** events defined by external specs that this suite *profiles* —
  NIP-66 kind 30166 relay announcements (NFX-04 §6), NIP-71 mirrors (NFX-02 §7) —
  carry `n` as a plain network/capability label; the `d`-agreement rule does not
  apply to them, and neither does the exactly-one rule above (a relay serving two
  namespaces announces both).
- Clients REQ with `{"#n": ["<namespace>"]}` and MUST additionally verify the `d`
  prefix locally (defense in depth against relays that index blindly).
- Relays implementing NFX-04 MUST index `#n` and MAY reject events whose `n` and `d`
  disagree.

## 4. Versioning rules

- **Breaking change** (any change that makes a correct old client reject or
  misinterpret a valid new artifact, or vice versa): increment `specver`, e.g.
  `nfx:mainnet:1` → `nfx:mainnet:2`. Old namespaces keep their meaning forever;
  they are never re-pointed.
- **Non-breaking additions** (new optional tags, new optional content fields, new
  transports): same namespace. Readers MUST ignore tags/fields they do not know.
- **Per-document freeze gates:** a document marked `Frozen@M<n>` may not change its
  wire-visible rules without a `specver` bump; clarifications follow the status model
  in `spec/README.md`.
- A client MUST NOT write events to a namespace it does not fully implement; a client
  reading an unknown `specver` MUST treat the events as opaque (no partial rendering).

## 5. Bootstrapping a network

A network comes alive when all of the following exist and reference each other:

1. at least one NFX-04 scoped relay announcing itself per NIP-66 (NFX-03 §6);
2. at least one seeder serving a hash list and segments (NFX-05);
3. for licensed content, at least one mint implementing NFX-09 and announced per
   NIP-87.

`testnet` and `regtest` exist so this bootstrap can be rehearsed without touching
`mainnet`.

## 6. What this document does NOT cover

Event schemas (NFX-02/03), transport (NFX-06/10), payments (NFX-07/08/09). Governance
of this suite (editorship, upstream submission) is a project matter, not protocol.

## Changelog

- 2026-09-16 — Frozen at M0. Initial text. `n`-tag rule fixes the "isolation at the
  query layer" gap in the originating design note; rationale in ADR 0006 (d).
- 2026-09-16 (clarifications, no behavior change): scoped the `d`-agreement rule to
  namespace addresses and exempted profiled external kinds; lowercase-only custom
  network names (matching the JSON schemas); `specver` leading zeros already banned,
  schemas updated to enforce it.
- 2026-09-23 — **Re-frozen at M0** with the brand-neutral wire token `nfx` (was
  `nutflix`; ADR 0008 §2). Nothing implemented or published the old token, so no
  `specver` bump; `nutflix:*` namespaces are declared void (§2). Clarification in the
  same re-freeze: exactly one `n` tag per event (§3) — two `n` tags would put one event
  into two networks.
