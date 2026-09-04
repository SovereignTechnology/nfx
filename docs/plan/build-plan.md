# Nutflix — Build Plan v2: Nostr-native P2P video network with Cashu-paid seeding and a YouTube-grade UI

Target: multiple peers seed a creator's video over Pear and get paid per block in Cashu; the creator picks the mint; 50/50 seeder/creator split by default; Blossom-addressable end to end; a web portal that runs the same protocol, same Nostr identity, and same Cashu wallet as the Pear app; and a UI that feels like YouTube, not like a protocol demo.

**Naming:** Nutflix is the brand/community name only. Package scope (`@sovit/`), protocol identifiers (`pay/1`), and repo names stay neutral so a forced rename touches the app icon and README, not the codebase. See §9 item 11.

Guiding rule: **bound the loss of any single interaction to a block's worth of sats, verify before you pay, and never trust a peer or a server for anything you can check yourself.**

Changes from v1: transport/storage is now Hyperblobs + Hypercore replication (per the Pear "stream stored video" guide) instead of a hand-written chunk protocol; payment is a side channel on the replication stream; Nostr replaces Autobase as the catalog; Blossom is an addressing/indexing layer at the gateway rather than the wire format; a full UI/product layer is added (§6).

---

## 0. Assumptions and decisions to confirm

| # | Assumption | Why it matters |
|---|-----------|----------------|
| A1 | Video bytes live in **Hyperblobs** (a blob = block range in a creator-keyed Hypercore) and move between peers via **Hypercore replication**. No custom transfer protocol. | Reuses Keet-proven replication and per-block Merkle verification. Cuts the audit surface roughly in half versus v1. |
| A2 | **Blossom identity = SHA-256 of the full file** in the NIP-71 `x` tag; **transport identity = core key + blob range**. The gateway keeps a sha256→blob index so standard Blossom clients (BUD-01 range GETs) can read from the swarm. | You get Blossom interop without re-chunking, and you get Blossom's HTTP surface only where HTTP exists (the gateway). |
| A3 | Payment runs on a separate protomux protocol **`pay/1` muxed onto the same stream as replication**. Seeder counts `upload` events per peer; viewer counts `download` events per peer. Chunk-first, pay-after-verify. Hypercore does not emit `download` for a block that failed its proof. | Payment gating without patching Hypercore. |
| A4 | When a peer exceeds the unpaid window (default: 4 blocks ≈ 256 KB), the seeder **destroys that replication stream** and bans the pubkey. | I'm not certain Hypercore exposes a per-peer "pause uploads" API. Stream destroy is coarse but sufficient. Verify in Phase 1; use the finer API if it exists. |
| A5 | The seeder enforces the split: every `PAY` carries two P2PK-locked proof sets (seeder's, creator's) or the stream stops. Seeder publishes the creator's as a NIP-61 nutzap; viewer keeps a copy as fallback. | Only way to stiff the creator is to also stiff the seeder, which the seeder detects. |
| A6 | Viewers hold balance in a **NIP-60 wallet** (proofs NIP-44-encrypted on relays), so one wallet follows them between Pear and web. | Largest "least wallet code" lever. |
| A7 | **Pear app playback** = `hypercore-blob-server` on localhost answering range requests to a plain `<video>` element. No CMAF/MSE needed on desktop. | Exactly what the guide does; seeking works out of the box. |
| A8 | **Browser playback** = Hypercore running in-page with in-memory storage, replicating over a WebSocket to the gateway, plus a service worker that answers range requests to `<video>` from the local core. Same protocol code as Pear. | If the current bare-* dependency tree doesn't run in browsers, fallback is gateway-served sha256 segments + MSE. **Phase 1 spike decides.** |
| A9 | Hyperblobs block size is set to 64 KiB (I believe this is the default; verify). Price is quoted per block; `PAY` may cover several blocks at once. | Fewer messages than paying every block individually; window math stays in blocks. |
| A10 | Protocol library is runtime-agnostic (Bare, Node, browser). Pear is a deployment target, not a dependency. | Insurance against depending on one runtime vendor. |
| A11 | Frontend is **one React + Vite + Tailwind codebase** with two shells: pear-electron renderer and static web. Data access goes through an adapter interface so screens don't know which network they're on. | One UI to polish, one UI to audit. |

