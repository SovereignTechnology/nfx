# The NFX web player

A library (`src/lib.ts`) and the test player page over it (`index.html`, `src/player.ts`):
hls.js over an NFX-05 §6 origin, with every playlist, init and segment checked against the
signed anchor by nfx-proto, compiled to WASM (`crates/nfx-wasm`), before hls.js sees a byte.
With trackers or Nostr relays, the NFX-10 browser mesh (p2p-media-loader 4) joins in, and
segments from peers are checked the same way. nutflix-pear's web client consumes the library (ADR 0101,
amended 2026-11-09); nfx imports nothing from it.

## The library

```ts
import { init, resolveManifest, watchEndpoints, selectStun, open } from './player.js';

await init();                                   // or init({ wasmUrl }) if the WASM is elsewhere
const m = await resolveManifest(a, relays);     // NFX-02 over Nostr, deletions applied
const stop = watchEndpoints(a, m.namespace, relays, (e) => {
  // e.origins: https bases, e.trackers: wss trackers, from the newest live beacon per
  // seeder; e.stunCreator: stun: URLs the video's creator names in its own beacon;
  // e.stunSeeders: each seeder's, for the fallback; e.originSources: the origins with the
  // renditions beacons claim each serves (hints); e.availability: how many seeders hold each
  // rendition
  // selectStun(own, e.stunCreator): the STUN servers to use (NFX-10 §1's rules)
});
const session = await open(videoElement, {
  manifestJson: m.event,                        // verified again in WASM
  origins: ['https://origin.example/nfx'],      // tried in order; or e.originSources
  renditions: ['720p', '360p'],                 // optional: allowed ids, preferred first
  signaling: { kind: 'nostr', relays: ['wss://relay.example'] }, // optional; none = no mesh
  // or: signaling: { kind: 'trackers', urls: ['wss://tracker.example'] },
  segmentSource: 'peers-then-https',            // optional: 'https-first' (default), or 'peers-only'
  iceServers: [{ urls: 'stun:stun.example:3478' }], // optional, STUN only
  onEvent: (ev) => {},                          // log, origin, verified, rejected, levels, playing, mesh, waiting, resumed, rescue, error
  signal,                                       // optional: aborts open(), or ends the session
});
session.levels; session.setLevel(-1); session.stats(); // each level has its rendition `id`
await session.addresses();                      // only when the user asks: peers' IP addresses
session.destroy();                              // hls.js, its worker, the p2p loader, sockets, peers
```

The types are in `src/api.ts`. `open()` also takes a bare `root` (with `video` and `segs` to
bind the hash list) instead of `manifestJson`.

**Where segments come from** (`segmentSource`, decision record 0109). With a mesh, the
default is the origin first (`https-first`). `peers-then-https` takes each segment from a
peer that holds it, and from the origin only as a rescue: when no connected peer holds the
segment playback is asking for once peers have had `peerWaitMs` (4 s) to connect, or when a
peer holds it but playback is about to need it. `peers-only` never asks an origin for a
segment: playback waits for a peer. `stats().mesh` says which is in use (`source`), how many
segments were rescued (`rescues`), whether playback is waiting for a peer (`waiting`), and
how long the first peer and the first segments took (`startup`). The hash list, playlists
and init segments come from an origin in all three. `session.setSegmentSource(source)`
changes it while the session plays: a page can offer a switch that turns HTTPS off for
segments (`peers-only`), and on again.

At the start of a session with a mesh the library checks once whether the browser's WebRTC
gathers a UDP candidate. If it gathers none (WebRTC is off, or kept to a proxy, by a setting
or an extension), no peer can connect: `stats().mesh.webrtc` is `blocked` and a `mesh` event
says why, so a page can tell the viewer instead of showing an origin as the only source.

### Where the bytes come from (stats for nerds, nfx #99)

`stats()` is a snapshot a page may poll. Besides the origin, levels and what was verified or
refused, it says where the bytes came from:
- `originBytes`: what the player's own loader took from the origin (playlists and inits,
  and segments when there is no mesh), and `bandwidthEstimate`, hls.js's estimate;
- `mesh.bytes` and `mesh.segments`: segment bytes and whole segments over HTTP and from
  peers, `mesh.uploaded`, `mesh.connected` (open now) beside `mesh.peers` (every connect);
- `mesh.peerList`: each peer (`MeshPeer`, at most 64, open ones first): the engine's id for
  it (a Nostr peer's session key, or a tracker peer's WebTorrent id), where it was found,
  bytes each way and whole segments. Ids and `via` come from the network, so a page shows
  them as text only;
- `mesh.signal`: the Nostr kind's counters (events sent and received, offers, answers) and
  how many of its relay sockets are open.

`addresses()` reads the selected ICE candidate pair of each open peer (one per peer: its first
open connection, when it is connected in several swarms) from the browser's `getStats()`
(`PeerAddress`: the remote address and port as the browser reports
them, both candidate types, `direct` or `relayed` through TURN, the round-trip time). It
runs only when called. **These are other viewers' IP addresses**: a page asks only when its
user asks to see them, and never logs, stores or sends them. The test page shows them behind
a "Show addresses" switch that is off each time the panel opens.

