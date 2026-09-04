import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';

import type { FfmpegPaths } from '../types.js';

/**
 * Locates `ffmpeg` + `ffprobe` for Node hosts and tests. Order:
 *   1. `NUTFLIX_FFMPEG` — path to the ffmpeg binary, OR a directory containing `ffmpeg`
 *      (a `bin/` subdirectory is also tried)
 *   2. `/tmp/scratch/ffmpeg/` — the dev-box scratch location (FFMPEG-PIN.md): `bin/ffmpeg`
 *      or `<extracted-release>/bin/ffmpeg`
 *   3. `PATH`
 * `ffprobe` is always taken from the same directory as `ffmpeg`.
 *
 * This is a LOOKUP for hosts that own their binary; the pipeline itself takes the paths as
 * injected config (`MediaPipelineDeps.binaries`), so a shipped binary in a desktop bundle
 * is just a different value.
 */

const SCRATCH = '/tmp/scratch/ffmpeg';

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pairFrom(ffmpeg: string): FfmpegPaths | undefined {
  if (!executable(ffmpeg)) return undefined;
  const ffprobe = join(dirname(ffmpeg), 'ffprobe');
  return executable(ffprobe) ? { ffmpeg, ffprobe } : undefined;
}

function fromDir(dir: string): FfmpegPaths | undefined {
  return pairFrom(join(dir, 'ffmpeg')) ?? pairFrom(join(dir, 'bin', 'ffmpeg'));
}

function fromEnv(value: string): FfmpegPaths | undefined {
  try {
    if (statSync(value).isDirectory()) return fromDir(value);
  } catch {
    return undefined;
  }
  return pairFrom(value);
}

function fromScratch(): FfmpegPaths | undefined {
  const direct = fromDir(SCRATCH);
  if (direct) return direct;
  let entries: string[];
  try {
    entries = readdirSync(SCRATCH);
  } catch {
    return undefined;
  }
  for (const e of entries.sort().reverse()) {
    const found = fromDir(join(SCRATCH, e));
    if (found) return found;
  }
  return undefined;
}

function fromPath(): FfmpegPaths | undefined {
  const path = process.env['PATH'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const found = pairFrom(join(dir, 'ffmpeg'));
    if (found) return found;
  }
  return undefined;
}

export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): FfmpegPaths | undefined {
  const explicit = env['NUTFLIX_FFMPEG'];
  if (explicit !== undefined && explicit !== '') return fromEnv(explicit);
  return fromScratch() ?? fromPath();
}
