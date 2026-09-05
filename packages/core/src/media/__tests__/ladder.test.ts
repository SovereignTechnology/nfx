import { describe, expect, it } from 'vitest';

import type { MediaProbe } from '../../contracts/media.js';
import { MediaError } from '../errors.js';
import {
  LADDER_TIERS,
  STORYBOARD_MAX_TILES,
  fitToHeight,
  planLadder,
  storyboardGeometry,
  thumbnailTimes,
} from '../ladder.js';

const src = (
  width: number,
  height: number,
  extra: Partial<NonNullable<MediaProbe['video']>> = {},
  durationSec = 120,
): MediaProbe => ({
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec,
  video: { codec: 'h264', width, height, fps: 30, ...extra },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
});

describe('planLadder', () => {
  it('1080p source → 1080p/720p/360p h264 mp4', () => {
    const plan = planLadder(src(1920, 1080));
    expect(plan.renditions.map((r) => r.label)).toEqual(['1080p', '720p', '360p']);
    expect(plan.renditions.every((r) => r.codec === 'h264' && r.container === 'mp4')).toBe(true);
    expect(plan.renditions[0]).toEqual({
      label: '1080p',
      height: 1080,
      videoBitrateKbps: 5000,
      audioBitrateKbps: 128,
      codec: 'h264',
      container: 'mp4',
    });
    expect(plan.source).toBe(plan.source);
  });

  it('never upscales: 720p source gets 720p/360p, 480p gets 360p only', () => {
    expect(planLadder(src(1280, 720)).renditions.map((r) => r.label)).toEqual(['720p', '360p']);
    expect(planLadder(src(854, 480)).renditions.map((r) => r.label)).toEqual(['360p']);
  });

  it('4K source is capped at 1080p (no 4K tier)', () => {
    expect(planLadder(src(3840, 2160)).renditions.map((r) => r.label)).toEqual([
      '1080p',
      '720p',
      '360p',
    ]);
  });

  it('a source below 360p yields one native-height rendition', () => {
    const plan = planLadder(src(320, 240));
    expect(plan.renditions).toHaveLength(1);
    expect(plan.renditions[0]?.label).toBe('240p');
    expect(plan.renditions[0]?.height).toBe(240);
    expect(plan.renditions[0]?.videoBitrateKbps).toBeGreaterThanOrEqual(200);
    // odd native heights are made even
    expect(planLadder(src(200, 135)).renditions[0]?.height).toBe(134);
  });

  it('uses display (rotated) height for portrait phone video', () => {
    // 1920x1080 stored, rotation 90 → displays as 1080x1920 → all three tiers fit by height
    const plan = planLadder(src(1920, 1080, { rotation: 90 }));
    expect(plan.renditions.map((r) => r.label)).toEqual(['1080p', '720p', '360p']);
  });

  it('honours maxHeight and codec options', () => {
    const plan = planLadder(src(1920, 1080), { maxHeight: 720, codec: 'vp9' });
    expect(plan.renditions.map((r) => r.label)).toEqual(['720p', '360p']);
    expect(plan.renditions.every((r) => r.codec === 'vp9' && r.container === 'webm')).toBe(true);
    expect(plan.renditions[0]?.videoBitrateKbps).toBeLessThan(2500);
    expect(planLadder(src(1920, 1080), { codec: 'av1' }).renditions[0]?.container).toBe('mp4');
  });

  it('throws no-video-stream for audio-only input', () => {
    const audioOnly: MediaProbe = {
      container: 'mp3',
      durationSec: 10,
      audio: { codec: 'mp3', channels: 2, sampleRate: 44100 },
    };
    expect(() => planLadder(audioOnly)).toThrow(MediaError);
  });

  it('adds thumbnail times and storyboard geometry', () => {
    const plan = planLadder(src(1920, 1080, {}, 100));
    expect(plan.thumbnailTimes).toEqual([10, 30, 50, 70]);
    expect(plan.storyboard).toEqual({ intervalSec: 1, cols: 10, rows: 10, tileWidth: 160 });
  });

  it('tiers are ordered tallest first and are the documented three', () => {
    expect(LADDER_TIERS.map((t) => t.height)).toEqual([1080, 720, 360]);
  });
});

describe('fitToHeight', () => {
  it('keeps aspect and even dimensions', () => {
    expect(fitToHeight({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitToHeight({ width: 1920, height: 1080 }, 360)).toEqual({ width: 640, height: 360 });
    expect(fitToHeight({ width: 1080, height: 1920 }, 720)).toEqual({ width: 406, height: 720 });
    expect(fitToHeight({ width: 4, height: 3 }, 361)).toEqual({ width: 480, height: 360 });
  });
});

describe('thumbnailTimes', () => {
  it('spreads through the clip, never past the end, and dedups', () => {
    expect(thumbnailTimes(10)).toEqual([1, 3, 5, 7]);
    expect(thumbnailTimes(0)).toEqual([0]);
    expect(thumbnailTimes(Number.NaN)).toEqual([0]);
    expect(thumbnailTimes(0.001)).toEqual([0]);
    for (const t of thumbnailTimes(0.5)) expect(t).toBeLessThan(0.5);
  });
});

describe('storyboardGeometry', () => {
  it('picks the smallest interval that keeps tiles ≤ max', () => {
    expect(storyboardGeometry(30)).toEqual({ intervalSec: 1, cols: 10, rows: 3, tileWidth: 160 });
    expect(storyboardGeometry(101)?.intervalSec).toBe(2);
    expect(storyboardGeometry(3600)?.intervalSec).toBe(60);
    const long = storyboardGeometry(6 * 3600);
    expect(long && Math.ceil((6 * 3600) / long.intervalSec)).toBeLessThanOrEqual(
      STORYBOARD_MAX_TILES,
    );
    expect(storyboardGeometry(3)).toEqual({ intervalSec: 1, cols: 3, rows: 1, tileWidth: 160 });
    expect(storyboardGeometry(0)).toBeUndefined();
  });
});
