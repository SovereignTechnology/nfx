# ffmpeg binary pin (lane L8)

The media pipeline shells out to an external `ffmpeg` + `ffprobe` (ADR 0003 / spike S-C:
`bare-ffmpeg` has no H.264 encoder, no faststart, no seek). The binary is **never committed
and never placed in `node_modules`**; the pipeline takes its path as injected config
(`MediaPipelineDeps.binaries`), so a shipped desktop binary, a system package on the
gateway, or the dev scratch copy below are all just different values.

## Pinned build (dev + CI reference)

| Field | Value |
|---|---|
| Source | BtbN/FFmpeg-Builds (GitHub), dated **immutable** release tag (not the moving `latest`) |
| Release tag | `autobuild-2026-09-04-14-01` |
| Asset | `ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz` |
| URL | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-04-14-01/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz |
| ffmpeg version string | `n8.1.2-50-g1a748fe2cd-20260904` (FFmpeg 8.1 release branch, static, GPL: libx264, libx265, libvpx, libsvtav1, libopus, libaom) |
| Tarball sha256 | `eb95195a525ee3160c169b98f941368e7f6f38719a2fd8554f2aa529fe2a3079` |
| Upstream `checksums.sha256` sha256 | `13efb3eb73af443ef9d38afb2d9e374acac2c244616fd95c61c129c70dab5700` |
| `bin/ffmpeg` sha256 | `f00df6c08171d403439cf4ab3dd426fcc0172206252981990e97c3c7bd3d9030` |
| `bin/ffprobe` sha256 | `bf692dc2e1d09ebdfe9aabe693a128f3fc12b374c6bafa89803d79ba98bba89c` |
| Size | 125,847,480 bytes (tar.xz) |
| Verified | 2026-09-04 on laptop-2: `sha256sum -c` against the release's own `checksums.sha256` = OK; GitHub API asset `digest` field agrees |

Why BtbN over johnvansickle.com: BtbN publishes a `checksums.sha256` per release and every
release tag is immutable, so the URL + hash pair above is reproducible; johnvansickle
publishes only MD5 and its `release` URL is a moving pointer.

## Install for tests (no root)

```sh
mkdir -p /tmp/scratch/ffmpeg && cd /tmp/scratch/ffmpeg
curl -sSLO https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-04-14-01/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz
echo 'eb95195a525ee3160c169b98f941368e7f6f38719a2fd8554f2aa529fe2a3079  ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz' | sha256sum -c -
tar -xJf ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz
```

## Resolution order (`findFfmpeg()` in `media/node/find-ffmpeg.ts`)

1. `NUTFLIX_FFMPEG` — path to the `ffmpeg` binary, or a directory containing `ffmpeg`
   (or `bin/ffmpeg`); `ffprobe` must sit beside it.
2. `/tmp/scratch/ffmpeg/bin/ffmpeg` or `/tmp/scratch/ffmpeg/<release-dir>/bin/ffmpeg`.
3. `PATH`.

The real-binary tests (`media/__tests__/node-real-ffmpeg.test.ts`) are
`describe.skipIf(!ffmpegAvailable)`; with no binary they are skipped and `npm run ci` stays
green. Test input is synthesised at test time with `-f lavfi testsrc` / `sine`; no media is
committed.

## Facts verified against this build (the pipeline depends on them)

- `ffprobe -print_format json -show_format -show_streams`: numbers arrive as strings
  (`"duration": "3.000000"`, `"sample_rate": "44100"`), rotation is in
  `streams[].side_data_list[].rotation` (`side_data_type: "Display Matrix"`).
- `-progress pipe:2` emits `out_time_us=`, `out_time_ms=` (both microseconds), `out_time=`,
  `fps=`, `progress=continue|end`.
- `-movflags +faststart` yields `ftyp moov free mdat`; the default muxer yields `ftyp free
  mdat moov` (moov last). The pipeline verifies by box order, not by flag.
- `-force_key_frames expr:gte(t,n_forced*2)` + `-g/-keyint_min` + `-sc_threshold 0` gives
  keyframes at exactly 0 s, 2 s, 4 s on every rendition (checked with `-skip_frame nokey`).
- `-map 0:a:0?` lets silent sources encode without an audio stream.

## Licensing note

This is a **GPL** build (needed for `libx264`). Whether a GPL ffmpeg may ship inside the
desktop bundle is sovtech's open question (S-C Q1). Nothing in the pipeline depends on the
answer: swap in an LGPL build + `libopenh264`, a system ffmpeg, or move transcoding to the
gateway by changing `binaries` alone.
