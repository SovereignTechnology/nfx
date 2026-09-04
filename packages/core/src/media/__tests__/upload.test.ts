import { describe, expect, it } from 'vitest';

import type { MediaPipeline, TranscodeOutput } from '../../contracts/media.js';
import type { UploadInput, UploadProgress } from '../../contracts/network-adapter.js';
import type { MintUrl, Sats, Sha256Hex } from '../../contracts/primitives.js';
import { VIDEOS } from '../../mocks/fixtures.js';
import { nodeSha256 } from '../node/sha256.js';
import { MemoryFs, MemorySink } from '../testing/fakes.js';
import { runStudioUpload, type UploadDraft } from '../upload.js';

const input: UploadInput = {
  file: '/videos/raw.mov',
  title: 'T',
  description: 'D',
  tags: ['a'],
  kind: 21,
  mints: ['https://mint.example' as MintUrl],
  satsPerBlock: 1 as Sats,
  split: { seeder: 50, creator: 50 },
};

const sha = (s: string): Sha256Hex => s.padEnd(64, '0') as Sha256Hex;

/** A scripted pipeline: no ffmpeg, just deterministic outputs and progress. */
function scriptedPipeline(fs: MemoryFs, opts: { failTranscode?: boolean } = {}): MediaPipeline {
  const out: TranscodeOutput = {
    renditions: [
      {
        spec: {
          label: '720p',
          height: 720,
          videoBitrateKbps: 2500,
          audioBitrateKbps: 128,
          codec: 'h264',
          container: 'mp4',
        },
        path: '/work/720p.mp4',
        size: 10,
        sha256: sha('aa'),
        faststart: true,
        width: 1280,
        height: 720,
      },
      {
        spec: {
          label: '360p',
          height: 360,
          videoBitrateKbps: 800,
          audioBitrateKbps: 96,
          codec: 'h264',
          container: 'mp4',
        },
        path: '/work/360p.mp4',
        size: 4,
        sha256: sha('bb'),
        faststart: true,
        width: 640,
        height: 360,
      },
    ],
    thumbnails: [
      { timeSec: 1, path: '/work/thumb-0.jpg', sha256: sha('t0') },
      { timeSec: 3, path: '/work/thumb-1.jpg', sha256: sha('t1') },
    ],
    placeholderDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
    storyboard: {
      path: '/work/storyboard.jpg',
      sha256: sha('sb'),
      cols: 10,
      rows: 1,
      intervalSec: 1,
      vttPath: '/work/storyboard.vtt',
    },
  };
  fs.set('/work/720p.mp4', new Uint8Array(10).fill(1));
  fs.set('/work/360p.mp4', new Uint8Array(4).fill(2));
  return {
    probe: () =>
      Promise.resolve({
        container: 'mov,mp4',
        durationSec: 5,
        video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
      }),
    plan: (probe) => ({
      source: probe,
      renditions: out.renditions.map((r) => r.spec),
      thumbnailTimes: [1, 3],
    }),
    transcode: (_path, _plan, onProgress) => {
      if (opts.failTranscode) return Promise.reject(new Error('encoder exploded'));
      onProgress({ stage: 'rendition', label: '720p', percent: 0 });
      onProgress({ stage: 'rendition', label: '720p', percent: 50, fps: 30 });
      onProgress({ stage: 'hash', label: '720p', percent: 100 });
      onProgress({ stage: 'thumbnails', done: 2, total: 2 });
      onProgress({ stage: 'storyboard' });
      return Promise.resolve(out);
    },
    publish: async (r, sink) => {
      const ref = await sink.put(fs.readChunks(r.path, 3), { blockSize: 3 });
      return {
        hyper: ref,
        hyperUrl: `hyper://${ref.core}/0-${ref.blob.blockLength}`,
        sha256: r.sha256,
        size: r.size,
      };
    },
  };
}

