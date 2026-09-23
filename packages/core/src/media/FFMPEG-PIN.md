# ffmpeg binary pin (lane L8)

The media pipeline shells out to an external `ffmpeg` + `ffprobe` (ADR 0003 / spike S-C:
`bare-ffmpeg` has no H.264 encoder, no faststart, no seek). The binary is **never committed
and never placed in `node_modules`**; the pipeline takes its path as injected config
(`MediaPipelineDeps.binaries`), so a shipped desktop binary, a system package on the
gateway, or the dev scratch copy below are all just different values.

## ⚠ The original pin was PRUNED upstream — re-pinned 2026-09-05 (orchestrator)

**BtbN deletes daily `autobuild-*` releases after about twelve days.** The tag L8 recorded
below, `autobuild-2026-09-04-14-01`, was **404 by 2026-09-05** — the whole release is gone, not
just moved, so the documented `curl` writes a 9-byte `Not Found` body and `sha256sum -c` fails.
The claim below that "every release tag is immutable" is only half right: a tag that still
exists is immutable, but most are **deleted**. Retention observed via the GitHub API on
2026-09-05: the **12 most recent dailies**, plus one **month-end** snapshot per month going back
to 2024.

**So the pin must be a month-end build.** The current dev/CI reference is:

| Field | Value |
|---|---|
| Release tag | `autobuild-2026-08-31-13-27` (month-end → long-lived) |
| Asset | `ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz` |
| URL | https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz |
| ffmpeg version string | `n8.1.2-50-g1a748fe2cd-20260831` |
| Tarball sha256 | `c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b` |
| Upstream `checksums.sha256` sha256 | `5a831b23711edf09476291bfbb104cc4e9c78ab6d9a3978ff27da1ee76b01c5b` |
| `bin/ffmpeg` sha256 | `ad7a8c8e8fe4f50972f32f63705cfcc57f44cd3531f57aa8defe388372242f5e` |
| `bin/ffprobe` sha256 | `150bfd75016992a8d495a5f5c16cd93387a21c059f4309ed1e6342659aef48b3` |
| Size | 128,065,756 bytes listed by the API for the *other* gpl asset; **this** tarball is 125,758,156 bytes |
| Verified | 2026-09-05 on laptop-2, three ways: the release's own `checksums.sha256` (whose own sha256 is above), the GitHub API asset `digest` field, and `ffmpeg -version`. `npx vitest run --project core src/media/__tests__/node-real-ffmpeg.test.ts` → 10 passed |

**It is the same FFmpeg revision as the original pin** (`n8.1.2-50-g1a748fe2cd`) — BtbN rebuilds
the same source daily, so the binaries differ byte-for-byte while the version string differs
only in its date suffix. That is why the tarball hash here is not the one recorded below.

Install (no root):

```sh
mkdir -p /tmp/scratch/ffmpeg && cd /tmp/scratch/ffmpeg
T=autobuild-2026-08-31-13-27
A=ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz
curl -sSLO "https://github.com/BtbN/FFmpeg-Builds/releases/download/$T/$A"
curl -sSLO "https://github.com/BtbN/FFmpeg-Builds/releases/download/$T/checksums.sha256"
grep " $A\$" checksums.sha256 | sha256sum -c -      # must print OK
tar -xJf "$A"
```

**When this pin is eventually pruned too** (month-end builds are long-lived but not forever):
pick the newest month-end tag from
`curl -s 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=100'`, verify the
tarball against that release's own `checksums.sha256` **and** the API `digest`, run the
real-ffmpeg suite, and update the table above. Do not silently switch to `latest` — it is a
moving pointer and defeats the point of a pin.

---

## Original pin (2026-09-04, lane L8) — URL DEAD, kept for provenance

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
