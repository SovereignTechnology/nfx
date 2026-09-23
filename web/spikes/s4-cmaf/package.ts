/**
 * Spike S4 (ADR 0008, A1): does ffmpeg produce valid NFX-05 output when driven by the demo's
 * L8 ladder and argv planning (2 s aligned GOP, `-sc_threshold 0`), with every file renamed
 * to its sha256?
 *
 * The L8 functions are imported unchanged from the read-only `packages/` mirror. The only
 * change is the container tail: L8 writes progressive MP4 (`-movflags +faststart -f mp4`),
 * NFX-05 wants CMAF, so the argv is cut at `-movflags` and given HLS/fMP4 output options.
 *
 * Usage: [NFX_DURATION=12] npx tsx package.ts [outDir=out]   → out/store/<sha256> + out/nfx.json
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renditionArgv, renditionDimensions, thumbnailArgv } from '../../../packages/core/src/media/argv.ts';
import { ffprobeArgv, parseFfprobeJson } from '../../../packages/core/src/media/ffprobe.ts';
import { GOP_SECONDS, planLadder } from '../../../packages/core/src/media/ladder.ts';

const NAMESPACE = 'nfx:testnet:1';
const DURATION_S = Number(process.env.NFX_DURATION ?? 12);
const VIDEO_ID = DURATION_S === 12 ? 's4-cmaf-testsrc' : `s4-cmaf-testsrc-${DURATION_S}s`;

interface FileEntry {
  name: string;
  role: 'playlist-master' | 'playlist' | 'init' | 'segment' | 'thumb' | 'subtitle';
  sha256: string;
  size: number;
  dur_ms?: number;
}
interface Rendition {
  id: string;
  playlist: string;
  bandwidth: number;
  codecs: string;
  resolution: string;
}

const out = resolve(process.argv[2] ?? 'out');
const work = join(out, 'work');
const store = join(out, 'store');
rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(store, { recursive: true });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const run = (bin: string, args: readonly string[]): Buffer =>
  execFileSync(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
const put = (bytes: Buffer): string => {
  const h = sha(bytes);
  writeFileSync(join(store, h), bytes);
  return h;
};
const checks: string[] = [];
const check = (ok: boolean, what: string): void => {
  checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) process.exitCode = 1;
};

// 1. A 12 s 1080p30 mezzanine with audio (synthetic: no licensing, deterministic content).
const src = join(work, 'source.mp4');
run('ffmpeg', [
  '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${DURATION_S}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION_S}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', src,
]);

// 2. Probe and plan with the demo's L8 code.
const probe = parseFfprobeJson(run('ffprobe', ffprobeArgv(src)).toString());
const plan = planLadder(probe);
const fps = probe.video?.fps ?? 30;
console.log(`ladder: ${plan.renditions.map((r) => `${r.label}@${r.videoBitrateKbps}k`).join(', ')}  (GOP ${GOP_SECONDS} s)`);

// 3. Encode each rendition: L8 argv, container tail swapped for CMAF HLS.
const files: FileEntry[] = [];
const renditions: Rendition[] = [];
const playlistEntries: FileEntry[] = [];
const segmentDurations: number[][] = [];

for (const spec of plan.renditions) {
  const dir = join(work, spec.label);
  mkdirSync(dir);
  const argv = [...renditionArgv(src, 'unused.mp4', probe, spec, { fps })];
  const cut = argv.indexOf('-movflags');
  if (cut < 0) throw new Error('L8 argv shape changed: no -movflags to cut at');
  run('ffmpeg', [
    ...argv.slice(0, cut),
    '-f', 'hls', '-hls_time', String(GOP_SECONDS), '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg_%05d.m4s'),
    join(dir, 'index.m3u8'),
  ]);

  // 4. Content-address: init → <sha>.mp4, segments → <sha>.m4s; rewrite the playlist (NFX-05 §3).
  const initBytes = readFileSync(join(dir, 'init.mp4'));
  const initSha = put(initBytes);
  const own: FileEntry[] = [{ name: `init-${spec.label}.mp4`, role: 'init', sha256: initSha, size: initBytes.length }];
  const durations: number[] = [];
  let pending = 0;
  let peakBps = 0;
  const lines: string[] = [];
  for (const line of readFileSync(join(dir, 'index.m3u8'), 'utf8').split('\n')) {
    if (line.startsWith('#EXT-X-MAP:')) {
      lines.push(`#EXT-X-MAP:URI="${initSha}.mp4"`);
    } else if (line.startsWith('#EXTINF:')) {
      pending = Number.parseFloat(line.slice('#EXTINF:'.length));
      lines.push(line);
    } else if (line !== '' && !line.startsWith('#')) {
      const bytes = readFileSync(join(dir, line));
      const h = put(bytes);
      const durMs = Math.round(pending * 1000);
      own.push({ name: `${spec.label}-${line}`, role: 'segment', sha256: h, size: bytes.length, dur_ms: durMs });
      durations.push(durMs);
      peakBps = Math.max(peakBps, Math.ceil((bytes.length * 8 * 1000) / durMs));
      // Keyframe check (NFX-05 §1): init + this segment must decode starting at an IDR.
      const probeFile = join(work, 'kf.mp4');
      writeFileSync(probeFile, Buffer.concat([initBytes, bytes]));
      const first = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-read_intervals', '%+#1',
        '-show_entries', 'frame=key_frame,pict_type', '-of', 'csv=p=0', probeFile]).toString().trim();
      check(first.startsWith('1,I'), `${spec.label} ${line} starts with an IDR (${first})`);
      lines.push(`${h}.m4s`);
    } else {
      lines.push(line);
    }
  }
  const playlist = Buffer.from(lines.join('\n'));
  const playlistSha = put(playlist);
  playlistEntries.push({ name: `r${spec.label}.m3u8`, role: 'playlist', sha256: playlistSha, size: playlist.length });
  files.push(...own);
  segmentDurations.push(durations);

  // CODECS from the stream itself. ffprobe reports no profile for a bare init segment,
  // so probe init + the first media segment (a decodable file).
  const firstSeg = own.find((f) => f.role === 'segment');
  const codecProbe = join(work, 'codecs.mp4');
  writeFileSync(codecProbe, Buffer.concat([initBytes, readFileSync(join(store, firstSeg?.sha256 ?? ''))]));
  const streams = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', codecProbe]).toString()).streams;
  const v = streams.find((s: { codec_type: string }) => s.codec_type === 'video');
  const a = streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  const profileIdc: Record<string, number> = { Baseline: 66, 'Constrained Baseline': 66, Main: 77, High: 100 };
  const idc = profileIdc[v.profile];
  if (idc === undefined) throw new Error(`unexpected H.264 profile ${v.profile}`);
  const avc1 = `avc1.${idc.toString(16).padStart(2, '0')}00${Number(v.level).toString(16).padStart(2, '0')}`;
  const codecs = a ? `${avc1},mp4a.40.2` : avc1;
  const dims = renditionDimensions(probe, spec);
  check(v.width === dims.width && v.height === dims.height, `${spec.label} is ${v.width}x${v.height} as L8 planned`);
  renditions.push({ id: spec.label, playlist: `r${spec.label}.m3u8`, bandwidth: peakBps, codecs, resolution: `${v.width}x${v.height}` });
}

// 5. Master playlist (content names only) and a thumbnail from L8's thumbnail argv.
const master = Buffer.from(
  ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
    ...renditions.flatMap((r, i) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.resolution},CODECS="${r.codecs}"`,
      `${playlistEntries[i]?.sha256}.m3u8`,
    ]), ''].join('\n'),
);
const thumbPath = join(work, 'thumb.jpg');
run('ffmpeg', thumbnailArgv(src, thumbPath, plan.thumbnailTimes[0] ?? 0));
const thumb = readFileSync(thumbPath);
const hashlist = {
  v: 1,
  video: `${NAMESPACE}:${VIDEO_ID}`,
  files: [
    { name: 'master.m3u8', role: 'playlist-master', sha256: put(master), size: master.length },
    ...playlistEntries,
    ...files,
    { name: 'thumb.jpg', role: 'thumb', sha256: put(thumb), size: thumb.length },
  ],
  renditions,
};
const hashlistBytes = Buffer.from(`${JSON.stringify(hashlist, null, 2)}\n`);
const root = put(hashlistBytes);

// 6. Cross-rendition alignment: same segment count and durations, so switches are seamless.
const [first, ...rest] = segmentDurations;
check(rest.every((d) => JSON.stringify(d) === JSON.stringify(first)), `segment durations align across renditions: ${JSON.stringify(first)}`);
check((first ?? []).slice(0, -1).every((d) => d === GOP_SECONDS * 1000), `every segment but the last is exactly ${GOP_SECONDS} s`);

const meta = { root, video: hashlist.video, segs: hashlist.files.length, thumb: hashlist.files.at(-1)?.sha256 };
writeFileSync(join(out, 'nfx.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(checks.join('\n'));
console.log(`root ${root}  files ${hashlist.files.length}  store ${store}`);
