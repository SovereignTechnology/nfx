import type { MediaProbe } from '../contracts/media.js';
import { MediaError } from './errors.js';

/**
 * `ffprobe -print_format json -show_format -show_streams` → `MediaProbe`.
 *
 * Field names verified against ffprobe n8.1.2 output (see FFMPEG-PIN.md). Everything that
 * ffprobe prints as a string ("duration": "3.000000") is parsed here; nothing is trusted to
 * be a number just because it looks like one.
 */

/** Argv for probing `path`. `path` is a single argv element — never shell-interpolated. */
export function ffprobeArgv(path: string): readonly string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // `--` is not understood by ffprobe; a leading `-` in a filename is disambiguated by
    // the caller passing an absolute path, which the pipeline always does.
    path,
  ];
}

interface RawStream {
  readonly codec_type?: unknown;
  readonly codec_name?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly r_frame_rate?: unknown;
  readonly avg_frame_rate?: unknown;
  readonly pix_fmt?: unknown;
  readonly channels?: unknown;
  readonly sample_rate?: unknown;
  readonly bit_rate?: unknown;
  readonly disposition?: { readonly attached_pic?: unknown };
  readonly side_data_list?: readonly { readonly rotation?: unknown }[];
  readonly tags?: { readonly rotate?: unknown };
}

interface RawProbe {
  readonly streams?: readonly RawStream[];
  readonly format?: {
    readonly format_name?: unknown;
    readonly duration?: unknown;
    readonly bit_rate?: unknown;
  };
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isObjectArray<T extends object>(v: readonly T[] | undefined): v is readonly T[] {
  return Array.isArray(v) && v.every((s: unknown) => typeof s === 'object' && s !== null);
}

/** "30000/1001" → 29.97; "0/0" → undefined. */
export function parseRational(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return num(v);
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s.trim());
  if (!m) return num(s);
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return a / b;
}

/** Normalises any rotation value to one of 0/90/180/270. */
export function normaliseRotation(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  const r = ((Math.round(n) % 360) + 360) % 360;
  return r;
}

export function parseFfprobeJson(text: string): MediaProbe {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new MediaError('probe-parse', 'ffprobe output is not JSON', { cause: e });
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MediaError('probe-parse', 'ffprobe output is not an object');
  }
  const p = raw as RawProbe;
  const streams: readonly RawStream[] = isObjectArray(p.streams) ? p.streams : [];
  const format: NonNullable<RawProbe['format']> = typeof p.format === 'object' ? p.format : {};

  const container = str(format.format_name);
  if (!container) throw new MediaError('probe-parse', 'ffprobe: missing format.format_name');

  const video = streams.find(
    (s) => s.codec_type === 'video' && num(s.disposition?.attached_pic) !== 1,
  );
  const audio = streams.find((s) => s.codec_type === 'audio');

  let durationSec = num(format.duration);
  if (durationSec === undefined) {
    // Some containers (raw streams) carry duration only on the stream.
    const sd = num((video as { duration?: unknown } | undefined)?.duration);
    durationSec = sd ?? 0;
  }

  const bitrate = num(format.bit_rate);

  let videoInfo: MediaProbe['video'];
  if (video) {
    const codec = str(video.codec_name);
    const width = num(video.width);
    const height = num(video.height);
    if (!codec || width === undefined || height === undefined) {
      throw new MediaError('probe-parse', 'ffprobe: video stream lacks codec/width/height');
    }
    const fps = parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate) ?? 0;
    const rotation =
      normaliseRotation(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation) ??
      normaliseRotation(video.tags?.rotate);
    const pixelFormat = str(video.pix_fmt);
    videoInfo = {
      codec,
      width,
      height,
      fps,
      ...(rotation !== undefined && rotation !== 0 ? { rotation } : {}),
      ...(pixelFormat !== undefined ? { pixelFormat } : {}),
    };
  }

  let audioInfo: MediaProbe['audio'];
  if (audio) {
    const codec = str(audio.codec_name) ?? 'unknown';
    audioInfo = {
      codec,
      channels: num(audio.channels) ?? 0,
      sampleRate: num(audio.sample_rate) ?? 0,
    };
  }

  return {
    container,
    durationSec,
    ...(bitrate !== undefined ? { bitrateKbps: Math.round(bitrate / 1000) } : {}),
    ...(videoInfo ? { video: videoInfo } : {}),
    ...(audioInfo ? { audio: audioInfo } : {}),
  };
}

/** Display dimensions after applying the container rotation (90/270 swap width/height). */
export function displayDimensions(video: NonNullable<MediaProbe['video']>): {
  readonly width: number;
  readonly height: number;
} {
  const rot = video.rotation ?? 0;
  return rot === 90 || rot === 270
    ? { width: video.height, height: video.width }
    : { width: video.width, height: video.height };
}

export function isMp4Container(container: string): boolean {
  return container.split(',').some((c) => c === 'mp4' || c === 'mov' || c === 'm4a');
}
