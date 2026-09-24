# Review: browser resolution by manifest address (2026-09-24)

Scope:
- `web/player/src/nostr.ts` and `src/resolve.ts`, plus the `player.ts` wiring,
  `index.html`, `e2e.ts` and `unit.ts`;
- `crates/nfx-wasm`: `parseATag`, the manifest `id`, and path-prefixed origins.

Method: `differential-review` (the browser trust boundary) and `sharp-edges`.

| Concern | Result |
|---|---|
| A relay returns a manifest for another address, or an invalid one | Every event is verified by nfx-proto (WASM), and the verified `a` must equal the requested one. Tested: an unpublished address fails with "no valid manifest", never a guess. |
| An old or far-future revision | The NFX-02 §4 current-revision rule applies (highest `created_at`, ties to the lowest `id`), and a revision dated more than 15 minutes ahead is ignored. |
| A hostile beacon steering requests | Beacons are verified in WASM, must match the address, and only `https` endpoints are used. Each is reduced to `https://host[/prefix]`: a query, fragment or credentials refuse it (unit tested). At most 8 origins are reported. The remaining exposure is inherent to following NFX-03 endpoints: a GET to a beacon-named host and path, ending in `/<root>`. |
| A hostile origin serving wrong bytes | Unchanged: each file is checked by WASM before hls.js sees it (the lying-origin e2e still passes). |
| A relay flood or oversized messages | Messages over 70 KiB are dropped unparsed, and one subscription hands on at most 1,000 events. |
| Relay URLs from the page URL | Only `ws://` and `wss://` are used; anything else is ignored. |
| The WASM master-playlist check | Previously it recognised `/<root>/master.m3u8` only at the top of the path, so an origin under a prefix failed every check. It now matches the last two path elements; bare `/master.m3u8` is still refused (tested). |

Carried forward:
- **Beacons are ephemeral**, so a viewer with no origin hint waits for the next
  republish, up to TTL/2 (60 s). Sites that know their origin should pass the hint.
- **Fallback happens only at start.** The player falls back to another origin only
  until the hash list verifies; switching origins mid-playback is not implemented.
- **No mesh yet.** WebRTC (`webrtc` endpoints) is not used; that is the p2p-media-loader
  work of NFX-10.

Verdict: **no blocker.**
