/**
 * Opaque pagination cursors for `Page<T>`.
 *
 * Time cursor: `t:<until>:<id,id,…>` — `until` is the `created_at` of the oldest item on
 * the previous page, and the ids are every item on that page sharing that second, so the
 * next query can be `until`-inclusive without repeating or skipping same-second events.
 * Offset cursor: `o:<n>` for in-memory rankings (trending).
 */
import type { NostrEvent, NostrFilter, UnixSeconds } from '../contracts/index.js';

export interface TimeCursor {
  readonly until: UnixSeconds;
  readonly seen: readonly string[];
}

export function encodeTimeCursor(page: readonly NostrEvent[]): string | undefined {
  const last = page[page.length - 1];
  if (!last) return undefined;
  const seen = page.filter((e) => e.created_at === last.created_at).map((e) => e.id);
  return `t:${last.created_at}:${seen.join(',')}`;
}

export function decodeTimeCursor(cursor: string | undefined): TimeCursor | undefined {
  if (cursor === undefined) return undefined;
  const m = /^t:(\d{1,12}):([0-9a-f,]*)$/.exec(cursor);
  const ids = m?.[2];
  if (!m || ids === undefined) return undefined;
  return {
    until: Number(m[1]) as UnixSeconds,
    seen: ids === '' ? [] : ids.split(','),
  };
}

/** Apply a time cursor to a filter (`until`), and return the post-filter to drop `seen`. */
export function applyTimeCursor(
  filter: NostrFilter,
  cursor: TimeCursor | undefined,
): { readonly filter: NostrFilter; readonly keep: (ev: NostrEvent) => boolean } {
  if (!cursor) return { filter, keep: () => true };
  const seen = new Set(cursor.seen);
  return {
    filter: { ...filter, until: cursor.until },
    keep: (ev) => !(ev.created_at === cursor.until && seen.has(ev.id)),
  };
}

export const encodeOffsetCursor = (n: number): string => `o:${n}`;

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const m = /^o:(\d{1,9})$/.exec(cursor);
  return m ? Number(m[1]) : 0;
}
