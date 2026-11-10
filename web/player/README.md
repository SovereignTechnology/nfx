# The NFX web player

A library (`src/lib.ts`) and the test player page over it (`index.html`, `src/player.ts`):
hls.js over an NFX-05 §6 origin, with every playlist, init and segment checked against the
signed anchor by nfx-proto, compiled to WASM (`crates/nfx-wasm`), before hls.js sees a byte.
With trackers or Nostr relays, the NFX-10 browser mesh (p2p-media-loader 4) joins in, and
segments from peers are checked the same way. nutflix-pear's web client consumes the library (ADR 0101,
amended 2026-11-09); nfx imports nothing from it.

## The library

```ts
import { init, resolveManifest, watchEndpoints, open } from './player.js';

await init();                                   // or init({ wasmUrl }) if the WASM is elsewhere
const m = await resolveManifest(a, relays);     // NFX-02 over Nostr, deletions applied
const stop = watchEndpoints(a, m.namespace, relays, (e) => {
  // e.origins: https bases, e.trackers: wss trackers, e.stunServers: stun: URLs,
  // from the newest live beacon per seeder
});
const session = await open(videoElement, {
  manifestJson: m.event,                        // verified again in WASM
  origins: ['https://origin.example/nfx'],      // tried in order
  signaling: { kind: 'nostr', relays: ['wss://relay.example'] }, // optional; none = no mesh
  // or: signaling: { kind: 'trackers', urls: ['wss://tracker.example'] },
  iceServers: [{ urls: 'stun:stun.example:3478' }], // optional, STUN only
  onEvent: (ev) => {},                          // log, origin, verified, rejected, levels, playing, error
  signal,                                       // optional: aborts open(), or ends the session
});
session.levels; session.setLevel(-1); session.stats();
session.destroy();                              // hls.js, its worker, the p2p loader, sockets, peers
```

The types are in `src/api.ts`. `open()` also takes a bare `root` (with `video` and `segs` to
bind the hash list) instead of `manifestJson`.

`signaling` is how mesh peers find each other and exchange offers, answers and ICE
candidates, wired into the engine in one place (`src/mesh.ts` `engineSignaling`). Two kinds:

- `{ kind: 'nostr', relays }` (1 to 8, `wss://`; NFX-10 §6, `src/signal-nostr.ts`): no
  tracker at all. Each session draws a fresh random key (never a user's) and joins one room
  per stream swarm, its key derived from the swarm ID. Presence (`connect` every 30 s,
  `disconnect` on destroy) and offers and answers travel as ephemeral kind-25050 events
  through ordinary relays, each signed when it is sent; offers and answers carry the complete
  SDP NIP-44 encrypted to the receiver's session key, and the lower session key offers.
  Every event is built and checked by nfx-proto in WASM, the same code native peers run.
  Relays see room and session keys, who signals whom and when, and the viewer's IP address,
  but not the SDP; peers see each other's addresses once they connect. A scoped relay
  (NFX-04) refuses kind 25050: give general relays. `relayUrl()`, `checkSignaling()`,
  `MAX_RELAYS`, `NOSTR_SIGNAL_KIND` and `NOSTR_SIGNAL_PROTOCOL` let a page check its
  settings first.
- `{ kind: 'trackers', urls }` (1 to 4, `wss://`): WebTorrent trackers, as before.

Trackers and origins named by beacons are hints:
`watchEndpoints` keeps only `wss://` trackers and `https://` origins, ranked by how many
seeders name them. With any tracker, the viewer uploads verified segments to other viewers,
and the trackers and those peers see the viewer's IP address.

## Build and test

```sh
npm ci
npm run build          # the WASM (wasm-pack) and the test page, out/
npm run build:lib      # the library: out-lib/player.js (minified) and its declarations
npm run typecheck
npm run unit           # sanitisers, the beacon endpoint book, open()'s option checks
npm run e2e            # the test page end to end (cargo, ffmpeg, openssl, Chromium)
npm run e2e:mesh       # the mesh, the bridge, the library's lifecycle, trackers from a beacon
eval "$(bash e2e-strfry.sh /var/tmp/strfry)"   # the stock relay, strfry at a pinned commit
npm run e2e:nostr      # two browsers over Nostr only (strfry, no tracker), the origin cut
npm run e2e:nostr-node # a browser and nfxd's mesh endpoint (full ICE) over strfry, the origin cut
```

The suites build `nfxd` and `nfx-package` and run headless Chromium in fresh contexts, on
loopback only.

## The mesh engine

The library bundles p2p-media-loader-core 4.0.0 from its own TypeScript source with one
patch, `engine/p2p-media-loader-core-4.0.0.patch`: `signalingClientFactory`, a stream
configuration hook through which a swarm takes a signaling client the page supplies (here
the Nostr one) instead of WebTorrent tracker clients. The engine keeps its peer
de-duplication and limits (`claimPeer`, `shouldGenerateOffers`), its `peerConnected`
contract and its teardown; with no factory it behaves as published. It is written to go
upstream as it is.

`npm run engine` (part of every build) runs `engine/patch.mjs`, which checks before it
writes anything: that `package-lock.json` pins the npm tarball at the integrity
`engine/pin.json` records (what `npm ci` verified), that the installed `src/` is file for
file the pinned tree (`src_sha256`), and that the patch has its pinned sha256. It applies
the patch in memory, strictly (every hunk at its stated line, no fuzz), checks the result
against `out_sha256`, and only then writes it to `out-engine/`, where esbuild resolves
`p2p-media-loader-core` (`--alias`).

## The library tar

`bash lib-tar.sh` builds the WASM and the library and packs `out-lib/nfx-web-lib-<commit>.tar`
(the first 12 hex digits of the nfx commit): `api.d.ts`, `player.d.ts`, `player.js` and
`wasm/nfx_wasm_bg.wasm`, names sorted, with the WASM's paths remapped to `/nfx` and `/cargo`.
The archive is written by `lib-tar.mjs`, not by a tar program (whose bytes vary with its
version): plain ustar members, mode 0644, uid and gid 0, mtime 0, no directory entries. It
prints each file's sha256 and the tar's.

The same commit built with the same tools gives the same bytes, so a consumer pins the
tar's sha256 beside the commit. The script refuses other tools: rustc 1.98.0 with the
`wasm32-unknown-unknown` target, wasm-pack 0.15.1, wasm-bindgen on `PATH` at the version
`crates/Cargo.lock` pins, and esbuild and typescript from `package-lock.json`. In a git
checkout the tree must be clean; from a source archive, pass `--commit <sha>`. `--expect
<sha256>` makes a mismatch an error.

To serve it, extract the tar into one directory: `player.js` loads
`wasm/nfx_wasm_bg.wasm` from beside itself unless `init({ wasmUrl })` says otherwise. A page
under a CSP needs `'wasm-unsafe-eval'` in `script-src` (the WASM verifier), `blob:` in
`media-src` (the MediaSource) and in `worker-src` (hls.js's transmuxing worker), and its
origins, relays (the Nostr signaling relays included) and trackers in `connect-src`.
