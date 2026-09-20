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

`nutflix:mainnet:1` (production) · `nutflix:testnet:1` (interop testing) ·
`nutflix:regtest:1` (local). Custom = `nutflix:<name>:<int>`.

## 3. ALPNs & topic grammar

| Wire | Value |
|---|---|
| blob transfer | iroh-blobs standard ALPN of the pinned series (§4) |
| payment channel | `nutflix/pay/1` |
| gossip | `nutflix/gossip/1` |
| swarm topic | `sha256("nfx/1/swarm/" + namespace + "/" + video-id)` (hex) — NFX-06 §4 |
| web infohash | `hex(sha256(namespace + ":" + video-id)[0..20])` — NFX-10 §2 |

## 4. Pinned dependency series

| Component | Pin | Notes |
|---|---|---|
| iroh / iroh-blobs / iroh-gossip | **TBD before M1 freeze** | one series; version bump = NFX-11 edit only |
| Cashu protocol | NUT-00/03/06/11 | via CDK or cashu-ts |
| Media profile | NFX-05 §1 | no external pin |

## 5. HTTP surfaces

| Surface | Spec |
|---|---|
| `GET /<sha256>` (+ HEAD) | NFX-05 §6 |
| `GET /<root>`, `GET /<root>/master.m3u8` | NFX-05 §6 |
| `X-Nutflix-Pay` / `X-Nutflix-Accepted` / `X-Nutflix-Price` / `X-Nutflix-Mints` / `X-Nutflix-Session` / 402 | NFX-07 §4 |
| `POST /v1/nfx/{escrow,license,redeem,claim}` | NFX-09 §2 |

## 6. Error codes (payment)

| Code | Meaning | Defined in |
|---|---|---|
| `underpaid` | pay short of chunks claimed; also license payment short | NFX-07 §3, NFX-09 §2 |
| `overpaid` | license payment exceeds `key_price` (exact-amount rule) | NFX-09 §2 |
| `bad-mint` | proofs from an unaccepted mint | NFX-07 §3 |
| `spent` | proofs already spent (mint swap failed) | NFX-07 §3 |
| `stale` | `pay.upto_chunk` ≤ last acked watermark | NFX-07 §2 |
| `payment-required` | license requested without payment/voucher | NFX-09 §2 |
| `bad-voucher` | voucher signature/whitelist/expiry failed | NFX-08 §5, NFX-09 §2 |
| `unknown-root` | mint has no escrow for that root | NFX-09 §2 |
| `root-mismatch` | escrow conflict for an existing root | NFX-09 §2 |

New codes are non-breaking (NFX-01 §4); clients MUST tolerate unknown ones.

## 7. Schemas and test vectors

| Artifact | Path |
|---|---|
| Hash-list JSON Schema | `schemas/hashlist.schema.json` |
| Beacon content JSON Schema | `schemas/beacon-content.schema.json` |
| Manifest event vector | `test-vectors/manifest.json` |
| Beacon event vector | `test-vectors/beacon.json` |
| Hash-list blob vector | `test-vectors/hashlist.json` |
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
- **L4 — mint**: NFX-09 all four endpoints + NUT-03/11 interop + NUT-06
  advertisement per NFX-09 §1.
- **L5 — scoped relay**: NFX-04 §§1–3 including NIP-40 and the rate-limit table.

A README badge that doesn't name a level is non-claim.

## Changelog

- 2026-09-16 — initial (M0).
- 2026-09-16 — review pass: error-code table now enumerates every code with its home
  section; infohash registered; verify command shown.
