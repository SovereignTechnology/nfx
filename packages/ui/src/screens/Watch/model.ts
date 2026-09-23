/**
 * Watch screen — pure model: constants, types and helpers with no React and no adapter.
 * Everything here is unit-tested directly (`__tests__/watch.test.ts` "pure helpers").
 *
 * Names are `Watch`-prefixed where a generic name could collide with another screen's
 * export under an `export *` barrel (Home already exports `describeError`).
 */
import type {
  Comment,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  PeerSpend,
  PlaySession,
  Playlist,
  Profile,
  Rendition,
  Sats,
  VideoManifest,
  VideoStats,
} from '@sovit/core';
import {
  renditionPriceSats,
  renditionRatePerMin,
  type PlayerState,
} from '../../components/index.js';

/** Progress is recorded roughly every 5 s while playing (build-plan §6.2 "Resume"). */
export const WATCH_PROGRESS_INTERVAL_MS = 5000;

/** Autoplay-next countdown length; the next video's price is shown the whole time. */
export const WATCH_UP_NEXT_SECONDS = 5;

/** Prefetch-depth fallback when neither the prop nor `adapter.settings()` gives one (§6.2). */
export const WATCH_DEFAULT_PREFETCH_SEC = 30;

/** Nutzap preset amounts in the sheet. */
export const WATCH_NUTZAP_AMOUNTS: readonly number[] = [21, 100, 1000];

/** Report reasons handed to `adapter.report` (NIP-56 kind 1984; gateways honour BUD-09). */
export const WATCH_REPORT_REASONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'spam', label: 'Spam or misleading' },
  { id: 'violence', label: 'Violent or hateful content' },
  { id: 'sexual', label: 'Sexual content' },
  { id: 'legal', label: 'Copyright or legal issue' },
  { id: 'other', label: 'Something else' },
];

/** Sidebar size (`adapter.related(id, WATCH_RELATED_COUNT)`). */
export const WATCH_RELATED_COUNT = 8;

/** Playlist manifests resolved for the playlist panel (metadata only — never media). */
export const WATCH_PLAYLIST_MAX = 50;

/**
 * The mini-player handshake payload (docs/lanes/L5-Watch.md "Mini-player handshake").
 *
 * `Watch → shell` (`onMiniPlayer`): the live, already-priced `PlaySession` plus what the
 * shell needs to keep showing it — from this call on the SHELL owns the session and must
 * `close()` it when its mini-player is dismissed. `Watch` never touches it again.
 *
 * `shell → Watch` (`resumeSession`): the same shape handed back when the viewer expands the
 * mini-player; `Watch` adopts the session (no new `play()`, no new price — it was shown when
 * the session started) and owns it again.
 */
export interface WatchHandoff {
  readonly session: PlaySession;
  readonly videoId: NostrEventId;
  readonly title: string;
  /** Media position at the hand-off, seconds. */
  readonly positionSec: number;
  /** `true` = the session was paused (not paying) when handed over. */
  readonly paused: boolean;
  readonly volume: number;
  readonly muted: boolean;
  readonly playbackRate: number;
}

/** What a failed `adapter.play()` means for the viewer. */
export type PlayErrorKind = 'no-seeders' | 'no-balance' | 'relay-down' | 'unknown';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/** Maps a play() rejection to the designed empty states (mock messages are prefixed). */
export function playErrorKind(err: unknown): PlayErrorKind {
  const message = messageOf(err);
  if (/no-seeders/i.test(message)) return 'no-seeders';
  if (/no-balance/i.test(message)) return 'no-balance';
  if (/relay/i.test(message)) return 'relay-down';
  return 'unknown';
}

/** Human copy for catalog failures. Never a stack trace (the shell logs those). */
export function describeWatchError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = messageOf(err);
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered. Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not load this video. Try again in a moment.',
    detail: message || undefined,
  };
}

export interface CommentThread {
  readonly root: Comment;
  readonly replies: readonly Comment[];
}

/**
 * One reply level (§6.1): top-level comments in page order, each with its replies.
 * Replies to replies flatten onto their top-level ancestor; orphans (parent not in this
 * page) render as roots. Two passes, so a reply listed BEFORE its parent (sort "new" puts
 * newer replies first) still lands under it. Replies read oldest-first; the adapter sorts
 * roots (new/top). Cycle-safe; drops nothing.
 */
