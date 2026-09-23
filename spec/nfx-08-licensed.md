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

`POST {mint}/v1/nfx/escrow` (NIP-98 auth by the creator key):

```json
{ "a": "38504:<creator-pubkey>:<namespace>:<video-id>",
  "root": "<hash-list sha256>", "key": "<K hex>" }
```

Escrow is keyed by the **manifest address `a`** (creator plus video), never by `root`
alone. The mint MUST verify:
- the NIP-98 signer is the creator named in `a`;
- a manifest at `a` (its own lookup, or a signed one presented in a `manifest` field)
  names *this* mint and carries this `root`.

Only then does it store `a → (root, key)`. Same request replayed identically = idempotent
`200`; same `a` with a different `root` or `key` = `409 root-mismatch` (NFX-09 §2).

Keying by `root` alone would let anyone copy a public root into a manifest of their own
and escrow first. Keyed by `a`, an impostor can only escrow under their own address.

## 4. Buying a license (watcher flow)

`POST {mint}/v1/nfx/license`:

```json
{ "a": "<manifest address>", "payment": "cashuB…" }   // or { "a", "voucher", "sig" } (§5)
```

- `payment` = proofs totalling **exactly** manifest `key_price` (overage and
  underage are both rejected; NFX-09 §2).
- Success: `200 { "key": "<hex>", "root": "<hex>" }`. The key travels over TLS only; clients SHOULD
  keep it in process memory and SHOULD NOT persist beyond the session.
- Free path: §5 voucher instead of payment.
- **Where `key_price` goes.** The mint accrues `key_price − fee` of every paid license
  to the creator, the same way it accrues the creator's share of a redemption: as
  proofs P2PK-locked (NUT-11) to the manifest `cashu_key`, indexed under `a`, and paid
  out by `claim` (§6, NFX-09 §2).
  - `fee` is only the NUT-02 input fee of the payment proofs. Fees come off the top
    (NFX-09 §2); the watcher still pays exactly `key_price`.
  - A voucher license accrues nothing.

After licensing, chunk payments follow NFX-07 with three differences:

