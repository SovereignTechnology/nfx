/**
 * Pure helpers for the Library screen: day grouping for Watch history (YouTube's "Today /
 * Yesterday / Monday / Aug 28"), the resume position a history row opens Watch at, count
 * copy and error copy. No DOM, no adapter calls — unit-tested on their own.
 */
import type { UnixSeconds } from '@sovit/core';
import { formatInteger } from '../../components/index.js';

/** Below this many seconds a history entry opens from the start (nothing worth resuming). */
export const RESUME_MIN_SEC = 5;

/** At or past this fraction of the duration the video counts as watched: "Watch again". */
export const WATCHED_FRACTION = 0.95;

interface DayParts {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function formatter(
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  const withZone: Intl.DateTimeFormatOptions =
    timeZone === undefined ? options : { ...options, timeZone };
  try {
    return new Intl.DateTimeFormat('en-US', withZone);
  } catch {
    // An unknown IANA zone throws RangeError; fall back to the runtime's own zone.
    return new Intl.DateTimeFormat('en-US', options);
  }
}

function dayParts(at: number, timeZone: string | undefined): DayParts {
  const parts = formatter(
    { year: 'numeric', month: 'numeric', day: 'numeric' },
    timeZone,
  ).formatToParts(new Date(at * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Calendar-day number (days since the epoch) of a date in the viewer's zone. */
function dayNumber(p: DayParts): number {
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

/** Stable key for the calendar day `at` falls on, in `timeZone` (default: the runtime's). */
export function historyDayKey(at: UnixSeconds | number, timeZone?: string): string {
  const p = dayParts(at, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * The heading a history day group gets, relative to `now`: "Today", "Yesterday", the weekday
 * within the last week, then "Aug 28" this year and "Aug 28, 2024" before that. A timestamp
 * in the future (clock skew between devices) reads as "Today".
 */
export function historyDayLabel(
  at: UnixSeconds | number,
  now: UnixSeconds | number,
  timeZone?: string,
): string {
  const a = dayParts(at, timeZone);
  const n = dayParts(now, timeZone);
  const diff = dayNumber(n) - dayNumber(a);
  const date = new Date(at * 1000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return formatter({ weekday: 'long' }, timeZone).format(date);
  if (a.y === n.y) return formatter({ month: 'short', day: 'numeric' }, timeZone).format(date);
  return formatter({ month: 'short', day: 'numeric', year: 'numeric' }, timeZone).format(date);
}

export interface HistoryGroup<T> {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly T[];
}

/**
 * Groups history entries (newest first, as `library.history` returns them) into calendar
 * days. Order is preserved: groups appear in the order their first entry does, entries keep
 * their order inside a group, so appending a page never reshuffles what is on screen.
 */
export function groupHistoryByDay<T extends { readonly at: UnixSeconds | number }>(
  entries: readonly T[],
  now: UnixSeconds | number,
  timeZone?: string,
): readonly HistoryGroup<T>[] {
  const groups: { key: string; label: string; entries: T[] }[] = [];
  const byKey = new Map<string, { key: string; label: string; entries: T[] }>();
  for (const e of entries) {
    const key = historyDayKey(e.at, timeZone);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: historyDayLabel(e.at, now, timeZone), entries: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

/** How far a history entry got, and what reopening it should do. */
export type HistoryProgress =
  | { readonly state: 'resume'; readonly at: number; readonly fraction: number | undefined }
  | { readonly state: 'watched'; readonly fraction: 1 }
  | { readonly state: 'start'; readonly fraction: number | undefined };

/**
 * `positionSec` vs duration → resume here (Watch route `t`), watched (start over, full bar)
 * or barely started (start over). Duration may be unknown (optional on the manifest): then
 * any position past `RESUME_MIN_SEC` is resumable and no bar fraction is known.
 */
export function historyProgress(
  positionSec: number,
  durationSec: number | undefined,
): HistoryProgress {
  const pos = Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0;
  const known = durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0;
  const fraction = known ? Math.min(1, pos / durationSec) : undefined;
  if (known && pos >= durationSec * WATCHED_FRACTION) return { state: 'watched', fraction: 1 };
  if (pos < RESUME_MIN_SEC) return { state: 'start', fraction };
  return { state: 'resume', at: Math.floor(pos), fraction };
}

/** "No videos" / "1 video" / "1,204 videos". */
export function countLabel(n: number, noun: string, plural = `${noun}s`): string {
  if (n <= 0) return `No ${plural}`;
  return `${formatInteger(n)} ${n === 1 ? noun : plural}`;
}

/** Human copy for a failed adapter call. Never a stack trace (the shell logs those). */
export function describeLibraryError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, so your library could not be loaded. Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  if (/signer|locked|decrypt/i.test(message)) {
    return {
      title: 'Could not unlock your library',
      description:
        'Your signer did not answer. Private lists are encrypted to your key, so they can only be read while your signer is connected and unlocked.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not load your library. Try again in a moment.',
    detail: message || undefined,
  };
}
