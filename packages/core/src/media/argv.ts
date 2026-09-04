import type { LadderPlan, MediaProbe, RenditionSpec } from '../contracts/media.js';
import { displayDimensions } from './ffprobe.js';
import { GOP_SECONDS, fitToHeight } from './ladder.js';

/**
 * ffmpeg argv builders. Every function returns an ARRAY handed to `ProcessRunner.run` —
 * there is no shell anywhere in this pipeline, so a filename like `; rm -rf / #.mp4` is
 * just a filename. Filter graphs are built from numbers we computed, never from user input.
 *
 * Common prefix: `-hide_banner -nostdin -y -loglevel error` keeps stderr to real errors plus
 * (for renditions) the `-progress pipe:2` key=value lines the progress parser reads.
 */

const COMMON: readonly string[] = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];

/** Placeholder width in px; ~500 bytes of JPEG, small enough to inline in a Nostr event. */
export const PLACEHOLDER_WIDTH = 32 as const;
export const THUMBNAIL_WIDTH = 640 as const;

export interface RenditionArgvOpts {
  readonly preset?: string;
  readonly fps: number;
}

/** GOP length in frames for keyframe-aligned switching: `fps × GOP_SECONDS`, min 1. */
export function gopFrames(fps: number): number {
  return Math.max(1, Math.round((fps > 0 ? fps : 30) * GOP_SECONDS));
}

/** The exact output dimensions a rendition will have (even, aspect-preserving). */
export function renditionDimensions(
  source: MediaProbe,
  spec: RenditionSpec,
): { readonly width: number; readonly height: number } {
  if (!source.video) throw new Error('renditionDimensions: source has no video');
  return fitToHeight(displayDimensions(source.video), spec.height);
}

function videoCodecArgs(spec: RenditionSpec, g: number, preset: string): readonly string[] {
  const vb = `${spec.videoBitrateKbps}k`;
  const maxrate = `${Math.round(spec.videoBitrateKbps * 1.5)}k`;
  const bufsize = `${spec.videoBitrateKbps * 2}k`;
  switch (spec.codec) {
    case 'h264':
      return [
        '-c:v',
        'libx264',
        '-preset',
        preset,
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        vb,
        '-maxrate',
        maxrate,
        '-bufsize',
        bufsize,
        '-g',
        String(g),
        '-keyint_min',
        String(g),
        '-sc_threshold',
        '0',
      ];
    case 'vp9':
      return [
        '-c:v',
        'libvpx-vp9',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        vb,
        '-maxrate',
        maxrate,
        '-bufsize',
        bufsize,
        '-row-mt',
        '1',
        '-g',
        String(g),
        '-keyint_min',
        String(g),
      ];
    case 'av1':
      return [
        '-c:v',
        'libsvtav1',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        vb,
        '-maxrate',
        maxrate,
        '-bufsize',
        bufsize,
        '-g',
        String(g),
      ];
  }
}

function audioCodecArgs(spec: RenditionSpec): readonly string[] {
  const ab = `${spec.audioBitrateKbps}k`;
  return spec.container === 'webm'
    ? ['-c:a', 'libopus', '-b:a', ab, '-ac', '2', '-ar', '48000']
    : ['-c:a', 'aac', '-b:a', ab, '-ac', '2', '-ar', '48000'];
}

/**
 * One rendition. `-force_key_frames expr:gte(t,n_forced*2)` pins a keyframe every
 * GOP_SECONDS regardless of encoder heuristics, so every rendition's keyframes line up.
 */
export function renditionArgv(
  input: string,
  output: string,
  source: MediaProbe,
  spec: RenditionSpec,
  opts: RenditionArgvOpts,
): readonly string[] {
  const dims = renditionDimensions(source, spec);
  const g = gopFrames(opts.fps);
  const preset = opts.preset ?? 'medium';
  const container: readonly string[] =
    spec.container === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'webm'];
  return [
    ...COMMON,
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=${dims.width}:${dims.height}`,
    ...videoCodecArgs(spec, g, preset),
    '-force_key_frames',
    `expr:gte(t,n_forced*${GOP_SECONDS})`,
    ...audioCodecArgs(spec),
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    ...container,
    '-progress',
    'pipe:2',
    '-nostats',
    output,
  ];
}

/** Single JPEG frame at `timeSec`, input-side seek (fast), scaled to THUMBNAIL_WIDTH. */
export function thumbnailArgv(
  input: string,
  output: string,
  timeSec: number,
  width: number = THUMBNAIL_WIDTH,
): readonly string[] {
  return [
    ...COMMON,
    '-ss',
    formatSeconds(timeSec),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${width},iw)':-2`,
    '-q:v',
    '2',
    '-f',
    'image2',
    output,
  ];
}

/** Tiny low-quality JPEG for the blur-up placeholder (inlined as a data: URL). */
export function placeholderArgv(input: string, output: string, timeSec: number): readonly string[] {
  return [
    ...COMMON,
    '-ss',
    formatSeconds(timeSec),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale=${PLACEHOLDER_WIDTH}:-2`,
    '-q:v',
    '12',
    '-f',
    'image2',
    output,
  ];
}

/** Storyboard sprite: one frame every `intervalSec`, tiled `cols × rows`, single JPEG. */
export function storyboardArgv(
  input: string,
  output: string,
  sb: NonNullable<LadderPlan['storyboard']>,
): readonly string[] {
  return [
    ...COMMON,
    '-i',
    input,
    '-vf',
    `fps=1/${sb.intervalSec},scale=${sb.tileWidth}:-2,tile=${sb.cols}x${sb.rows}`,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    '-f',
    'image2',
    output,
  ];
}

/** Seconds as ffmpeg accepts them; fixed 3 decimals, never exponent notation. */
export function formatSeconds(t: number): string {
  return (Number.isFinite(t) && t > 0 ? t : 0).toFixed(3);
}
