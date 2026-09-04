import type { HyperblobRef } from '../contracts/manifest.js';
import type { FsAdapter, ProcessRunner } from '../contracts/media.js';
import type { Sha256Hex } from '../contracts/primitives.js';

/**
 * Incremental SHA-256, injected. `node:crypto` in the Node adapter, `bare-crypto` (or
 * sodium) on Bare. This module never implements hashing (SECURITY.md "No model writes crypto").
 */
export interface Sha256Hasher {
  update(chunk: Uint8Array): void;
  /** Lower-case hex of the 32-byte digest. */
  digest(): Sha256Hex;
}

export type Sha256Factory = () => Sha256Hasher;

/** Where the binaries live. Injected config so a shipped or a system ffmpeg both work. */
export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface MediaPipelineDeps {
  readonly runner: ProcessRunner;
  readonly fs: FsAdapter;
  readonly sha256: Sha256Factory;
  readonly binaries: FfmpegPaths;
  /** Chunk size for streaming reads (hash + Hyperblobs). Default 64 KiB = one Hyperblobs block. */
  readonly chunkSize?: number;
  /** Formats the imeta `url` for a Hyperblobs reference. Default: `hyper://<core>/<blockOffset>-<blockLength>`. */
  readonly hyperUrl?: (ref: HyperblobRef) => string;
  /** x264/x265 preset. Default `medium`; tests use `ultrafast`. */
  readonly preset?: string;
  /** Temp directory prefix passed to `fs.mkdtemp`. */
  readonly workDirPrefix?: string;
}
