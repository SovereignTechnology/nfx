# Spike S2 — Tauri playback: **PASS on Linux** (2026-09-23)

**Question:** does hls.js play NFX-05 CMAF on the Tauri webview when segments come from
the Rust store through an `nfx://` custom scheme? And which GStreamer plugins does
Linux need?

**Setup:**
- Code: `crates/spikes/s2-tauri`, its own Cargo workspace, run with
  `run.sh <store-dir>`.
- Stack: Tauri **2.11.6**, WebKitGTK **2.52.6** (Ubuntu 24.04), hls.js 1.7.3.
- Content: S4's output packaged by the demo's pinned ffmpeg n8.1.2, root `a39d4ee3…`,
  3 renditions, 12 s.
- Display: a real Tauri window, rendered in a **private headless GNOME Shell**
  (`dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x720`), so nothing
  appeared on the user's desktop.

## How it works

1. **Rust side (the NFX consumer).**
   - At start it verifies the hash list against its root with `nfx-proto`.
   - It registers the `nfx` URI scheme, serving the NFX-05 §6 paths (`/<root>`,
     `/<root>/master.m3u8`, `/<root>/<sha256>.<ext>`) from the content-addressed store.
   - It checks every file against its sha256 before serving it (the Blossom rule on the
     native side).
2. **Page side.** hls.js loads `nfx://localhost/<root>/master.m3u8`; the Windows and
   Android form is `http://nfx.localhost/…`. It then plays, seeks to 7 s and switches to
   the lowest rendition, reporting each step to Rust over IPC.

## Criteria

| Criterion | Result |
|---|---|
| Plays on Linux | **PASS**, 3/3 runs: playback past 2.5 s, 16 files served over `nfx://`, 0 refused |
| Seeks | **PASS**: seek to 7 s, playing at ~7.7 s |
| Switches renditions | **PASS**: switched to 360p mid-play and kept playing; no hls.js errors |
| Record which GStreamer plugins Linux needs | **Established by experiment**, below |

MSE reports H.264 High support at all three levels. The webview identifies as
`AppleWebKit/605.1.15 … Safari/605.1.15`. Native HLS is not offered on Linux
(`canPlayType` returns empty), so hls.js/MSE is the path there. The same page works on
macOS WKWebView, which also has native HLS.

## GStreamer on Linux

WebKitGTK built this pipeline: `uridecodebin3` → `decodebin3` → `parsebin` →
`qtdemux` → `h264parse` / `aacparse` → **`avdec_h264`** / **`avdec_aac`**.

| Element | Package |
|---|---|
| `decodebin3`, `uridecodebin3`, `parsebin` | `gstreamer1.0-plugins-base` |
| `qtdemux`, `aacparse` | `gstreamer1.0-plugins-good` |
| `h264parse` | `gstreamer1.0-plugins-bad` |
| `avdec_h264`, `avdec_aac` | `gstreamer1.0-libav` |

Decoder necessity, tested by disabling features (`GST_PLUGIN_FEATURE_RANK=…:NONE`):

| Disabled | Outcome |
|---|---|
| `avdec_h264` | PASS: `openh264dec` (from `gstreamer1.0-plugins-bad`, via libopenh264) took over |
| `avdec_h264`, `avdec_aac` | PASS: `openh264dec` + `avdec_aac_fixed` (still gst-libav) |
| every H.264 decoder (`avdec_h264`, `openh264dec`, `vulkanh264dec`, `qsvh264dec`) | **FAIL, cleanly:** MSE refuses the codec, hls.js raises a fatal `manifestIncompatibleCodecsError` |

**So gst-libav is the recommended dependency, but not the only way to get H.264:**
`openh264dec` works too. AAC came from gst-libav in every passing run.

**Recommendation for the Linux package:**
- depend on `gstreamer1.0-plugins-base`, `-good`, `-bad` and `gstreamer1.0-libav`;
- check `MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2"')` at
  start-up, and show a "missing media codecs" message instead of a black player.

## Findings

- **The custom scheme is enough; no localhost HTTP server is needed.** Serving from
  Rust also puts NFX-05 §4 verification at the one place every byte passes through. The
  webview never sees unverified bytes.
- **The response carries `Access-Control-Allow-Origin: *`,** because the page origin
  (`tauri://localhost`) differs from `nfx://localhost`. Whether WebKitGTK strictly
  requires it was not isolated.
- **Headless testing works:** a private `gnome-shell --headless` gives CI-style runs of
  a real Tauri window with no Xvfb and no sudo.

## Not covered

- macOS WKWebView and Windows WebView2. Neither exists on this host; the plan's pass
  criterion is Linux.
- Hardware decoding: the headless session had no GPU (a harmless MESA/ZINK warning).
- Long content, and the iroh-backed store (A2's `nfx-node`).
