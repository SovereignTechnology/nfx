/**
 * Trending by kind 9321 nutzaps: sats per hour with exponential decay
 * (build-plan §2.2, "Trending" row).
 *
 * HONESTY CAVEAT, carried into the type names: these are PAID views and PAID sats as
 * observed on relays. They are not global, not un-gameable, and pay-to-trend by
 * design. Amounts are what the nutzap event CLAIMS (`proof` tag amounts); this layer
 * does not verify DLEQ or P2PK locks — that is the payment lane's job. Disclose in UI.
 */
import type {
  MintUrl,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  Page,
  Sats,
  UnixSeconds,
  VideoManifest,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { decodeOffsetCursor, encodeOffsetCursor } from './cursor.js';
import { isHex64, tagValue, tagValues } from './event.js';
import { fetchVideos } from './feeds.js';

// ---- pure scoring --------------------------------------------------------------------

export interface DecayOptions {
  /** Age at which a nutzap counts half. Default 6 h. */
  readonly halfLifeSec: number;
  /** Nutzaps older than this are ignored entirely. Default 7 days. */
  readonly windowSec: number;
}

export const DEFAULT_DECAY: DecayOptions = { halfLifeSec: 6 * 3600, windowSec: 7 * 24 * 3600 };

/** 2^(-age/halfLife); age ≤ 0 → 1; outside the window → 0. Pure. */
export function decayWeight(ageSec: number, opts: DecayOptions = DEFAULT_DECAY): number {
  if (!Number.isFinite(ageSec)) return 0;
  if (ageSec <= 0) return 1;
  if (ageSec > opts.windowSec) return 0;
  return Math.pow(2, -ageSec / opts.halfLifeSec);
}

export interface PaidEvent {
  readonly sats: number;
  readonly at: UnixSeconds;
  readonly payer: NostrPubkey;
}

export interface TrendingScore {
  /** Unique paying pubkeys inside the window — the "paid views" number. Labelled as such. */
  readonly paidViews: number;
  /** Raw claimed sats inside the window. */
  readonly paidSats: Sats;
  /** Decay-weighted sats: Σ sats·2^(-age/halfLife). The ranking key. */
  readonly decayedSats: number;
  /** paidSats ÷ window hours, for the "sats/hour" label. */
  readonly satsPerHour: number;
  readonly nutzaps: number;
}

/** Pure aggregation of one video's nutzaps at time `now`. */
export function scorePaidEvents(
  events: readonly PaidEvent[],
  now: UnixSeconds,
  opts: DecayOptions = DEFAULT_DECAY,
): TrendingScore {
  let paidSats = 0;
  let decayedSats = 0;
  let nutzaps = 0;
  const payers = new Set<string>();
  for (const e of events) {
    const w = decayWeight(now - e.at, opts);
    if (w === 0) continue;
    paidSats += e.sats;
    decayedSats += e.sats * w;
    nutzaps += 1;
    payers.add(e.payer);
  }
  return {
    paidViews: payers.size,
    paidSats: paidSats as Sats,
    decayedSats,
    satsPerHour: opts.windowSec > 0 ? paidSats / (opts.windowSec / 3600) : 0,
    nutzaps,
  };
}

export interface TrendingEntry extends TrendingScore {
  readonly videoId: NostrEventId;
}

/** Rank videos by `decayedSats` desc (ties: more paidViews, then id). Pure. */
export function rankTrending(
  byVideo: ReadonlyMap<NostrEventId, readonly PaidEvent[]>,
  now: UnixSeconds,
  opts: DecayOptions = DEFAULT_DECAY,
): TrendingEntry[] {
  const out: TrendingEntry[] = [];
  for (const [videoId, events] of byVideo) {
    const s = scorePaidEvents(events, now, opts);
    if (s.nutzaps > 0) out.push({ videoId, ...s });
  }
  return out.sort(
    (a, b) =>
      b.decayedSats - a.decayedSats ||
      b.paidViews - a.paidViews ||
      (a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0),
  );
}

// ---- NIP-61 kind 9321 parsing --------------------------------------------------------

export interface Nutzap {
  readonly id: NostrEventId;
  readonly sender: NostrPubkey;
  readonly recipient: NostrPubkey;
  readonly videoId?: NostrEventId;
  readonly targetKind?: number;
  readonly mint?: MintUrl;
  readonly unit: string;
  /** Sum of `proof` amounts as CLAIMED by the sender. Not mint-verified here. */
  readonly claimedAmount: number;
  readonly comment: string;
  readonly createdAt: UnixSeconds;
  readonly event: NostrEvent;
}

/** Parse a VERIFIED kind-9321 event. `null` for wrong kind, no recipient, or no proofs. */
export function parseNutzap(ev: NostrEvent): Nutzap | null {
  if (ev.kind !== NostrKind.NutzapPayout) return null;
  const recipient = tagValue(ev, 'p');
  if (recipient === undefined || !isHex64(recipient)) return null;
  let amount = 0;
  let proofs = 0;
  for (const raw of tagValues(ev, 'proof')) {
    let p: unknown;
    try {
      p = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof p !== 'object' || p === null) continue;
    const a = (p as Record<string, unknown>)['amount'];
    if (typeof a !== 'number' || !Number.isInteger(a) || a <= 0) continue;
    amount += a;
    proofs += 1;
  }
  if (proofs === 0) return null;
  const e = tagValue(ev, 'e');
  const k = tagValue(ev, 'k');
  const u = tagValue(ev, 'u');
  return {
    id: ev.id,
    sender: ev.pubkey,
    recipient: recipient as NostrPubkey,
    ...(e !== undefined && isHex64(e) ? { videoId: e as NostrEventId } : {}),
    ...(k !== undefined && /^\d{1,5}$/.test(k) ? { targetKind: Number(k) } : {}),
    ...(u !== undefined && /^https?:\/\//.test(u) ? { mint: u as MintUrl } : {}),
    unit: tagValue(ev, 'unit') ?? 'sat',
    claimedAmount: amount,
    comment: ev.content,
    createdAt: ev.created_at as UnixSeconds,
    event: ev,
  };
}

/** Group sat-denominated nutzaps that target a video by video id. */
export function groupNutzapsByVideo(nutzaps: readonly Nutzap[]): Map<NostrEventId, PaidEvent[]> {
  const out = new Map<NostrEventId, PaidEvent[]>();
  for (const z of nutzaps) {
    if (z.videoId === undefined || z.unit !== 'sat') continue;
    const list = out.get(z.videoId) ?? [];
    list.push({ sats: z.claimedAmount, at: z.createdAt, payer: z.sender });
    out.set(z.videoId, list);
  }
  return out;
}

// ---- relay-backed --------------------------------------------------------------------

export interface TrendingOptions extends DecayOptions {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  /** Max nutzap events to pull from relays for the ranking. Default 2000. */
  readonly maxNutzaps?: number;
}

export interface TrendingPage extends Page<VideoManifest> {
  /** Score per returned video, same order as `items`. */
  readonly scores: readonly TrendingEntry[];
}

/** Fetch nutzaps in the window, rank, then fetch the top videos (verified). */
export async function trendingFeed(
  client: NostrClient,
  opts: Partial<TrendingOptions> = {},
): Promise<TrendingPage> {
  const decay: DecayOptions = {
    halfLifeSec: opts.halfLifeSec ?? DEFAULT_DECAY.halfLifeSec,
    windowSec: opts.windowSec ?? DEFAULT_DECAY.windowSec,
  };
  const now = client.now();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = decodeOffsetCursor(opts.cursor);
  const events = await client.query({
    kinds: [NostrKind.NutzapPayout],
    since: Math.max(0, now - decay.windowSec) as UnixSeconds,
    limit: opts.maxNutzaps ?? 2000,
  });
  const nutzaps = events.flatMap((ev) => {
    const z = parseNutzap(ev);
    return z ? [z] : [];
  });
  const ranked = rankTrending(groupNutzapsByVideo(nutzaps), now, decay);
  // Over-fetch so ids that turn out not to be (verified) videos do not shrink the page.
  const slice = ranked.slice(offset, offset + limit * 2);
  const videos = await fetchVideos(
    client,
    slice.map((e) => e.videoId),
  );
  const byId = new Map(videos.map((v) => [v.id, v]));
  const items: VideoManifest[] = [];
  const scores: TrendingEntry[] = [];
  let consumed = 0;
  for (const e of slice) {
    consumed += 1;
    const v = byId.get(e.videoId);
    if (!v) continue;
    items.push(v);
    scores.push(e);
    if (items.length === limit) break;
  }
  const nextOffset = offset + consumed;
  const more = items.length === limit && nextOffset < ranked.length;
  return more ? { items, scores, next: encodeOffsetCursor(nextOffset) } : { items, scores };
}

/** Per-video paid stats (unique payers + claimed sats) inside the window. */
export async function fetchPaidStats(
  client: NostrClient,
  videoId: NostrEventId,
  opts: DecayOptions = DEFAULT_DECAY,
): Promise<TrendingScore> {
  const now = client.now();
  const events = await client.query({
    kinds: [NostrKind.NutzapPayout],
    '#e': [videoId],
    since: Math.max(0, now - opts.windowSec) as UnixSeconds,
  });
  const paid =
    groupNutzapsByVideo(
      events.flatMap((ev) => {
        const z = parseNutzap(ev);
        return z ? [z] : [];
      }),
    ).get(videoId) ?? [];
  return scorePaidEvents(paid, now, opts);
}
