import { describe, expect, it } from 'vitest';

import { base64Encode, dataUrl } from '../base64.js';
import { ProgressTracker, parseProgressLine } from '../progress.js';
import { storyboardVtt, vttTimestamp } from '../storyboard.js';

describe('parseProgressLine', () => {
  it('parses the n8.1.2 key=value vocabulary', () => {
    expect(parseProgressLine('out_time_us=3000000')).toEqual({ outTimeSec: 3 });
    expect(parseProgressLine('out_time_ms=1500000')).toEqual({ outTimeSec: 1.5 });
    expect(parseProgressLine('out_time=00:01:02.500000')).toEqual({ outTimeSec: 62.5 });
    expect(parseProgressLine('fps=27.50')).toEqual({ fps: 27.5 });
    expect(parseProgressLine('progress=continue')).toEqual({ end: false });
    expect(parseProgressLine('progress=end')).toEqual({ end: true });
  });
  it('ignores unrelated and malformed lines', () => {
    expect(parseProgressLine('frame=90')).toBeUndefined();
    expect(parseProgressLine('speed=  56x')).toBeUndefined();
    expect(parseProgressLine('[libx264 @ 0x1] kb/s:182')).toBeUndefined();
    expect(parseProgressLine('out_time_us=N/A')).toBeUndefined();
    expect(parseProgressLine('out_time=garbage')).toBeUndefined();
    expect(parseProgressLine('=x')).toBeUndefined();
    expect(parseProgressLine('')).toBeUndefined();
  });
});

describe('ProgressTracker', () => {
  it('emits monotone percentages with fps, clamps at 100 and finishes on progress=end', () => {
    const seen: [number, number | undefined][] = [];
    const t = new ProgressTracker(10, (p, f) => seen.push([p, f]));
    t.line('fps=30.00');
    t.line('out_time_us=2500000');
    t.line('out_time_us=2400000'); // never goes backwards
    t.line('fps=0.00'); // zero fps is not a reading
    t.line('out_time_us=5000000');
    t.line('out_time_us=50000000'); // beyond duration → 100
    t.line('progress=end');
    expect(seen).toEqual([
      [25, 30],
      [50, 30],
      [100, 30],
    ]);
  });
  it('reaches 100 on end even when time never reported', () => {
    const seen: number[] = [];
    const t = new ProgressTracker(10, (p) => seen.push(p));
    t.line('progress=end');
    expect(seen).toEqual([100]);
  });
  it('handles unknown duration without dividing by zero', () => {
    const seen: number[] = [];
    const t = new ProgressTracker(0, (p) => seen.push(p));
    t.line('out_time_us=1000');
    t.line('progress=end');
    expect(seen).toEqual([100]);
  });
});

describe('storyboardVtt', () => {
  it('writes one cue per tile with xywh fragments, clipping the last cue to the duration', () => {
    const vtt = storyboardVtt({
      durationSec: 4.5,
      intervalSec: 2,
      cols: 2,
      rows: 2,
      spriteWidth: 320,
      spriteHeight: 180,
      spriteUrl: 'storyboard.jpg',
    });
    expect(vtt).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:02.000',
        'storyboard.jpg#xywh=0,0,160,90',
        '',
        '00:00:02.000 --> 00:00:04.000',
        'storyboard.jpg#xywh=160,0,160,90',
        '',
        '00:00:04.000 --> 00:00:04.500',
        'storyboard.jpg#xywh=0,90,160,90',
        '',
      ].join('\n'),
    );
  });
  it('vttTimestamp formats hours and rounds milliseconds', () => {
    expect(vttTimestamp(0)).toBe('00:00:00.000');
    expect(vttTimestamp(3661.0005)).toBe('01:01:01.001');
    expect(vttTimestamp(59.9999)).toBe('00:00:59.999');
  });
});

describe('base64', () => {
  it('matches Buffer for all padding cases', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', '\u00ff\u0000\u0080']) {
      const bytes = new TextEncoder().encode(s);
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
    const rnd = new Uint8Array(1001).map((_, i) => (i * 7919) % 256);
    expect(base64Encode(rnd)).toBe(Buffer.from(rnd).toString('base64'));
  });
  it('dataUrl prefixes the mime', () => {
    expect(dataUrl('image/jpeg', new Uint8Array([255, 216]))).toBe('data:image/jpeg;base64,/9g=');
  });
});
