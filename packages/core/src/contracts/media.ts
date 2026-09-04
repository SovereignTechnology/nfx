import type { HyperblobRef, Rendition } from './manifest.js';
import type { Sha256Hex } from './primitives.js';

/**
 * Media pipeline contract (build-plan §6.4; spike S-C).
 *
 * S-C found that `bare-ffmpeg` cannot encode H.264, cannot write faststart MP4, and cannot
 * seek, and that no `bare-*` addon loads under Node. So `@sovit/core/media` is PURE
 * PLANNING CODE — probe schema → rendition ladder → ffmpeg argv → verification — with the
 * process runner and filesystem injected. Two adapters exist: `node:child_process` (gateway)
 * and `bare-subprocess` (desktop worker). In-process `bare-ffmpeg`/`bare-media` probing and
 * thumbnailing, if used at all, live in a Bare-only optional package behind this interface.
 */

/** Normalised probe result; both `ffprobe -print_format json` and bare-media map to this. */
export interface MediaProbe {
  readonly container: string; // e.g. "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"
  readonly durationSec: number;
  readonly bitrateKbps?: number;
  readonly video?: {
    readonly codec: string; // "h264", "hevc", "vp9", "av1"
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly rotation?: number;
    readonly pixelFormat?: string;
  };
  readonly audio?: {
    readonly codec: string;
    readonly channels: number;
    readonly sampleRate: number;
  };
  /** True when `moov` precedes `mdat` (range playback starts immediately). */
  readonly faststart?: boolean;
}

export interface RenditionSpec {
  readonly label: string; // "1080p" | "720p" | "360p" — never taller than the source
  readonly height: number;
  readonly videoBitrateKbps: number;
  readonly audioBitrateKbps: number;
  readonly codec: 'h264' | 'vp9' | 'av1';
  readonly container: 'mp4' | 'webm';
}

export interface LadderPlan {
  readonly source: MediaProbe;
  readonly renditions: readonly RenditionSpec[];
  /** Seconds at which to grab thumbnail candidates. */
  readonly thumbnailTimes: readonly number[];
  readonly storyboard?: {
    readonly intervalSec: number;
    readonly cols: number;
    readonly rows: number;
    readonly tileWidth: number;
  };
}

/** Injected process runner. Never a shell string — argv only. */
export interface ProcessRunner {
  run(
    file: string,
    args: readonly string[],
    opts?: {
      readonly cwd?: string;
      readonly onStderrLine?: (line: string) => void;
      readonly signal?: {
        readonly aborted: boolean;
        addEventListener(type: 'abort', cb: () => void): void;
      };
    },
  ): Promise<{ readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string }>;
}

/** Minimal fs the pipeline needs; mapped to `node:fs/promises` or `bare-fs`. */
export interface FsAdapter {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ readonly size: number }>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, opts?: { readonly recursive?: boolean }): Promise<void>;
  /** Streaming read for hashing + Hyperblobs write without loading the file. */
  readChunks(path: string, chunkSize: number): AsyncIterable<Uint8Array>;
}

export type TranscodeProgress =
  | { readonly stage: 'probe' }
  | {
      readonly stage: 'rendition';
      readonly label: string;
      readonly percent: number;
      readonly fps?: number;
    }
  | { readonly stage: 'thumbnails'; readonly done: number; readonly total: number }
  | { readonly stage: 'storyboard' }
  | { readonly stage: 'hash'; readonly label: string; readonly percent: number }
  | { readonly stage: 'write'; readonly label: string; readonly percent: number };

export interface TranscodeOutput {
  readonly renditions: readonly {
    readonly spec: RenditionSpec;
    readonly path: string;
    readonly size: number;
    readonly sha256: Sha256Hex;
    readonly faststart: true;
    readonly width: number;
    readonly height: number;
  }[];
  readonly thumbnails: readonly {
    readonly timeSec: number;
    readonly path: string;
    readonly sha256: Sha256Hex;
  }[];
  readonly placeholderDataUrl: string;
  readonly storyboard?: {
    readonly path: string;
    readonly sha256: Sha256Hex;
    readonly cols: number;
    readonly rows: number;
    readonly intervalSec: number;
    readonly vttPath: string;
  };
}

export interface MediaPipeline {
  probe(path: string): Promise<MediaProbe>;
  plan(
    probe: MediaProbe,
    opts?: { readonly maxHeight?: number; readonly codec?: RenditionSpec['codec'] },
  ): LadderPlan;
  /** Runs the plan. Every output MP4 is verified faststart before it is returned. */
  transcode(
    path: string,
    plan: LadderPlan,
    onProgress: (p: TranscodeProgress) => void,
    opts?: { readonly workDir?: string },
  ): Promise<TranscodeOutput>;
  /** Writes a finished rendition into Hyperblobs and returns the reference + verified sha256. */
  publish(
    output: TranscodeOutput['renditions'][number],
    sink: BlobSink,
  ): Promise<Pick<Rendition, 'hyper' | 'hyperUrl' | 'sha256' | 'size'>>;
}

/** Where rendition bytes go. Implemented by the seeder over Hyperblobs. */
export interface BlobSink {
  put(
    chunks: AsyncIterable<Uint8Array>,
    opts?: { readonly blockSize?: number },
  ): Promise<HyperblobRef>;
}
