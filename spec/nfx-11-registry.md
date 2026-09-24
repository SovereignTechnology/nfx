# NFX-11 — Registry, schemas, test vectors, conformance

**Status: Living document** · updated at every freeze.

Single table of every shared constant, so no constant lives twice across NFX docs.

## 1. Kinds

| Kind | Range class | Document | Meaning |
|---|---|---|---|
| 38504 | addressable | NFX-02 | video manifest |
| 20464 | ephemeral | NFX-03 | availability beacon |
| 30166 | addressable | NIP-66, profiled by NFX-04 §6 | scoped-relay announcement (adds `n` tag) |

Provisional until submitted to `nostr-protocol/registry-of-kinds`. Both 38504/20464
chosen unclaimed as of 2026-09-16.

## 2. Namespaces (NFX-01 §2)

`nfx:mainnet:1` (production) · `nfx:testnet:1` (interop testing) ·
`nfx:regtest:1` (local). Custom = `nfx:<name>:<int>`. The token is `nfx` and nothing
else; `nutflix:*` namespaces are void (NFX-01 §2).

## 3. ALPNs & topic grammar

| Wire | Value |
|---|---|
| blob transfer | iroh-blobs standard ALPN of the pinned series (§4) |
| payment channel | `nfx/pay/1` |
| gossip | `nfx/gossip/1` |
| swarm topic | `sha256("nfx/1/swarm/" + namespace + "/" + video-id)` (hex) — NFX-06 §4 |
| web stream swarm ID | `nfx/1/web/<namespace>:<video-id>/<rendition-id>` (one swarm per rendition) — NFX-10 §2 |
| web tracker infohash | `base64(sha1(stream swarm ID)[0..15])`, 20 ASCII chars (p2p-media-loader v4 `computeInfoHash`) — NFX-10 §2 |
| Hyperswarm topic | `sha256("nfx/1/hyper/" + namespace + "/" + video-id)` — NFX-12 §3 |
| Protomux payment protocol | `nfx/pay/1`, channel id `utf8(<namespace>:<video-id>)` — NFX-12 §5 |

Beacon endpoint types (`endpoints[].t`, NFX-03 §4). Readers skip types they do not
implement:

| `t` | Document |
|---|---|
| `iroh` | NFX-06 |
| `https` | NFX-05 §6 |
| `webrtc` | NFX-10 §2 |
| `hyper` | NFX-12 (optional) |

Capability keys:

| Where | Key | Document |
|---|---|---|
| relay NIP-11 document | `"nfx"` | NFX-04 §3 |
| mint NUT-06 info | `"nfx"` (incl. `redeem_pubkey`) | NFX-09 §1 |

## 4. Pinned dependency series

| Component | Pin | Notes |
|---|---|---|
| iroh / iroh-relay | **1.x** (1.2.0 at pinning, 2026-09-23) | the iroh 1.x wire; nothing pre-1.0 is conformant |
| iroh-blobs | **0.103.x** (depends on iroh ^1) | its standard ALPN is the NFX blob wire; tickets are its `BlobTicket` string form, whose byte layout NFX-06 §2 states and `tickets.json` pins |
| iroh-gossip | **0.101.x** (depends on iroh ^1) | carries `nfx/gossip/1` (NFX-06 §4) |
| p2p-media-loader | **v4** (4.0.0 at pinning; upstream for the free mesh, a maintained v4 fork for the paid mesh) | NFX-10 §§1–3; its `computeInfoHash` defines the tracker infohash |
| Hypercore stack | hypercore 11, hyperdrive 13, hyperswarm 4, protomux 3 | NFX-12 (optional) |
| Cashu protocol | NUT-00/02/03/06/07/08/11/12 | via CDK or cashu-ts; NUT-08 only for its blank outputs (NFX-09 `redeem`) |
| Media profile | NFX-05 §1 | no external pin |

The three iroh crates are one series: a bump of any of them is an NFX-11 edit only,
made together.

**Every network runs its own `iroh-relay`** from the pinned series (NFX-06 §1). The
public relays run by iroh's developers stop serving pre-1.0 clients on 2026-09-30.
They are a convenience whose policy is not ours, and no NFX network may depend on
them.

## 5. HTTP surfaces

