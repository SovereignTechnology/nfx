import { describe, expect, it } from 'vitest';

import { MediaError } from '../errors.js';
import {
  displayDimensions,
  ffprobeArgv,
  isMp4Container,
  normaliseRotation,
  parseFfprobeJson,
  parseRational,
} from '../ffprobe.js';
import { probeJson } from '../testing/fakes.js';

/** Verbatim shape from ffprobe n8.1.2 (trimmed) — see FFMPEG-PIN.md. */
const REAL = `{
  "streams": [
    { "index": 0, "codec_name": "h264", "codec_type": "video", "width": 640, "height": 360,
      "pix_fmt": "yuv420p", "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
      "duration": "3.000000", "bit_rate": "183773", "disposition": { "attached_pic": 0 },
      "side_data_list": [ { "side_data_type": "Display Matrix", "rotation": 90 } ] },
    { "index": 1, "codec_name": "aac", "codec_type": "audio", "sample_rate": "44100",
      "channels": 1, "channel_layout": "mono", "bit_rate": "69594" }
  ],
  "format": { "filename": "in.mp4", "nb_streams": 2, "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
    "duration": "3.000000", "size": "99185", "bit_rate": "264493" }
}`;

describe('ffprobeArgv', () => {
  it('passes the path as one argv element, never through a shell', () => {
    const hostile = "/tmp/x/; rm -rf / #$(id) 'a b'.mp4";
    const argv = ffprobeArgv(hostile);
    expect(argv.at(-1)).toBe(hostile);
    expect(argv).toContain('json');
    expect(argv.filter((a) => a.includes('rm -rf'))).toHaveLength(1);
  });
});

describe('parseFfprobeJson', () => {
  it('maps a real ffprobe document', () => {
    const p = parseFfprobeJson(REAL);
    expect(p).toEqual({
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 3,
      bitrateKbps: 264,
      video: {
        codec: 'h264',
        width: 640,
        height: 360,
        fps: 30,
        rotation: 90,
        pixelFormat: 'yuv420p',
      },
      audio: { codec: 'aac', channels: 1, sampleRate: 44100 },
    });
  });

  it('omits rotation when 0 and audio when absent', () => {
    const p = parseFfprobeJson(
      probeJson({ duration: 10, video: { width: 1920, height: 1080, rotation: 0 } }),
    );
    expect(p.video?.rotation).toBeUndefined();
    expect(p.audio).toBeUndefined();
  });

  it('skips attached-picture "video" streams (cover art)', () => {
    const doc = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 300,
          height: 300,
          disposition: { attached_pic: 1 },
        },
        { codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '44100' },
      ],
      format: { format_name: 'mp3', duration: '200.5' },
    });
    const p = parseFfprobeJson(doc);
    expect(p.video).toBeUndefined();
    expect(p.audio?.codec).toBe('mp3');
    expect(p.durationSec).toBe(200.5);
  });

  it('falls back to the video stream duration when format.duration is missing', () => {
    const doc = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 16, height: 16, duration: '4.5' },
      ],
      format: { format_name: 'h264' },
    });
    expect(parseFfprobeJson(doc).durationSec).toBe(4.5);
  });

  it('accepts the legacy tags.rotate form', () => {
    const doc = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 16, height: 16, tags: { rotate: '270' } },
      ],
      format: { format_name: 'mov', duration: '1' },
    });
    expect(parseFfprobeJson(doc).video?.rotation).toBe(270);
  });

  it('throws probe-parse on garbage, missing format name, or a broken video stream', () => {
    for (const bad of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ format: { format_name: 'mp4' }, streams: [{ codec_type: 'video' }] }),
    ]) {
      let err: unknown;
      try {
        parseFfprobeJson(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MediaError);
      expect((err as MediaError).code).toBe('probe-parse');
    }
  });

  it('tolerates non-object stream entries by ignoring the array', () => {
    const doc = JSON.stringify({
      streams: [null, 3],
      format: { format_name: 'mp4', duration: '1' },
    });
    expect(parseFfprobeJson(doc).video).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parseRational', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRational('0/0')).toBeUndefined();
    expect(parseRational('25')).toBe(25);
    expect(parseRational(24)).toBe(24);
    expect(parseRational('x')).toBeUndefined();
  });
  it('normaliseRotation', () => {
    expect(normaliseRotation(-90)).toBe(270);
    expect(normaliseRotation('90')).toBe(90);
    expect(normaliseRotation(450)).toBe(90);
    expect(normaliseRotation(undefined)).toBeUndefined();
  });
  it('displayDimensions swaps on 90/270', () => {
    const v = { codec: 'h264', width: 1920, height: 1080, fps: 30 };
    expect(displayDimensions(v)).toEqual({ width: 1920, height: 1080 });
    expect(displayDimensions({ ...v, rotation: 90 })).toEqual({ width: 1080, height: 1920 });
    expect(displayDimensions({ ...v, rotation: 180 })).toEqual({ width: 1920, height: 1080 });
  });
  it('isMp4Container', () => {
    expect(isMp4Container('mov,mp4,m4a,3gp,3g2,mj2')).toBe(true);
    expect(isMp4Container('matroska,webm')).toBe(false);
    expect(isMp4Container('image2')).toBe(false);
  });
});
