/**
 * Node adapters for `@sovit/core/media` — the ONLY files under `media/` that import `node:`.
 * Intended export path: `@sovit/core/media/node` (orchestrator wires the subpath at merge).
 */
import type { MediaPipeline } from '../../contracts/media.js';
import { createMediaPipeline } from '../pipeline.js';
import type { FfmpegPaths, MediaPipelineDeps } from '../types.js';
import { findFfmpeg } from './find-ffmpeg.js';
import { nodeFsAdapter } from './fs-adapter.js';
import { nodeProcessRunner } from './process-runner.js';
import { nodeSha256 } from './sha256.js';

export { findFfmpeg } from './find-ffmpeg.js';
export { nodeFsAdapter } from './fs-adapter.js';
export { LineSplitter, concatChunks, nodeProcessRunner } from './process-runner.js';
export { nodeSha256 } from './sha256.js';

export type NodeMediaPipelineOptions = Omit<
  MediaPipelineDeps,
  'runner' | 'fs' | 'sha256' | 'binaries'
> & {
  /** Explicit binaries; default = `findFfmpeg()`, which throws if nothing is found. */
  readonly binaries?: FfmpegPaths;
  readonly tmpDir?: string;
};

/** Convenience: a fully wired pipeline for Node hosts. */
export function createNodeMediaPipeline(opts: NodeMediaPipelineOptions = {}): MediaPipeline {
  const binaries = opts.binaries ?? findFfmpeg();
  if (!binaries) {
    throw new Error(
      'ffmpeg/ffprobe not found: set NUTFLIX_FFMPEG or install per packages/core/src/media/FFMPEG-PIN.md',
    );
  }
  const { tmpDir, binaries: _b, ...rest } = opts;
  return createMediaPipeline({
    ...rest,
    runner: nodeProcessRunner(),
    fs: nodeFsAdapter(tmpDir !== undefined ? { tmpDir } : {}),
    sha256: nodeSha256,
    binaries,
  });
}