---

## 1. Threat model

| Actor | Attack | Control | Residual loss |
|-------|--------|---------|---------------|
| Malicious seeder | Serves wrong bytes | Hypercore Merkle proof per block, before `download` fires | 0 |
| Malicious seeder | Stalls | Hypercore already multi-sources; per-peer timeout, drop | Time |
| Malicious viewer | Downloads, never pays | Window (4 blocks), then stream destroy + ban | ~4 blocks of sats |
| Malicious viewer | Pays seeder, stiffs creator | Seeder requires both proof sets | 0 |
| Malicious viewer | Double-spends | DLEQ offline check; async swap at mint; ban on failure | ≤ window |
| MITM | Steals proofs in flight | Noise secret-stream + P2PK lock to recipient | 0 |
| Any peer | Forged proofs | NUT-12 DLEQ against cached mint keyset | 0 |
| Mint | Rug / compromise | Small balances, creator-chosen mint, one-click melt-out, mint shown in UI | Balance at that mint |
| Impostor creator | Fake video under real title | Signed NIP-71 event; UI shows verified pubkey/NIP-05, not just display name | Reputation |
| Sybil seeders | Join topic, serve nothing | Pay-after-verify makes them unprofitable; peer reputation | Time |
| Internet | DoS seeder/gateway | Per-pubkey rate limits, max streams, OS hardening | Availability |
| npm | Compromised dep | Lockfile, `npm ci --ignore-scripts`, exact pins, native module audit | Depends |
| Portal operator | Malicious JS | Open source, reproducible build, hash in signed Nostr event, SRI, CSP. **Not fully fixable in a browser — say so in the UI.** | Web session |
| Host | Keys read from disk/logs | Encrypted at rest, secure memory, log redaction | Keys on host |
| Content | XSS via titles/descriptions/comments | Render as text or sanitized markdown; CSP no-inline; Electron `contextIsolation`, no `nodeIntegration`, sandboxed renderer | 0 |
| Content | Malicious thumbnail/blob | Thumbnails are Blossom blobs with `x` hash in imeta; verify before display; images decoded in renderer only | 0 |

---