describe('runStudioUpload', () => {
  it('drives probe → transcode → write → publish and maps progress to UploadProgress', async () => {
    const fs = new MemoryFs();
    const progress: UploadProgress[] = [];
    const drafts: UploadDraft[] = [];
    const manifest = VIDEOS[0]!;
    const sink = new MemorySink();
    const video = await runStudioUpload(input, (p) => progress.push(p), {
      pipeline: scriptedPipeline(fs),
      sink,
      publish: (d) => {
        drafts.push(d);
        return Promise.resolve(manifest);
      },
      sha256: nodeSha256,
      fs,
      workDir: '/work',
    });
    expect(video).toBe(manifest);
    expect(progress.map((p) => p.stage)).toEqual([
      'probing',
      'transcoding',
      'transcoding',
      'thumbnails',
      'writing',
      'writing',
      'writing',
      'writing',
      'writing',
      'writing',
      'writing',
      'writing',
      'publishing',
      'done',
    ]);
    expect(progress[1]).toEqual({ stage: 'transcoding', rendition: '720p', percent: 0 });
    expect(progress[3]).toEqual({
      stage: 'thumbnails',
      candidates: ['/work/thumb-0.jpg', '/work/thumb-1.jpg'],
    });
    const writes = progress.filter(
      (p): p is Extract<UploadProgress, { stage: 'writing' }> => p.stage === 'writing',
    );
    expect(writes.filter((w) => w.rendition === '720p').map((w) => w.percent)).toEqual([
      0, 30, 60, 90, 100,
    ]);
    expect(writes.filter((w) => w.rendition === '360p').map((w) => w.percent)).toEqual([
      0, 75, 100,
    ]);
    expect(sink.puts.map((p) => p.bytes.length)).toEqual([10, 4]);

    const d = drafts[0]!;
    expect(d.renditions.map((r) => r.label)).toEqual(['720p', '360p']);
    expect(d.renditions[0]).toMatchObject({
      mime: 'video/mp4',
      sha256: sha('aa'),
      size: 10,
      width: 1280,
      height: 720,
      bitrateKbps: 2628,
      hyperUrl: `hyper://${'a'.repeat(64)}/0-4`,
      fallbacks: [],
      placeholder: 'data:image/jpeg;base64,/9j/2Q==',
    });
    expect(d.thumbnail).toEqual({
      kind: 'candidate',
      path: '/work/thumb-0.jpg',
      sha256: sha('t0'),
    });
    expect(d.storyboard?.vttPath).toBe('/work/storyboard.vtt');
    expect(d.workDir).toBe('/work');
    expect(fs.removed).toEqual([]);
  });

  it('honours thumbnailChoice as an index (clamped) or as user-supplied bytes', async () => {
    const fs = new MemoryFs();
    const manifest = VIDEOS[1]!;
    const run = async (choice: UploadInput['thumbnailChoice']) => {
      let draft: UploadDraft | undefined;
      const withChoice: UploadInput =
        choice === undefined ? input : { ...input, thumbnailChoice: choice };
      await runStudioUpload(withChoice, () => undefined, {
        pipeline: scriptedPipeline(fs),
        sink: new MemorySink(),
        publish: (d) => {
          draft = d;
          return Promise.resolve(manifest);
        },
        sha256: nodeSha256,
        fs,
        workDir: '/work',
      });
      return draft!.thumbnail;
    };
    expect(await run(1)).toMatchObject({ kind: 'candidate', path: '/work/thumb-1.jpg' });
    expect(await run(99)).toMatchObject({ kind: 'candidate', path: '/work/thumb-1.jpg' });
    expect(await run(-3)).toMatchObject({ kind: 'candidate', path: '/work/thumb-0.jpg' });
    const custom = await run({
      size: 3,
      type: 'image/png',
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });
    expect(custom.kind).toBe('custom');
    expect(custom.sha256).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
  });

  it('reports mirrors per server (failure is not fatal), removes the work dir when asked, and supports per-rendition sinks', async () => {
    const fs = new MemoryFs();
    const progress: UploadProgress[] = [];
    const sinks = new Map<string, MemorySink>();
    await runStudioUpload(
      { ...input, mirrorTo: ['https://a.example', 'https://b.example'] },
      (p) => progress.push(p),
      {
        pipeline: scriptedPipeline(fs),
        sink: (spec) => {
          const s = new MemorySink(spec.label.padEnd(64, 'c'));
          sinks.set(spec.label, s);
          return s;
        },
        publish: () => Promise.resolve(VIDEOS[2]!),
        mirror: (server) =>
          server.includes('a.') ? Promise.resolve(true) : Promise.reject(new Error('timeout')),
        sha256: nodeSha256,
        fs,
        workDir: '/work',
        removeWorkDir: true,
      },
    );
    expect(progress.filter((p) => p.stage === 'mirroring')).toEqual([
      { stage: 'mirroring', server: 'https://a.example', ok: true },
      { stage: 'mirroring', server: 'https://b.example', ok: false },
    ]);
    expect([...sinks.keys()]).toEqual(['720p', '360p']);
    expect(fs.removed).toEqual(['/work']);
    expect(progress.at(-1)?.stage).toBe('done');
  });

  it('emits an error stage and rethrows on failure; rejects non-path inputs up front', async () => {
    const fs = new MemoryFs();
    const progress: UploadProgress[] = [];
    await expect(
      runStudioUpload(input, (p) => progress.push(p), {
        pipeline: scriptedPipeline(fs, { failTranscode: true }),
        sink: new MemorySink(),
        publish: () => Promise.reject(new Error('unreachable')),
        sha256: nodeSha256,
        fs,
      }),
    ).rejects.toThrow('encoder exploded');
    expect(progress.at(-1)).toEqual({ stage: 'error', message: 'encoder exploded' });

    const webFile = {
      name: 'x.mp4',
      lastModified: 0,
      size: 1,
      type: 'video/mp4',
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
    };
    const p2: UploadProgress[] = [];
    await expect(
      runStudioUpload({ ...input, file: webFile }, (p) => p2.push(p), {
        pipeline: scriptedPipeline(fs),
        sink: new MemorySink(),
        publish: () => Promise.resolve(VIDEOS[0]!),
        sha256: nodeSha256,
        fs,
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
    expect(p2.map((p) => p.stage)).toEqual(['error']);
  });
});
