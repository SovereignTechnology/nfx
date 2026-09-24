# NFX desktop viewer

A Tauri 2 window around `nfxd`'s node. Give it one or more scoped relays and a video
address (`38504:<creator>:<namespace>:<video-id>`). It then:
1. resolves the signed manifest (NFX-02) and learns seeders from verified beacons
   (NFX-03);
2. plays over `nfx://` while the video is fetched over iroh. Every file is checked
   against its sha256 before it plays (NFX-05 §4);
3. seeds the video once it has all of it.

```sh
./run.sh      # build (release) and start; needs web/player's npm ci for hls.js
./e2e.sh      # end to end in a private headless GNOME Shell: prints RESULT PASS|FAIL
```

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
| `settings.json` | Relays and iroh relays. |
| `store/` | Content by sha256. `store/.nfxd/` holds iroh-blobs' index. |

## Security

- **The page trusts nothing it fetches directly.** Bytes come only from `nfx://`, which
  the node's origin serves after re-hashing them. It serves only files of hash lists
  verified against a signed manifest (NFX-05 §6.2).
- **The CSP allows only the app's own scripts**, with no inline script. Media and fetch
  go to `nfx:` / `http://nfx.localhost`. The page builds the DOM with `textContent`
  only.
- **Relays must be `ws://` or `wss://`.** Addresses and deletions are handled with
  `nfx-proto`'s parser, never a generic Nostr one (NFX-02 §2).
