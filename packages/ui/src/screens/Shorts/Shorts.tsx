/**
 * Shorts screen (build-plan §6.1 row "Shorts"): a vertical feed of kind 22 (9:16) videos,
 * one at a time, YouTube-Shorts style — a centred 9:16 frame on desktop, full-bleed on a
 * phone-width container. Next/previous by scroll-snap (touch swipe and scrollbar), wheel
 * (one short per gesture), ArrowUp/ArrowDown/j/k/PageUp/PageDown, and visible up/down
 * buttons. The route `{ name: 'shorts', videoId? }` starts the feed at that short and is kept
 * in sync through `navigate` as the viewer moves.
 *
 * Money rules (build-plan §6.2 "buffer = money", SECURITY.md "price shown vs price charged"):
 *  - every short shows its price through `SatsBadge` BEFORE its play affordance (DOM order);
 *  - nothing plays on arrival: a short starts only on an explicit action on THAT short (its
 *    play button, or Space while it is the active short with its price on screen);
 *  - moving to another short closes the previous `PlaySession` (stop paying) and leaves the
 *    new one idle behind its own price — moving is never consent to pay for the next one;
 *  - no session, no `<video>` and no blob bytes for neighbours: only the active short can
 *    ever hold a session, and a `play()` that resolves after the viewer moved on (or after
 *    unmount) is closed on arrival;
 *  - `play()` is called with the rendition whose price was shown, and if the session comes
 *    back charging more than that price (a different rendition or policy) it is closed at
 *    once and the new price is shown for fresh consent;
 *  - pause = `PlaySession.pause()` (stop paying, and the UI says so); the end of a short
 *    pauses the session too, so nothing is paid past the last frame.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 * Posters and avatars pass through `adapter.image(url, sha256)` (T16) with a `Skeleton`
 * while pending; titles and descriptions render through `Markdown`.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  MintUrl,
  NostrEventId,
  NostrPubkey,
  PlaySession,
  Profile,
  Rendition,
  Sats,
  VideoManifest,
  VideoStats,
} from '@sovit/core';
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Markdown,
  MintChip,
  SatsBadge,
  Sheet,
  Skeleton,
  ToastStack,
  cx,
  formatDuration,
  formatInteger,
  formatSats,
  isTextEntryTarget,
  mintHost,
  parseMarkdown,
  renditionPriceSats,
  shortPubkey,
  toPlainText,
  type ToastItem,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';

/** Shorts per `adapter.feed({ source: 'shorts' })` page. */
export const SHORTS_PAGE_SIZE = 10;

/** Prefetch depth when neither the prop nor `Settings.prefetchSeconds` is known. */
export const SHORTS_DEFAULT_PREFETCH_SEC = 30;

/** Nutzap amounts offered in the sheet (sats). */
export const SHORTS_NUTZAP_AMOUNTS: readonly number[] = [21, 100, 500, 1000];

/** Wheel distance (px) that counts as "next/previous" within one gesture. */
const WHEEL_THRESHOLD = 40;
/** A wheel gesture ends after this much quiet; one gesture moves at most one short. */
const WHEEL_GESTURE_GAP_MS = 250;
/** Native scrolling (touch swipe, scrollbar) is read once it has settled this long. */
const SCROLL_SETTLE_MS = 120;

export interface ShortsProps extends ScreenProps {
  /** Start the feed at this short (the route's `videoId`). Later changes are followed. */
  readonly videoId?: NostrEventId | undefined;
  /**
   * Prefetch-depth override for `PlaySession.setPrefetchSeconds`; default is
   * `Settings.prefetchSeconds` from the adapter, then `SHORTS_DEFAULT_PREFETCH_SEC`.
   */
  readonly prefetchSeconds?: number | undefined;
  /**
   * Called when a short's paid session has started. The shell should pause whatever else
   * is paying (e.g. the mini-player's session) so two streams are never billed at once.
   */
  readonly onPlaybackStart?: ((videoId: NostrEventId) => void) | undefined;
  /** Shorts per feed page. */
  readonly pageSize?: number | undefined;
  readonly className?: string | undefined;
}

/** What a failed `adapter.play()` means for the viewer (mock messages are prefixed). */
export type ShortsPlayErrorKind =
  'no-seeders' | 'no-balance' | 'no-signer' | 'relay-down' | 'unknown';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

export function shortsPlayErrorKind(err: unknown): ShortsPlayErrorKind {
  const message = messageOf(err);
  if (/no-seeders/i.test(message)) return 'no-seeders';
  if (/no-balance/i.test(message)) return 'no-balance';
  if (/signer/i.test(message)) return 'no-signer';
  if (/relay/i.test(message)) return 'relay-down';
  return 'unknown';
}

/** Human copy for a failed feed load. Never a stack trace (the shell logs those). */
export function describeShortsError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = messageOf(err);
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, so there are no shorts to show. Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not load shorts. Try again in a moment.',
    detail: message || undefined,
  };
}

/**
 * The rendition a short plays in and its full price (blocks × sats per block). The screen
 * asks `play()` for exactly this rendition, so the figure shown is the figure charged.
 */
export function shortPrice(
  video: VideoManifest,
): { readonly rendition: Rendition; readonly sats: Sats } | undefined {
  const rendition = video.renditions[0];
  if (rendition === undefined) return undefined;
  return { rendition, sats: renditionPriceSats(rendition, video.price) };
}

type Me = 'pending' | NostrPubkey | null;

interface FeedState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly items: readonly VideoManifest[];
  readonly next: string | undefined;
  readonly error: unknown;
  readonly more: 'idle' | 'loading' | 'error';
  /** The route's `videoId` could not be found; the feed starts at the latest short. */
  readonly missing: boolean;
}

const LOADING_FEED: FeedState = {
  status: 'loading',
  items: [],
  next: undefined,
  error: undefined,
  more: 'idle',
  missing: false,
};

type PlayStatus = 'idle' | 'starting' | 'playing' | 'paused' | 'ended';

interface Spend {
  readonly total: Sats;
  readonly ratePerMin: Sats;
}

/** Playback of the ACTIVE short only; every other short is implicitly idle. */
interface Playback {
  readonly videoId: NostrEventId | null;
  readonly status: PlayStatus;
  /** `play()` rejected. */
  readonly error: unknown;
  /** The media element failed after the session started (session already closed). */
  readonly mediaError: boolean;
  /** The session asked for more than the price shown; it was closed unused. */
  readonly priceChanged: boolean;
  readonly spend: Spend | undefined;
  readonly currentTime: number;
  readonly duration: number;
}

const IDLE: Playback = {
  videoId: null,
  status: 'idle',
  error: undefined,
  mediaError: false,
  priceChanged: false,
  spend: undefined,
  currentTime: 0,
  duration: 0,
};

