# NFX desktop viewer

A Tauri 2 window around `nfxd`'s node. Give it one or more scoped relays and a video
address (`38504:<creator>:<namespace>:<video-id>`). It then:
1. resolves the signed manifest (NFX-02) and learns seeders from verified beacons
   (NFX-03);
2. plays over `nfx://` while the video is fetched over iroh. Every file is checked
   against its sha256 before it plays (NFX-05 §4);
3. keeps and seeds what its user watches (NFX-18, decision record 0110), unless "Seed
   videos I watch" (the `share` setting) is off. It is on by default, existing installs
   included, and the page says once what that makes public before anything is kept:
   - a video played for a minute (seeks not counted) is fetched whole in the background
     and seeded while the app runs, and again after a restart (`kept.json`). One left
     before the minute keeps nothing: its files are deleted when the next play starts, or
     at the next start;
   - seeding announces each kept video publicly, signed with this node's key, with this
     computer's public address. No address that is not public is announced
     (`public_addrs_only`), and the router is never asked to open a port, sharing or not.
     It fetches under an iroh identity of its own, a fresh key at every start that serves
     nothing, so a seeder it watches from never learns the id its beacons name (NFX-18 §4);
   - kept videos share a disk cap (`cap_gib`, 20 GiB by default): the least recently
     watched are deleted first to make room, never the one playing; at most 100 are kept,
     and at most 20 videos or 16 GiB start to be kept in any hour (NFX-18 §2.4);
   - turning sharing off stops all announcing at once. Kept files stay, and play;
4. keeps a history of what was watched (when, where playback was, at most 500 videos) on
   this computer only, with each video's kept and seeding state. "Remove" takes a video
   off it and deletes this computer's copy;
5. orders the seeders it pulls from by seeder ratings (NFX-16) only if they are set up:
   the user's npub and at least one general relay. The node then reads the user's follow
   and mute lists and the ratings of those they follow, and tries well-rated seeders
   first. Ratings never block a seeder, and the app publishes none. Reading one's own
   lists tells those relays that this computer's address goes with that key, so this is
   off by default too;
6. shows where the bytes came from in "Stats for nerds" (right-click the video, the button
   under it, or `n`; nfx #99): each iroh seeder by a short id with the bytes and blobs it
   sent, what this node serves to browsers, and the player's own numbers (resolution,
   buffer, dropped frames). Seeders' addresses and whether a path is direct or through a
   relay appear only behind its "Show addresses" switch, which is off each time the panel
   opens.

```sh
./run.sh      # build (release) and start; needs web/player's npm ci for hls.js
./e2e.sh      # end to end in a private headless GNOME Shell: prints RESULT PASS|FAIL
NFX_E2E_DISPLAY=xvfb ./e2e.sh   # the same on a private Xvfb, where GNOME Shell can't run
```

GNOME Shell needs systemd-logind, so in a container or a Kata guest the e2e runs with
`NFX_E2E_DISPLAY=xvfb` (needs `xvfb`).

It is a separate Cargo workspace, so Tauri's and WebKitGTK's tree stays out of the main
CI. Check it locally:
- `cargo clippy -- -D warnings`
- `cargo deny --manifest-path Cargo.toml --config deny.toml check`

## Linux runtime

Needs WebKitGTK plus these GStreamer plugins (spike S2):
- `gstreamer1.0-plugins-base`;
- `gstreamer1.0-plugins-good` (`qtdemux`, `aacparse`);
- `gstreamer1.0-plugins-bad` (`h264parse`, and `openh264dec` as a fallback decoder);
- `gstreamer1.0-libav` (`avdec_h264`, `avdec_aac`).

## Data

The data directory is the app's data dir, or `NFX_DESKTOP_DATA`:

| Path | What |
|---|---|
| `node.key` | This node's Nostr key, mode 0600, created on first run. Never printed; only the public key is shown. |
| `settings.json` | `version` (1; a file without it is from before keeping, and sharing turns on when it is read), `relays` (Nostr scoped relays), `iroh_relays` (the network's own iroh relays; none disables relaying, so direct connections only), `share` (keep and seed what is watched; `true` unless turned off), `keep_notice_seen` (the user answered the notice; nothing is kept before), `cap_gib` (disk space for kept videos), and for seeder ratings `rating_root` (the user's key, hex; unset = off), `rating_trusted` (more keys, hex) and `general_relays`. Written whole and atomically. |
| `kept.json` | The kept videos: `a`, `root`, `title`, `size` (bytes, once whole), `kept_at`, `last_watched`. Seeded again at start while sharing is on: from the store when whole, fetched first otherwise. A file that cannot be read stops the start-up sweep of the store. |
| `history.json` | What was watched: `a`, `title`, `position` (seconds), `watched_at`. Never published. |
| `store/` | Content by sha256: the kept videos and the one playing. Files no kept video uses are deleted at start. `store/.nfxd/` holds iroh-blobs' index. |

## Security

- **The page trusts nothing it fetches directly.** Bytes come only from `nfx://`, which
  the node's origin serves after re-hashing them. It serves only files of hash lists
  verified against a signed manifest (NFX-05 §6.2).
- **The CSP allows only the app's own scripts**, with no inline script. Media and fetch
  go to `nfx:` / `http://nfx.localhost`. The page builds the DOM with `textContent`
  only.
- **Rating keys are npubs only.** Bare hex would let a pasted secret key pass for a public
  key and go out to relays as a filter. An nsec is refused as one, and no refusal repeats
  the key it was given.
- **Relays must be `ws://` or `wss://`.** Addresses and deletions are handled with
  `nfx-proto`'s parser, never a generic Nostr one (NFX-02 §2).
- **Watching and seeding use different iroh identities** (NFX-18 §4). The node runs two
  iroh endpoints over one blobs store: one serves and is the only one named in tickets and
  beacons; the other only dials, has a fresh key at every start and refuses every incoming
  connection. Every fetch, a watch's on-demand pulls included, goes out from the second, so
  a seeder that serves this computer a video cannot tie that watch to what it seeds. Both
  share this computer's IP address and the network's iroh relays, which see both ids.