A seeder may hold only some renditions of a video (NFX-03 §4), so a session offers only
levels some source it uses can deliver (NFX-10 §1, `src/levels.ts`, `src/probe.ts`). It
takes every file from one origin, and **asks the origin** what it holds (nfx #85): once the
hash list verifies, `open()` fetches each allowed rendition's media playlist (verified) and
sends a `GET` for the init it names, reading at most 64 KiB; in parallel (6 at a time, at
most 32 renditions) and within 8 s per origin in all. A rendition is held when its init
answers `200` (or `206`). The first origin that holds an allowed rendition is used, and its
levels are the allowed renditions (`renditions`, or all) it holds; an origin that holds
none is skipped, with an `origin` event giving each rendition's answer. The mesh adds no
level, since a segment peers do not deliver comes from that origin. hls.js reads a master
playlist cut to those variants, matched by playlist content name, so it never learns of
another level, and ABR picks freely among the rest, starting on the first of `renditions`.

What beacons say an origin serves (an `OriginSource`'s `renditions`, from its beacon's
`https` endpoint) is **a hint, not a constraint**: beacons come from any key, so a stranger
could otherwise deny an origin by naming it with a list that leaves out what the viewer
needs. The hint orders the work (an origin whose hint names an allowed rendition is tried
first, and the renditions it names are asked for first), and never removes an origin or a
level. `availability` (who holds which rendition, by distinct seeder key, newest beacon
each, at most 64) lets a page rank renditions; the test page shows it and leaves the levels
to `open()`.

STUN servers come from Nostr too (NFX-10 §1), from the `stun` endpoints of live beacons.
`watchEndpoints` reads them on the page's relays. `stunCreator` holds those of the creator's
own beacon: one signed by the key in its `a` tag, the manifest's author. `selectStun(own,
relays, creator)` picks a session's servers by the rules every NFX client uses: the page's
own first, then those the relays it signals through name for themselves (below), then the
creator's that are global unicast and on a port of 1024 or above; each once, at most 4 in
all. A beacon signed by any other key adds none, however many keys name a server: keys
are free, so a count proves nothing. STUN service announcements (kind 33478, which `nutflixd
stun --announce` signs) are a directory for people and operators; the player never reads
them. So routine selection never makes a viewer ask more than 4 STUN servers, or one that
neither the creator nor one of its relays named. The fallback below, only when the page asks
for it, adds a seeder's server at the address of a peer it already signals with. Every STUN
server learns the viewer's address: a page that must tell no one but its own servers who
watches passes only its own servers to `open()`, no `relayStun` and no `stunFallback`.

If no STUN server the session asks finds a mapping, or it asks none, Nostr signaling can
fall back, when asked to:
`signaling: { kind: 'nostr', relays, stunFallback: { own, seeders: () => endpoints.stunSeeders } }`
(`own`: the page's own STUN URLs, 0 to 4). Once a gathering ends with no server-reflexive
candidate, a later connection to a peer also asks one STUN server per seeder, for that
connection only, if a live beacon names it and its IP address is among the candidates that
same peer's SDP gave (a session key is not linked to a beacon key, so the address is the
test). Never a server only an announcement names or on a port below 1024, and at most 4
STUN servers in the session. `selectStunFallback` is the same rule as a pure function.

A relay can offer STUN on its own host (NFX-10 §1, NFX-04 §3): its NIP-11 document lists
25050 in `nfx.kinds` and gives `nfx.stun_port` (1024 to 65535; `nutflixd
--embed-relay-stun-port`). The relay already sees the viewer's address on its WebSocket, so
its STUN server learns only the UDP port. With
`signaling: { kind: 'nostr', relays, relayStun: { own } }` (`own`: the page's own STUN URLs,
0 to 4, each among `iceServers`), the session reads each relay's document when it starts,
in parallel with connecting (at most 3 s and 64 KiB each, once per session; no relay whose
host is an IP address that is not global unicast, or `localhost`, is asked). Nothing waits
for them: each new peer connection asks the page's own servers, then the relays' known by
then (`stun:<host of the relay URL>:<stun_port>`), then the rest of `iceServers`, each
once, and a server joins only while the session has asked fewer than 4 in all (the
fallback's included). A document that comes late counts from the next connection. It is
off unless given: a viewer behind a proxy, a VPN or Tor must not use it (the STUN request
goes around the proxy and tells the relay the address it hides), and a page cannot detect
that. `fetchRelayInfo(relay)`, `parseRelayInfo(doc)` and `relayStunUrl(relay, info)` are the
same steps for a page that reads relays' documents itself (`src/relay-info.ts` is reusable
for `nfx.kinds` too); their vectors are in `test-vectors/relay-stun.json`. The test page
turns it on with `&signal=nostr`, and `&relayStun=0` turns it off.

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
  (NFX-04) refuses kind 25050 unless its NIP-11 `nfx.kinds` lists it (NFX-04 §1 as amended
  2026-11-18): give general relays, and such scoped relays beside them. `relayUrl()`,
  `checkSignaling()`, `MAX_RELAYS`, `NOSTR_SIGNAL_KIND` and `NOSTR_SIGNAL_PROTOCOL` let a
  page check its settings first.

  `remoteCandidates` (optional, `'all'` or `'global'`; default `'all'`, every candidate as
  before) says which ICE candidates of a peer's offer or answer reach
  `setRemoteDescription`. `{ kind: 'nostr', relays, remoteCandidates: 'global' }` is for a
  page that must not let a stranger's SDP point its ICE agent's connectivity checks at the
  user's LAN, loopback, router or a cloud metadata address, such as a desktop renderer
  (nutflix-pear ADR 0023 rule 5). It keeps only UDP candidates at global unicast IP
  addresses, at most 16 per SDP (`MAX_REMOTE_CANDIDATES`), the first in SDP order. It drops
  private, shared (CGNAT), loopback, link-local, documentation, benchmarking, multicast and
  reserved IPv4; IPv6 outside 2000::/3 and in 2001:db8::/32; mDNS (`.local`) and other
  names; TCP; and any candidate line not in the strict form browsers write. Every other line,
  `a=end-of-candidates` included, is kept byte for byte (`src/remote-sdp.ts` has the rules).
  An SDP left with no candidate is still applied, and that connection fails while playback
  keeps fetching from the origin. A peer behind a NAT is still reached through its
  server-reflexive candidate. A peer on the same LAN that offers only mDNS host candidates
  is not reached. The filter is `filterRemoteSdp(sdp, mode)`, exported and pure, so a
  consumer can test against it. Its vectors are in `test-vectors/remote-sdp.json`. Trackers
  signaling refuses `'global'`, since its SDP goes through the engine's tracker clients,
  which this does not filter.
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
npm run unit           # sanitisers, the beacon endpoint book and availability, open()'s option checks, levels and probes, the remote candidate filter, relays' NIP-11 and STUN, where segments come from, the WebRTC check
npm run unit:policy    # the engine's choice of source with peers first, over every input
npm run e2e            # the test page end to end (cargo, ffmpeg, openssl, Chromium), held renditions and a hostile beacon included
npm run e2e:mesh       # the mesh, the bridge, the library's lifecycle, trackers from a beacon
eval "$(bash e2e-strfry.sh /var/tmp/strfry)"   # the stock relay, strfry at a pinned commit
npm run e2e:nostr      # two browsers over Nostr only (strfry, no tracker), the origin cut
npm run e2e:nostr-node # a browser and nutflixd's mesh endpoint (full ICE) over strfry, the origin cut
npm run e2e:peer-first # peers first: segments from nutflixd's mesh endpoint from the first one, rescues, a browser with WebRTC blocked
```

