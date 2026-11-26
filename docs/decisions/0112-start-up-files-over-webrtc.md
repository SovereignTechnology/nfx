# 112. Start-up files over WebRTC: the video room and the file channel

Date: 2026-11-26

## Status

Proposed 2026-11-26, for the maintainer (sovtech) to decide. The number is fixed when it is merged.

It amends NFX-10 §§1, 2, 6, 6.1, 6.6, 6.7 and 6.8, which are a Draft, in place, and adds §6.9
(video room) and §6.10 (file channel). NFX-11 (Living) gains two §3 rows and two §7 rows. It also
amends **NFX-05 §2 and §6, which are frozen**, in place, as an exception to the freeze rule (README
"Status model"), as NFX-04 was for #96, #104 and decision 0108:

| Frozen section | Was | Becomes |
|---|---|---|
| NFX-05 §2 | the hash list is fetched by `root` "from any origin/seeder and MUST NOT be trusted from any other source" | from any origin, seeder or peer (NFX-10 §6.10), trusted only because it hashes to `root` |
| NFX-05 §6 | "Every network needs ≥1 (manifest mirroring, browser genesis, censored-shutdown backstop)" | a network SHOULD have at least one, for manifest mirroring and as a backstop; a browser does not need one to start |

No artifact changes and no reader of a frozen document changes behaviour: a hash list is still
fetched by `root` and verified against it, wherever it comes from. The second change drops a
deployment requirement that no implementation checks. The alternative, a `specver` bump, would change
every namespace, room key and manifest.

## Context

- Decision 0109 lets a browser take its segments from peers first, with HTTPS as a rescue, or from
  peers only. Its point 7 left the rest on an origin: the hash list, the playlists and the init
  segments ("start-up files") come only over HTTPS (NFX-10 §1), and the levels a page offers are
  those an origin answers for (`web/player/src/lib.ts:374-411`, `initProbe` at `:431-451`).
- So a page cannot start at all without an origin. `open()` refuses an empty origin list
  (`web/player/src/endpoints.ts:825`). The reference web client waits up to 62 s for a beacon that
  names an origin and then fails with `no-seeders`, and reads the hash list over HTTPS itself to
  decide which renditions to allow.
- A page cannot meet a peer before it has the hash list either. Rooms are per stream swarm (NFX-10
  §6.1), and a stream swarm ID needs a rendition id (§2), which only the hash list names. Decision
  0105 turned mesh presence down as a way to find a first source for that reason.
- The mesh data channel carries p2p-media-loader's peer protocol only, which names segments by their
  position in a playlist the page does not have yet.
- When the network's public seeder and its domain were unreachable for 45 minutes on 2026-11-26, the
  site still loaded from public servers and listed nothing playable: every start-up file had one
  HTTPS source.
- The maintainer's direction (2026-11-26): everything signaled over Nostr and delivered over WebRTC,
  start-up files included; no TURN, no second HTTPS origin, no Blossom mirror, no new host. The spec
  is not locked: frozen text may be amended.
- NFX-12 §4 already defines a file protocol for HyperDHT peers, `nfx/files/1`: `get` a file by its
  sha256, `data` frames, `end`, `missing`, scoped to one video, capped by the hash list.

## Decision

1. **A video room per video** (NFX-10 §6.9). Its ID is
   `nfx/1/web/video/38504:<creator pubkey>:<namespace>:<video-id>`, the manifest's address under a
   prefix no stream swarm ID has; its key pair is derived as the stream rooms' are. A page that holds
   only the signed manifest can derive it. It exists only in Nostr signaling (no tracker swarm), with
   the events of §§6.2–6.5 unchanged.
   - It is per manifest address, not per `root` and not per `<namespace>:<video-id>`: beacons and
     lookups are addressed by `a`, so a seeder's beacon and its room name the same thing; a revised
     manifest keeps its room; and two creators who pick the same video-id do not share one.
   - Seeders (nodes) join the video room of every video they serve, beside its stream rooms, with the
     same session key. A page joins it when it opens a video, before it has the hash list, and stays
     while it plays and serves start-up files.
   - **Only a session that wants files offers there**, to at most 3 peers at a time, whatever the key
     order; one that serves answers, within a sub-limit (page 4, node a quarter of its connections,
     at least 2). Started viewers do not connect to each other through it. Glare between two
     sessions that both want files follows §6.6.
   - Relays keep no ephemeral event, so a member that serves sends its presence out of turn when it
     first sees a newcomer: a node at most every 5 s per room (as nfxd already does in stream rooms,
     `crates/nfx-node/src/mesh/mod.rs:1758-1767`), a page at most every 30 s.
   - **Both kinds of room, side by side.** The video room replaces the need for a source found some
     other way before the first file; it replaces nothing else. Once the hash list verifies, a page
     joins the stream rooms of its levels as before.
