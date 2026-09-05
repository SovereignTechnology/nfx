/**
 * Video feeds: subscriptions (follows), tags, author, shorts, ids, and NIP-50 search.
 * Every item is a `VideoManifest` produced by `parseVideoEvent` from an event that
 * passed the client's verification boundary.
 */
import type {
  NostrEvent,
  NostrEventId,
  NostrFilter,
  NostrPubkey,
  Page,
  SearchFilters,
  UnixSeconds,
  VideoManifest,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import { parseVideoEvent } from '../manifest/parse.js';
import type { NostrClient } from './client.js';
import { applyTimeCursor, decodeTimeCursor, encodeTimeCursor } from './cursor.js';
import { fetchSubscriptions } from './follows.js';
import type { Unsubscribe } from './types.js';

export const VIDEO_KINDS: readonly number[] = [NostrKind.Video, NostrKind.ShortVideo];
export const DEFAULT_PAGE = 20;
export const MAX_PAGE = 100;

export interface FeedOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

const clampLimit = (n: number | undefined): number =>
  Math.min(MAX_PAGE, Math.max(1, n ?? DEFAULT_PAGE));

/** Verified events → manifests, dropping events that fail to parse. */
export function toManifests(events: readonly NostrEvent[]): VideoManifest[] {
  const out: VideoManifest[] = [];
  for (const ev of events) {
    const r = parseVideoEvent(ev);
    if (r.ok) out.push(r.value);
  }
  return out;
}

/**
 * One page of videos matching `base` (kinds are forced to 21/22 unless `base.kinds` is
 * a subset of them). Over-fetches slightly so parse failures don't shrink the page.
 */
export async function videoPage(
  client: NostrClient,
  base: NostrFilter,
  opts: FeedOptions = {},
  keep: (v: VideoManifest) => boolean = () => true,
): Promise<Page<VideoManifest>> {
  const limit = clampLimit(opts.limit);
  const kinds = base.kinds?.filter((k) => VIDEO_KINDS.includes(k)) ?? VIDEO_KINDS;
  if (kinds.length === 0) return { items: [] };
  const cursor = decodeTimeCursor(opts.cursor);
  const applied = applyTimeCursor({ ...base, kinds, limit: limit + 5 }, cursor);
  const events = (await client.query(applied.filter)).filter(applied.keep);
  const items: VideoManifest[] = [];
  const consumed: NostrEvent[] = [];
  for (const ev of events) {
    const r = parseVideoEvent(ev);
    if (!r.ok || !keep(r.value)) continue;
    items.push(r.value);
    consumed.push(ev);
    if (items.length === limit) break;
  }
  const next = items.length === limit ? encodeTimeCursor(consumed) : undefined;
  return next === undefined ? { items } : { items, next };
}

/** Videos from the channels `viewer` subscribes to (channel set, else kind 3). */
export async function subscriptionsFeed(
  client: NostrClient,
  viewer: NostrPubkey,
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  const { pubkeys } = await fetchSubscriptions(client, viewer);
  if (pubkeys.length === 0) return { items: [] };
  return videoPage(client, { authors: pubkeys }, opts);
}

export async function tagsFeed(
  client: NostrClient,
  tags: readonly string[],
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  const t = tags.map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
  if (t.length === 0) return { items: [] };
  return videoPage(client, { '#t': t }, opts);
}

export async function authorFeed(
  client: NostrClient,
  author: NostrPubkey,
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  return videoPage(client, { authors: [author] }, opts);
}

export async function shortsFeed(
  client: NostrClient,
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  return videoPage(client, { kinds: [NostrKind.ShortVideo] }, opts);
}

/** Newest videos on the read relays regardless of author (the "global" fallback). */
export async function latestFeed(
  client: NostrClient,
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  return videoPage(client, {}, opts);
}

/** Fetch specific videos by id. Order follows `ids`; missing/invalid ids are omitted. */
export async function fetchVideos(
  client: NostrClient,
  ids: readonly NostrEventId[],
): Promise<VideoManifest[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const events = await client.query({ ids: unique, kinds: [...VIDEO_KINDS] });
  const byId = new Map(toManifests(events).map((m) => [m.id, m]));
  return unique.flatMap((id) => {
    const m = byId.get(id);
    return m ? [m] : [];
  });
}

export async function fetchVideo(
  client: NostrClient,
  id: NostrEventId,
): Promise<VideoManifest | null> {
  return (await fetchVideos(client, [id]))[0] ?? null;
}

/**
 * NIP-50 search. Relay-side `search` + structured filters; duration limits are applied
 * client-side because relays cannot see them. Relays without NIP-50 return junk or
 * nothing — the caller degrades gracefully by design (build-plan §2.2).
 */
export async function searchVideos(
  client: NostrClient,
  text: string,
  filters: SearchFilters = {},
  opts: FeedOptions = {},
): Promise<Page<VideoManifest>> {
  const q = text.trim();
  if (q === '') return { items: [] };
  const base: NostrFilter = {
    search: q,
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(filters.author === undefined ? {} : { authors: [filters.author] }),
    ...(filters.tags && filters.tags.length > 0 ? { '#t': filters.tags } : {}),
  };
  const min = filters.minDurationSec;
  const max = filters.maxDurationSec;
  return videoPage(client, base, opts, (v) => {
    if (min === undefined && max === undefined) return true;
    if (v.durationSec === undefined) return false;
    return (
      (min === undefined || v.durationSec >= min) && (max === undefined || v.durationSec <= max)
    );
  });
}

/** Same-creator and same-tag videos, excluding the video itself. Client-side, honest. */
export async function relatedVideos(
  client: NostrClient,
  video: VideoManifest,
  limit = 12,
): Promise<VideoManifest[]> {
  const filters: NostrFilter[] = [{ authors: [video.author], kinds: [...VIDEO_KINDS], limit }];
  if (video.tags.length > 0) filters.push({ '#t': video.tags, kinds: [...VIDEO_KINDS], limit });
  const events = await client.queryMany(filters);
  const out = toManifests(events).filter((m) => m.id !== video.id);
  // Prefer more tag overlap, then same author, then recency.
  const score = (m: VideoManifest): number =>
    m.tags.filter((t) => video.tags.includes(t)).length * 2 + (m.author === video.author ? 1 : 0);
  return out.sort((a, b) => score(b) - score(a) || b.publishedAt - a.publishedAt).slice(0, limit);
}

/** Live: new videos from `authors` published after `since`. Verified before delivery. */
export function watchNewVideos(
  client: NostrClient,
  authors: readonly NostrPubkey[],
  since: UnixSeconds,
  onVideo: (v: VideoManifest) => void,
): Unsubscribe {
  if (authors.length === 0) return () => undefined;
  return client.subscribe([{ authors, kinds: [...VIDEO_KINDS], since }], (ev) => {
    const r = parseVideoEvent(ev);
    if (r.ok) onVideo(r.value);
  });
}
