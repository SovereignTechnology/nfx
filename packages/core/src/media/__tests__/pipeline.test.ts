import { describe, expect, it } from 'vitest';

import type { MediaPipeline, TranscodeProgress } from '../../contracts/media.js';
import { MediaError, ProcessRunnerError } from '../errors.js';
import { nodeSha256 } from '../node/sha256.js';
import { createMediaPipeline } from '../pipeline.js';
import {
  FakeRunner,
  MemoryFs,
  MemorySink,
  probeJson,
  syntheticMp4,
  type RecordedCall,
} from '../testing/fakes.js';

const sha256Of = (bytes: Uint8Array): string => {
  const h = nodeSha256();
  h.update(bytes);
  return h.digest();
};

const BIN = { ffmpeg: '/opt/ff/ffmpeg', ffprobe: '/opt/ff/ffprobe' };
const INPUT = "/media/in/$(evil) 'clip'.mov";

const opt = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * A fake ffmpeg/ffprobe pair driven by argv shape. It writes plausible bytes into `fs` for
 * every output path it is asked for, and answers ffprobe with the dims it "encoded".
 */
function fakeTools(
  fs: MemoryFs,
  behaviour: {
    source?: Parameters<typeof probeJson>[0];
    faststart?: boolean;
    failLabel?: string;
    sourceMp4Faststart?: boolean;
  } = {},
) {
  const source = behaviour.source ?? {
    duration: 20,
    bitrate: 4_000_000,
    video: { width: 1920, height: 1080 },
    audio: {},
  };
  const encoded = new Map<string, { w: number; h: number }>();
  return new FakeRunner((call: RecordedCall, stderr) => {
    if (call.file === BIN.ffprobe) {
      const path = call.args.at(-1) ?? '';
      if (path === INPUT) return { stdout: probeJson(source) };
      if (path.endsWith('storyboard.jpg')) {
        return {
          stdout: probeJson({
            format: 'image2',
            video: { codec: 'mjpeg', width: 1600, height: 900 },
          }),
        };
      }
      const dims = encoded.get(path);
      if (!dims) return { exitCode: 1, stderr: `${path}: No such file or directory` };
      return {
        stdout: probeJson({ duration: 20, video: { width: dims.w, height: dims.h }, audio: {} }),
      };
    }
    if (call.file !== BIN.ffmpeg) return { exitCode: 127, stderr: 'unknown tool' };
    const out = call.args.at(-1) ?? '';
    const vf = opt(call.args, '-vf') ?? '';
    if (call.args.includes('-progress')) {
      const m = /^scale=(\d+):(\d+)$/.exec(vf);
      if (!m) throw new Error(`unexpected -vf ${vf}`);
      const label =
        out
          .split('/')
          .at(-1)
          ?.replace(/\.\w+$/, '') ?? '';
      if (behaviour.failLabel === label) {
        stderr('[libx264 @ 0x1] broken pipe');
        return { exitCode: 1, stderr: 'Conversion failed!' };
      }
      stderr('fps=25.00');
      stderr('out_time_us=10000000');
      stderr('progress=continue');
      stderr('out_time_us=20000000');
      stderr('progress=end');
      const mp4 = syntheticMp4({
        faststart: behaviour.faststart ?? true,
        mdatSize: 5000 + label.length,
      });
      fs.set(out, out.endsWith('.webm') ? new Uint8Array(3000) : mp4);
      encoded.set(out, { w: Number(m[1]), h: Number(m[2]) });
      return {};
    }
    if (vf.includes('tile=')) {
      fs.set(out, new Uint8Array([0xff, 0xd8, 1, 2, 3]));
      return {};
    }
    if (vf.startsWith('scale=32:')) {
      fs.set(out, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      return {};
    }
    // thumbnail
    fs.set(out, new TextEncoder().encode(`thumb@${opt(call.args, '-ss') ?? '?'}`));
    return {};
  });
}

function build(
  fs: MemoryFs,
  runner: FakeRunner,
  extra: Partial<Parameters<typeof createMediaPipeline>[0]> = {},
): MediaPipeline {
  return createMediaPipeline({
    runner,
    fs,
    sha256: nodeSha256,
    binaries: BIN,
    preset: 'ultrafast',
    ...extra,
  });
}

describe('MediaPipeline.probe', () => {
  it('runs ffprobe with argv only and detects faststart by box order from the first chunk', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true, mdatSize: 1_000_000 }));
    const runner = fakeTools(fs);
    const p = build(fs, runner, { chunkSize: 512 });
    const probe = await p.probe(INPUT);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.file).toBe(BIN.ffprobe);
    expect(runner.calls[0]?.args.at(-1)).toBe(INPUT);
    expect(probe.video).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(probe.faststart).toBe(true);
  });

  it('reports mdat-first inputs as not faststart', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: false }));
    const probe = await build(fs, fakeTools(fs)).probe(INPUT);
    expect(probe.faststart).toBe(false);
  });

  it('treats a malformed box structure as not faststart rather than throwing', async () => {
    const fs = new MemoryFs();
    const junk = syntheticMp4({ faststart: true });
    junk[3] = 2; // ftyp size = 2 < 8 → RangeError inside the scanner
    fs.set(INPUT, junk);
    const probe = await build(fs, fakeTools(fs)).probe(INPUT);
    expect(probe.faststart).toBe(false);
  });

  it('skips the box scan for non-MP4 containers', async () => {
    const fs = new MemoryFs();
    const runner = fakeTools(fs, {
      source: { format: 'matroska,webm', duration: 5, video: { width: 640, height: 360 } },
    });
    const probe = await build(fs, runner).probe(INPUT); // file is NOT in fs: scan would throw
    expect(probe.faststart).toBeUndefined();
  });

  it('maps spawn failure to ffmpeg-not-found and a non-zero exit to process-failed', async () => {
    const fs = new MemoryFs();
    const missing = new FakeRunner((c) => {
      throw new ProcessRunnerError('spawn-failed', c.file, { errno: 'ENOENT' });
    });
    await expect(build(fs, missing).probe(INPUT)).rejects.toMatchObject({
      name: 'MediaError',
      code: 'ffmpeg-not-found',
    });
    const failing = new FakeRunner(() => ({ exitCode: 1, stderr: 'Invalid data found' }));
    await expect(build(fs, failing).probe(INPUT)).rejects.toMatchObject({
      code: 'process-failed',
      stderr: 'Invalid data found',
    });
  });
});