1. seeders redeem through the split endpoint (NFX-09 `redeem`, naming the video's `a`),
   which splits the amount net of fees in the manifest's `split` ratio. The creator's
   share is held for `claim`, P2PK-locked (NUT-11) to the manifest `cashu_key`; the
   seeder's is signed onto the seeder's own blank outputs;
2. **the watcher's proofs MUST be issued by the manifest's escrow mint** — only that
   mint can apply the split, and NUT-03 swaps are intra-mint. Consequently the
   seeder's `quote.mints` / beacon `accepts_mints` reduce to exactly that one mint
   for licensed videos (NFX-03 §4). There is no cross-mint settlement in this
   version;
3. **chunk proofs are locked to the split endpoint.** Every proof in a licensed-mode
   payment (the `pay` token on `nfx/pay/1`, or `X-NFX-Pay` on HTTPS) MUST be a NUT-11
   P2PK proof whose secret has:
   - `data` = the escrow mint's `redeem_pubkey` (NFX-09 §1);
   - no `pubkeys` tag, and `n_sigs` absent or `1`: the mint's key is the only signer;
   - `sigflag` absent or `SIG_INPUTS`;
   - optionally `locktime` plus `refund` keys of the watcher's choosing, so that proofs
     the watcher locked but never spent come back to it. If present, `locktime` MUST be
     at least 3600 s after the `pay` is sent.

   Only the mint holds `redeem_pubkey`'s secret, so such proofs can be spent only
   through `POST /v1/nfx/redeem`, which applies the split. A seeder's ordinary NUT-03
   swap fails for lack of a witness. Before this rule, licensed chunk payments were
   plain bearer tokens of the escrow mint: a seeder could swap them directly, skip
   `redeem`, and keep 100%. A watcher MUST NOT send unlocked proofs for a licensed
   video, and a seeder that asks for them is non-conformant. The lock protects the
   creator from a seeder acting alone. A watcher and a seeder colluding out of band can
   always bypass it, just as they can share the key (§1).

   The watcher makes locked proofs with an ordinary NUT-03 swap at the escrow mint whose
   outputs carry P2PK secrets. It MAY lock a budget ahead, e.g. right after buying the
   license, and reclaim what it did not spend through `refund` after `locktime`.

### 4.1 Seeder verification (licensed)

For licensed videos this replaces NFX-07 §3 step 3. A seeder cannot swap locked proofs
to test them, so it verifies offline, in order:

1. the amount exactly covers the new chunks (`underpaid`) and every proof is from the
   escrow mint (`bad-mint`);
2. every proof's secret is a P2PK secret satisfying difference 3 above, and any
   `locktime` is at least 3600 s in the future (`bad-lock`);
3. every proof carries a valid NUT-12 DLEQ proof for the escrow mint's keyset
   (`bad-lock`; a proof that cannot be checked offline is refused, not trusted);
4. it SHOULD then check NUT-07 proof state (a read that spends nothing) and treat
   `SPENT` or `PENDING` as `spent`.

It `ack`s after steps 1–3 and redeems through NFX-09 `redeem` before the earliest
`locktime` among the proofs it holds. Batching redemptions is allowed and does not
change what the creator receives (NFX-09 §2 carry rule). Loss on a bad payment stays
bounded by `window`.

## 5. Free-seeder vouchers

Manifest `free_seeder` npubs get the key at zero cost so they can seed without paying:

```
voucher = { "v":1, "type":"nfx-voucher", "network":"<namespace>",
            "video":"<namespace>:<video-id>", "seeder":"<pubkey hex>",
            "not_after":<unix> }
sig     = schnorr_sign(creator_seckey, sha256(utf8(canon(voucher))))
```

`sig` is a BIP-340 signature over that 32-byte digest. `canon(obj)` is the suite's one
canonical-JSON rule, defined normatively in NFX-11 §9 (also used by NFX-06 §4). Every
implementation MUST serialize the *received* object with `canon` before verifying —
never trust the sender's wire layout — so Python insertion order and Rust `serde_json`
key order cannot diverge. `network` MUST equal the namespace prefix of `video`.

Presented in `license`'s `voucher`+`sig` fields **by the seeder itself**: the license
request MUST carry NIP-98 auth by the voucher's `seeder` key. The mint MUST verify all of:
- the NIP-98 signer equals `seeder`;
- the signature, against the creator named in the request's `a`;
- `seeder` ∈ that manifest's `free_seeder`;
- `not_after` is in the future;
- `network`/`video` match the manifest at `a`.

All-or-nothing: any failure = `402` with `code: "bad-voucher"`. Binding the presenter
to `seeder` makes a leaked voucher useless to anyone else.

Vouchers are in-band payloads, deliberately **not** a nostr kind: mints see them,
relays don't, and they expire.

## 6. Creator settlement

`POST {mint}/v1/nfx/claim` (NIP-98 auth by the creator key) → outstanding
P2PK-locked payouts, per video address `a`. Batch/never is the operator's choice; the mint API is the only
coupling. See NFX-09 for the full mint contract.

## 7. Open issues (must close before the M3 freeze)

- **No AEAD associated data.** Ciphertext is not bound to its position (§2). The
  per-file sha256 anchor covers this today; revisit if files are ever reused across
  hash lists.

## Changelog

- Draft 2026-09-16 — initial.
- Draft 2026-09-16 (review fixes): licensed-mode chunk proofs MUST come from the
  escrow mint (the split endpoint is intra-mint); voucher signatures now use a
  defined canonical-JSON serialization; license payment is exact-amount.
- Draft 2026-09-23 — wire token `nfx` (ADR 0008 §2). Plan amendment 3: licensed
  chunk proofs are P2PK-locked to the mint's `redeem_pubkey` (§4 difference 3), and
  seeders verify offline (§4.1, new code `bad-lock`), closing the split bypass by
  direct NUT-03 swap. Plan amendment 4: `key_price` accrues to the creator's
  `cashu_key`. `canon` moved to NFX-11 §9. Open issues listed (§7).
- Draft 2026-09-23 (sovtech's decisions after A1; ADR 0008 addendum). Escrow, license
  and claim are keyed by the manifest address `a` (ends root squatting). `key_price`
  accrues net of the NUT-02 input fee (fees come off the top). The voucher path requires
  NIP-98 by the voucher's `seeder`. The seeder share is signed onto the seeder's own
  blank outputs. The escrow, voucher and fee open issues are closed.
