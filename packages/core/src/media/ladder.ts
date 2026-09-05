import type { LadderPlan, MediaProbe, RenditionSpec } from '../contracts/media.js';
import { MediaError } from './errors.js';
import { displayDimensions } from './ffprobe.js';

/**
 * Rendition ladder (build-plan §6.4): 1080p / 720p / 360p, never upscaled.
 *
 * Bitrates are the usual H.264 streaming targets; VP9/AV1 tiers scale them down since those
 * codecs are more efficient at the same quality.
 */

interface Tier {
  readonly label: string;
  readonly height: number;
  readonly videoBitrateKbps: number;
  readonly audioBitrateKbps: number;
}

export const LADDER_TIERS: readonly Tier[] = [
  { label: '1080p', height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 128 },
  { label: '720p', height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
  { label: '360p', height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
];

/** Keyframe interval in seconds — identical for every rendition so switches align. */
export const GOP_SECONDS = 2 as const;

/** Thumbnail candidate positions as fractions of the duration. */
export const THUMBNAIL_FRACTIONS: readonly number[] = [0.1, 0.3, 0.5, 0.7];

export const STORYBOARD_COLS = 10 as const;
export const STORYBOARD_TILE_WIDTH = 160 as const;
/** Storyboards aim for at most this many tiles; interval is picked from the list below. */
export const STORYBOARD_MAX_TILES = 100 as const;
const STORYBOARD_INTERVALS: readonly number[] = [1, 2, 5, 10, 20, 30, 60, 120, 300];

const codecContainer = (codec: RenditionSpec['codec']): RenditionSpec['container'] =>
  codec === 'vp9' ? 'webm' : 'mp4';

const bitrateScale = (codec: RenditionSpec['codec']): number =>
  codec === 'h264' ? 1 : codec === 'vp9' ? 0.7 : 0.55;

/** Even output size preserving aspect for a target height. */
export function fitToHeight(
  src: { readonly width: number; readonly height: number },
  height: number,
): { readonly width: number; readonly height: number } {
  const h = height - (height % 2);
  const w = Math.round((src.width * h) / src.height);
  return { width: w + (w % 2), height: h };
}

/** Thumbnail candidate timestamps for a duration, deduplicated and inside the clip. */
export function thumbnailTimes(durationSec: number): readonly number[] {
  if (!(durationSec > 0)) return [0];
  const times = THUMBNAIL_FRACTIONS.map((f) => Math.floor(durationSec * f * 1000) / 1000);
  const uniq = [...new Set(times)].filter((t) => t >= 0 && t < durationSec);
  return uniq.length > 0 ? uniq : [0];
}

export function storyboardGeometry(
  durationSec: number,
): NonNullable<LadderPlan['storyboard']> | undefined {
  if (!(durationSec > 0)) return undefined;
  const intervalSec =
    STORYBOARD_INTERVALS.find((i) => Math.ceil(durationSec / i) <= STORYBOARD_MAX_TILES) ??
    STORYBOARD_INTERVALS[STORYBOARD_INTERVALS.length - 1] ??
    300;
  const tiles = Math.max(1, Math.ceil(durationSec / intervalSec));
  const cols = Math.min(STORYBOARD_COLS, tiles);
  const rows = Math.ceil(tiles / cols);
  return { intervalSec, cols, rows, tileWidth: STORYBOARD_TILE_WIDTH };
}

export function planLadder(
  probe: MediaProbe,
  opts: { readonly maxHeight?: number; readonly codec?: RenditionSpec['codec'] } = {},
): LadderPlan {
  if (!probe.video) throw new MediaError('no-video-stream', 'input has no video stream');
  const codec = opts.codec ?? 'h264';
  const container = codecContainer(codec);
  const src = displayDimensions(probe.video);
  const cap = Math.min(src.height, opts.maxHeight ?? Infinity);
  const scale = bitrateScale(codec);

  let renditions: RenditionSpec[] = LADDER_TIERS.filter((t) => t.height <= cap).map((t) => ({
    label: t.label,
    height: t.height,
    videoBitrateKbps: Math.round(t.videoBitrateKbps * scale),
    audioBitrateKbps: t.audioBitrateKbps,
    codec,
    container,
  }));

  if (renditions.length === 0) {
    // Source is shorter than the lowest tier: one rendition at native (even) height.
    const h = Math.max(2, cap - (cap % 2));
    const lowest = LADDER_TIERS[LADDER_TIERS.length - 1];
    const vk = lowest ? Math.round((lowest.videoBitrateKbps * h) / lowest.height) : 400;
    renditions = [
      {
        label: `${h}p`,
        height: h,
        videoBitrateKbps: Math.max(200, Math.round(vk * scale)),
        audioBitrateKbps: lowest?.audioBitrateKbps ?? 96,
        codec,
        container,
      },
    ];
  }

  const storyboard = storyboardGeometry(probe.durationSec);
  return {
    source: probe,
    renditions,
    thumbnailTimes: thumbnailTimes(probe.durationSec),
    ...(storyboard ? { storyboard } : {}),
  };
}