describe('MediaPipeline.transcode', () => {
  async function run(behaviour: Parameters<typeof fakeTools>[1] = {}) {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const runner = fakeTools(fs, behaviour);
    const p = build(fs, runner);
    const probe = await p.probe(INPUT);
    const plan = p.plan(probe);
    const progress: TranscodeProgress[] = [];
    const out = await p.transcode(INPUT, plan, (e) => progress.push(e));
    return { fs, runner, p, plan, progress, out };
  }

  it('produces the full ladder with verified faststart, sha256 and probed dimensions', async () => {
    const { fs, out, runner } = await run();
    expect(out.renditions.map((r) => r.spec.label)).toEqual(['1080p', '720p', '360p']);
    for (const r of out.renditions) {
      expect(r.faststart).toBe(true);
      expect(r.path).toBe(`/tmp/nutflix-transcode-1/${r.spec.label}.mp4`);
      const bytes = fs.files.get(r.path)!;
      expect(r.size).toBe(bytes.length);
      expect(r.sha256).toBe(sha256Of(bytes));
    }
    expect(out.renditions.map((r) => [r.width, r.height])).toEqual([
      [1920, 1080],
      [1280, 720],
      [640, 360],
    ]);
    // every ffmpeg rendition call carries faststart + the hostile input verbatim
    const encodes = runner.calls.filter(
      (c) => c.file === BIN.ffmpeg && c.args.includes('-progress'),
    );
    expect(encodes).toHaveLength(3);
    for (const c of encodes) {
      expect(opt(c.args, '-i')).toBe(INPUT);
      expect(c.args.join(' ')).toContain('-movflags +faststart');
      expect(opt(c.args, '-preset')).toBe('ultrafast');
    }
  });

  it('emits thumbnails with sha256, a data: placeholder and a storyboard + VTT', async () => {
    const { fs, out, plan } = await run();
    expect(out.thumbnails.map((t) => t.timeSec)).toEqual([2, 6, 10, 14]);
    for (const t of out.thumbnails) expect(t.sha256).toBe(sha256Of(fs.files.get(t.path)!));
    expect(out.placeholderDataUrl).toBe('data:image/jpeg;base64,/9j/2Q==');
    expect(out.storyboard).toMatchObject({ cols: 10, rows: 2, intervalSec: 1 });
    expect(plan.storyboard).toEqual({ intervalSec: 1, cols: 10, rows: 2, tileWidth: 160 });
    expect(out.storyboard?.sha256).toBe(sha256Of(fs.files.get(out.storyboard!.path)!));
    const vtt = new TextDecoder().decode(fs.files.get(out.storyboard!.vttPath));
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    // sprite probed as 1600x900 with 10 cols × 2 rows → 160x450 tiles
    expect(vtt).toContain('storyboard.jpg#xywh=0,0,160,450');
    expect(vtt).toContain('00:00:19.000 --> 00:00:20.000');
    expect(vtt.split('-->').length - 1).toBe(20);
  });

  it('reports progress in order: rendition percent (with fps), hash, thumbnails, storyboard', async () => {
    const { progress } = await run();
    const rend = progress.filter((p) => p.stage === 'rendition');
    expect(rend.slice(0, 3)).toEqual([
      { stage: 'rendition', label: '1080p', percent: 0 },
      { stage: 'rendition', label: '1080p', percent: 50, fps: 25 },
      { stage: 'rendition', label: '1080p', percent: 100, fps: 25 },
    ]);
    expect(progress.some((p) => p.stage === 'hash' && p.percent === 100)).toBe(true);
    const thumbs = progress.filter((p) => p.stage === 'thumbnails');
    expect(thumbs.at(0)).toEqual({ stage: 'thumbnails', done: 0, total: 4 });
    expect(thumbs.at(-1)).toEqual({ stage: 'thumbnails', done: 4, total: 4 });
    expect(progress.at(-1)).toEqual({ stage: 'storyboard' });
    const firstThumb = progress.findIndex((p) => p.stage === 'thumbnails');
    expect(progress.findLastIndex((p) => p.stage === 'rendition')).toBeLessThan(firstThumb);
  });

  it('REJECTS an output whose moov follows mdat even though ffmpeg exited 0', async () => {
    await expect(run({ faststart: false })).rejects.toMatchObject({
      name: 'MediaError',
      code: 'not-faststart',
    });
  });

  it('surfaces encoder failure with captured stderr', async () => {
    await expect(run({ failLabel: '720p' })).rejects.toMatchObject({
      code: 'process-failed',
      message: 'ffmpeg 720p: exit 1',
      stderr: 'Conversion failed!',
    });
  });

  it('respects an explicit workDir and rejects a plan without video', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const p = build(fs, fakeTools(fs));
    const plan = p.plan(await p.probe(INPUT));
    const out = await p.transcode(INPUT, plan, () => undefined, { workDir: '/work/x' });
    expect(out.renditions[0]?.path).toBe('/work/x/1080p.mp4');
    await expect(
      p.transcode(
        INPUT,
        { ...plan, source: { container: 'mp3', durationSec: 1 } },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'no-video-stream' });
  });

  it('webm renditions skip the MP4 box check', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const p = build(fs, fakeTools(fs));
    const plan = p.plan(await p.probe(INPUT), { codec: 'vp9', maxHeight: 360 });
    const out = await p.transcode(INPUT, plan, () => undefined);
    expect(out.renditions[0]?.path.endsWith('360p.webm')).toBe(true);
    expect(out.renditions[0]?.size).toBe(3000);
  });
});

