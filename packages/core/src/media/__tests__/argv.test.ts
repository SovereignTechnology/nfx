import { describe, expect, it } from 'vitest';

import type { MediaProbe, RenditionSpec } from '../../contracts/media.js';
import {
  formatSeconds,
  gopFrames,
  placeholderArgv,
  renditionArgv,
  renditionDimensions,
  storyboardArgv,
  thumbnailArgv,
} from '../argv.js';

const source: MediaProbe = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 60,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 29.97 },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000 },
};
const spec720: RenditionSpec = {
  label: '720p',
  height: 720,
  videoBitrateKbps: 2500,
  audioBitrateKbps: 128,
  codec: 'h264',
  container: 'mp4',
};

/** `-flag value` lookup helper. */
const opt = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

describe('renditionArgv (h264/mp4)', () => {
  const argv = renditionArgv('/in/a.mp4', '/out/720p.mp4', source, spec720, {
    fps: 29.97,
    preset: 'medium',
  });

  it('is an argv array with input and output as whole elements', () => {
    expect(argv[0]).toBe('-hide_banner');
    expect(opt(argv, '-i')).toBe('/in/a.mp4');
    expect(argv.at(-1)).toBe('/out/720p.mp4');
    expect(argv).toContain('-nostdin');
    expect(argv).toContain('-y');
  });

  it('requests faststart MP4 with libx264 + aac', () => {
    expect(argv.join(' ')).toContain('-movflags +faststart');
    expect(opt(argv, '-f')).toBe('mp4');
    expect(opt(argv, '-c:v')).toBe('libx264');
    expect(opt(argv, '-c:a')).toBe('aac');
    expect(opt(argv, '-preset')).toBe('medium');
    expect(opt(argv, '-pix_fmt')).toBe('yuv420p');
    expect(opt(argv, '-b:v')).toBe('2500k');
    expect(opt(argv, '-maxrate')).toBe('3750k');
    expect(opt(argv, '-bufsize')).toBe('5000k');
    expect(opt(argv, '-b:a')).toBe('128k');
  });

  it('keyframe-aligns the GOP: 2 s at the source fps, scene-cut off, forced keyframes', () => {
    expect(opt(argv, '-g')).toBe('60');
    expect(opt(argv, '-keyint_min')).toBe('60');
    expect(opt(argv, '-sc_threshold')).toBe('0');
    expect(opt(argv, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
  });

  it('scales to exact even dimensions computed from the source aspect', () => {
    expect(opt(argv, '-vf')).toBe('scale=1280:720');
    expect(renditionDimensions(source, spec720)).toEqual({ width: 1280, height: 720 });
  });

  it('maps optional audio so silent sources still encode', () => {
    expect(argv.join(' ')).toContain('-map 0:v:0 -map 0:a:0?');
  });

  it('strips subtitles, data streams, metadata and chapters', () => {
    expect(argv).toContain('-sn');
    expect(argv).toContain('-dn');
    expect(opt(argv, '-map_metadata')).toBe('-1');
    expect(opt(argv, '-map_chapters')).toBe('-1');
  });

  it('emits machine-readable progress on stderr', () => {
    expect(opt(argv, '-progress')).toBe('pipe:2');
    expect(argv).toContain('-nostats');
  });

  it('uses rotated display dimensions for portrait sources', () => {
    const portrait: MediaProbe = { ...source, video: { ...source.video!, rotation: 90 } };
    const a = renditionArgv('/in', '/out', portrait, spec720, { fps: 30 });
    expect(opt(a, '-vf')).toBe('scale=406:720');
  });

  it('vp9 → webm/libopus, av1 → mp4/libsvtav1, no movflags for webm', () => {
    const vp9 = renditionArgv(
      '/i',
      '/o.webm',
      source,
      { ...spec720, codec: 'vp9', container: 'webm' },
      { fps: 30 },
    );
    expect(opt(vp9, '-c:v')).toBe('libvpx-vp9');
    expect(opt(vp9, '-c:a')).toBe('libopus');
    expect(opt(vp9, '-f')).toBe('webm');
    expect(vp9).not.toContain('-movflags');
    const av1 = renditionArgv('/i', '/o.mp4', source, { ...spec720, codec: 'av1' }, { fps: 30 });
    expect(opt(av1, '-c:v')).toBe('libsvtav1');
    expect(av1.join(' ')).toContain('-movflags +faststart');
  });

  it('falls back to 30 fps GOP when fps is unknown', () => {
    expect(gopFrames(0)).toBe(60);
    expect(gopFrames(24)).toBe(48);
    expect(gopFrames(0.2)).toBe(1);
  });
});

describe('injection safety', () => {
  const hostile = '/tmp/up loads/$(touch /tmp/pwned); rm -rf ~ #`id`\'"|&&.mp4';
  const hostileOut = '/tmp/out dir/$(reboot)/720p.mp4';

  it('passes hostile filenames through verbatim as single elements in every builder', () => {
    const builders: (readonly string[])[] = [
      renditionArgv(hostile, hostileOut, source, spec720, { fps: 30 }),
      thumbnailArgv(hostile, hostileOut, 1),
      placeholderArgv(hostile, hostileOut, 1),
      storyboardArgv(hostile, hostileOut, { intervalSec: 1, cols: 10, rows: 2, tileWidth: 160 }),
    ];
    for (const argv of builders) {
      expect(opt(argv, '-i')).toBe(hostile);
      expect(argv.at(-1)).toBe(hostileOut);
      // Nothing was split on spaces or quoted; exactly two elements mention the hostile paths.
      expect(argv.filter((a) => a.includes('$(') || a.includes('rm -rf'))).toHaveLength(2);
      // No shell, ever.
      expect(argv.some((a) => a === '-c' || a === '/bin/sh' || a === 'sh')).toBe(false);
    }
  });

  it('filter graphs are built from computed numbers only', () => {
    const argv = renditionArgv(hostile, hostileOut, source, spec720, { fps: 30 });
    expect(opt(argv, '-vf')).toMatch(/^scale=\d+:\d+$/);
    const sb = storyboardArgv(hostile, hostileOut, {
      intervalSec: 5,
      cols: 10,
      rows: 3,
      tileWidth: 160,
    });
    expect(opt(sb, '-vf')).toBe('fps=1/5,scale=160:-2,tile=10x3');
  });
});

describe('still-image argv', () => {
  it('thumbnail: input-side seek, one frame, bounded width, high quality', () => {
    const a = thumbnailArgv('/in.mp4', '/t.jpg', 12.3456);
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(opt(a, '-ss')).toBe('12.346');
    expect(opt(a, '-frames:v')).toBe('1');
    expect(opt(a, '-vf')).toBe("scale='min(640,iw)':-2");
    expect(opt(a, '-q:v')).toBe('2');
    expect(opt(a, '-f')).toBe('image2');
  });
  it('placeholder: 32 px wide, low quality', () => {
    const a = placeholderArgv('/in.mp4', '/p.jpg', 0);
    expect(opt(a, '-vf')).toBe('scale=32:-2');
    expect(opt(a, '-q:v')).toBe('12');
  });
  it('storyboard: fps/scale/tile chain, single output frame', () => {
    const a = storyboardArgv('/in.mp4', '/s.jpg', {
      intervalSec: 2,
      cols: 10,
      rows: 5,
      tileWidth: 160,
    });
    expect(opt(a, '-vf')).toBe('fps=1/2,scale=160:-2,tile=10x5');
    expect(opt(a, '-frames:v')).toBe('1');
  });
  it('formatSeconds never emits exponent notation or negatives', () => {
    expect(formatSeconds(1e-7)).toBe('0.000');
    expect(formatSeconds(-5)).toBe('0.000');
    expect(formatSeconds(3600.5)).toBe('3600.500');
    expect(formatSeconds(Number.NaN)).toBe('0.000');
  });
});
