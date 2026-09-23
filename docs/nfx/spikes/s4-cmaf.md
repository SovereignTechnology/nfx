# Spike S4 — CMAF packaging for NFX-05: **PASS**, 2 criteria unverified on this host (2026-09-23)

**Question:** does ffmpeg produce valid NFX-05 output when it is driven by the demo's L8
ladder and argv planning (2 s aligned GOP, `-sc_threshold 0`) and every file is renamed
to its sha256?

**Code:** `web/spikes/s4-cmaf/`

| File | Role |
|---|---|
| `package.ts` | the packager |
| `origin.ts` | an NFX-05 §6 origin, reused by S2/S3 |
| `player.html` | hls.js test page |
| `play.ts` | Playwright driver |
| `crates/spikes/nfx-verify-store` | runs `nfx-proto` over a store |

**Setup:**
- Deps: npm-pinned tsx 4.23.15, hls.js 1.7.3, playwright 1.63.0, installed with
  `--ignore-scripts`.
- ffmpeg: the system 6.1.1 (Ubuntu). The demo pins BtbN n8.1.2 (`FFMPEG-PIN.md`); re-run
  with the pin before relying on exact bytes.
- Input: a synthetic 12 s 1080p30 `testsrc2` plus a 440 Hz sine, so there are no licences
  and nothing to download.

## How L8 drives it

`planLadder`, `renditionArgv`, `renditionDimensions`, `thumbnailArgv`, `ffprobeArgv` and
`parseFfprobeJson` are imported **unchanged** from the read-only `packages/` mirror.
- The ladder: 1080p @ 5000k, 720p @ 2500k, 360p @ 800k, H.264 High + AAC.
- L8 ends its argv with progressive-MP4 options (`-movflags +faststart -f mp4`). The
  packager cuts the argv at `-movflags` and appends HLS/CMAF options:

  ```
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4
  -hls_flags independent_segments
  ```

- It then renames the init to `<sha>.mp4` and each segment to `<sha>.m4s`, rewrites
  every playlist to content names, writes a master playlist, and adds L8's thumbnail as
  role `thumb`.

## Criteria

| Criterion | Result |
|---|---|
| The hash list validates against its schema | **PASS.** `hashlist.schema.json` passes (jsonschema, Draft 2020-12). |
| … and against the spec, via `nfx-proto` | **PASS.** `HashList::verify` checks the root, `segs`, video and rendition rules. All 26 files match their sha256 and size. All 4 playlists reference only listed content names (NFX-05 §3). |
| NFX-05 §1 media profile | **PASS.** All 18 segments start with an IDR (init + segment probed). Segments are exactly 2.000 s and identical across all three renditions, so switches are aligned. Dimensions match L8's `renditionDimensions`. |
| Plays in hls.js | **PASS** in Playwright Chromium 1243 and Firefox 1543 (fresh headless contexts). Each played past 2.5 s, seeked to 7 s and kept playing, switched to 360p mid-play, and raised no fatal errors. MSE reports H.264 High support in both. |
| Plays in mpv | **Proxy PASS; mpv itself unverified** (not installed; `sudo apt install mpv`). ffmpeg's native HLS demuxer fetched `http://…/<root>/master.m3u8` from the origin and decoded **every stream of every rendition** without error. |
| Plays in Safari native HLS | **Unverified.** There is no Safari on Linux. Playwright WebKit (the closest engine, via GStreamer) would not launch: the host lacks `libavif16`, which needs sudo. |

## Output (root `3b37b0c9…`, 26 files)

| Rendition | BANDWIDTH (peak segment) | CODECS | Resolution |
|---|---|---|---|
| 1080p | 5 413 552 | `avc1.640028,mp4a.40.2` | 1920×1080 |
| 720p | 2 750 072 | `avc1.64001f,mp4a.40.2` | 1280×720 |
| 360p | 942 572 | `avc1.64001e,mp4a.40.2` | 640×360 |

File counts: 1 master, 3 playlists, 3 inits (≤ 1.4 KB), 18 segments (12.9 MB), 1 thumb.
The hash list itself is 5.6 KB.

## Findings

- **L8 needs one change for NFX:** swap the container tail. Its GOP pinning
  (`-g 60 -keyint_min 60 -sc_threshold 0` and `-force_key_frames expr:gte(t,n_forced*2)`)
  already yields CMAF-ready, switch-aligned segments. `nfx-media` should port the ladder
  and codec argv as-is and own only the HLS/fMP4 tail.
- **CODECS must come from the bitstream.** ffprobe reports no profile or level for a
  bare init segment; the packager probes init + first segment. `nfx-media` should parse
  `avcC` from the init directly; the demo's `mp4-boxes.ts` is the reference to port.
- **BANDWIDTH is the measured peak segment bitrate.** 1080p peaks 8 % over its nominal
  5000k. Use the measurement, never the ladder figure.
- **The A0 NFX-05 §6 path was load-bearing.** hls.js was given `/<root>/master.m3u8` and
  resolved every variant playlist and segment as `/<root>/<sha>.<ext>`, which is exactly
  the route A0 added. Without it the test would have 404'd.
- **The origin's caching headers behave as specified:** `immutable` + CORS `*` on hits,
  `no-store` on misses, `video/iso.segment` for segments.

## Not covered

- Real footage with scene cuts. Synthetic content has none; `-sc_threshold 0` plus
  forced keyframes should hold regardless.
- VP9/AV1 and Opus renditions. They are optional in NFX-05.
- Licensed-mode encryption (M3).
- The BtbN-pinned ffmpeg.
- mpv and Safari themselves.