interface Binding {
  readonly videoId: NostrEventId;
  readonly session: PlaySession;
}

/** Why a short cannot be started right now (shown in place of its play button). */
type Gate = 'none' | 'pending' | 'signer' | 'seeders' | 'balance' | 'unplayable';

interface ZapState {
  readonly video: VideoManifest;
  readonly amount: number;
  readonly mint: MintUrl | undefined;
  readonly message: string;
  readonly busy: boolean;
  readonly error: unknown;
}

function dedupe(
  existing: readonly VideoManifest[],
  incoming: readonly VideoManifest[],
): readonly VideoManifest[] {
  const seen = new Set(existing.map((v) => v.id));
  const out = [...existing];
  for (const v of incoming) {
    if (!seen.has(v.id)) {
      seen.add(v.id);
      out.push(v);
    }
  }
  return out;
}

function closeQuietly(session: PlaySession): void {
  try {
    void session.close().catch(() => undefined);
  } catch {
    // A transport that throws on close has nothing left to pay for.
  }
}

/** `play()` on the element; autoplay policy / unsupported sources are not errors here. */
function safePlay(el: HTMLVideoElement | null): void {
  if (el === null) return;
  try {
    void el.play().catch(() => undefined);
  } catch {
    // jsdom and MSE-less runtimes: the session state is what the UI shows.
  }
}

function safePause(el: HTMLVideoElement | null): void {
  if (el === null) return;
  try {
    el.pause();
  } catch {
    // see safePlay
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, a[href], input, select, textarea, summary, [role="button"]') !== null
  );
}

function pickMint(
  mints: readonly MintUrl[],
  balances: ReadonlyMap<MintUrl, Sats> | undefined,
  amount: number,
): MintUrl | undefined {
  return mints.find((m) => (balances?.get(m) ?? 0) >= amount) ?? mints[0];
}

function channelName(profile: Profile | null | undefined, pubkey: NostrPubkey): string {
  return profile?.displayName ?? profile?.name ?? shortPubkey(pubkey);
}

/**
 * The Shorts screen: one 9:16 short at a time, its price before its play button, a side
 * rail of actions and a paid session only while the viewer explicitly plays it.
 */