2. **A file channel** (NFX-10 §6.10): a WebRTC data channel, ordered and reliable, labelled
   `nfx-files/1`, beside p2p-media-loader's channel. p2p-media-loader's peer protocol is untouched.
   - On a stream-room connection the **offerer opens it once the first channel is open**, never with
     the offer: an nfxd before this change binds the first channel that opens whatever its label
     (`crates/nfx-node/src/rtc_serve.rs:355`), and so does the web library as an answerer
     (`web/player/src/signal-nostr.ts:800`). Opened later, the file channel is ignored by both. On a
     video-room connection it is the only channel.
   - **Messages** are binary: a type byte, then the body. Types 0-3 are NFX-12 §4's `get`, `data`,
     `end` and `missing`, byte for byte; 4 `hello` (version 1, flags: serves files, serves beacons),
     5 `cancel`, 6 `busy`, 7 `list` (which renditions of a `root`), 8 `have` (the rendition ids held
     whole and those held in part), 9 `beacons`. A `data` message carries at most 16,379 bytes of
     the file, so a whole message is at most 16 KiB, which every WebRTC stack carries; a file spans
     as many as it needs. Request ids are never reused on a channel, so a `cancel` needs no answer:
     anything that still arrives for it is ignored. A malformed message closes the channel. A new
     message type takes a new label (`nfx-files/2`), as NFX-12 §3 rules for Protomux.
   - **What is served**: the hash list (`get` of `root`) and the files of a hash list of the
     connection's video with any role but `segment`; never a segment, which stays on p2p-media-loader;
     never a file of another video, so a channel is no oracle for what else a peer holds.
   - **Caps as over HTTPS today**: a file at most its `size` from the hash list
     (`web/player/src/fetcher.ts:211`), the hash list at most 16 MiB (`web/player/src/verify.ts:12`,
     nfx-node's `MAX_HASH_LIST_BYTES`); a `beacons` answer at most 64 KiB.
   - **Verification as over HTTPS today**: the hash list against the manifest's `root`, video and
     `segs` (`Anchor.fromBytes`, `web/player/src/verify.ts:102-111`); every other file against its
     listed sha256, and a playlist by the content-name rule (`Anchor.check`,
     `crates/nfx-wasm/src/lib.rs:216-232`). A peer that sends a mismatch is dropped for the session,
     all its connections with it.
   - **Flow control**: a server keeps at most 256 KiB of file data queued per channel ahead of the
     transport (NFX-12 §4's figure; `bufferedAmount` in a browser) and sends one file at a time per
     channel; a requester accepts answers interleaved, as NFX-12 §4 allows.
   - **Limits**: at most 8 open requests per channel; each file answered at most twice per channel. A
     node charges file requests to the budget its segment requests use per connection (burst 60, then
     20 per second; over it the connection is dropped: `rtc_serve.rs:41-42, 395`), counts their
     queued bytes in the same 16 MiB (`rtc_serve.rs:35`), and answers `busy` over its global budget
     (`rtc_serve.rs:43-44, 405`). The web library: burst 30, then 10 per second, per connection.
   - **Choosing peers** follows NFX-17 §4.3 as for sources: one peer's bytes per file, give up after
     4 s without a byte or below the floor, a hedge to a second peer after 2 s without a byte (at most
     3 at once), move on after `missing` or `busy`. Peers that delivered a verified file come first,
     then those whose `have` names the file's rendition, then the rest at random.
3. **`have` replaces the origin probe.** A page offers a level only for a rendition that a connected
   peer's `have` names as held whole and whose media playlist and init have verified, from any
   peer. When no connected peer holds any rendition whole (a video whose seeders are gone, played
   from its viewers), the renditions peers hold in part are offered instead, on the same condition;
   p2p-media-loader's announcements then say which segments each holds, and a missing one is waited
   for or rescued as the page may. A peer whose `have` names a rendition and then answers `missing`
   for its playlist or init has its `have` ignored for the session. A node usually holds its
   renditions whole; a page holds what it has watched, in part, unless it keeps the video whole.
4. **Bootstrap with only the manifest**: join the video room and offer to the peers met; `get` the
   hash list from one, hedge to another after 2 s; verify it; `list` the peers; `get` the master
   playlist and, for each allowed rendition (at most 32, six at a time, 8 s in all as the origin probe
   has today), its media playlist and init; offer the confirmed levels; start the player and join
   their stream rooms. The verified start-up files are kept for the session, answer the page's own
   loads, and are served to others.
5. **Origins become an optional rescue, by `segmentSource`.** Under `https-first` (still the
   library's default), start-up files come over HTTPS as before; the page still serves the file
   channel. Under `peers-then-https`, peers first: a start-up file goes over HTTPS only when peers
   have had their wait (`peerWaitMs`, default 4 s, for a first file-channel peer; then the give-ups
   above), only the file the bootstrap or the player is waiting for, and the levels are the peers'
   unless no peer confirms one in time, in which case the origin probe runs as today. Decision 0109's
   rule holds: nothing over HTTPS in the background. Under `peers-only`, nothing over HTTPS at all,
   start-up files included; origins a caller gives are kept for a later switch.
6. **`open()` with no origin.** `origins` may be empty when the caller passes `manifestJson` (a bare
   `root` has no address, so no video room) and Nostr `signaling`; otherwise a `TypeError` as today.
   With no origin, `open()` waits for peers (`waiting` with reason `no-peer`, and new `startup` events
   for each stage) until its `signal` aborts, and rejects at once if the WebRTC check (0109 point 5)
   finds the browser's WebRTC blocked. `Stats.origin` is `null` with no origin; hls.js gets a base
   under `.invalid` (RFC 6761) that is never fetched, since every load goes through the session's
   sources. A new option `serveFiles` (default true) turns serving start-up files and staying in the
   video room off.
7. **Beacons over the file channel.** A server MAY answer `beacons` with its own newest beacon of the
   video, if it has one, exactly as it signed it, and with others it holds: at most 4 in all, its own
   first, then the creator's. A reader accepts one that passes NFX-03 at its clock, names the video it
   plays in `a`, and is dated at most 30 s ahead; it keeps the newest per signer and drops it at
   `expiration`. It trusts it as NFX-17 §§4.1-4.2 trust a beacon that arrived in a tell: **the
   creator's own beacon (signer = the creator in `a` = the manifest's author) is tier 1 wherever it
   came from**, so its `stun` endpoint counts (NFX-10 §1 rule 3); a key with a positive trusted score
   (NFX-16 §4) is tier 2; any other key is a pool entry: `https` endpoints only, no weight, no STUN
   server. The manifest names no seeders, and this does not add a tag that would make it. A peer
   re-serves only the exact event it received, verified and live, never re-signed. A page re-serves
   those of keys in tiers 1 and 2, and of keys whose beacon it got from a peer that then delivered it
   a file that verified. Presence cannot carry beacons: readers drop a presence whose content is not
   empty (`crates/nfx-proto/src/signal.rs:472-474`), and NIP-DC defines it so.
8. **Sources in tiers.** The web library's `SessionSources.get` (`web/player/src/session-sources.ts`)
   asks file providers before its HTTP origins: the local store another change adds, then the file
   channel. What this decision needs from that interface:
   - providers are keyed by the same path the HTTP tier uses (`<root>`, or `<root>/<content name>`)
     and are told the file's expected sha256, role and byte limit;
   - `get(file, verify, signal)` is async, takes an `AbortSignal`, and resolves to bytes or `null`
     (not held); it never throws for "not held";
   - every tier's bytes pass the same `verify` as HTTP's, inside the provider (so it can move to
     another peer) and again in `SessionSources`: no provider is trusted;
   - each tier has a deadline before the next is asked, unless it is the last tier with a chance, which
     then waits, as a page with peers only does; the file channel's is 4 s, the default of the
     engine's `peerWaitMs`;
   - "every source failed" means every tier. With no HTTP source, `fetchFile`'s empty source set must
     not end the file at once (`web/player/src/fetcher.ts:288-292` throws under `once`, and otherwise
     waits 10 s on HTTP alone);
   - a provider may decline a role at once: the file channel declines `segment`, so an HTTP rescue of a
     segment is never delayed by it.
9. **nfxd** joins the video room of each video it serves while it has at least one of its stream
   rooms, counted in its room limit (`MAX_ROOMS`), never offers there, answers within the sub-limit,
   closes a video-room connection 20 s after its last request, serves the file channel from its
   store, which re-verifies on read, and answers `beacons` with its own newest beacon. As an offerer
   in a stream room it opens the file channel after the first channel is open (str0m 0.24.1's
   `DirectApi::create_data_channel` opens a channel on the running association without SDP). A flag
   turns the file channel off.
10. **The reference web client** stops waiting for a beacon that names an origin before it plays,
    passes the origins it knows at Play only as the rescue (none in the strict mode the plan ends in),
    and drops its own HTTPS read of the hash list: the library decides levels from `have`.

## Alternatives

| Design | Why not |
|---|---|
| A second HTTPS origin, or a Blossom mirror of start-up files | the maintainer ruled both out: each is a fixed host in the path |
| Start-up files in Nostr events | a hash list may be 16 MiB, far past what relays take; relays would carry bytes |
| Start-up files over p2p-media-loader's protocol | it names segments by playlist position, which a page without the playlist cannot compute; changing it changes the segment wire for every peer |
| A video room per `root` | beacons and lookups name a video by address; a revised manifest would move its viewers to a new room while its seeders announce under the old address |
| A video room per `<namespace>:<video-id>`, like stream swarm IDs | two creators who pick the same video-id would share it |
| Guessing stream rooms (`720p`, `1080p`) before the hash list | rendition ids are the publisher's free choice |
| Every pair in the video room connects (§6.6 unchanged) | started viewers would connect to each other for nothing; each newcomer would draw an offer from every lower key |
| A `seeder` list in the manifest, to trust beacons by | a change to frozen NFX-02, and the creator would re-sign the manifest whenever a seeder comes or goes |
| Beacons in presence content | readers drop a presence with content (NFX-10 §6.5, NIP-DC §5) |
| Segments on the file channel too | a second path for what p2p-media-loader already carries, outside its availability map |
| NFX-12's 65,536-byte `data` frames unchanged | larger than the 16 KiB every WebRTC stack carries in one message |

## Consequences

- A browser can start and play with no origin at all, from a seeder that speaks the file channel or
  from another viewer that started before it, while one of them can be reached over UDP. With no TURN,
  a browser whose UDP is blocked, or whose WebRTC is off, gets nothing under `peers-only`; it is told
  so (0109 point 5).
- Every seeder and every playing viewer is in one more room per video: one more presence every 30 s
  on each relay, and the out-of-turn presence for newcomers. Starts become visible to relays from the
  first moment, failed ones included. NFX-17 asks already publish starts; a video room does not name
  the video in clear (§6.1).
- A viewer that serves start-up files uploads them (a hash list of up to 16 MiB, playlists, inits) to
  newcomers, and strangers who join the video room can reach it, as in a stream room. `serveFiles:
  false` ends both once it has started.
- A node that answers `beacons` links its session key to its beacon key for the peers it answers.
- Mixed versions keep working. An old page never opens the file channel and never joins a video room.
  A new page facing only old seeders finds no one in the video room: with origins under
  `peers-then-https` it rescues over HTTPS after `peerWaitMs`, so each start is up to that much slower
  until seeders run this change; with no origin it waits. Seeders must run it before a web client
  depends on it.
- Rendition rooms stay shared between creators who pick the same video-id (stream swarm IDs name no
  creator, `crates/nfx-pay-wire/src/namespace.rs:121-124`); video rooms do not.
- NFX-17 §8 asks whether a node may forward a beacon for a seeder that does not answer. For the file
  channel this decision says yes, as the exact event; tells stay the signer's own.
- The web library's API changes: `origins` may be empty (with `manifestJson` and Nostr signaling),
  `Stats.origin` may be `null`, `serveFiles`, `startup` and `beacon` events, `MeshStats` counts
  start-up files to and from peers, and `peers-only` now covers start-up files.

## Tests

- **Vectors**, from the spec text by a new generator beside `meshsig.py`: `mesh-signal.json` gains
  `video_rooms` (the manifest vector's address, a testnet address, and one whose video-id matches a
  stream vector's, showing the IDs differ); `file-channel.json` holds every message type in hex, a
  40,000-byte transfer in three `data` messages, a `have`, a `beacons` answer carrying
  `beacon.json`'s event, and beacon acceptance at a fixed time (the creator's: tier 1; another
  key's: pool); `file-channel-invalid.json` holds every message that closes the channel (each wrong
  length, type 10, `data` of 0 or 16,380 bytes, `hello` version 0 or 2, a second `hello`, a ninth
  open request, a `have` that is not an object of two arrays of distinct strings, names an id in
  both, or names more than 32) and every beacon a reader refuses (expired, dated 31 s ahead, another
  video's, not kind 20464, a `beacons` answer of 5 events or over 64 KiB).
- **Rust**: nfx-proto codec and derivation over the vectors; nfx-node's file server (shared budget,
  256 KiB window, twice per file, scope to the video, `segment` refused, `busy` over the global
  budget) and mesh (joins the video room per served video, never offers there, answers within its
  sub-limit, out-of-turn presence at most every 5 s, idle close at 20 s); a daemon test in which a
  native requester takes the hash list and an init over a real connection.
- **Web library, unit**: the codec over the vectors; the requester (hello within 3 s, hedge at 2 s,
  give-up at 4 s, `missing` and `busy` move on, a mismatch drops the peer, late data after `cancel`
  ignored); the tiers (`null` and deadlines fall through, a provider's bytes are verified again, no
  "every source failed" before every tier has); `open()` with no origin (accepted only with
  `manifestJson` and Nostr signaling; rejected at once when WebRTC is blocked; `peers-only` never
  calls `fetch`).
- **Browser end to end** (`web/player/e2e-no-origin.ts`): the test server serves the page and its WASM
  and has no origin route at all from the first moment; an nfxd seeds over a stock relay. Asserts the
  first frame, 20 s of play, levels equal to what nfxd holds, and no HTTP request but the page's own.
  Then a second browser starts with nfxd stopped and takes its start-up files from the first. Then a
  page with origins under `peers-then-https` against an nfxd without the file channel rescues after
  the wait; and the previous library against the new nfxd plays as before.
- **NAT matrix** (`web/player/e2e-nat/run.sh`): a cell `nfxd-browser-no-origin` (no origin from the
  first moment) and a cell in which browser B starts from browser A with no nfxd.
- **Drill**: the site's playback proof run with the network's public seeder and its domain unreachable,
  from two vantages: the list, the first frame, 8 s of play, bytes over WebRTC, no origin request.

## Settled while drafting

- NFX-05 §§2 and 6 are amended in place, not by a `specver` bump: the maintainer's direction of
  2026-11-26 is that the spec is not locked while the network is `nfx:testnet:1`.
- Viewers serve start-up files by default (`serveFiles: true`), and a node answers `beacons` with
  its own newest beacon by default (a flag turns it off): the end state is a network that needs no
  fixed host, and a newcomer needs some peer that can hand it both.
- `have` reports renditions held in part as well as whole, so a video whose seeders are gone still
  plays from its viewers (point 3).
