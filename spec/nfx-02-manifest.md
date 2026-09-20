# NFX-02 — Catalog manifest (kind 38504)

**Status: Draft (target freeze: M1)** · supersedes nothing · depends on NFX-01, NFX-05

One signed, addressable Nostr event per video. It is the *only* low-churn nostr object
in the protocol; everything above ~1 msg/min lives elsewhere (NFX-03, NFX-06).

## 1. Event shape

| Field | Value |
|---|---|
| `kind` | **38504** (addressable per NIP-01; provisional, ADR 0006 (c)) |
| `pubkey` | the creator's key; the manifest is authoritative only from this key |
| `content` | markdown description. Plain text and markdown only; clients MUST NOT render HTML from it |
| `created_at` | publication/update time. Newest supersedes per NIP-01 addressable rules |

Whole event SHOULD stay under 16 KiB so general-purpose relays accept it. Anything too
big for the event (per-file hashes, rendition tables) lives in the **hash list blob**
referenced by the `root` tag (NFX-05). Never inline segment hashes here.

## 2. `d` tag and video-id

```
["d", "<namespace>:<video-id>"]
namespace = per NFX-01 §2, e.g. "nutflix:mainnet:1"
video-id  = [a-z0-9][a-z0-9-]{6,62}
```

Chosen by the creator at publish; unique per creator per network by addressability. A
video-id MUST NOT be reused for different content or migrated across namespaces.

## 3. Tag table

"Licensed" / "Open" columns: **R** required, **O** optional, **–** prohibited.

| Tag | Value | Open | Licensed | Notes |
|---|---|---|---|---|
| `d` | `<namespace>:<video-id>` | R | R | §2; prefix MUST equal `n` (NFX-01 §3) |
| `n` | `<namespace>` | R | R | indexed isolation tag |
| `title` | text | R | R | |
| `published_at` | unix seconds (string) | R | R | |
| `license` | `open` \| `licensed` | R | R | hybrid-licensing flag |
| `root` | sha256 hex of hash-list blob | R | R | NFX-05; the integrity anchor |
| `segs` | integer = entries in hash list | R | R | lets clients size fetches |
| `duration` | integer seconds | O | O | |
| `thumb` | two values: `<sha256>`, `<mime>` | O | O | poster/poster-blur blob, content-addressed (NFX-05) |
| `price_hint` | integer sats per chunk | O | – | creator's *advisory* delivery price; the binding quote is the seeder's `quote` message (NFX-07 §2) |
| `key_price` | integer sats | – | R | one-time price paid to the mint for the video key |
| `split` | integer basis points, seeder share | – | R | e.g. `5000` = 50%; creator share is the remainder, P2PK-locked at redemption (NFX-08/09) |
| `mint` | mint URL | – | R (exactly one) | mint holding the key in escrow; creator's trust knob |
| `cashu_key` | 33-byte compressed secp256k1 hex | – | R | where the creator's share is P2PK-locked (NUT-11) |
| `free_seeder` | seeder pubkey hex, repeatable | – | O | whitelisted for zero-cost key release via voucher (NFX-08 §5) |
| `t` | hashtag, repeatable | O | O | discovery aid; not namespaced |
| `alt` | ≤280-char plain summary | O | O | SHOULD be present (screen readers, indexers) |

Unknown tags MUST be ignored (NFX-01 §4 non-breaking rule).

## 4. Parse/verify algorithm

A manifest object exists only after all of:

1. signature verifies (NIP-01), `kind` = 38504;
2. `d` parses per §2 and its namespace prefix equals the `n` tag (reject otherwise);
3. `license` is `open` or `licensed` and the tag table above is satisfied;
4. `root` is 64 lowercase hex; `segs` parses ≥ 1;
5. if `licensed`: exactly one `mint` (https URL), `split` ∈ [0,10000],
   `key_price` ≥ 0, `cashu_key` is a valid compressed point.

Any failure: discard the event entirely (do not partially render).

## 5. Worked example

See `test-vectors/manifest.json` — a complete, real-signature event (regenerable via
`test-vectors/generate.py`), abbreviated here:

```json
{
  "kind": 38504,
  "content": "A walk through the salt flats at dusk.",
  "tags": [
    ["d", "nutflix:mainnet:1:salt-flats-dusk"],
    ["n", "nutflix:mainnet:1"],
    ["title", "Salt Flats at Dusk"],
    ["published_at", "1790000000"],
    ["license", "licensed"],
    ["root", "<sha256 of the test-vector hash list>"],
    ["segs", "7"],
    ["duration", "6"],
    ["key_price", "200"],
    ["split", "5000"],
    ["mint", "https://mint.example"],
    ["cashu_key", "03…"],
    ["free_seeder", "<hex pubkey of that seeder>"],
    ["t", "travel"],
    ["alt", "Drone footage over salt flats at sunset, 6 seconds."]
  ]
}
```

## 6. Replaceability and deletion

- Update = same author + `d`, newer `created_at`. Relays keep the newest.
- Delisting (creator renunciation): publish a manifest with `license` set to `open`,
  `price_hint` `0`, and **all licensed-only tags removed** (`key_price`, `split`,
  `mint`, `cashu_key`, `free_seeder` — otherwise the event fails §4 and no client
  ever parses it), or issue a NIP-09 deletion request. Clients SHOULD honor NIP-09
  for manifests; seeders MUST stop beacons for deleted manifests but are not required
  to delete stored bytes (they are just content-addressed blobs).

## 7. Annex A (non-normative): NIP-71 mirror

A mirroring tool MAY also publish a kind-34235/34236 NIP-71 event whose `imeta url`
points at an origin's plain-HTTPS HLS playlist, giving the video a listing in the
existing NIP-71 ecosystem with zero payments or swarm. This is a discovery adaptor:
conformance is never required, the kind-38504 manifest remains canonical, and the two
MUST be linkable via the mirror's `["a","38504:<pubkey>:<d>"]` tag. NIP-71 consumers
see a playable video; NFX consumers ignore the mirror.

## Changelog

- Draft 2026-09-16 — initial. Dedicated kind (not a NIP-71 superset) per ADR 0006 (c);
  `n`/`d` agreement rule per NFX-01 §3; hash list kept off-relay per ADR 0006 (e).
- Draft 2026-09-16 (review fixes): delisting must drop licensed-only tags (the §4
  parse gate would otherwise reject its own renunciation event); `price_hint` note
  points at the `quote` message as the binding price; `thumb` arity and `alt` legend
  corrected.