| Surface | Spec |
|---|---|
| `GET /<sha256>[.<ext>]` (+ HEAD) | NFX-05 §6 |
| `GET /<root>`, `GET /<root>/master.m3u8`, `GET /<root>/<sha256>.<ext>` | NFX-05 §6 |
| `Cache-Control: public, max-age=31536000, immutable` (and its limits) | NFX-05 §6.1 |
| `X-NFX-Pay` / `X-NFX-Accepted` / `X-NFX-Price` / `X-NFX-Mints` / `X-NFX-Session` / 402 | NFX-07 §4 |
| `POST /v1/nfx/{escrow,license,redeem,claim}` | NFX-09 §2 |

## 6. Error codes (payment)

| Code | Meaning | Defined in |
|---|---|---|
| `underpaid` | pay short of chunks claimed; also license payment short | NFX-07 §3, NFX-09 §2 |
| `overpaid` | payment exceeds the exact amount: license payment above `key_price`, or a `pay` above chunks × price | NFX-09 §2, NFX-07 §3 |
| `bad-mint` | proofs from an unaccepted mint | NFX-07 §3 |
| `spent` | proofs already spent (mint swap failed) | NFX-07 §3 |
| `bad-lock` | licensed chunk proof not P2PK-locked to the mint's `redeem_pubkey`, locktime too near, or no valid DLEQ | NFX-08 §4.1, NFX-09 §2 |
| `stale` | `pay.upto_chunk` ≤ last acked watermark | NFX-07 §2 |
| `bad-token` | token unreadable, not unit `sat`, of more than one mint, with locked proofs, or with an invalid DLEQ | NFX-07 §3 |
| `banned` | the peer is banned by this seeder (a spent proof) | NFX-07 §3 |
| `bad-session` | the session id belongs to another peer, or the peer holds too many sessions | NFX-07 §3 |
| `payment-required` | license requested without payment/voucher | NFX-09 §2 |
| `bad-voucher` | voucher signature, presenter (NIP-98 ≠ `seeder`), whitelist or expiry failed | NFX-08 §5, NFX-09 §2 |
| `unknown-video` | mint has no escrow for that manifest address `a` | NFX-09 §2 |
| `root-mismatch` | escrow conflict: same `a` with a different `root` or `key` | NFX-09 §2 |
| `below-fee` | redemption's NUT-02 input fee ≥ its total; batch and retry | NFX-09 §2 |

New codes are non-breaking (NFX-01 §4); clients MUST tolerate unknown ones.

## 7. Schemas and test vectors

| Artifact | Path |
|---|---|
| Hash-list JSON Schema | `schemas/hashlist.schema.json` |
| Beacon content JSON Schema | `schemas/beacon-content.schema.json` |
| Manifest event vector | `test-vectors/manifest.json` |
| Beacon event vector | `test-vectors/beacon.json` |
| Hash-list blob vector | `test-vectors/hashlist.json` |
| Invalid-manifest vectors (signed; every one MUST be rejected) | `test-vectors/manifest-invalid.json` |
| Canonical-JSON vectors | `test-vectors/canon.json` |
| Voucher vector | `test-vectors/voucher.json` |
| Licensed-mode encryption vector (XChaCha20-Poly1305 with associated data) | `test-vectors/licensed.json` |
| pay/1 messages, valid and invalid (NFX-07 §2) | `test-vectors/pay1.json` |
| Gossip envelope vector | `test-vectors/gossip.json` |
| Derived identifiers (namespaces, topics, infohash) | `test-vectors/derived.json` |
| Generator (source of truth) | `test-vectors/generate.py` |

Vectors use throwaway keys whose *secret is published in the file* — never use them
elsewhere. Regenerate and re-verify (needs `coincurve`):

```sh
python3 test-vectors/generate.py            # regenerate
python3 test-vectors/generate.py --verify   # byte-exact re-check
```

## 8. Conformance levels

- **L1 — catalog reader**: validates manifests per NFX-02 §4; honors `n`-tag
  isolation (NFX-01 §3); ignores unknown tags.
- **L2 — watcher**: L1 + fetches/verifies per NFX-05 §4 + at least one of (NFX-06
  iroh | NFX-05 §6 origin) + NFX-07 pays or handles 402 correctly.
- **L3 — seeder**: L1 + NFX-03 beacons at TTL policy + NFX-05 §5 verified pinning +
  NFX-06 collection serving (or bridge, NFX-10 §2) + NFX-07 verification duties
  §3 (window enforcement included).
- **L4 — mint**: NFX-09 all four endpoints + NUT-03/08/11/12 interop + NUT-06
  advertisement per NFX-09 §1.
- **L5 — scoped relay**: NFX-04 §§1–3 including NIP-40 and the rate-limit table.

