/**
 * WebVTT for a storyboard sprite (scrub preview): one cue per tile, `#xywh=` fragment per
 * the media-fragments convention players understand (video.js, hls.js, Shaka).
 */

export interface StoryboardVttInput {
  readonly durationSec: number;
  readonly intervalSec: number;
  readonly cols: number;
  readonly rows: number;
  /** Full sprite dimensions as probed from the emitted JPEG. */
  readonly spriteWidth: number;
  readonly spriteHeight: number;
  /** URL/filename the cues point at. Later replaced by the Blossom URL (T16). */
  readonly spriteUrl: string;
}

export function vttTimestamp(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const whole = Math.floor(rest);
  const ms = Math.round((rest - whole) * 1000);
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(whole, 2)}.${pad(ms === 1000 ? 999 : ms, 3)}`;
}

export function storyboardVtt(input: StoryboardVttInput): string {
  const { durationSec, intervalSec, cols, rows, spriteWidth, spriteHeight, spriteUrl } = input;
  const tileW = Math.floor(spriteWidth / cols);
  const tileH = Math.floor(spriteHeight / rows);
  const lines = ['WEBVTT', ''];
  const tiles = cols * rows;
  for (let i = 0; i < tiles; i++) {
    const start = i * intervalSec;
    if (start >= durationSec) break;
    const end = Math.min(durationSec, start + intervalSec);
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    lines.push(
      `${vttTimestamp(start)} --> ${vttTimestamp(end)}`,
      `${spriteUrl}#xywh=${x},${y},${tileW},${tileH}`,
      '',
    );
  }
  return lines.join('\n');
}
