import type { HyperblobRef, Rendition } from '../contracts/manifest.js';
import type {
  BlobSink,
  FsAdapter,
  LadderPlan,
  MediaPipeline,
  MediaProbe,
  ProcessRunner,
  RenditionSpec,
  TranscodeOutput,
  TranscodeProgress,
} from '../contracts/media.js';
import type { Sha256Hex } from '../contracts/primitives.js';
import { placeholderArgv, renditionArgv, storyboardArgv, thumbnailArgv } from './argv.js';
import { dataUrl } from './base64.js';
import { MediaError, isProcessRunnerError } from './errors.js';
import { ffprobeArgv, isMp4Container, parseFfprobeJson } from './ffprobe.js';
import { defaultHyperUrl } from './hyper-url.js';
import { planLadder } from './ladder.js';
import { Mp4BoxScanner } from './mp4-boxes.js';
import { ProgressTracker } from './progress.js';
import { storyboardVtt } from './storyboard.js';
import type { MediaPipelineDeps, Sha256Factory } from './types.js';

/**
 * The pure-planning `MediaPipeline` (contracts/media.ts). Every external effect goes through
 * the injected `ProcessRunner` (argv arrays only) and `FsAdapter`; hashing is the injected
 * `sha256`. No `node:` import in this file — see `__tests__/runtime-agnostic.test.ts`.
 *
 * Paths are joined with `/`; both Node (all platforms) and Bare accept that.
 */

const DEFAULT_CHUNK = 65_536;
const DEFAULT_PREFIX = 'nutflix-transcode-';

const decoder = new TextDecoder();

async function runOrThrow(
  runner: ProcessRunner,
  file: string,
  args: readonly string[],
  what: string,
  onStderrLine?: (line: string) => void,
): Promise<{ readonly stdout: Uint8Array; readonly stderr: string }> {
  let res: Awaited<ReturnType<ProcessRunner['run']>>;
  try {
    res = await runner.run(file, args, onStderrLine ? { onStderrLine } : undefined);
  } catch (e) {
    if (isProcessRunnerError(e)) {
      if (e.code === 'aborted') throw new MediaError('aborted', `${what}: aborted`, { cause: e });
      throw new MediaError(
        'ffmpeg-not-found',
        `${what}: could not spawn ${e.file}${e.errno ? ` (${e.errno})` : ''}`,
        { cause: e },
      );
    }
    throw new MediaError('process-failed', `${what}: runner failed`, { cause: e });
  }
  if (res.exitCode !== 0) {
    throw new MediaError('process-failed', `${what}: exit ${res.exitCode}`, {
      stderr: res.stderr,
    });
  }
  return res;
}

async function hashFile(
  fs: FsAdapter,
  sha256: Sha256Factory,
  path: string,
  chunkSize: number,
  onBytes?: (done: number) => void,
): Promise<{ readonly sha256: Sha256Hex; readonly size: number }> {
  const h = sha256();
  let size = 0;
  for await (const chunk of fs.readChunks(path, chunkSize)) {
    h.update(chunk);
    size += chunk.length;
    onBytes?.(size);
  }
  return { sha256: h.digest(), size };
}

function hashBytes(sha256: Sha256Factory, bytes: Uint8Array): Sha256Hex {
  const h = sha256();
  h.update(bytes);
  return h.digest();
}

/** Reads only as much of the file as needed to see both `moov` and `mdat`. */
async function detectFaststart(fs: FsAdapter, path: string, chunkSize: number): Promise<boolean> {
  const scanner = new Mp4BoxScanner();
  const it = fs.readChunks(path, chunkSize)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      scanner.feed(r.value);
      if (scanner.decided()) break;
    }
  } catch (e) {
    // A malformed top-level box structure is, by definition, not a faststart MP4.
    if (e instanceof RangeError) return false;
    throw e;
  } finally {
    await it.return?.();
  }
  return scanner.faststart();
}

function outputName(spec: RenditionSpec): string {
  return `${spec.label}.${spec.container}`;
}