## 2. Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │ Nostr relays                                 │
                 │ 0 profile · 3 follows · 7 reactions          │
                 │ 21/22 video (NIP-71) · 1111 comments (NIP-22)│
                 │ 30005 video sets (NIP-51) · 10019 nutzap info│
                 │ 17375/7375/7376 wallet (NIP-60) · 9321 nutzap│
                 │ 10063 server list (BUD-03) · 1984 reports    │
                 └───────────┬────────────────────┬─────────────┘
                             │ wss                │ wss
  ┌──────────────┐           │                    │        ┌────────────────┐
  │ Pear seeder  │◄──hyperswarm: hypercore repl + pay/1──►│ Gateway node   │
  │ daemon       │           │                    │        │ = seeder +     │
  └──────────────┘           │                    │        │  WS bridge +   │
  ┌──────────────┐           │                    │        │  Blossom HTTP  │
  │ Pear desktop │◄──────────┘                    │        └───────┬────────┘
  │ (electron    │  local: hypercore-blob-server → <video>         │ ws: hypercore repl + pay/1
  │  renderer +  │                                                 ▼
  │  Bare worker)│                                          ┌────────────────┐
  └──────────────┘                                          │ Web portal     │
                                                            │ (same React UI,│
                       ┌──────────────┐                     │  in-page core, │
                       │ Cashu mint   │ ← creator's choice  │  SW → <video>) │
                       └──────────────┘                     └────────────────┘
```

### 2.1 Packages

| Package | Runs on | Contents |
|---------|---------|----------|
| `@sovit/core` | Bare, Node, browser | `manifest`, `payment`, `signer`, `wallet-nip60`, `pay/1` protocol, `discovery`, `nostr` data layer (feeds, comments, reactions, sets) |
| `@sovit/seeder` | Bare (Pear terminal app) | Corestore + Hyperblobs, swarm, `pay/1` server side, swap/nutzap batching, CAS index, rate limits, melt command |
| `@sovit/gateway` | Bare or Node | `@sovit/seeder` + WS bridge (replication stream over WebSocket) + Blossom HTTP (BUD-01/02/03/04/06/09) + sha256→blob index |
| `@sovit/ui` | Browser + Electron renderer | React screens, design system, player, wallet widgets, upload flow. Talks only to a `NetworkAdapter` interface |
| `@sovit/app-desktop` | Pear (pear-electron) | Shell: Bare worker hosting seeder + blob server; preload bridge; `NetworkAdapter` = worker IPC |
| `@sovit/app-web` | Static | Shell: `NetworkAdapter` = WS gateway + in-page Hypercore; service worker for range requests; NIP-07/46 signer |

`payment` and `signer` in `@sovit/core` are the audit surface. Keep them tiny.

### 2.2 Data model (Nostr events)

**Video** — NIP-71 kind 21 (normal) / 22 (short). Tags:

```
["title", "..."]
["published_at", "<unix>"]
["imeta", "url hyper://<core-key-hex>/<blob-id>", "m video/mp4", "x <sha256 full file>",
          "size <bytes>", "dim 1920x1080", "image <thumb-blossom-url>", "fallback https://gateway/<sha256>"]
["imeta", ...]                                  # one per rendition (1080p/720p/360p) — NIP-71 supports variants
["mint", "https://mint.example"]                # creator-chosen mint(s)
["price", "<sats per 64KiB block>", "sat"]
["split", "seeder:50", "creator:50"]            # default if absent
["p2pk", "<creator cashu P2PK pubkey>"]         # from creator's kind 10019
["t", "topic"]                                  # hashtags for feeds
["duration", "<seconds>"]
["blossom", "https://gateway.example"]          # HTTP fallback servers
```

**Channel** = kind 0 profile + NIP-05. **Subscribe** = kind 3 follow (or a NIP-51 kind 30000 "channels" set if you want subscriptions separate from social follows — recommend the set). **Like** = kind 7 reaction on the video event. **Comment** = NIP-22 kind 1111 with `A`/`a` root pointing at the video. **Playlist** = NIP-51 kind 30005 video set. **Watch later / history** = NIP-51 private (encrypted) sets so they roam but aren't public. **Report** = NIP-56 kind 1984 → gateways honour it (BUD-09). **Seeder announcement** = kind 10019 with accepted mints + P2PK pubkey. **Creator payout** = kind 9321 nutzap.

**Things YouTube has that Nostr does not, and the substitute:**

| YouTube feature | Substitute | Honest caveat |
|-----------------|-----------|---------------|
| View count | Count of unique paying pubkeys from nutzap events (creator-side, verifiable) + gateway-reported plays | Not global, not un-gameable. Show "paid views" and label it |
| Trending | Sats earned per hour from kind 9321 events, decayed | Pay-to-trend by design; disclose |
| Global search | NIP-50 relay search + local index of subscribed channels; gateways may run a search index | Depends on relays; degrade gracefully |
| Recommendations | Same-creator, same-tags, "people who nutzapped this also nutzapped" computed client-side | No cross-user model; say so |
| Notifications | Relay subscription on followed pubkeys' kind 21/22 + replies to your comments | Only while a client is open unless a gateway pushes |
| Live | Out of scope here; Pear's live-camera guide covers the transport later | — |

### 2.3 `pay/1` (protomux, alongside Hypercore replication)

| Message | Dir | Payload |
|---------|-----|---------|
| `HELLO` | both | version, nostr pubkey, signed challenge, accepted mints, price/block, split |
| `PAY` | viewer→seeder | `{ fromBlock, toBlock, seederProofs[], creatorProofs[] }` — both P2PK, both with DLEQ |
| `ACK` | seeder→viewer | ok / reason |
| `PRICE` | seeder→viewer | new price (viewer may leave) |

Rules: seeder tracks `uploaded − paid` per peer, destroys stream past window; viewer pays only for blocks Hypercore has emitted `download` for from that peer; seeder verifies offline (DLEQ, P2PK target, exact amounts, mint) before `ACK`; swaps at mint asynchronously in batches; overpayment rejected.

---

## 3. Payment flow

**Funding (the only wallet UX you build):** read `mint` tag → check NIP-60 balance at that mint → if short, request a mint quote (NUT-04), show the bolt11, user pays from any Lightning wallet → poll → write kind 7375. Optional: auto-top-up when balance drops below N sats, using a melt at another mint the user holds balance at (two cashu-ts calls, opt-in, costs LN fees).

**Per block range:** `download` events accumulate → `payment.split(blocks × price, seederPubkey, creatorPubkey)` → NUT-11 P2PK send → update NIP-60 (7375 with `del`, 7376 history) → `PAY` → `ACK`.

**Seeder:** verify → `ACK` → every N blocks or 60 s: swap own proofs (NUT-03) into own NIP-60 wallet; publish creator proofs as kind 9321. Melt to Lightning (NUT-05) on command or threshold.

Wallet surface = **mint quote, P2PK send, swap, melt**. All in `@cashu/cashu-ts`. No Lightning code. No custody.

**NIP-60 P2PK key:** dedicated wallet key in kind 17375. Pear: decrypt via signer nip44, hold in `sodium-native` secure memory. Browser: prefer the `signSecret` NIP-07/46 extension so the key never enters page memory; fall back to nip44 decrypt if the signer lacks it, and show the user which mode they're in.

---

## 4. Least-wallet-code strategy

| Need | Use | Build? |
|------|-----|--------|
| Cashu NUT-03/04/05/11/12 | `@cashu/cashu-ts` | No |
| NIP-60/61 state | existing NIP-60 library — verify maintenance at Phase 1 start | Adapter only |
| Nostr events/signing | `nostr-tools` | No |
| Signer (Pear) | local key encrypted with a passkey (WebAuthn), or NIP-46 | Adapter |
| Signer (web) | NIP-07 or NIP-46 only; refuse to run without one | Adapter |
| Lightning | none | No |

Out of scope: LNbits, NWC, custodial balances, proof-management UI. Nutzaps are the creator payout.

---

## 5. Gateway and web portal

**Gateway** = `@sovit/seeder` plus:
1. **WS bridge** — one WebSocket = one Hypercore replication stream + `pay/1`. To the browser, the gateway is a seeder; it charges its own price (disclosed in `HELLO`) and pays upstream.
2. **Blossom HTTP** — `GET/HEAD /<sha256>` with range (from the sha256→blob index, reusing `hypercore-blob-server` range logic), `PUT /upload` with kind 24242 auth (gateway becomes first seeder), `PUT /mirror`, `HEAD /upload`, `PUT /report`. This is what makes the network readable by any Blossom client.

**Browser** (assumption A8): in-page Hypercore over WS, service worker serving `Range` responses to `<video>`, same `pay/1` code. Strict CSP, SRI on every script, no third-party origins, no analytics, reproducible build with hash published in a signed Nostr event. Proofs decrypted into memory only; nothing persisted in the browser.

---

## 6. UI / product layer ("polished YouTube")

### 6.1 Screens

| Screen | Content | Backed by |
|--------|---------|-----------|
| **Home** | Grid of thumbnails: subscriptions feed, trending (sats/hour), tags you follow. Infinite scroll, skeleton loaders, hover preview (first ~3 s pulled from the blob — costs a few blocks; make hover-preview a setting, default on for Pear, off for web) | kind 21/22 by follows, 9321 aggregates |
| **Watch** | Player (16:9, theater, mini-player on navigate, PiP), title, channel row with Subscribe + "sats to creator" badge, like/nutzap buttons, description (sanitized), comments (NIP-22, sorted new/top by reactions), sidebar of related | NIP-71 event, 1111, 7, 9321 |
| **Channel** | Banner, avatar, NIP-05 verification badge, tabs: Videos / Shorts / Playlists / About; "Seeding N videos" indicator if the channel runs a seeder | kind 0, 21/22, 30005, 10019 |
| **Search** | Results with filters (date, duration, tags, creator) | NIP-50 + local index |
| **Shorts** | Vertical swipe feed of kind 22 | kind 22 |
| **Library** | History, Watch later, Playlists, Liked | NIP-51 private/public sets |
| **Studio** | Upload (drag/drop, progress, transcoding renditions, thumbnail pick, title/description/tags, mint selection, price, split), Analytics (paid views, sats by rendition, seeder count), Seeder status (earnings, melt-out, banned peers) | local + relays |
| **Wallet** | Balance per mint, fund via LN invoice QR, auto-top-up threshold, melt-out, history (7376); a persistent header chip showing balance and "streaming X sats/min" while playing | NIP-60 |
| **Settings** | Signer (NIP-07/46/local), relays, default mints, seeding on/off + disk cap, data-saver (prefetch depth), theme | local + kind 10002 |

### 6.2 Player behaviours that matter here

- **Buffer = money.** Prefetch depth is a user setting (default ~30 s). Do not prefetch related videos. Pause = stop paying; show it.
- **Rendition switching** = switching to a different Hyperblob (different core or blob range) at a keyframe; show the price difference. Auto mode picks by throughput, not by sats.
- **Keyboard**: space/k, j/l ±10 s, f, m, t, i, </> speed, number keys seek %.
- **Resume** from NIP-51 private history; **autoplay next** from playlist or related, with the price shown before it starts.
- **Peer panel** (optional overlay): seeders you're paying, sats/min each. This is your differentiator; make it pretty, not a debug view.

### 6.3 Design system

- Tokens: 8-pt spacing, one type scale, semantic colours with dark default and light option, motion ≤ 200 ms, prefers-reduced-motion respected.
- Components: `VideoCard`, `Player`, `ChannelRow`, `SatsBadge`, `MintChip`, `PeerMeter`, `Skeleton`, `Sheet`, `Toast`. Storybook or equivalent so the Electron and web shells render pixel-identical components.
- Everything renders text as text. Descriptions/comments: a fixed markdown subset (bold, italic, links with rel=noopener, nostr: links resolved to profile chips). No raw HTML, ever.
- Media: thumbnails and avatars are Blossom blobs; verify `x` hash before display when present; lazy-load; blur-up placeholder from a tiny inline variant published in imeta.
- Empty/error states designed, not defaulted: "no balance at this mint", "no seeders online", "signer not detected".
- Accessibility: focus rings, ARIA on player controls, captions track support (WebVTT as a Blossom blob referenced in imeta).

### 6.4 Upload pipeline (Studio)

1. Drop file → probe with ffmpeg (Pear: `bare-ffmpeg`/`bare-media` per the Pear docs — verify what they expose; fallback: spawn system ffmpeg via `bare-subprocess`; web: server-side at gateway after BUD-02 upload, with a clear "your gateway will transcode" notice).
2. Transcode renditions (1080p/720p/360p, faststart MP4 so range playback starts immediately), generate thumbnail candidates + tiny placeholder + optional storyboard sprite for scrub preview.
3. Write each rendition to Hyperblobs; compute sha256 of each; start seeding.
4. Publish NIP-71 event with one imeta per rendition; optionally BUD-02 mirror to chosen gateways for availability.
5. Studio shows: seeder count, first paid view, sats earned.

---

## 7. Host and supply-chain hardening

Seeder and gateway: dedicated user; systemd `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`; test `MemoryDenyWriteExecute` against the JS engine's JIT. Keys at rest: argon2id-derived passphrase key; never env vars. In memory: `sodium-native` secure buffers, zeroed on logout. Log redaction layer in front of every logger (tokens, proofs, nsec). Per-pubkey rate limits and global stream cap; persisted ban list. Dependencies: exact pins, lockfile, `npm ci --ignore-scripts`, provenance where available, explicit list of native modules (`sodium-native`, `udx-native`, `bare-*` bindings) reviewed on every bump. Releases: Pear drive signed by an offline app key; release hash published in a Nostr event from the org key.

Electron renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload exposes only the `NetworkAdapter` methods; CSP identical to the web build.

---

## 8. Phases

**Phase 0 — Spec and spikes (2 weeks)**
- Write `pay/1` as a BUD-style spec; write the NIP-71 tag extensions; `SECURITY.md` = §1.
- **Spike A:** Hypercore per-peer upload gating — does a pause API exist, or is stream destroy the tool?
- **Spike B:** current Hypercore + Hyperblobs in a browser over a WS bridge with in-memory storage and a service worker feeding `<video>`. Pass/fail decides A8.
- **Spike C:** `bare-ffmpeg`/`bare-media` capability for transcode + thumbnail.
- Decide A1–A11.

**Phase 1 — `@sovit/core` without network (3 weeks)**
- `payment`, `signer` (local), `wallet-nip60` against Nutshell on regtest; `manifest`; Nostr data layer (feeds, comments, reactions, sets) against a local relay.
- Property tests: mutated block → never paid; short/missing proof set → rejected; DLEQ forgery → rejected; overpay → rejected.
- Exit: 100% branch coverage on `payment`.

**Phase 2 — `pay/1` over in-memory replication (2 weeks)**
- Two Corestores replicating over a duplex pair; `pay/1` muxed in; window/ban logic.
- Adversary sims: stalling seeder, non-paying viewer, creator-stiffing viewer, double-spender (mock mint reports spent).
- Exit: every adversary bounded to §1 residuals.

**Phase 3 — Seeder daemon on Pear (2 weeks)**
- Hyperswarm, Hyperblobs storage with disk cap, kind 10019 announce, batch swap + nutzap, melt command, systemd hardening.
- Exit: two seeders on separate hosts; a viewer lib on a third streams a full video and both seeders melt out (testnet mint).

**Phase 4 — Design system + desktop app (5 weeks)**
- Weeks 1–2: `@sovit/ui` tokens/components in isolation; Home, Watch, Channel, Wallet screens with mock adapter.
- Weeks 3–5: pear-electron shell, Bare worker (seeder + blob server), `NetworkAdapter` over worker IPC, Studio upload pipeline, signer (local + NIP-46).
- Exit: upload → publish → discover → watch → pay → payout end-to-end with three seeders; UI review against the §6 screens.

**Phase 5 — Gateway + web portal (4 weeks)**
- WS bridge, Blossom HTTP + sha256 index, web shell with the adapter chosen in Spike B, service worker player, NIP-07/46 signer, in-memory NIP-60.
- CSP/SRI/reproducible build; release-hash event.
- Exit: wallet funded in Pear spends in the browser and vice-versa; a third-party Blossom client fetches a video by sha256 from the gateway.

**Phase 6 — Polish and adversarial testing (3+ weeks)**
- Player edge cases (rendition switch, seek past buffer, network drop mid-`PAY`), mini-player/PiP, keyboard, a11y pass, empty/error states.
- Fuzz `pay/1` codec and `payment` parsers; live double-spend attempts on a real mint; external review of `payment`, `signer`, gateway auth.
- Exit: findings fixed; spec updated; a non-developer can use it without reading docs.

---

## 9. Open questions (answer before Phase 1)

1. **Economics:** default price per 64 KiB block, and whether a 4-block window (≈ 256 KB) is an acceptable seeder exposure.
2. **Mints per video:** one or several? Several = seeders must cache several keysets.
3. **Who publishes creator nutzaps:** seeder, viewer, or both (recommended: both).
4. **Gateway fee model:** flat per-block markup, disclosed in `HELLO`?
5. **Cold-video retention:** nothing here pays to hold unwatched content. Creator-funded storage bounties would be a Phase 7 with its own mechanism — do not bolt it onto `pay/1`.
6. **Subscriptions:** kind 3 follows or a dedicated NIP-51 set? (Recommend the set — keeps "I watch your videos" separate from "I follow you socially".)
7. **View counts:** are you comfortable displaying "paid views" and labelling it, or would you rather show nothing than a gameable number?
8. **Transcoding on web upload:** gateway-side transcode is a cost and a moderation exposure for the operator. Allowed, or Pear-only uploads?
9. **Moderation on gateways:** BUD-09 reports + allow/deny by creator pubkey; who curates the default list?
10. **NIP-60 library:** re-verify maintenance status at Phase 1 start; do not pin from this document.
11. **Brand risk:** "Nutflix" invites a Netflix trademark claim; parody is a weak defense for a commercial streaming product, and app stores, npm, GitHub, and registrars respond to US takedowns wherever the project is based. Mitigation adopted: brand name only, no trademark filing, no multi-year domain commitments, neutral identifiers in code, and a pre-checked second name reserved so a rename is a day's work.
