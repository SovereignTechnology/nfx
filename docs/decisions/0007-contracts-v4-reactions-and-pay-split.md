# 7. Contracts v4 (reactions) and the per-PAY split: minimum PAY size + creator carry

Date: 2026-09-23

## Status

Accepted (decisions by sovtech, 2026-09-23, answering the open inputs recorded in
`docs/status.md` after the L5 screens merged). Amends ADR 0005 Q1.

## Context

1. **The per-PAY split starves creators at small PAYs.** ADR 0005 Q1 set
   `seederSats = ceil(amount × s / 100)`, `creatorSats = amount − seederSats`, and claimed both
   shares are ≥ 1 sat once `amount ≥ 2`. That was wrong (ADR 0005 erratum, found by L5-Studio):
   `creatorSats = floor(amount × c / 100)`, which is **0 whenever `amount × c < 100`**. At the
   default 4-block window and 1 sat/block a PAY is 4 sats, so any split with `c < 25` pays the
   creator nothing on every PAY — for the whole video.
2. **Dislikes.** The L5 screens could only show one `reactions` number, and un-like was sent as a
   NIP-25 `-` reaction because v3 had no way to withdraw one (Watch, Shorts). sovtech: **always
   show dislikes.** Once dislikes are public, un-like-as-`-` would register a public dislike.
3. **Card price vs charged price.** Cards said "from <cheapest rendition>"; Watch and Shorts charge
   the manifest's first (default) rendition, priced exactly.

## Decisions

### (a) Per-PAY split — minimum PAY size AND the creator's fractional remainder carried

**Carry.** On each payment stream the payer and the seeder keep an integer
`carry ∈ [0, 99]` (hundredths of a sat, scaled by the percentage), starting at 0:

```
units       = amount × c + carry
creatorSats = floor(units / 100)
carry'      = units mod 100
seederSats  = amount − creatorSats
```

This telescopes: over a stream of PAYs totalling `T` sats the creator receives exactly
`floor(T × c / 100)` — their full share less under 1 sat — no matter how small each PAY is.
The seeder receives the rest (its share rounded up, as ADR 0005 chose).

**Minimum PAY size.** A PAY's `amount` must be `≥ minPaySats`, except the final PAY that settles
the last blocks of a core (end of blob / end of session), which may be smaller. Reason: each PAY
is a P2PK proof set, and mints charge per input (NUT-02 `input_fee_ppk`) — a 1–4 sat PAY can
cost more in fees and mint round-trips than it carries. Carry fixes fairness; the minimum fixes
overhead.

Consequence for the seeder window: pay/1 pays for blocks already uploaded, so the unpaid window
must fit one minimum PAY — **effective window = `max(windowBlocks, ceil(minPaySats / satsPerBlock))`**.
Seeder exposure per viewer is then ≤ `max(windowBlocks × satsPerBlock, minPaySats)`.

**Proposed parameters (confirm at the Stage 2 bump):** `minPaySats` default **10**, carried in
the price policy so a creator can raise it; `windowBlocks` stays 4.

**Stage 2 must specify, not guess:**
- **Carry scope = one pay/1 channel × one core.** Each seeder can only verify the split of PAYs
  it receives, so the carry cannot span seeders. It resets on a new channel; `rebind(from, to)`
  must say whether carries merge (recommend: sum mod 100, the overflow going to the creator
  share of the next PAY — or simply keep `to`'s carry; pick one and test it).
- **Carry advances only on an ACCEPTED PAY.** A rejected PAY leaves it unchanged. Put `carryIn`
  in the PAY message so a desync is an explicit `malformed`, not a silent split dispute
  (pay/1 codec change, locked dir).
- **No end-of-stream flush.** The creator loses < 1 sat per stream. Deliberately simple.
- L10: property tests over random split / amount / PAY sequences assert the telescoping total;
  cheat modes for a wrong `carryIn` and an under-minimum non-final PAY.
- Invariant 2 ("exact amounts, computed identically on both sides") now includes the carry.

Implementation lands with the locked payment code in **Stage 2** (contracts **v5**,
`packages/core/src/payment`, `pay-protocol`, seeder verification, L10). Until then the v3 rule
stands in code and in `MockPaymentEngine`; `PricePolicy.split`'s doc comment points here.

### (b) Contracts v4 — reactions (additive, done now)

- `VideoStats.likes` and `VideoStats.dislikes` (**required**: dislikes are always shown) and
  `VideoStats.myReaction?: 'like' | 'dislike'`. `reactions` stays (all reactions).
- `NetworkAdapter.unreact(videoId)` — NIP-09 deletion of the viewer's kind-7 reaction(s) on the
  video. Un-like / un-dislike call this; **a withdrawn like is never sent as `-`**. Switching
  like ↔ dislike is a single `react`, since clients count the newest reaction per pubkey
  (L1 `summarizeReactions` already does).
- `MockNetworkAdapter` implements both. The real adapter (L6) maps `unreact` onto L1's event
  publishing with a kind-5 deletion referencing the viewer's reaction ids.

### (c) Cards show the default rendition's price

`VideoCard` (and every card-like price) shows the price of the rendition that will actually
play — the manifest's first — with no "from". The price on a card equals the price Watch/Shorts
quote and `play()` charges. `cheapestRenditionSats` stays for Home's hover-preview cost only.

### (d) Library copy

Watch later is a private NIP-51 set, **encrypted to the viewer's key**; playlists can be public
or private (the `isPrivate` toggle already exists — say so in the tab hint). History stays
"encrypted to your key"; likes stay "public".

## Consequences

- `CONTRACTS_VERSION = 4`. The Stage 2 bump listed in `docs/status.md` is now **v5**, and gains
  the carry + minimum PAY text from (a).
- Lane follow-ups: **L4-fixes** (`VideoCard` default-rendition price + price in the thumbnail's
  accessible name, thumbs-up/down and other missing icons, the list-layout skeleton fixes,
  `Sheet` initial focus) and **L5-fixes** (Watch + Shorts like/dislike buttons with both counts,
  `unreact` for neutral; Library tab hints; Channel playlist price; Studio split copy).
- L6's real `NetworkAdapter` must implement `unreact` and populate `likes` / `dislikes` /
  `myReaction` from L1's reaction summary.