A README badge that doesn't name a level is non-claim.

## 9. Canonical JSON (`canon`)

The suite's one canonicalization, used wherever an NFX-defined JSON object is signed
(NFX-06 §4 gossip envelopes, NFX-08 §5 vouchers). Freezes with its first user (M1).
Nostr event ids are **not** `canon`; they use NIP-01's own serialization.

`canon(value)` is the UTF-8 encoding of:

- **object** — `{`, then members sorted by key, compared as sequences of Unicode code
  points (identical to comparing their UTF-8 bytes), each as `canon(key):canon(value)`,
  separated by `,`, then `}`. Duplicate keys make the value non-canonicalizable.
- **array** — `[`, elements in their given order separated by `,`, `]`.
- **string** — `"`, the characters, `"`. Escape exactly these: `"` → `\"`, `\` → `\\`,
  U+0008 → `\b`, U+0009 → `\t`, U+000A → `\n`, U+000C → `\f`, U+000D → `\r`, and
  every other code point below U+0020 → `\u00xx` with lowercase hex. Every other
  code point, U+007F and all non-ASCII included, is written as itself (no `\/`, no
  `\uXXXX` for non-ASCII).
- **number** — integers only, in `[-(2^53 − 1), 2^53 − 1]`, written in shortest
  decimal form (no `+`, no leading zeros, no fraction, no exponent). A received
  object whose JSON text contains a number with a fraction or exponent part, the
  token `-0`, or an integer outside that range, is non-canonicalizable. (Parsers
  disagree about `-0`: `serde_json` reads it as a float, Python as the integer 0.
  Rejecting it removes the disagreement.)
- **text** — the received JSON text MUST be valid UTF-8 without lone surrogates,
  including in `\u` escapes.
- **true**, **false**, **null** — as written.

No whitespace appears anywhere outside strings. A verifier that meets a
non-canonicalizable value MUST reject the signed object; it MUST NOT round or
normalize it. This rule equals Python's
`json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` and Rust
`serde_json::to_string` of a `serde_json::Value` (without the `preserve_order`
feature), both restricted to the integer domain above. JavaScript implementations
must sort keys by code point explicitly, because `Array.prototype.sort` compares
UTF-16 code units. `test-vectors/canon.json` pins the edge cases.

## Changelog

- 2026-09-16 — initial (M0).
- 2026-09-16 — review pass: error-code table now enumerates every code with its home
  section; infohash registered; verify command shown.
- 2026-09-23 — ADR 0008: wire token `nfx` everywhere (namespaces, ALPNs, headers,
  capability keys). iroh series pinned (iroh/iroh-relay 1.x, iroh-blobs 0.103,
  iroh-gossip 0.101) with self-hosted `iroh-relay` (plan amendment 9). p2p-media-loader
  v4 and the NFX-12 Hypercore stack pinned. Endpoint-type and capability-key registries
  added, along with the `bad-lock` code, the new NFX-05 §6 paths and `canon` (§9, moved
  here from NFX-08 §5 and made exact). New vectors: invalid manifests, canon, voucher,
  gossip envelope, derived identifiers.
- 2026-09-23 — decisions after A1 (ADR 0008 addendum): the web stream swarm ID and
  tracker infohash replace the per-video web infohash; the ticket string form is pinned;
  `unknown-root` → `unknown-video`; new code `below-fee`; NUT-08 listed (blank outputs).
- 2026-09-23 — licensed-mode encryption vector added (NFX-08 §2 associated data).
- 2026-09-24 — M1 freeze candidate: `tickets.json` (real iroh tickets and collection hashes,
  encoded independently of iroh by the generator and checked against iroh-blobs 0.103);
  the beacon vector's placeholder tickets are replaced. The generator now needs `blake3`.
- 2026-09-24 — **M1 freeze**: NFX-02, 03, 04, 05 and 06 frozen (sovtech). The pins they rest
  on are the iroh 1.x series with iroh-blobs 0.103.x (the `BlobTicket` layout in NFX-06 §2)
  and iroh-gossip 0.101.x (§4), plus the vectors as of this date, including `tickets.json`
  and `deletion.json`.
- 2026-09-24 (M2.0) — `overpaid` also covers a pay/1 `pay` above chunks × price (NFX-07
  §3). New vector file `pay1.json` (NFX-07 §2 message rules).
- 2026-09-24 (M2.0 audit) — new payment codes `bad-token`, `banned` and `bad-session`
  (NFX-07 §3).