export function Shorts({
  adapter,
  navigate,
  miniPlayer,
  videoId,
  prefetchSeconds,
  onPlaybackStart,
  pageSize = SHORTS_PAGE_SIZE,
  className,
}: ShortsProps): ReactElement {
  const id = useId();
  const aliveRef = useRef(true);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onStartRef = useRef(onPlaybackStart);
  onStartRef.current = onPlaybackStart;

  // ---- feed ----------------------------------------------------------------------------
  const [feed, setFeed] = useState<FeedState>(LOADING_FEED);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const [reloadGen, setReloadGen] = useState(0);
  const reloadGenRef = useRef(reloadGen);
  reloadGenRef.current = reloadGen;
  const startIdRef = useRef<NostrEventId | undefined>(videoId);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const pendingJumpRef = useRef<number | null>(null);
  const feedElRef = useRef<HTMLDivElement | null>(null);
  const moreBusyRef = useRef(false);
  const [noticeHidden, setNoticeHidden] = useState(false);
  const [descOpen, setDescOpen] = useState(false);

  const items = feed.items;
  const hasTail = feed.status === 'ready' && items.length > 0;
  const maxIndex = hasTail ? items.length : Math.max(0, items.length - 1);
  const maxIndexRef = useRef(maxIndex);
  maxIndexRef.current = maxIndex;
  const activeVideo: VideoManifest | undefined = items[activeIndex];
  const activeId = activeVideo?.id ?? null;
  const activeIdRef = useRef<NostrEventId | null>(activeId);
  activeIdRef.current = activeId;

  // ---- session (active short only) ------------------------------------------------------
  const [binding, setBinding] = useState<Binding | null>(null);
  const bindingRef = useRef<Binding | null>(null);
  const spendUnsubRef = useRef<(() => void) | null>(null);
  const startTokenRef = useRef(0);
  const [playback, setPlayback] = useState<Playback>(IDLE);
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const prefetchRef = useRef(prefetchSeconds ?? SHORTS_DEFAULT_PREFETCH_SEC);
  const [priceOverride, setPriceOverride] = useState<Readonly<Record<string, Sats>>>({});
  const priceOverrideRef = useRef(priceOverride);
  priceOverrideRef.current = priceOverride;

  /** Stops paying and forgets the session. No state updates (safe on unmount). */
  const releaseSession = useCallback((): void => {
    startTokenRef.current += 1; // a play() still in flight is now stale → closed on arrival
    spendUnsubRef.current?.();
    spendUnsubRef.current = null;
    const b = bindingRef.current;
    bindingRef.current = null;
    if (b !== null) {
      safePause(videoElRef.current);
      closeQuietly(b.session);
    }
  }, []);

  const closeSession = useCallback((): void => {
    releaseSession();
    setBinding(null);
    setPlayback(IDLE);
  }, [releaseSession]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      releaseSession();
    };
  }, [releaseSession]);

  // ---- moving between shorts ------------------------------------------------------------
  const scrollToIndex = useCallback((index: number, smooth: boolean): void => {
    const node = feedElRef.current;
    if (node === null) return;
    // jsdom (and very old engines) have no Element.scrollTo — fall back to scrollTop.
    const el = node as unknown as {
      scrollTo?: (o: ScrollToOptions) => void;
      scrollTop: number;
      readonly clientHeight: number;
    };
    const top = index * el.clientHeight;
    // No explicit `behavior` for a smooth move: the stylesheet decides (reduced motion).
    if (el.scrollTo !== undefined) el.scrollTo(smooth ? { top } : { top, behavior: 'instant' });
    else el.scrollTop = top;
  }, []);

  /**
   * Makes short `index` the active one. Always closes the previous short's session first;
   * the new short is left idle behind its own price (moving is not consent to pay).
   */
  const activate = useCallback(
    (index: number, source: 'user' | 'scroll' | 'route'): void => {
      const next = Math.min(Math.max(index, 0), maxIndexRef.current);
      if (next === activeIndexRef.current) return;
      closeSession();
      activeIndexRef.current = next;
      const video = feedRef.current.items[next];
      activeIdRef.current = video?.id ?? null;
      setActiveIndex(next);
      setDescOpen(false);
      if (source !== 'scroll') scrollToIndex(next, true);
      if (video !== undefined && source !== 'route') {
        navigateRef.current({ name: 'shorts', videoId: video.id });
      }
    },
    [closeSession, scrollToIndex],
  );
  const activateRef = useRef(activate);
  activateRef.current = activate;

  // ---- feed load (initial, retry, or a route to a short that is not loaded) --------------
  useEffect(() => {
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    const startId = startIdRef.current;
    closeSession();
    moreBusyRef.current = false;
    setNoticeHidden(false);
    setFeed(LOADING_FEED);
    void (async (): Promise<void> => {
      try {
        const page = await adapter.feed({ source: 'shorts', limit: pageSize });
        if (cancelled()) return;
        let list = dedupe([], page.items);
        let start = 0;
        let missing = false;
        if (startId !== undefined) {
          const at = list.findIndex((v) => v.id === startId);
          if (at >= 0) {
            start = at;
          } else {
            let found: VideoManifest | null;
            try {
              found = await adapter.video(startId);
            } catch {
              found = null;
            }
            if (cancelled()) return;
            if (found !== null) {
              const first = found;
              list = [first, ...list.filter((v) => v.id !== first.id)];
            } else {
              missing = true;
            }
          }
        }
        activeIndexRef.current = start;
        activeIdRef.current = list[start]?.id ?? null;
        pendingJumpRef.current = start;
        setActiveIndex(start);
        setFeed({
          status: 'ready',
          items: list,
          next: page.next,
          error: undefined,
          more: 'idle',
          missing,
        });
      } catch (err: unknown) {
        if (cancelled()) return;
        setFeed({ ...LOADING_FEED, status: 'error', error: err });
      }
    })();
    return () => {
      ac.abort();
    };
  }, [adapter, closeSession, pageSize, reloadGen]);

  // Jump (no animation, no navigation) to the start short once its slide exists.
  useEffect(() => {
    if (feed.status !== 'ready' || pendingJumpRef.current === null) return;
    scrollToIndex(pendingJumpRef.current, false);
    pendingJumpRef.current = null;
  }, [feed.status, scrollToIndex]);

  // Follow the route: our own navigate() comes back as the active id (no-op); anything
  // else (back/forward, a link) activates that short, or reloads the feed starting there.
  const lastVideoIdProp = useRef(videoId);
  useEffect(() => {
    if (videoId === lastVideoIdProp.current) return;
    lastVideoIdProp.current = videoId;
    if (videoId === undefined || videoId === activeIdRef.current) return;
    const f = feedRef.current;
    const at = f.status === 'ready' ? f.items.findIndex((v) => v.id === videoId) : -1;
    if (at >= 0) {
      activate(at, 'route');
      return;
    }
    startIdRef.current = videoId;
    setReloadGen((g) => g + 1);
  }, [activate, videoId]);

  const loadMore = useCallback((): void => {
    const f = feedRef.current;
    if (f.status !== 'ready' || f.next === undefined || moreBusyRef.current) return;
    moreBusyRef.current = true;
    const gen = reloadGenRef.current;
    setFeed((prev) => ({ ...prev, more: 'loading' }));
    adapter.feed({ source: 'shorts', limit: pageSize, cursor: f.next }).then(
      (page) => {
        if (!aliveRef.current || gen !== reloadGenRef.current) return;
        moreBusyRef.current = false;
        setFeed((prev) => ({
          ...prev,
          items: dedupe(prev.items, page.items),
          next: page.next,
          more: 'idle',
        }));
      },
      () => {
        if (!aliveRef.current || gen !== reloadGenRef.current) return;
        moreBusyRef.current = false;
        setFeed((prev) => ({ ...prev, more: 'error' }));
      },
    );
  }, [adapter, pageSize]);

  // Fetch the next page while the viewer is two shorts from the end.
  useEffect(() => {
    if (feed.status !== 'ready' || feed.next === undefined || feed.more !== 'idle') return;
    if (activeIndex >= feed.items.length - 2) loadMore();
  }, [activeIndex, feed.items.length, feed.more, feed.next, feed.status, loadMore]);

  // ---- identity, library, wallet, settings (once per adapter) ----------------------------
  const [me, setMe] = useState<Me>('pending');
  const [subs, setSubs] = useState<ReadonlySet<NostrPubkey>>(new Set());
  const [liked, setLiked] = useState<ReadonlySet<NostrEventId>>(new Set());
  const [balances, setBalances] = useState<ReadonlyMap<MintUrl, Sats> | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    adapter.me().then(
      (pk) => {
        if (cancelled) return;
        setMe(pk);
        if (pk === null) return;
        adapter.subscriptions().then(
          (list) => {
            if (!cancelled) setSubs(new Set(list));
          },
          () => undefined,
        );
        adapter.library.liked().then(
          (list) => {
            if (!cancelled) setLiked(new Set(list.map((v) => v.id)));
          },
          () => undefined,
        );
      },
      () => {
        if (!cancelled) setMe(null);
      },
    );
    adapter.wallet.balances().then(
      (b) => {
        if (!cancelled) setBalances(b);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    if (prefetchSeconds !== undefined) {
      prefetchRef.current = prefetchSeconds;
      return undefined;
    }
    let cancelled = false;
    adapter.settings().then(
      (s) => {
        if (!cancelled) prefetchRef.current = s.prefetchSeconds;
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, prefetchSeconds]);

  const refreshBalances = useCallback((): void => {
    adapter.wallet.balances().then(
      (b) => {
        if (aliveRef.current) setBalances(b);
      },
      () => undefined,
    );
  }, [adapter]);

  // ---- per-short resolution: posters (T16), channel profiles + avatars, stats ------------
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string | null>>>({});
  const [profiles, setProfiles] = useState<Readonly<Record<string, Profile | null>>>({});
  const [avatars, setAvatars] = useState<Readonly<Record<string, string>>>({});
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats>>>({});
  const requested = useRef({
    thumbs: new Set<string>(),
    profiles: new Set<string>(),
    stats: new Set<string>(),
  });

  const loadStats = useCallback(
    (videoId: NostrEventId): void => {
      requested.current.stats.add(videoId);
      adapter.stats(videoId).then(
        (s) => {
          if (aliveRef.current) setStats((prev) => ({ ...prev, [videoId]: s }));
        },
        () => undefined,
      );
    },
    [adapter],
  );

  useEffect(() => {
    const req = requested.current;
    for (const video of items) {
      if (!req.thumbs.has(video.id)) {
        req.thumbs.add(video.id);
        const image = video.renditions[0]?.image;
        if (image) {
          adapter.image(image.url, image.sha256).then(
            (src) => {
              if (aliveRef.current) setThumbs((prev) => ({ ...prev, [video.id]: src }));
            },
            () => {
              // Hash mismatch / unreachable: no poster, just the dark frame (T16).
              if (aliveRef.current) setThumbs((prev) => ({ ...prev, [video.id]: null }));
            },
          );
        } else {
          setThumbs((prev) => ({ ...prev, [video.id]: null }));
        }
      }
      if (!req.profiles.has(video.author)) {
        const pubkey = video.author;
        req.profiles.add(pubkey);
        adapter.profile(pubkey).then(
          (p) => {
            if (!aliveRef.current) return;
            setProfiles((prev) => ({ ...prev, [pubkey]: p }));
            const picture = p?.picture;
            if (picture) {
              adapter.image(picture).then(
                (src) => {
                  if (aliveRef.current) setAvatars((prev) => ({ ...prev, [pubkey]: src }));
                },
                () => undefined,
              );
            }
          },
          () => {
            if (aliveRef.current) setProfiles((prev) => ({ ...prev, [pubkey]: null }));
          },
        );
      }
      if (!req.stats.has(video.id)) loadStats(video.id);
    }
  }, [adapter, items, loadStats]);

  // ---- gates, price --------------------------------------------------------------------
  const shownPrice = (video: VideoManifest): Sats | undefined =>
    priceOverride[video.id] ?? shortPrice(video)?.sats;

  const gateFor = (video: VideoManifest): Gate => {
    if (shortPrice(video) === undefined) return 'unplayable';
    if (me === 'pending') return 'pending';
    if (me === null) return 'signer';
    if (stats[video.id]?.seedersOnline === 0) return 'seeders';
    const mints = video.price.mints;
    if (
      balances !== undefined &&
      mints.length > 0 &&
      mints.every((m) => (balances.get(m) ?? 0) <= 0)
    ) {
      return 'balance';
    }
    return 'none';
  };
  const gateRef = useRef(gateFor);
  gateRef.current = gateFor;

  // ---- playback ------------------------------------------------------------------------
  /** Starts a paid session for the ACTIVE short. Its price is on screen at every call site. */
  const startPlayback = useCallback(
    (video: VideoManifest): void => {
      if (video.id !== activeIdRef.current || bindingRef.current !== null) return;
      if (gateRef.current(video) !== 'none') return;
      const price = shortPrice(video);
      if (price === undefined) return;
      const shown = priceOverrideRef.current[video.id] ?? price.sats;
      startTokenRef.current += 1;
      const token = startTokenRef.current;
      setPlayback({ ...IDLE, videoId: video.id, status: 'starting' });
      adapter.play(video.id, price.rendition.label).then(
        (session) => {
          if (
            !aliveRef.current ||
            token !== startTokenRef.current ||
            activeIdRef.current !== video.id
          ) {
            // Unmounted or moved on while connecting: never keep a paying session.
            closeQuietly(session);
            return;
          }
          const rendition =
            video.renditions.find((r) => r.label === session.rendition) ?? price.rendition;
          const charged = renditionPriceSats(rendition, session.policy);
          if (charged > shown) {
            // Price shown vs price charged: refuse, show the real price, ask again.
            closeQuietly(session);
            setPriceOverride((prev) => ({ ...prev, [video.id]: charged }));
            setPlayback({ ...IDLE, videoId: video.id, priceChanged: true });
            return;
          }
          try {
            session.setPrefetchSeconds(prefetchRef.current);
          } catch {
            // The adapter keeps its own default depth.
          }
          const b: Binding = { videoId: video.id, session };
          bindingRef.current = b;
          spendUnsubRef.current = session.onSpend((s) => {
            if (!aliveRef.current || bindingRef.current?.session !== session) return;
            setPlayback((prev) => (prev.videoId === video.id ? { ...prev, spend: s } : prev));
          });
          setBinding(b);
          setPlayback({
            ...IDLE,
            videoId: video.id,
            status: 'playing',
            duration: video.durationSec ?? 0,
          });
          onStartRef.current?.(video.id);
        },
        (err: unknown) => {
          if (!aliveRef.current || token !== startTokenRef.current) return;
          setPlayback({ ...IDLE, videoId: video.id, error: err });
        },
      );
    },
    [adapter],
  );

  const pausePlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null) return;
    b.session.pause(); // stops paying — not merely a media pause
    safePause(videoElRef.current);
    setPlayback((prev) => ({ ...prev, status: 'paused' }));
  }, []);

  const resumePlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null) return;
    const replay = playbackRef.current.status === 'ended';
    const el = videoElRef.current;
    if (replay && el !== null) {
      try {
        el.currentTime = 0;
      } catch {
        // see safePlay
      }
    }
    b.session.resume();
    safePlay(el);
    setPlayback((prev) => ({ ...prev, status: 'playing', ...(replay ? { currentTime: 0 } : {}) }));
  }, []);

  const togglePlay = useCallback(
    (video: VideoManifest): void => {
      if (video.id !== activeIdRef.current) return;
      if (bindingRef.current?.videoId === video.id) {
        if (playbackRef.current.status === 'playing') pausePlayback();
        else resumePlayback();
        return;
      }
      if (playbackRef.current.status === 'starting') return;
      startPlayback(video);
    },
    [pausePlayback, resumePlayback, startPlayback],
  );

  const endPlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null) return;
    b.session.pause(); // buffer = money — never pay past the end
    setPlayback((prev) => ({ ...prev, status: 'ended' }));
  }, []);

  const mediaFailed = useCallback(
    (videoId: NostrEventId): void => {
      closeSession();
      setPlayback({ ...IDLE, videoId, mediaError: true });
    },
    [closeSession],
  );

  // The element exists only once a session is bound (an explicit play); start it then.
  useEffect(() => {
    if (binding === null) return;
    const el = videoElRef.current;
    if (el === null) return;
    el.muted = mutedRef.current;
    safePlay(el);
  }, [binding]);

  useEffect(() => {
    const el = videoElRef.current;
    if (el !== null) el.muted = muted;
  }, [muted]);

  // ---- toasts --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>): void => {
    toastSeq.current += 1;
    const item: ToastItem = { ...toast, id: `shorts-toast-${String(toastSeq.current)}` };
    setToasts((prev) => [...prev, item]);
  }, []);
  const dismissToast = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);
  const promptSignIn = useCallback((): void => {
    pushToast({
      tone: 'info',
      title: 'Sign in to do that',
      description: 'Connect a Nostr signer to like, subscribe and send nutzaps.',
      action: {
        label: 'Connect signer',
        onClick: () => {
          navigateRef.current({ name: 'settings' });
        },
      },
    });
  }, [pushToast]);

  // ---- social actions ------------------------------------------------------------------
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const markBusy = useCallback((key: string, on: boolean): void => {
    setBusy((prev) => {
      const s = new Set(prev);
      if (on) s.add(key);
      else s.delete(key);
      return s;
    });
  }, []);
  const [likeDelta, setLikeDelta] = useState<Readonly<Record<string, number>>>({});

  const toggleLike = (video: VideoManifest): void => {
    if (me === 'pending') return;
    if (me === null) {
      promptSignIn();
      return;
    }
    const key = `like:${video.id}`;
    if (busy.has(key)) return;
    const next = !liked.has(video.id);
    markBusy(key, true);
    adapter.react(video.id, next ? '+' : '-').then(
      () => {
        if (!aliveRef.current) return;
        markBusy(key, false);
        setLiked((prev) => {
          const s = new Set(prev);
          if (next) s.add(video.id);
          else s.delete(video.id);
          return s;
        });
        setLikeDelta((prev) => ({ ...prev, [video.id]: (prev[video.id] ?? 0) + (next ? 1 : -1) }));
      },
      () => {
        if (!aliveRef.current) return;
        markBusy(key, false);
        pushToast({ tone: 'error', title: 'Could not register your like' });
      },
    );
  };

  const toggleSubscribe = (pubkey: NostrPubkey): void => {
    if (me === 'pending') return;
    if (me === null) {
      promptSignIn();
      return;
    }
    const key = `sub:${pubkey}`;
    if (busy.has(key)) return;
    const next = !subs.has(pubkey);
    markBusy(key, true);
    (next ? adapter.subscribe(pubkey) : adapter.unsubscribe(pubkey)).then(
      () => {
        if (!aliveRef.current) return;
        markBusy(key, false);
        setSubs((prev) => {
          const s = new Set(prev);
          if (next) s.add(pubkey);
          else s.delete(pubkey);
          return s;
        });
      },
      () => {
        if (!aliveRef.current) return;
        markBusy(key, false);
        pushToast({
          tone: 'error',
          title: next ? 'Could not subscribe' : 'Could not unsubscribe',
        });
      },
    );
  };

  // ---- nutzap sheet --------------------------------------------------------------------
  const [zap, setZap] = useState<ZapState | null>(null);
  const zapRef = useRef(zap);
  zapRef.current = zap;

  const openZap = (video: VideoManifest): void => {
    if (me === 'pending') return;
    if (me === null) {
      promptSignIn();
      return;
    }
    const amount = SHORTS_NUTZAP_AMOUNTS[0] ?? 21;
    setZap({
      video,
      amount,
      mint: pickMint(video.price.mints, balances, amount),
      message: '',
      busy: false,
      error: undefined,
    });
    refreshBalances();
  };

  const closeZap = useCallback((): void => {
    setZap(null);
  }, []);

  const sendZap = (): void => {
    const z = zapRef.current;
    if (z === null || z.busy || z.mint === undefined) return;
    const mint = z.mint;
    const amount = z.amount as Sats;
    const message = z.message.trim();
    const name = channelName(profiles[z.video.author], z.video.author);
    setZap({ ...z, busy: true, error: undefined });
    const sent =
      message.length > 0
        ? adapter.nutzap(z.video.id, amount, mint, message)
        : adapter.nutzap(z.video.id, amount, mint);
    sent.then(
      () => {
        if (!aliveRef.current) return;
        setZap(null);
        pushToast({
          tone: 'sats',
          title: 'Nutzap sent',
          description: `${formatSats(amount)} to ${name} via ${mintHost(mint)}`,
        });
        refreshBalances();
      },
      (err: unknown) => {
        if (!aliveRef.current) return;
        setZap((prev) => (prev === null ? null : { ...prev, busy: false, error: err }));
      },
    );
  };

  // ---- navigation helpers --------------------------------------------------------------
  const openChannel = (pubkey: NostrPubkey): void => {
    navigate({ name: 'channel', pubkey });
  };
  const openComments = (video: VideoManifest): void => {
    navigate({ name: 'watch', videoId: video.id });
  };

  // ---- keyboard (document-level while mounted, like YouTube Shorts) --------------------
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandlerRef.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (zapRef.current !== null || feedRef.current.status !== 'ready') return;
    if (isTextEntryTarget(e.target)) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'ArrowDown' || key === 'PageDown' || key === 'j') {
      e.preventDefault();
      activate(activeIndexRef.current + 1, 'user');
    } else if (key === 'ArrowUp' || key === 'PageUp' || key === 'k') {
      e.preventDefault();
      activate(activeIndexRef.current - 1, 'user');
    } else if (key === ' ' && !isInteractiveTarget(e.target)) {
      const video = feedRef.current.items[activeIndexRef.current];
      if (video === undefined) return;
      e.preventDefault();
      togglePlay(video);
    } else if (key === 'm' && bindingRef.current !== null) {
      e.preventDefault();
      setMuted((m) => !m);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      keyHandlerRef.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // ---- wheel: one short per gesture (native listener — React's is passive) -------------
  useEffect(() => {
    const el = feedElRef.current;
    if (el === null) return undefined;
    const state = {
      acc: 0,
      locked: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || zapRef.current !== null || feedRef.current.status !== 'ready') return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const scroller =
        e.target instanceof Element ? e.target.closest('.nf-shorts__desc--open') : null;
      if (scroller !== null && scroller.scrollHeight > scroller.clientHeight) return;
      e.preventDefault();
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.locked = false;
        state.acc = 0;
        state.timer = undefined;
      }, WHEEL_GESTURE_GAP_MS);
      if (state.locked) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight || 800 : 1;
      state.acc += e.deltaY * scale;
      if (Math.abs(state.acc) >= WHEEL_THRESHOLD) {
        const dir = state.acc > 0 ? 1 : -1;
        state.locked = true;
        state.acc = 0;
        activateRef.current(activeIndexRef.current + dir, 'user');
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (state.timer !== undefined) clearTimeout(state.timer);
    };
  }, []);

  // ---- native scroll (touch swipe, scrollbar): read the snapped short once settled ------
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (scrollTimerRef.current !== undefined) clearTimeout(scrollTimerRef.current);
    },
    [],
  );
  const onFeedScroll = (): void => {
    if (scrollTimerRef.current !== undefined) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = undefined;
      const el = feedElRef.current;
      if (!aliveRef.current || el === null || el.clientHeight <= 0) return;
      activateRef.current(Math.round(el.scrollTop / el.clientHeight), 'scroll');
    }, SCROLL_SETTLE_MS);
  };

  // ---- render --------------------------------------------------------------------------
  const setSize = feed.next === undefined ? items.length : -1;

  const card = (node: ReactNode): ReactElement => <div className="nf-shorts__card">{node}</div>;

  const renderPlayError = (video: VideoManifest, err: unknown): ReactElement => {
    const retry = (): void => {
      startPlayback(video);
    };
    switch (shortsPlayErrorKind(err)) {
      case 'no-seeders':
        return card(<EmptyState compact preset="no-seeders-online" onAction={retry} />);
      case 'no-balance':
        return card(
          <EmptyState
            compact
            preset="no-balance-at-mint"
            onAction={() => {
              navigate({ name: 'wallet' });
            }}
          />,
        );
      case 'no-signer':
        return card(
          <EmptyState
            compact
            preset="signer-not-detected"
            onAction={() => {
              navigate({ name: 'settings' });
            }}
          />,
        );
      case 'relay-down':
        return card(
          <ErrorState
            compact
            title="Relay down"
            description="The network did not answer, so this short could not start. Nothing was paid."
            detail={messageOf(err) || undefined}
            onRetry={retry}
          />,
        );
      case 'unknown':
        return card(
          <ErrorState
            compact
            title="Could not start this short"
            description="Nothing was paid. Try again in a moment."
            detail={messageOf(err) || undefined}
            onRetry={retry}
          />,
        );
    }
  };

  const renderGate = (video: VideoManifest, gate: Gate): ReactElement | null => {
    switch (gate) {
      case 'signer':
        return card(
          <EmptyState
            compact
            preset="signer-not-detected"
            description="Connect a Nostr signer (NIP-07 extension, NIP-46 remote signer, or a local key) to pay for and play shorts."
            onAction={() => {
              navigate({ name: 'settings' });
            }}
          />,
        );
      case 'seeders':
        return card(
          <EmptyState
            compact
            preset="no-seeders-online"
            description="Nobody is sharing this short right now. Retry, or swipe on to the next one."
            onAction={() => {
              loadStats(video.id);
            }}
          />,
        );
      case 'balance':
        return card(
          <EmptyState
            compact
            preset="no-balance-at-mint"
            description={`This short is priced at ${video.price.mints.map((m) => mintHost(m)).join(', ')}, where you hold no sats. Top up there to play it.`}
            onAction={() => {
              navigate({ name: 'wallet' });
            }}
          />,
        );
      case 'unplayable':
        return card(
          <EmptyState
            compact
            icon="videoOff"
            title="Not playable"
            description="This short lists no playable rendition. Swipe on to the next one."
          />,
        );
      case 'none':
      case 'pending':
        return null;
    }
  };

  const renderCenter = (
    video: VideoManifest,
    pb: Playback,
    bound: boolean,
    price: Sats | undefined,
  ): ReactElement | null => {
    if (bound) {
      if (pb.status === 'paused' || pb.status === 'ended') {
        const ended = pb.status === 'ended';
        return (
          <div className="nf-shorts__center">
            <IconButton
              icon={ended ? 'replay' : 'play'}
              label={ended ? 'Replay' : 'Resume'}
              tone="overlay"
              size="lg"
              className="nf-shorts__play"
              onClick={() => {
                togglePlay(video);
              }}
            />
          </div>
        );
      }
      return null;
    }
    const gate = gateFor(video);
    let body: ReactNode;
    if (pb.error !== undefined) body = renderPlayError(video, pb.error);
    else if (pb.mediaError)
      body = card(
        <ErrorState
          compact
          title="This short could not be played"
          description="The stream stopped and nothing more is being paid for."
          onRetry={() => {
            startPlayback(video);
          }}
        />,
      );
    else body = renderGate(video, gate);
    const starting = pb.status === 'starting';
    return (
      <div className="nf-shorts__center">
        {price !== undefined ? (
          <SatsBadge
            sats={price}
            overlay
            className="nf-shorts__price"
            label={`Price: ${formatSats(price)} to watch this short in full`}
          />
        ) : null}
        {pb.priceChanged ? (
          <p className="nf-shorts__note" role="status">
            The price changed since it was shown. Check it and press play again.
          </p>
        ) : null}
        {body ?? (
          <>
            <IconButton
              icon="play"
              label={price !== undefined ? `Play — ${formatSats(price)}` : 'Play'}
              tone="overlay"
              size="lg"
              className="nf-shorts__play"
              disabled={gate === 'pending' || starting}
              aria-busy={starting || undefined}
              onClick={() => {
                togglePlay(video);
              }}
            />
            <p className="nf-shorts__hint">
              {starting
                ? 'Starting…'
                : `${formatDuration(video.durationSec ?? 0)} · you pay per block as it streams`}
            </p>
          </>
        )}
      </div>
    );
  };

  const renderSlide = (video: VideoManifest, index: number): ReactElement => {
    const active = index === activeIndex;
    const pb = active && playback.videoId === video.id ? playback : IDLE;
    const bound = active && binding !== null && binding.videoId === video.id;
    const price = shownPrice(video);
    const profile = profiles[video.author];
    const name = channelName(profile, video.author);
    const st = stats[video.id];
    const titleId = `${id}-title-${String(index)}`;
    const descId = `${id}-desc-${String(index)}`;
    const thumb = thumbs[video.id];
    const isLiked = liked.has(video.id);
    const likes = Math.max(0, (st?.reactions ?? 0) + (likeDelta[video.id] ?? 0));
    const comments = st?.comments ?? 0;
    const subscribed = subs.has(video.author);
    const isMine = me !== 'pending' && me !== null && me === video.author;
    const open = active && descOpen;
    return (
      <article
        key={video.id}
        className={cx('nf-shorts__slide', active && 'nf-shorts__slide--active')}
        aria-labelledby={titleId}
        aria-posinset={index + 1}
        aria-setsize={setSize}
        aria-current={active || undefined}
        data-video-id={video.id}
        inert={!active}
      >
        <div className="nf-shorts__short">
          <div className="nf-shorts__frame">
            {bound ? (
              <video
                ref={videoElRef}
                className="nf-shorts__video"
                src={
                  binding.session.source.kind === 'mediasource'
                    ? undefined
                    : binding.session.source.url
                }
                poster={thumb ?? undefined}
                playsInline
                preload="auto"
                onClick={() => {
                  togglePlay(video);
                }}
                onTimeUpdate={(e) => {
                  const el = e.currentTarget;
                  const t = el.currentTime;
                  const d = el.duration;
                  setPlayback((prev) =>
                    prev.videoId === video.id
                      ? {
                          ...prev,
                          currentTime: Number.isFinite(t) ? t : prev.currentTime,
                          duration: Number.isFinite(d) && d > 0 ? d : prev.duration,
                        }
                      : prev,
                  );
                }}
                onEnded={endPlayback}
                onError={() => {
                  mediaFailed(video.id);
                }}
              />
            ) : thumb ? (
              <img className="nf-shorts__poster" src={thumb} alt="" decoding="async" />
            ) : thumb === undefined ? (
              <Skeleton variant="block" className="nf-shorts__poster-skeleton" />
            ) : null}
            <div className="nf-shorts__scrim" aria-hidden="true" />
            {bound ? (
              <div className="nf-shorts__top">
                <div className="nf-shorts__status">
                  {price !== undefined ? (
                    <SatsBadge
                      sats={price}
                      size="sm"
                      overlay
                      label={`Price: ${formatSats(price)} to watch this short in full`}
                    />
                  ) : null}
                  {pb.status === 'playing' && pb.spend !== undefined ? (
                    <SatsBadge
                      sats={pb.spend.ratePerMin}
                      variant="rate"
                      size="sm"
                      prefix="streaming"
                      label={`Streaming ${formatInteger(pb.spend.ratePerMin)} sats per minute — ${formatInteger(pb.spend.total)} sats so far`}
                    />
                  ) : null}
                  {pb.status === 'paused' ? (
                    <span className="nf-shorts__paystate">
                      <Icon name="pause" size={14} />
                      Paused — not paying
                    </span>
                  ) : null}
                </div>
                <div className="nf-shorts__controls">
                  <IconButton
                    icon={pb.status === 'playing' ? 'pause' : 'play'}
                    label={pb.status === 'playing' ? 'Pause (space)' : 'Play (space)'}
                    tone="overlay"
                    onClick={() => {
                      togglePlay(video);
                    }}
                  />
                  <IconButton
                    icon={muted ? 'volumeOff' : 'volumeUp'}
                    label={muted ? 'Unmute (m)' : 'Mute (m)'}
                    tone="overlay"
                    pressed={muted}
                    onClick={() => {
                      setMuted((m) => !m);
                    }}
                  />
                </div>
              </div>
            ) : null}
            {renderCenter(video, pb, bound, price)}
            <div className="nf-shorts__info">
              <div className="nf-shorts__channel">
                <button
                  type="button"
                  className="nf-shorts__channel-link"
                  onClick={() => {
                    openChannel(video.author);
                  }}
                >
                  <Avatar name={name} seed={video.author} src={avatars[video.author]} size="md" />
                  <span className="nf-shorts__channel-name">{name}</span>
                </button>
                {isMine ? null : (
                  <Button
                    size="sm"
                    variant={subscribed ? 'secondary' : 'primary'}
                    className={cx('nf-shorts__subscribe', subscribed && 'nf-shorts__subscribe--on')}
                    loading={busy.has(`sub:${video.author}`)}
                    aria-label={subscribed ? `Unsubscribe from ${name}` : `Subscribe to ${name}`}
                    onClick={() => {
                      toggleSubscribe(video.author);
                    }}
                  >
                    {subscribed ? 'Subscribed' : 'Subscribe'}
                  </Button>
                )}
              </div>
              <div className="nf-shorts__title" role="heading" aria-level={2} id={titleId}>
                <Markdown source={video.title} />
              </div>
              {video.description.trim() !== '' ? (
                <div className="nf-shorts__about">
                  <div
                    id={descId}
                    className={cx('nf-shorts__desc', open && 'nf-shorts__desc--open')}
                  >
                    <Markdown source={video.description} />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="nf-shorts__more"
                    aria-expanded={open}
                    aria-controls={descId}
                    onClick={() => {
                      setDescOpen((o) => !o);
                    }}
                  >
                    {open ? 'Less' : 'More'}
                  </Button>
                </div>
              ) : null}
            </div>
            {bound ? (
              <progress
                className="nf-shorts__progress"
                max={pb.duration > 0 ? pb.duration : 1}
                value={Math.min(pb.currentTime, pb.duration > 0 ? pb.duration : 1)}
                aria-label="Playback progress"
              />
            ) : null}
          </div>
          <div className="nf-shorts__rail" role="group" aria-label="Actions for this short">
            <Button
              variant={isLiked ? 'primary' : 'secondary'}
              pressed={isLiked}
              loading={busy.has(`like:${video.id}`)}
              title={isLiked ? 'Remove your like' : 'Like this short'}
              onClick={() => {
                toggleLike(video);
              }}
            >
              {likes > 0 ? `Like · ${formatInteger(likes)}` : 'Like'}
            </Button>
            <Button
              variant="secondary"
              title="Read and write comments on the watch page"
              onClick={() => {
                openComments(video);
              }}
            >
              {comments > 0 ? `Comments · ${formatInteger(comments)}` : 'Comments'}
            </Button>
            <Button
              variant="accent"
              icon="bolt"
              onClick={() => {
                openZap(video);
              }}
            >
              Nutzap
            </Button>
          </div>
        </div>
      </article>
    );
  };

  const skeletonShort = (key: string): ReactElement => (
    <div key={key} className="nf-shorts__slide" aria-hidden="true">
      <div className="nf-shorts__short">
        <Skeleton variant="block" className="nf-shorts__frame-skeleton" />
        <div className="nf-shorts__rail">
          <Skeleton variant="block" className="nf-shorts__rail-skeleton" />
          <Skeleton variant="block" className="nf-shorts__rail-skeleton" />
          <Skeleton variant="block" className="nf-shorts__rail-skeleton" />
        </div>
      </div>
    </div>
  );

  const renderTail = (): ReactElement => {
    const index = items.length;
    const active = activeIndex === index;
    let body: ReactElement;
    if (feed.more === 'error') {
      body = (
        <ErrorState
          title="Could not load more shorts"
          description="The next page did not arrive. The shorts above are still here."
          onRetry={loadMore}
        />
      );
    } else if (feed.next !== undefined) {
      body = (
        <div className="nf-shorts__short" aria-hidden="true">
          <Skeleton variant="block" className="nf-shorts__frame-skeleton" />
        </div>
      );
    } else {
      body = (
        <EmptyState
          icon="check"
          title="You're all caught up"
          description="That is every short for now. New ones land here as creators publish them."
          action="Back to the first short"
          onAction={() => {
            activate(0, 'user');
          }}
        />
      );
    }
    return (
      <article
        key="tail"
        className={cx('nf-shorts__slide', 'nf-shorts__slide--tail')}
        aria-label={
          feed.more === 'error'
            ? 'Could not load more shorts'
            : feed.next !== undefined
              ? 'Loading more shorts'
              : 'End of shorts'
        }
        aria-busy={feed.more === 'loading' || undefined}
        inert={!active}
      >
        {body}
      </article>
    );
  };

  const renderBody = (): ReactNode => {
    if (feed.status === 'loading') return skeletonShort('loading');
    if (feed.status === 'error') {
      const e = describeShortsError(feed.error);
      return (
        <div className="nf-shorts__slide nf-shorts__slide--state">
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              setReloadGen((g) => g + 1);
            }}
          />
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="nf-shorts__slide nf-shorts__slide--state">
          <EmptyState
            icon="videoOff"
            title="No shorts yet"
            description={
              feed.missing
                ? 'That short is not available any more, and nobody has published another one yet. Vertical videos show up here as soon as creators post them.'
                : 'Nobody has published a short yet. Vertical videos under a minute show up here as soon as creators post them.'
            }
            action="Browse Home"
            onAction={() => {
              navigate({ name: 'home' });
            }}
          />
        </div>
      );
    }
    return (
      <>
        {items.map(renderSlide)}
        {renderTail()}
      </>
    );
  };

  const ready = feed.status === 'ready' && items.length > 0;
  const announce = ready
    ? activeVideo !== undefined
      ? `Short ${String(activeIndex + 1)}${setSize > 0 ? ` of ${String(setSize)}` : ''}: ${toPlainText(parseMarkdown(activeVideo.title))}`
      : feed.next === undefined
        ? 'End of shorts'
        : 'Loading more shorts'
    : '';

  // Nutzap sheet data.
  const zapVideo = zap?.video;
  const zapName = zapVideo ? channelName(profiles[zapVideo.author], zapVideo.author) : '';
  const zapMints = zapVideo?.price.mints ?? [];
  const zapNoBalance =
    balances !== undefined &&
    zapMints.length > 0 &&
    zapMints.every((m) => (balances.get(m) ?? 0) <= 0);
  const zapMint = zap?.mint;
  /** The chosen mint when it holds less than the chosen amount. */
  const zapShortAt =
    zap !== null &&
    zapMint !== undefined &&
    balances !== undefined &&
    (balances.get(zapMint) ?? 0) < zap.amount
      ? zapMint
      : undefined;
  const canSend = zapMint !== undefined && !zapNoBalance && zapShortAt === undefined;

  return (
    <section
      className={cx('nf-shorts', className)}
      aria-labelledby={`${id}-heading`}
      data-state={feed.status}
    >
      <h1 id={`${id}-heading`} className="nf-shorts__sr">
        Shorts
      </h1>
      <div
        ref={feedElRef}
        className="nf-shorts__feed"
        role={ready ? 'feed' : undefined}
        aria-label={ready ? 'Shorts feed' : undefined}
        aria-busy={feed.status === 'loading' || feed.more === 'loading' || undefined}
        onScroll={onFeedScroll}
      >
        {renderBody()}
      </div>
      {ready ? (
        <div className="nf-shorts__nav">
          <IconButton
            icon="chevronLeft"
            label="Previous short (k)"
            className="nf-shorts__nav-btn"
            disabled={activeIndex <= 0}
            onClick={() => {
              activate(activeIndexRef.current - 1, 'user');
            }}
          />
          <IconButton
            icon="chevronRight"
            label="Next short (j)"
            className="nf-shorts__nav-btn"
            disabled={activeIndex >= maxIndex}
            onClick={() => {
              activate(activeIndexRef.current + 1, 'user');
            }}
          />
        </div>
      ) : null}
      {ready && feed.missing && !noticeHidden ? (
        <div className="nf-shorts__notice" role="status">
          <Icon name="info" size={18} />
          <span>That short is not available any more — here are the latest shorts.</span>
          <IconButton
            icon="close"
            label="Dismiss"
            size="sm"
            onClick={() => {
              setNoticeHidden(true);
            }}
          />
        </div>
      ) : null}
      <p className="nf-shorts__sr" aria-live="polite">
        {announce}
      </p>
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-shorts__mini">{miniPlayer}</div>
      ) : null}
      <Sheet
        open={zap !== null}
        onClose={closeZap}
        title={`Nutzap ${zapName}`}
        footer={
          zap !== null ? (
            <div className="nf-shorts__zap-foot">
              <SatsBadge sats={zap.amount} prefix="You send" />
              <Button
                variant="accent"
                icon="bolt"
                loading={zap.busy}
                disabled={!canSend}
                onClick={sendZap}
              >
                Send nutzap
              </Button>
            </div>
          ) : undefined
        }
      >
        {zap !== null ? (
          <div className="nf-shorts__zap">
            <p className="nf-shorts__zap-lead">
              A nutzap is a tip sent straight to the creator as Cashu ecash (NIP-61). It is separate
              from what you pay seeders to watch.
            </p>
            <fieldset className="nf-shorts__zap-group">
              <legend className="nf-shorts__zap-legend">Amount (sats)</legend>
              <div className="nf-shorts__zap-row">
                {SHORTS_NUTZAP_AMOUNTS.map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    pressed={a === zap.amount}
                    onClick={() => {
                      setZap((prev) =>
                        prev === null
                          ? null
                          : {
                              ...prev,
                              amount: a,
                              mint:
                                prev.mint !== undefined &&
                                (balances === undefined || (balances.get(prev.mint) ?? 0) >= a)
                                  ? prev.mint
                                  : pickMint(prev.video.price.mints, balances, a),
                            },
                      );
                    }}
                  >
                    {formatInteger(a)}
                  </Button>
                ))}
              </div>
            </fieldset>
            <fieldset className="nf-shorts__zap-group">
              <legend className="nf-shorts__zap-legend">Mint</legend>
              <div className="nf-shorts__zap-row">
                {zapMints.map((m) => (
                  <MintChip
                    key={m}
                    mint={m}
                    balance={balances?.get(m)}
                    selected={m === zap.mint}
                    onSelect={(mint) => {
                      setZap((prev) => (prev === null ? null : { ...prev, mint }));
                    }}
                  />
                ))}
              </div>
            </fieldset>
            <label className="nf-shorts__zap-field">
              <span className="nf-shorts__zap-legend">Message (optional)</span>
              <input
                type="text"
                className="nf-shorts__zap-input"
                maxLength={140}
                value={zap.message}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const message = e.target.value;
                  setZap((prev) => (prev === null ? null : { ...prev, message }));
                }}
              />
            </label>
            {zapNoBalance ? (
              <EmptyState
                compact
                preset="no-balance-at-mint"
                description={`${zapName} accepts nutzaps at ${zapMints.map((m) => mintHost(m)).join(', ')}, where you hold no sats. Top up there first.`}
                onAction={() => {
                  setZap(null);
                  navigate({ name: 'wallet' });
                }}
              />
            ) : zapShortAt !== undefined ? (
              <p className="nf-shorts__zap-warn" role="status">
                Not enough at {mintHost(zapShortAt)} for this amount — pick a smaller amount or
                another mint.
              </p>
            ) : null}
            {zap.error !== undefined ? (
              <ErrorState
                compact
                title="Nutzap not sent"
                description="Nothing left your wallet. Try again in a moment."
                detail={messageOf(zap.error) || undefined}
              />
            ) : null}
          </div>
        ) : null}
      </Sheet>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </section>
  );
}