export function buildCommentThreads(items: readonly Comment[]): readonly CommentThread[] {
  const byId = new Map<NostrEventId, Comment>(items.map((c) => [c.id, c]));
  const rootOf = (c: Comment): Comment => {
    let cur = c;
    const seen = new Set<NostrEventId>();
    while (cur.parent !== undefined && !seen.has(cur.id)) {
      const parent = byId.get(cur.parent);
      if (parent === undefined) break;
      seen.add(cur.id);
      cur = parent;
    }
    return cur;
  };
  const threads: { readonly root: Comment; readonly replies: Comment[] }[] = [];
  const byRoot = new Map<NostrEventId, { readonly root: Comment; readonly replies: Comment[] }>();
  const roots = new Map<NostrEventId, Comment>(items.map((c) => [c.id, rootOf(c)]));
  for (const c of items) {
    if (roots.get(c.id) !== c) continue;
    const t = { root: c, replies: [] as Comment[] };
    threads.push(t);
    byRoot.set(c.id, t);
  }
  for (const c of items) {
    const root = roots.get(c.id);
    if (root === undefined || root === c) continue;
    const thread = byRoot.get(root.id);
    if (thread === undefined) {
      // A cycle whose members all point back into it: show the comment rather than drop it.
      const t = { root: c, replies: [] as Comment[] };
      threads.push(t);
      byRoot.set(c.id, t);
    } else {
      thread.replies.push(c);
    }
  }
  for (const t of threads) t.replies.sort((a, b) => a.createdAt - b.createdAt);
  return threads;
}

/**
 * History resume position. Trivially-small positions (< 5 s) and a basically-finished video
 * (within 10 s of the end) start at 0 — YouTube's convention. `t` deep links bypass this.
 */
export function resumePositionSec(video: VideoManifest, historySec: number): number {
  if (historySec < 5) return 0;
  const duration = video.durationSec;
  if (duration !== undefined && historySec >= Math.max(0, duration - 10)) return 0;
  return Math.floor(historySec);
}

/**
 * The rendition that WILL play: the viewer's preferred label when this video has it, else
 * the manifest's first rendition (what `adapter.play(id)` picks without a label). The poster
 * price, the up-next price and the label passed to `adapter.play` all come from this one
 * function, so the price shown is the price charged (execution plan §2 Stage-2 audit item).
 */
export function pickRendition(
  video: VideoManifest,
  preferredLabel: string | undefined,
): Rendition | undefined {
  if (preferredLabel !== undefined) {
    const hit = video.renditions.find((r) => r.label === preferredLabel);
    if (hit !== undefined) return hit;
  }
  return video.renditions[0];
}

/** Price of watching `video` at the rendition `pickRendition` chooses. */
export interface RenditionQuote {
  readonly label: string;
  /** Whole-video price at this rendition (blocks × satsPerBlock). */
  readonly sats: Sats;
  /** Sats per minute of playback at this rendition (0 when the duration is unknown). */
  readonly ratePerMin: Sats;
}

export function quoteFor(
  video: VideoManifest,
  preferredLabel: string | undefined,
): RenditionQuote | undefined {
  const r = pickRendition(video, preferredLabel);
  if (r === undefined) return undefined;
  return {
    label: r.label,
    sats: renditionPriceSats(r, video.price),
    ratePerMin: renditionRatePerMin(r, video.price, video.durationSec),
  };
}

/**
 * "Paid so far" for the seek bar: blocks paid (summed over seeders) → seconds of media at
 * the session's rendition. Bytes/s from `bitrateKbps` when present, else size/duration.
 */
export function paidThroughSec(
  video: VideoManifest,
  renditionLabel: string,
  peers: readonly PeerSpend[],
): number {
  const rendition = video.renditions.find((x) => x.label === renditionLabel);
  if (rendition === undefined) return 0;
  const duration = video.durationSec;
  const bytesPerSec =
    rendition.bitrateKbps !== undefined && rendition.bitrateKbps > 0
      ? rendition.bitrateKbps * 125
      : duration !== undefined && duration > 0
        ? rendition.size / duration
        : 0;
  if (bytesPerSec <= 0) return 0;
  const blocks = peers.reduce((acc, p) => acc + p.blocks, 0);
  const blockSize = video.price.blockSize > 0 ? video.price.blockSize : 1;
  const sec = (blocks * blockSize) / bytesPerSec;
  return duration !== undefined && duration > 0 ? Math.min(sec, duration) : sec;
}