export function createMediaPipeline(deps: MediaPipelineDeps): MediaPipeline {
  const { runner, fs, sha256, binaries } = deps;
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK;
  const hyperUrl = deps.hyperUrl ?? defaultHyperUrl;
  const preset = deps.preset ?? 'medium';
  const prefix = deps.workDirPrefix ?? DEFAULT_PREFIX;

  async function probe(path: string): Promise<MediaProbe> {
    const res = await runOrThrow(runner, binaries.ffprobe, ffprobeArgv(path), 'ffprobe');
    const parsed = parseFfprobeJson(decoder.decode(res.stdout));
    if (!isMp4Container(parsed.container)) return parsed;
    const faststart = await detectFaststart(fs, path, chunkSize);
    return { ...parsed, faststart };
  }

  function plan(
    source: MediaProbe,
    opts?: { readonly maxHeight?: number; readonly codec?: RenditionSpec['codec'] },
  ): LadderPlan {
    return planLadder(source, opts ?? {});
  }

  async function transcode(
    path: string,
    ladder: LadderPlan,
    onProgress: (p: TranscodeProgress) => void,
    opts: { readonly workDir?: string } = {},
  ): Promise<TranscodeOutput> {
    const source = ladder.source;
    if (!source.video) throw new MediaError('no-video-stream', 'plan source has no video');
    const workDir = opts.workDir ?? (await fs.mkdtemp(prefix));
    const fps = source.video.fps;

    // ---- renditions -------------------------------------------------------------------
    const renditions: TranscodeOutput['renditions'][number][] = [];
    for (const spec of ladder.renditions) {
      const out = `${workDir}/${outputName(spec)}`;
      const tracker = new ProgressTracker(source.durationSec, (percent, tfps) => {
        onProgress({
          stage: 'rendition',
          label: spec.label,
          percent,
          ...(tfps !== undefined ? { fps: tfps } : {}),
        });
      });
      onProgress({ stage: 'rendition', label: spec.label, percent: 0 });
      await runOrThrow(
        runner,
        binaries.ffmpeg,
        renditionArgv(path, out, source, spec, { preset, fps }),
        `ffmpeg ${spec.label}`,
        (line) => {
          tracker.line(line);
        },
      );

      const outProbe = await probe(out);
      if (!outProbe.video) {
        throw new MediaError('process-failed', `${spec.label}: output has no video stream`);
      }
      if (spec.container === 'mp4' && outProbe.faststart !== true) {
        throw new MediaError('not-faststart', `${spec.label}: moov does not precede mdat`);
      }

      const { size } = await fs.stat(out);
      const hashed = await hashFile(fs, sha256, out, chunkSize, (done) => {
        onProgress({
          stage: 'hash',
          label: spec.label,
          percent: size > 0 ? Math.min(100, Math.floor((done / size) * 100)) : 100,
        });
      });
      if (hashed.size !== size) {
        throw new MediaError('hash-mismatch', `${spec.label}: file changed while hashing`);
      }
      renditions.push({
        spec,
        path: out,
        size,
        sha256: hashed.sha256,
        faststart: true,
        width: outProbe.video.width,
        height: outProbe.video.height,
      });
    }

    // ---- thumbnails -------------------------------------------------------------------
    const thumbnails: TranscodeOutput['thumbnails'][number][] = [];
    const total = ladder.thumbnailTimes.length;
    onProgress({ stage: 'thumbnails', done: 0, total });
    for (const [i, timeSec] of ladder.thumbnailTimes.entries()) {
      const out = `${workDir}/thumb-${i}.jpg`;
      await runOrThrow(runner, binaries.ffmpeg, thumbnailArgv(path, out, timeSec), 'thumbnail');
      const bytes = await fs.readFile(out);
      thumbnails.push({ timeSec, path: out, sha256: hashBytes(sha256, bytes) });
      onProgress({ stage: 'thumbnails', done: i + 1, total });
    }

    // ---- placeholder ------------------------------------------------------------------
    const phPath = `${workDir}/placeholder.jpg`;
    const phTime = ladder.thumbnailTimes[0] ?? 0;
    await runOrThrow(runner, binaries.ffmpeg, placeholderArgv(path, phPath, phTime), 'placeholder');
    const placeholderDataUrl = dataUrl('image/jpeg', await fs.readFile(phPath));

    // ---- storyboard -------------------------------------------------------------------
    let storyboard: TranscodeOutput['storyboard'];
    if (ladder.storyboard) {
      onProgress({ stage: 'storyboard' });
      const sb = ladder.storyboard;
      const spritePath = `${workDir}/storyboard.jpg`;
      const vttPath = `${workDir}/storyboard.vtt`;
      await runOrThrow(runner, binaries.ffmpeg, storyboardArgv(path, spritePath, sb), 'storyboard');
      const spriteProbe = await runOrThrow(
        runner,
        binaries.ffprobe,
        ffprobeArgv(spritePath),
        'ffprobe storyboard',
      );
      const sprite = parseFfprobeJson(decoder.decode(spriteProbe.stdout));
      if (!sprite.video) throw new MediaError('process-failed', 'storyboard: sprite has no image');
      const vtt = storyboardVtt({
        durationSec: source.durationSec,
        intervalSec: sb.intervalSec,
        cols: sb.cols,
        rows: sb.rows,
        spriteWidth: sprite.video.width,
        spriteHeight: sprite.video.height,
        spriteUrl: 'storyboard.jpg',
      });
      await fs.writeFile(vttPath, new TextEncoder().encode(vtt));
      const spriteBytes = await fs.readFile(spritePath);
      storyboard = {
        path: spritePath,
        sha256: hashBytes(sha256, spriteBytes),
        cols: sb.cols,
        rows: sb.rows,
        intervalSec: sb.intervalSec,
        vttPath,
      };
    }

    return {
      renditions,
      thumbnails,
      placeholderDataUrl,
      ...(storyboard ? { storyboard } : {}),
    };
  }

  async function publish(
    output: TranscodeOutput['renditions'][number],
    sink: BlobSink,
  ): Promise<Pick<Rendition, 'hyper' | 'hyperUrl' | 'sha256' | 'size'>> {
    const h = sha256();
    let size = 0;
    async function* tee(): AsyncGenerator<Uint8Array> {
      for await (const chunk of fs.readChunks(output.path, chunkSize)) {
        h.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    }
    const ref: HyperblobRef = await sink.put(tee(), { blockSize: chunkSize });
    const digest = h.digest();
    if (digest !== output.sha256 || size !== output.size) {
      throw new MediaError(
        'hash-mismatch',
        `${output.spec.label}: bytes written to Hyperblobs do not match the transcode output`,
      );
    }
    return { hyper: ref, hyperUrl: hyperUrl(ref), sha256: digest, size };
  }

  return { probe, plan, transcode, publish };
}
