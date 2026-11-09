# The NFX web player

A library (`src/lib.ts`) and the test player page over it (`index.html`, `src/player.ts`):
hls.js over an NFX-05 §6 origin, with every playlist, init and segment checked against the
signed anchor by nfx-proto, compiled to WASM (`crates/nfx-wasm`), before hls.js sees a byte.
With trackers, the NFX-10 browser mesh (p2p-media-loader 4) joins in, and segments from
peers are checked the same way. nutflix-pear's web client consumes the library (ADR 0101,
amended 2026-11-09); nfx imports nothing from it.

## The library

```ts
import { init, resolveManifest, watchEndpoints, open } from './player.js';

await init();                                   // or init({ wasmUrl }) if the WASM is elsewhere
const m = await resolveManifest(a, relays);     // NFX-02 over Nostr, deletions applied
const stop = watchEndpoints(a, m.namespace, relays, (e) => {
  // e.origins: https bases, e.trackers: wss trackers, from the newest live beacon per seeder
});
const session = await open(videoElement, {
  manifestJson: m.event,                        // verified again in WASM
  origins: ['https://origin.example/nfx'],      // tried in order
  signaling: { kind: 'trackers', urls: ['wss://tracker.example'] }, // optional; none = no mesh
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
candidates. This build has one kind, WebTorrent trackers (1 to 4, `wss://`). It is a seam:
the planned Nostr kind (ephemeral NIP-44 events, per-session keys, no tracker; nfx #71) will
be another member of the `Signaling` union, wired in `src/mesh.ts` `engineSignaling`, and
callers passing `{ kind: 'trackers' }` will not change. p2p-media-loader 4.0.0 opens its
tracker sockets itself, so that kind needs an engine that lets the library carry the
exchange. Trackers and origins named by beacons are hints:
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
```

The suites build `nfxd` and `nfx-package` and run headless Chromium in fresh contexts, on
loopback only.

## The library tar

`bash lib-tar.sh` builds the WASM and the library and packs `out-lib/nfx-web-lib-<commit>.tar`
(the first 12 hex digits of the nfx commit): `api.d.ts`, `player.d.ts`, `player.js` and
`wasm/nfx_wasm_bg.wasm`, names sorted, mtime 0, uid and gid 0, mode 0644, no directory
entries, POSIX format without atime or ctime, and the WASM's paths remapped to `/nfx` and
`/cargo`. It prints each file's sha256 and the tar's.

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
origins, relays and trackers in `connect-src`.