The suites build `nutflixd` and `nutflix-package` and run headless Chromium in fresh contexts, on
loopback only.

`e2e-nat/run.sh` is the same mesh through NATs (nfx #71): one browser behind each of two
nftables routers in network namespaces, signaling only through strfry and taking STUN only
from a public nutflixd (`--stun`), with router byte counters for the path the bytes took. It
needs root, so it runs in CI only (`.github/workflows/nfx-nat-browsers.yml`), never on a
developer's machine; its header lists the cells.

## The mesh engine

The library bundles p2p-media-loader-core 4.0.0 from its own TypeScript source with one
patch, `engine/p2p-media-loader-core-4.0.0.patch`: `signalingClientFactory`, a stream
configuration hook through which a swarm takes a signaling client the page supplies (here
the Nostr one) instead of WebTorrent tracker clients. The engine keeps its peer
de-duplication and limits (`claimPeer`, `shouldGenerateOffers`), its `peerConnected`
contract and its teardown; with no factory it behaves as published. The same patch adds
the peer's `RTCPeerConnection` to `onPeerConnect`'s details (`PeerConnectDetails`, nfx #99), so
`Session.addresses()` can read each connection's selected candidate pair; the engine still
owns the connection. It is written to go upstream as it is.

The patch also carries NFX's own choices, which are not meant for upstream as they are:
`httpSegmentFetch` and `segmentFromOneSource` (NFX-17 §4.3), and `segmentPolicy` with
`peerWaitMs` (decision record 0109): `peer-first` and `peer-only` take segments from the
peers that announced them, fetch nothing over HTTP in the background, and use HTTP at most
as a rescue for the segment playback is asking for (`peer-first` only). One pure function,
`decidePeerModeSource` in `utils/stream.ts`, makes the choice; `policy-unit.ts` checks it
over every input. `http-first`, the default, is the engine's published code path.

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
origins, relays (the Nostr signaling relays included) and trackers in `connect-src`. With
`relayStun`, `connect-src` also needs each signaling relay's NIP-11 URL (`https://` for
`wss://`, on the same host and port); where the policy refuses one, its document is not read
and the session asks no STUN server of that relay.
