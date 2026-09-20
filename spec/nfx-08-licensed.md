# NFX-08 — Payments, licensed mode & vouchers

**Status: Draft (target freeze: M3)** · depends on NFX-01/02/05/07; implements against NFX-09

Licensed mode: segments encrypted; a per-video key is escrowed at the creator's mint
(NFX-02 `mint` tag). Buy the key once, then per-chunk economics run exactly like
NFX-07 — except the mint splits every redemption between seeder and creator.

## 1. Trust posture (state it plainly)

- The escrow mint sees the video key. "Creator chooses the mint" moves that trust to a
  party the creator picked; it never deletes it.
- After a watcher buys the key they can share it. That is physics (the design note's
  words), so licensed mode is priced accordingly; nothing here attempts watermarking
  or key-per-viewer.

## 2. Encryption

Per file in the hash list:

```
K        = 32 random bytes (per video, generated at publish)
stored   = nonce[24] || XChaCha20-Poly1305(key=K, nonce, plaintext_semantics)
```

- Encryption applies to `init` and `segment` files (a keyless blob is unplayable);
  playlists, master, thumbs, subtitles stay cleartext (no confidentiality value).
- **The hash list hashes *stored* (ciphertext) bytes** — NFX-05 §4 verification is
  unchanged and transport stays untrusted.
- Decrypt-before-play is the player's only licensed-mode code path beyond escrow.

## 3. Escrow (publisher flow, once per video)

`POST {mint}/v1/nfx/escrow` (NIP-98 auth from the creator key):

```json
{ "root": "<hash-list sha256>", "key": "<K hex>" }
```

The mint MUST verify that some manifest (its own lookup or a presented `manifest`
field) names *this* mint, then store `(root → key)`. Same request replayed
identically = idempotent `200`; same `root`, different `key` = `409`.

## 4. Buying a license (watcher flow)

`POST {mint}/v1/nfx/license`:

```json
{ "root": "<…>", "payment": "cashuB…" }        // or { "voucher": {…}, "sig": "…" }
```

- `payment` = proofs totalling **exactly** manifest `key_price` (overage and
  underage are both rejected; NFX-09 §2).
- Success: `200 { "key": "<hex>" }`. The key travels over TLS only; clients SHOULD
  keep it in process memory and SHOULD NOT persist beyond the session.
- Free path: §5 voucher instead of payment.

After licensing, chunk payments follow NFX-07 with two differences:

1. seeders redeem through the split endpoint (NFX-09 `redeem`), which forwards the
   creator's share, P2PK-locked (NUT-11) to the manifest `cashu_key` and held for
   `claim`, in the manifest's `split` ratio;
2. **the watcher's proofs MUST be issued by the manifest's escrow mint** — only that
   mint can apply the split, and NUT-03 swaps are intra-mint. Consequently the
   seeder's `quote.mints` / beacon `accepts_mints` reduce to exactly that one mint
   for licensed videos (NFX-03 §4). There is no cross-mint settlement in this
   version.

## 5. Free-seeder vouchers

Manifest `free_seeder` npubs get the key at zero cost so they can seed without paying:

```
voucher = { "v":1, "type":"nfx-voucher", "network":"<namespace>",
            "video":"<namespace>:<video-id>", "seeder":"<pubkey hex>",
            "not_after":<unix> }
sig     = schnorr_sign(creator_seckey, sha256(utf8(canon(voucher))))
```

`canon(obj)` is the suite's one canonical-JSON rule (also used by NFX-06 §4):
**UTF-8, object keys sorted lexicographically (code-point order), no insignificant
whitespace, numbers in shortest JSON form.** Every implementation MUST serialize the
*received* object with `canon` before verifying — never trust the sender's wire
layout — so Python insertion order and Rust `serde_json` key order cannot diverge.

Presented in `license`'s `voucher`+`sig` fields. The mint MUST verify: signature
against the manifest author's key; `seeder` ∈ manifest `free_seeder`; `not_after` in
the future; `network`/`video` match the request's `root`'s manifest. All-or-nothing:
any failure = `402` with `code: "bad-voucher"`.

Vouchers are in-band payloads, deliberately **not** a nostr kind: mints see them,
relays don't, and they expire.

## 6. Creator settlement

`POST {mint}/v1/nfx/claim` (NIP-98 auth by the manifest author key) → outstanding
P2PK-locked payouts. Batch/never is the operator's choice; the mint API is the only
coupling. See NFX-09 for the full mint contract.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): licensed-mode chunk proofs MUST come from the
  escrow mint (the split endpoint is intra-mint); voucher signatures now use a
  defined canonical-JSON serialization; license payment is exact-amount.