describe('MediaPipeline.publish', () => {
  it('streams the rendition into the sink in chunkSize blocks, re-hashes and returns the ref', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const p = build(fs, fakeTools(fs), { chunkSize: 1024 });
    const plan = p.plan(await p.probe(INPUT), { maxHeight: 360 });
    const out = await p.transcode(INPUT, plan, () => undefined);
    const r = out.renditions[0]!;
    const sink = new MemorySink('b'.repeat(64));
    const pub = await p.publish(r, sink);
    expect(sink.puts[0]?.blockSize).toBe(1024);
    expect(sink.puts[0]?.bytes).toEqual(fs.files.get(r.path));
    expect(pub.sha256).toBe(r.sha256);
    expect(pub.size).toBe(r.size);
    expect(pub.hyper.blob.blockLength).toBe(Math.ceil(r.size / 1024));
    expect(pub.hyperUrl).toBe(`hyper://${'b'.repeat(64)}/0-${pub.hyper.blob.blockLength}`);
  });

  it('uses the injected hyperUrl formatter', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const p = build(fs, fakeTools(fs), {
      hyperUrl: (ref) => `hyper://z32(${ref.core.slice(0, 4)})/${ref.blob.byteLength}`,
    });
    const plan = p.plan(await p.probe(INPUT), { maxHeight: 360 });
    const out = await p.transcode(INPUT, plan, () => undefined);
    const pub = await p.publish(out.renditions[0]!, new MemorySink());
    expect(pub.hyperUrl).toBe(`hyper://z32(aaaa)/${out.renditions[0]!.size}`);
  });

  it('fails with hash-mismatch if the file changed after transcode', async () => {
    const fs = new MemoryFs();
    fs.set(INPUT, syntheticMp4({ faststart: true }));
    const p = build(fs, fakeTools(fs));
    const plan = p.plan(await p.probe(INPUT), { maxHeight: 360 });
    const out = await p.transcode(INPUT, plan, () => undefined);
    const r = out.renditions[0]!;
    fs.set(r.path, syntheticMp4({ faststart: true, mdatSize: 77 }));
    await expect(p.publish(r, new MemorySink())).rejects.toMatchObject({ code: 'hash-mismatch' });
    expect(new MediaError('aborted', 'x').name).toBe('MediaError');
  });
});
