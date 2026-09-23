/** Pure Library helpers: day labels/grouping, resume position, counts, error copy. */
import { describe, expect, it } from 'vitest';
import { mocks } from '@sovit/core';
import {
  countLabel,
  describeLibraryError,
  groupHistoryByDay,
  historyDayKey,
  historyDayLabel,
  historyProgress,
} from '../libraryFormat.js';

const NOW = mocks.FIXTURE_NOW; // Thu 2025-09-04 15:33:20 UTC
const H = 3600;
const D = 86_400;

describe('historyDayLabel', () => {
  it('reads Today / Yesterday / weekday / date / date with year, in the given zone', () => {
    expect(historyDayLabel(NOW - H, NOW, 'UTC')).toBe('Today');
    expect(historyDayLabel(NOW - 15.5 * H, NOW, 'UTC')).toBe('Today'); // 00:03 same day
    expect(historyDayLabel(NOW - 16 * H, NOW, 'UTC')).toBe('Yesterday'); // 23:33 the day before
    expect(historyDayLabel(NOW - 3 * D, NOW, 'UTC')).toBe('Monday');
    expect(historyDayLabel(NOW - 6 * D, NOW, 'UTC')).toBe('Friday');
    expect(historyDayLabel(NOW - 7 * D, NOW, 'UTC')).toBe('Aug 28');
    expect(historyDayLabel(NOW - 400 * D, NOW, 'UTC')).toBe('Jul 31, 2024');
    expect(historyDayLabel(NOW + H, NOW, 'UTC')).toBe('Today'); // clock skew
  });

  it('cuts days in the viewer zone, not UTC', () => {
    // 15:33 UTC on Sep 4 is 01:33 on Sep 5 in Sydney (UTC+10), so 2 h earlier is "Yesterday"
    // there while it is still "Today" in UTC.
    expect(historyDayLabel(NOW - 2 * H, NOW, 'Australia/Sydney')).toBe('Yesterday');
    expect(historyDayLabel(NOW - 2 * H, NOW, 'UTC')).toBe('Today');
    expect(historyDayKey(NOW, 'Australia/Sydney')).toBe('2025-09-05');
    expect(historyDayKey(NOW, 'UTC')).toBe('2025-09-04');
  });

  it('falls back to the runtime zone for an unknown zone instead of throwing', () => {
    expect(() => historyDayLabel(NOW - H, NOW, 'Not/AZone')).not.toThrow();
  });
});

describe('groupHistoryByDay', () => {
  it('keeps order, groups consecutive days, labels each group once', () => {
    const entries = [NOW - H, NOW - 2 * H, NOW - D, NOW - 3 * D, NOW - 3 * D - H].map((at, i) => ({
      at,
      i,
    }));
    const groups = groupHistoryByDay(entries, NOW, 'UTC');
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Monday']);
    expect(groups.map((g) => g.entries.map((e) => e.i))).toEqual([[0, 1], [2], [3, 4]]);
    expect(groupHistoryByDay([], NOW, 'UTC')).toEqual([]);
  });
});

describe('historyProgress', () => {
  it('resume / watched / start, with the bar fraction', () => {
    expect(historyProgress(312, 754)).toEqual({ state: 'resume', at: 312, fraction: 312 / 754 });
    expect(historyProgress(312.9, 754)).toMatchObject({ state: 'resume', at: 312 });
    expect(historyProgress(720, 754)).toEqual({ state: 'watched', fraction: 1 });
    expect(historyProgress(2, 754)).toEqual({ state: 'start', fraction: 2 / 754 });
    expect(historyProgress(40, undefined)).toEqual({
      state: 'resume',
      at: 40,
      fraction: undefined,
    });
    expect(historyProgress(Number.NaN, 100)).toEqual({ state: 'start', fraction: 0 });
    expect(historyProgress(-5, 100)).toEqual({ state: 'start', fraction: 0 });
  });
});

describe('countLabel / describeLibraryError', () => {
  it('pluralises and groups', () => {
    expect(countLabel(0, 'video')).toBe('No videos');
    expect(countLabel(1, 'video')).toBe('1 video');
    expect(countLabel(1204, 'playlist')).toBe('1,204 playlists');
  });

  it('maps relay and signer failures, and unknown values', () => {
    expect(describeLibraryError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeLibraryError('decrypt failed').title).toBe('Could not unlock your library');
    expect(describeLibraryError(new Error('boom')).title).toBe('Something went wrong');
    expect(describeLibraryError(undefined).detail).toBeUndefined();
  });
});