/**
 * The manifest's inline blur-up placeholder, only when it really is an inline image
 * (`data:image/…`, as `Rendition.placeholder` is documented). Anything else — a remote URL
 * that would bypass the T16 hash check, or another scheme — is ignored.
 */
export function safePlaceholder(video: VideoManifest): string | undefined {
  const p = video.renditions.find((r) => r.placeholder !== undefined)?.placeholder;
  return p !== undefined && /^data:image\/[a-z0-9.+-]+[;,]/i.test(p) ? p : undefined;
}

/** Idle chrome state for a video (or the empty stage while loading). */
export function idlePlayerState(video: VideoManifest | undefined, theater: boolean): PlayerState {
  const hasCaptions = video?.renditions.some((r) => (r.captions?.length ?? 0) > 0) ?? false;
  return {
    status: 'idle',
    currentTimeSec: 0,
    durationSec: video?.durationSec ?? 0,
    buffered: [],
    paidThroughSec: 0,
    volume: 1,
    muted: false,
    playbackRate: 1,
    rendition: video?.renditions[0]?.label ?? '',
    captions: hasCaptions ? 'off' : 'unavailable',
    pip: false,
    theater,
    fullscreen: false,
    mini: false,
    spend: undefined,
    errorMessage: undefined,
  };
}

/**
 * Next video for autoplay: the item after `currentId` in the playlist when the playlist has
 * it, otherwise the first kind-21 related video that is not the current one. Shorts never
 * autoplay into a watch page. `null` = nothing to offer.
 */
export function nextUp(
  currentId: NostrEventId,
  playlist: { readonly videoIds: readonly NostrEventId[] } | undefined,
  playlistItems: readonly VideoManifest[],
  related: readonly VideoManifest[],
): { readonly video: VideoManifest; readonly from: 'playlist' | 'related' } | null {
  if (playlist !== undefined) {
    const at = playlist.videoIds.indexOf(currentId);
    if (at >= 0) {
      for (const id of playlist.videoIds.slice(at + 1)) {
        const v = playlistItems.find((x) => x.id === id);
        if (v?.kind === 21) return { video: v, from: 'playlist' };
      }
      // End of the playlist: fall through to related, like YouTube.
    }
  }
  const r = related.find((v) => v.kind === 21 && v.id !== currentId);
  return r === undefined ? null : { video: r, from: 'related' };
}

/** A playlist in the shape this screen needs (`Playlist` from the library, or a shell queue). */
export type WatchPlaylist = Pick<Playlist, 'title' | 'videoIds'> & {
  readonly id?: string | undefined;
};

/** `'pending'` until `adapter.me()` answers; `null` = signed out. */
export type Me = 'pending' | NostrPubkey | null;

/** Everything loaded for the video on screen. */
export interface VideoData {
  readonly video: VideoManifest;
  readonly stats: VideoStats | undefined;
  readonly channel: Profile;
  readonly avatarSrc: string | undefined;
  readonly thumbSrc: string | undefined;
  readonly subscribed: boolean;
  readonly liked: boolean;
  /** `undefined` = unknown (signed out or the read failed). */
  readonly watchLater: boolean | undefined;
  /** Wallet balances when the read succeeded; `undefined` = unknown (never blocks play). */
  readonly balances: ReadonlyMap<MintUrl, Sats> | undefined;
  readonly resumeSec: number;
  readonly prefetchSec: number;
  /** Resolved (T16) first caption track, when the video has one. */
  readonly captionsSrc: string | undefined;
  readonly captionsLang: string | undefined;
}

export type StageGate = 'none' | 'signer' | 'seeders' | 'balance';

/** Whether playback may start at all, and why not, from already-loaded data. */
export function stageGate(data: VideoData, me: Me): StageGate {
  if (me === null) return 'signer';
  if (data.stats?.seedersOnline === 0) return 'seeders';
  const mints = data.video.price.mints;
  if (
    data.balances !== undefined &&
    mints.length > 0 &&
    mints.every((m) => (data.balances?.get(m) ?? 0) <= 0)
  ) {
    return 'balance';
  }
  return 'none';
}
