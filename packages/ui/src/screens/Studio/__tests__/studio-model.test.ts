/**
 * Studio's pure model: display arithmetic (ADR 0005 split rounding, per-minute estimates),
 * the upload-progress reducer and step statuses, draft validation → `UploadInput`, and error
 * classification (MediaError codes, a stripped IPC message, relay/signer copy).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCK_SIZE, media, mocks } from '@sovit/core';
import type { MintUrl, UploadProgress } from '@sovit/core';
import {
  BLOCK_SIZE,
  EMPTY_DRAFT,
  INITIAL_PROGRESS,
  TYPICAL_RENDITIONS,
  classifyStudioError,
  describeBanReason,
  describeStudioError,
  failProgress,
  formatBytes,
  looksLikeVideo,
  normalizeHttpsUrl,
  normalizeInvoice,
  parseServers,
  parseSplit,
  parseTags,
  reduceUploadProgress,
  renditionKbps,
  satsPerGigabyte,
  satsPerMinute,
  splitPayment,
  titleFromFileName,
  toUploadInput,
  uploadSteps,
  validateDraft,
  type StudioDraft,
} from '../model.js';

describe('display arithmetic', () => {
  it('keeps the block size and the typical ladder in sync with core', () => {
    expect(BLOCK_SIZE).toBe(DEFAULT_BLOCK_SIZE);
    expect(TYPICAL_RENDITIONS).toEqual(
      media.LADDER_TIERS.map((t) => ({
        label: t.label,
        kbps: t.videoBitrateKbps + t.audioBitrateKbps,
      })),
    );
  });

  it('splits a payment per ADR 0005 Q1: seeder = ceil(amount × s / 100), creator = rest', () => {
    const half = { seeder: 50, creator: 50 };
    expect(splitPayment(1, half)).toEqual({ seeder: 1, creator: 0 });
    expect(splitPayment(2, half)).toEqual({ seeder: 1, creator: 1 });
    expect(splitPayment(3, half)).toEqual({ seeder: 2, creator: 1 });
    expect(splitPayment(7, { seeder: 33, creator: 67 })).toEqual({ seeder: 3, creator: 4 });
    expect(splitPayment(100, { seeder: 29, creator: 71 })).toEqual({ seeder: 29, creator: 71 });
    expect(splitPayment(5, { seeder: 0, creator: 100 })).toEqual({ seeder: 0, creator: 5 });
    expect(splitPayment(5, { seeder: 100, creator: 0 })).toEqual({ seeder: 5, creator: 0 });
    // Shares always sum to the amount and the seeder always gets ≥ 1 when s > 0.
    for (let amount = 1; amount <= 40; amount++)
      for (let s = 1; s <= 99; s++) {
        const r = splitPayment(amount, { seeder: s, creator: 100 - s });
        expect(r.seeder + r.creator).toBe(amount);
        expect(r.seeder).toBeGreaterThanOrEqual(1);
        // The creator gets ≥ 1 for amount ≥ 2 only while s ≤ 50 …
        if (amount >= 2 && s <= 50) expect(r.creator).toBeGreaterThanOrEqual(1);
      }
    // … not "whenever both percentages are > 0" as ADR 0005's consequences paragraph says:
    // 2 sats at 99/1 → ceil(1.98) = 2 to the seeder, 0 to the creator (reported in the lane doc).
    expect(splitPayment(2, { seeder: 99, creator: 1 })).toEqual({ seeder: 2, creator: 0 });
  });

  it('prices a minute in whole blocks and a GB exactly', () => {
    // 2628 kbps × 125 × 60 = 19.71 MB/min → 300.75 blocks → 301.
    expect(satsPerMinute(2628, 1)).toBe(301);
    expect(satsPerMinute(2628, 3)).toBe(903);
    expect(satsPerMinute(0, 5)).toBe(0);
    expect(satsPerGigabyte(1)).toBe(Math.ceil(1e9 / 65_536));
  });

  it('derives a rendition bitrate from imeta or size ÷ duration', () => {
    const r = mocks.VIDEOS[0]!.renditions[0]!;
    expect(renditionKbps(r, 100)).toBe(r.bitrateKbps);
    const { bitrateKbps: _drop, ...noRate } = r;
    expect(renditionKbps(noRate, 10)).toBeCloseTo((r.size * 8) / 1000 / 10);
    expect(renditionKbps(noRate, undefined)).toBeUndefined();
  });
});

describe('small parsers', () => {
  it('tags, urls, invoices, files, bytes', () => {
    expect(parseTags(' #Space, physics ,, Orbital  mechanics, space\nnew')).toEqual([
      'space',
      'physics',
      'orbital-mechanics',
      'new',
    ]);
    expect(normalizeHttpsUrl('https://Mint.Example/')).toBe('https://mint.example');
    expect(normalizeHttpsUrl('https://mint.example/v1/')).toBe('https://mint.example/v1');
    expect(normalizeHttpsUrl('http://mint.example')).toBeNull();
    expect(normalizeHttpsUrl('https://user:pw@mint.example')).toBeNull();
    expect(normalizeHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(parseServers('https://a.example\nnope\nhttps://a.example/')).toEqual({
      servers: ['https://a.example'],
      invalid: ['nope'],
    });
    expect(normalizeInvoice(`lightning:LNBC10N1${'P'.repeat(30)}`)).toBe(
      `lnbc10n1${'p'.repeat(30)}`,
    );
    expect(normalizeInvoice('lnbc1')).toBeNull();
    expect(normalizeInvoice('bitcoin:bc1qxyz')).toBeNull();
    expect(looksLikeVideo('a.mp4', 'video/mp4')).toBe(true);
    expect(looksLikeVideo('a.mkv', '')).toBe(true);
    expect(looksLikeVideo('a.mp4', 'application/pdf')).toBe(false);
    expect(looksLikeVideo('a.txt', '')).toBe(false);
    expect(titleFromFileName('Day 3 — final.MOV')).toBe('Day 3 — final');
    expect(formatBytes(734_003_200)).toBe('700 MB');
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
    expect(formatBytes(1_536)).toBe('1.5 KB');
    expect(formatBytes(12)).toBe('12 B');
    expect(parseSplit('40', '60')).toEqual({ seeder: 40, creator: 60 });
    expect(parseSplit('40', '50')).toBeUndefined();
    expect(parseSplit('4.5', '95.5')).toBeUndefined();
    expect(describeBanReason('window-exceeded')).toContain('unpaid window');
    expect(describeBanReason('something-new')).toBe('something-new');
  });
});

describe('draft → UploadInput', () => {
  const draft: StudioDraft = {
    ...EMPTY_DRAFT,
    file: { source: '/v.mp4', name: 'v.mp4' },
    title: '  A title ',
    tags: 'a, b',
    mints: ['https://mint.example' as MintUrl],
    mirrors: 'https://m.example/',
  };

  it('builds the exact contract input for a valid draft', () => {
    expect(validateDraft(draft)).toEqual({});
    expect(toUploadInput(draft)).toEqual({
      file: '/v.mp4',
      title: 'A title',
      description: '',
      tags: ['a', 'b'],
      kind: 21,
      mints: ['https://mint.example'],
      satsPerBlock: 1,
      split: { seeder: 50, creator: 50 },
      mirrorTo: ['https://m.example'],
    });
  });

  it('refuses an invalid draft and names every problem', () => {
    const bad: StudioDraft = {
      ...EMPTY_DRAFT,
      title: 'x'.repeat(101),
      tags: Array.from({ length: 11 }, (_, i) => `t${i}`).join(','),
      price: '1.5',
      seeder: '60',
      creator: '60',
      thumbnail: { mode: 'custom', image: undefined },
      mirrors: 'ftp://nope',
    };
    expect(Object.keys(validateDraft(bad)).sort()).toEqual(
      ['file', 'mints', 'mirrors', 'price', 'split', 'tags', 'thumbnail', 'title'].sort(),
    );
    expect(toUploadInput(bad)).toBeUndefined();
  });
});

describe('upload progress', () => {
  const run = (events: readonly UploadProgress[]): typeof INITIAL_PROGRESS =>
    events.reduce(reduceUploadProgress, INITIAL_PROGRESS);

  it('folds events per stage and per rendition, clamping percentages', () => {
    const v = run([
      { stage: 'probing' },
      { stage: 'transcoding', rendition: '1080p', percent: 50 },
      { stage: 'transcoding', rendition: '720p', percent: 20 },
      { stage: 'transcoding', rendition: '1080p', percent: 140 },
      { stage: 'thumbnails', candidates: ['a', 'b'] },
      { stage: 'writing', rendition: '1080p', percent: -5 },
      { stage: 'mirroring', server: 's1', ok: false },
      { stage: 'mirroring', server: 's1', ok: true },
    ]);
    expect(v.transcoding).toEqual([
      { label: '1080p', percent: 100 },
      { label: '720p', percent: 20 },
    ]);
    expect(v.writing).toEqual([{ label: '1080p', percent: 0 }]);
    expect(v.candidates).toEqual(['a', 'b']);
    expect(v.mirrors).toEqual([{ server: 's1', ok: true }]);
  });

  it('computes step statuses, with mirror only when asked', () => {
    const mid = run([
      { stage: 'probing' },
      { stage: 'transcoding', rendition: '720p', percent: 3 },
    ]);
    expect(uploadSteps(mid, false).map((s) => s.status)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
      'pending',
    ]);
    expect(uploadSteps(mid, true)).toHaveLength(6);
    expect(uploadSteps(INITIAL_PROGRESS, false)[0]?.status).toBe('pending');
    const done = run([{ stage: 'done', video: mocks.VIDEOS[0]! }]);
    expect(uploadSteps(done, true).every((s) => s.status === 'done')).toBe(true);
  });

  it('marks the running step failed, from an event or a rejection, once', () => {
    const e = run([
      { stage: 'writing', rendition: '720p', percent: 10 },
      { stage: 'error', message: 'disk full' },
    ]);
    expect(e.failedAt).toBe('write');
    expect(e.errorMessage).toBe('disk full');
    expect(uploadSteps(e, false)[3]?.status).toBe('error');
    expect(failProgress(e, 'later')).toBe(e);
    const r = failProgress(run([{ stage: 'publishing' }]), 'relay-down');
    expect(r.failedAt).toBe('publish');
    expect(failProgress(INITIAL_PROGRESS, undefined).failedAt).toBe('probe');
  });
});

describe('error classification', () => {
  it('reads MediaError / ProcessRunnerError codes, directly or as cause', () => {
    expect(classifyStudioError(new media.MediaError('ffmpeg-not-found', 'x'))).toBe(
      'ffmpeg-not-found',
    );
    const runner = new media.ProcessRunnerError('spawn-failed', 'ffmpeg', { errno: 'ENOENT' });
    expect(classifyStudioError(runner)).toBe('ffmpeg-not-found');
    expect(classifyStudioError(new Error('wrapped', { cause: runner }))).toBe('ffmpeg-not-found');
    expect(classifyStudioError(new media.MediaError('unsupported-input', 'x'))).toBe(
      'unsupported-input',
    );
    expect(classifyStudioError(new media.MediaError('no-video-stream', 'x'))).toBe(
      'no-video-stream',
    );
    expect(classifyStudioError(new media.MediaError('hash-mismatch', 'x'))).toBe(
      'verification-failed',
    );
    expect(classifyStudioError(new media.MediaError('process-failed', 'x'))).toBe('process-failed');
  });

  it('falls back to the message when an IPC hop dropped the code', () => {
    expect(classifyStudioError(new Error('ffprobe: could not spawn ffprobe (ENOENT)'))).toBe(
      'ffmpeg-not-found',
    );
    expect(classifyStudioError('spawn ffmpeg ENOENT: ffmpeg not found')).toBe('ffmpeg-not-found');
    expect(classifyStudioError({ message: 'relay-down: no relays reachable' })).toBe('relay-down');
    expect(classifyStudioError(new Error('no-signer: signer not detected'))).toBe('no-signer');
    expect(classifyStudioError(new Error('no-balance: no balance at x'))).toBe('no-balance');
    expect(classifyStudioError(new Error('ffmpeg exited 1'))).toBe('unknown');
    expect(classifyStudioError(undefined)).toBe('unknown');
  });

  it('describes by context, with the machine message as detail only', () => {
    const relay = new Error('relay-down: no relays reachable');
    expect(describeStudioError(relay, 'upload').title).toBe('Could not publish');
    expect(describeStudioError(relay, 'load').title).toBe('Relay down');
    expect(describeStudioError(relay).detail).toBe('relay-down: no relays reachable');
    expect(describeStudioError(new Error('boom'), 'melt').title).toBe('Melt-out failed');
    expect(describeStudioError(new Error('boom'), 'seeder').title).toBe(
      'Could not load your seeder',
    );
    expect(describeStudioError(null).detail).toBeUndefined();
  });
});
