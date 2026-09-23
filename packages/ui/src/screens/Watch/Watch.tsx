/**
 * Watch screen (build-plan §6.1 row "Watch", §6.2 player behaviours).
 *
 * Layout follows YouTube (design brief: "clean, like the mainstream sites"): a 16:9 stage,
 * title, channel row (Subscribe + "sats to creator"), like / nutzap / overflow (save, keyboard
 * shortcuts, report), the description and NIP-22 comments through the Markdown subset only,
 * and an "Up next" rail (optional playlist panel, related videos, a Shorts shelf).
 *
 * Money rules (build-plan §6.2 "buffer = money", execution plan Stage-2 "price shown vs price
 * charged"):
 *  - the price is the FIRST thing in the stage's DOM, before any play affordance, and it is
 *    the price of the rendition that will actually play: `quoteFor()` picks it and the SAME
 *    label is passed to `adapter.play()`; a session that comes back at another rendition is
 *    closed unplayed. Nothing autoplays on mount;
 *  - `PlaySession.pause()` = stop paying, and the UI says so ("Paused — not paying", 0 sats/min
 *    in the chip and the peer panel). The element's own pause (PiP window, media keys) pauses
 *    the session too;
 *  - `setPrefetchSeconds` gets the prop, else `Settings.prefetchSeconds`, else 30;
 *  - rendition switching goes through `PlaySession.switchRendition`; the player's quality menu
 *    shows every rendition's price and the difference first, and a toast states it after;
 *  - autoplay-next is a cancellable countdown showing the next video's price at the rendition
 *    that will play; if the freshly loaded manifest prices it higher, autoplay is refused;
 *  - related videos are never prefetched — only their hash-verified thumbnails load;
 *  - thumbnails/avatars/captions go through `adapter.image(url, sha256)` (T16).
 *
 * Mini-player handshake (docs/lanes/L5-Watch.md): `onMiniPlayer(session, videoId, handoff)`
 * gives the live session to the shell — on `i` / the mini-player button, on in-screen
 * navigation to a non-watch route, and on unmount while a session is live — after which the
 * shell owns it. `resumeSession` hands one back. Without `onMiniPlayer` the mini-player
 * floats in place and unmount closes the session.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 * `MockNetworkAdapter` appears only in stories/tests, never here.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type {
  NostrEventId,
  NostrPubkey,
  PeerSpend,
  PlaySession,
  Profile,
  Sats,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import {
  Button,
  ChannelRow,
  ChannelRowSkeleton,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Markdown,
  Player,
  SatsBadge,
  Skeleton,
  SkeletonLines,
  ToastStack,
  VideoCardSkeleton,
  cx,
  formatDuration,
  formatInteger,
  formatPaidViews,
  formatRelativeTime,
  isTextEntryTarget,
  keyboardAction,
  shortPubkey,
  mintHost,
  type PlayerAction,
  type PlayerState,
  type TimeRange,
  type ToastItem,
  type ToastTone,
} from '../../components/index.js';
import type { Route, ScreenProps } from '../shared/route.js';
import {
  WATCH_DEFAULT_PREFETCH_SEC,
  WATCH_PLAYLIST_MAX,
  WATCH_PROGRESS_INTERVAL_MS,
  WATCH_RELATED_COUNT,
  WATCH_UP_NEXT_SECONDS,
  describeWatchError,
  idlePlayerState,
  nextUp,
  paidThroughSec,
  playErrorKind,
  quoteFor,
  resumePositionSec,
  safePlaceholder,
  stageGate,
  type Me,
  type RenditionQuote,
  type VideoData,
  type WatchHandoff,
  type WatchPlaylist,
} from './model.js';
import { useResolvers } from './useResolvers.js';
import { WatchComments } from './WatchComments.js';
import { NutzapSheet, ReportSheet, ShortcutsSheet } from './WatchSheets.js';
import { PeerOverlay, PricePanel, StageNote, UpNextOverlay } from './WatchParts.js';
import { WatchRelated, type RelatedList } from './WatchRelated.js';

export interface WatchProps extends ScreenProps {
  /** The video to watch (`Route { name: 'watch', videoId }`). A change reloads the screen. */
  readonly videoId: NostrEventId;
  /** Route `t` deep link: start position in seconds. Overrides library-history resume. */
  readonly startAtSec?: number | undefined;
  /**
   * Mini-player handshake, Watch → shell. Called ONCE per hand-off with the live session, the
   * video id and a `WatchHandoff` (position, paused, volume…). From then on the SHELL owns the
   * session — it keeps playing (and paying) in the shell's mini-player, and the shell must
   * `close()` it when that is dismissed. Triggers: the mini-player control (`i`), in-screen
   * navigation to a non-watch route, and unmount while a session is live and not ended.
   * Without this prop the mini-player floats in place and unmount closes the session.
   */
  readonly onMiniPlayer?:
    ((session: PlaySession, videoId: NostrEventId, handoff: WatchHandoff) => void) | undefined;
  /**
   * Mini-player handshake, shell → Watch: a session previously handed off, given back when
   * the viewer expands the mini-player. Adopted when `resumeSession.videoId` is the video on
   * screen — no new `play()`, no new price (it was shown when the session started).
   */
  readonly resumeSession?: WatchHandoff | undefined;
  /** Playlist context (Library → Watch): shows the playlist panel; autoplay-next follows it. */
  readonly playlist?: WatchPlaylist | undefined;
  /** Initial state of the Autoplay switch (autoplay-next, price shown first). Default true. */
  readonly autoplayNext?: boolean | undefined;
  /** Prefetch-depth override for `PlaySession.setPrefetchSeconds`. */
  readonly prefetchSeconds?: number | undefined;
  /** "now" for relative timestamps; stories/tests pin it so PNGs are diffable. */
  readonly now?: UnixSeconds | number | undefined;
  readonly className?: string | undefined;
}

type VideoPhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: unknown }
  | { readonly status: 'not-found' }
  | { readonly status: 'ready'; readonly data: VideoData };

interface SessionBinding {
  readonly session: PlaySession;
  readonly videoId: NostrEventId;
  readonly unsubPeers: () => void;
  readonly unsubSpend: () => void;
}

interface UpNext {
  readonly video: VideoManifest;
  readonly quote: RenditionQuote;
  readonly from: 'playlist' | 'related';
  readonly left: number;
}

const LOADING_LIST: RelatedList = { status: 'loading', items: [], error: undefined };
const PROGRESS_STEP_SEC = WATCH_PROGRESS_INTERVAL_MS / 1000;

/** `HTMLMediaElement.play()` without unhandled rejections (autoplay policy, aborted loads). */
function mediaPlay(el: HTMLVideoElement): void {
  try {
    Promise.resolve(el.play()).catch(() => undefined);
  } catch {
    // not playable (no source yet); the element reports its own error state
  }
}

function mediaPause(el: HTMLVideoElement): void {
  try {
    el.pause();
  } catch {
    // nothing to pause
  }
}

/** The element can drive the clock (a real media pipeline, not a stub or a dead source). */
function elementDrivesClock(el: HTMLVideoElement): boolean {
  // NETWORK_EMPTY (no loader ran — jsdom) and NETWORK_NO_SOURCE (unsupported/failed source)
  // mean nothing will ever advance `currentTime`; the screen's 1 Hz clock stands in then.
  return el.error === null && el.networkState !== 0 && el.networkState !== 3;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

/** Close a session without surfacing its failure, and remember it can never be adopted. */
function closeQuietly(session: PlaySession, spent: WeakSet<PlaySession>): void {
  spent.add(session);
  void session.close().catch(() => undefined);
}

function timeRanges(r: TimeRanges): readonly TimeRange[] {
  const out: TimeRange[] = [];
  for (let i = 0; i < r.length; i++) out.push({ start: r.start(i), end: r.end(i) });
  return out;
}

/**
 * The Watch screen: one video, its channel, comments and what's next — plus, behind a price
 * shown before any play affordance, a `PlaySession` paying seeders per block.
 */
export function Watch({
  adapter,
  navigate,
  miniPlayer,
  videoId,
  startAtSec,
  onMiniPlayer,
  resumeSession,
  playlist,
  autoplayNext,
  prefetchSeconds,
  now,
  className,
}: WatchProps): ReactElement {
  const id = useId();
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const resolvers = useResolvers(adapter);
  const { profiles, avatars, thumbs, resolveProfile, resolveThumb, resolveStats } = resolvers;

  // ---- refs threaded through callbacks -------------------------------------------------
  const aliveRef = useRef(true);
  const bindingRef = useRef<SessionBinding | null>(null);
  const connectingRef = useRef(false);
  /** True once the live session was handed to the shell: nothing here may close it. */
  const handedOffRef = useRef(false);
  /** Set by the up-next countdown: when THAT video loads at THAT price, start playback. */
  const pendingAutoplayRef = useRef<{
    readonly videoId: NostrEventId;
    readonly label: string;
    readonly sats: Sats;
  } | null>(null);
  /** Bumped by every video load; an answer for an older load is stale. */
  const loadTokenRef = useRef(0);
  /**
   * Sessions this screen closed, or adopted and still owns: never adoptable (again) through
   * `resumeSession`. A hand-off removes its session, so the shell can give it back.
   */
  const spentRef = useRef(new WeakSet<PlaySession>());
  const positionSecRef = useRef(0);
  const lastRecordRef = useRef(0);
  const spendRef = useRef<{ readonly total: Sats; readonly ratePerMin: Sats } | undefined>(
    undefined,
  );
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<VideoData | null>(null);
  const relatedRef = useRef<readonly VideoManifest[]>([]);
  const playlistItemsRef = useRef<readonly VideoManifest[]>([]);
  const switchingRef = useRef(false);
  const onMiniPlayerRef = useRef(onMiniPlayer);
  onMiniPlayerRef.current = onMiniPlayer;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;

  // ---- toasts --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeqRef = useRef(0);
  const pushToast = useCallback(
    (tone: ToastTone, title: string, description?: string, action?: ToastItem['action']): void => {
      if (!aliveRef.current) return;
      toastSeqRef.current += 1;
      const item: ToastItem = {
        id: `toast-${String(toastSeqRef.current)}`,
        tone,
        title,
        ...(description !== undefined ? { description } : {}),
        ...(action !== undefined ? { action } : {}),
      };
      setToasts((prev) => [...prev, item]);
    },
    [],
  );
  const dismissToast = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  // ---- routing inside the screen ---------------------------------------------------------
  // The up-next countdown advances the screen even if the shell ignores the navigation
  // announcement; a changed `videoId` prop always wins and clears the override.
  const [localId, setLocalId] = useState<NostrEventId | null>(null);
  useEffect(() => {
    setLocalId(null);
  }, [videoId]);
  const activeId = localId ?? videoId;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // ---- identity --------------------------------------------------------------------------
  const [me, setMe] = useState<Me>('pending');
  const meRef = useRef(me);
  meRef.current = me;
  useEffect(() => {
    const ac = new AbortController();
    adapter.me().then(
      (pk) => {
        if (!ac.signal.aborted) setMe(pk);
      },
      () => {
        // An identity that cannot be read degrades to the signed-out experience.
        if (!ac.signal.aborted) setMe(null);
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter]);

  // ---- playback state ----------------------------------------------------------------------
  const [player, setPlayer] = useState<PlayerState>(() => idlePlayerState(undefined, false));
  const playerRef = useRef(player);
  playerRef.current = player;
  const [binding, setBinding] = useState<SessionBinding | null>(null);
  const [peers, setPeers] = useState<readonly PeerSpend[]>([]);
  const [peersSeen, setPeersSeen] = useState(false);
  const [showPeers, setShowPeers] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [playError, setPlayError] = useState<unknown>(undefined);
  const [handedOff, setHandedOff] = useState(false);
  const [upNext, setUpNext] = useState<UpNext | null>(null);
  const upNextRef = useRef(upNext);
  upNextRef.current = upNext;
  /** Preferred rendition label (persists across videos in this screen, like YouTube). */
  const [quality, setQuality] = useState<string | undefined>(undefined);
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const [autoplay, setAutoplay] = useState(autoplayNext ?? true);
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  useEffect(() => {
    setAutoplay(autoplayNext ?? true);
  }, [autoplayNext]);

  const patchPlayer = useCallback((patch: Partial<PlayerState>): void => {
    setPlayer((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Records the position of the LIVE session's video (never a video that was not played). */
  const recordProgressNow = useCallback((): void => {
    const b = bindingRef.current;
    const who = meRef.current;
    if (b === null || who === null || who === 'pending') return;
    void adapter.library
      .recordProgress(b.videoId, Math.max(0, Math.round(positionSecRef.current)))
      .catch(() => undefined);
  }, [adapter]);

  const detachSession = useCallback((mode: 'close' | 'hand-off'): void => {
    const b = bindingRef.current;
    if (b === null) return;
    b.unsubPeers();
    b.unsubSpend();
    bindingRef.current = null;
    setBinding(null);
    if (mode === 'close') closeQuietly(b.session, spentRef.current);
  }, []);

  const attachSession = useCallback(
    (
      session: PlaySession,
      data: VideoData,
      opts?: { readonly positionSec?: number; readonly paused?: boolean },
    ): void => {
      session.setPrefetchSeconds(data.prefetchSec);
      const video = data.video;
      const unsubPeers = session.onPeers((list) => {
        if (!aliveRef.current) return;
        setPeers(list);
        setPeersSeen(true);
        for (const p of list) resolveProfile(p.pubkey);
        const paid = paidThroughSec(video, session.rendition, list);
        setPlayer((prev) =>
          prev.paidThroughSec === paid ? prev : { ...prev, paidThroughSec: paid },
        );
      });
      const unsubSpend = session.onSpend((s) => {
        if (!aliveRef.current) return;
        spendRef.current = s;
        // Paused = not paying: the chip keeps the total but reads 0 sats/min.
        setPlayer((prev) =>
          prev.status === 'playing'
            ? { ...prev, spend: s }
            : { ...prev, spend: { total: s.total, ratePerMin: 0 as Sats } },
        );
      });
      bindingRef.current = { session, videoId: video.id, unsubPeers, unsubSpend };
      handedOffRef.current = false;
      connectingRef.current = false;
      const position = opts?.positionSec ?? data.resumeSec;
      const paused = opts?.paused === true;
      positionSecRef.current = position;
      lastRecordRef.current = Math.floor(position);
      spendRef.current = undefined;
      setBinding(bindingRef.current);
      setPeers([]);
      setPeersSeen(false);
      setConnecting(false);
      setPlayError(undefined);
      setHandedOff(false);
      setQuality(session.rendition);
      setPlayer((prev) => ({
        ...idlePlayerState(video, prev.theater),
        status: paused ? 'paused' : 'playing',
        currentTimeSec: position,
        rendition: session.rendition,
        captions: data.captionsSrc !== undefined ? 'off' : 'unavailable',
        volume: prev.volume,
        muted: prev.muted,
        playbackRate: prev.playbackRate,
      }));
    },
    [resolveProfile],
  );

  const patchData = useCallback((patch: Partial<VideoData>): void => {
    const cur = dataRef.current;
    if (cur === null) return;
    dataRef.current = { ...cur, ...patch };
    setPhase((prev) =>
      prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, ...patch } } : prev,
    );
  }, []);

  /**
   * Start playback. Every path that reaches this call site showed the price of exactly
   * `quoteFor(video, label)` first; that label is what `adapter.play` receives.
   */
  const startPlayback = useCallback(
    (label?: string): void => {
      const data = dataRef.current;
      if (data === null || bindingRef.current !== null || connectingRef.current) return;
      if (stageGate(data, meRef.current) !== 'none') return;
      const quote = quoteFor(data.video, label ?? qualityRef.current);
      if (quote === undefined) return;
      const token = loadTokenRef.current;
      const expectedId = data.video.id;
      connectingRef.current = true;
      setConnecting(true);
      setPlayError(undefined);
      adapter.play(expectedId, quote.label).then(
        (session) => {
          const latest = dataRef.current;
          if (!aliveRef.current || loadTokenRef.current !== token || latest === null) {
            // Stale (unmounted or moved on): never leak a paying session.
            connectingRef.current = false;
            closeQuietly(session, spentRef.current);
            return;
          }
          if (session.videoId !== expectedId || session.rendition !== quote.label) {
            // Price shown ≠ price charged: refuse the session before it plays a frame.
            session.pause();
            closeQuietly(session, spentRef.current);
            connectingRef.current = false;
            setConnecting(false);
            setPlayError(
              new Error(
                `The network offered ${session.rendition} instead of the ${quote.label} you were shown the price for, so nothing was played.`,
              ),
            );
            return;
          }
          attachSession(session, latest);
        },
        (err: unknown) => {
          connectingRef.current = false;
          if (!aliveRef.current || loadTokenRef.current !== token) return;
          setConnecting(false);
          setPlayError(err);
        },
      );
    },
    [adapter, attachSession],
  );

  // ---- video load (catalog + stats + channel + wallet + history) -------------------------
  const [phase, setPhase] = useState<VideoPhase>({ status: 'loading' });
  const [loadGen, setLoadGen] = useState(0);
  const deepLinkSec = activeId === videoId ? startAtSec : undefined;

  useEffect(() => {
    if (me === 'pending') return undefined;
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    loadTokenRef.current += 1;
    // Reset the whole per-video state. A pending autoplay survives ONLY for its own video.
    if (pendingAutoplayRef.current !== null && pendingAutoplayRef.current.videoId !== activeId) {
      pendingAutoplayRef.current = null;
    }
    recordProgressNow();
    detachSession('close');
    handedOffRef.current = false;
    connectingRef.current = false;
    setHandedOff(false);
    setConnecting(false);
    setPlayError(undefined);
    setPeers([]);
    setPeersSeen(false);
    setShowPeers(false);
    setUpNext(null);
    positionSecRef.current = 0;
    lastRecordRef.current = 0;
    spendRef.current = undefined;
    dataRef.current = null;
    setPlayer((prev) => idlePlayerState(undefined, prev.theater));
    setPhase({ status: 'loading' });

    void (async (): Promise<void> => {
      try {
        const video = await adapter.video(activeId);
        if (cancelled()) return;
        if (video === null) {
          setPhase({ status: 'not-found' });
          return;
        }
        const signedIn = me !== null;
        const [statsR, profileR, subsR, likedR, laterR, historyR, settingsR, balancesR] =
          await Promise.allSettled([
            adapter.stats(video.id),
            adapter.profile(video.author),
            signedIn ? adapter.subscriptions() : Promise.resolve(null),
            signedIn ? adapter.library.liked() : Promise.resolve(null),
            signedIn ? adapter.library.watchLater() : Promise.resolve(null),
            signedIn ? adapter.library.history() : Promise.resolve(null),
            prefetchSeconds !== undefined ? Promise.resolve(null) : adapter.settings(),
            adapter.wallet.balances(),
          ]);
        if (cancelled()) return;
        const ok = <T,>(r: PromiseSettledResult<T>): T | undefined =>
          r.status === 'fulfilled' ? r.value : undefined;
        const stats = ok(statsR);
        const profile = ok(profileR) ?? null;
        const subs = ok(subsR) ?? null;
        const liked = ok(likedR) ?? null;
        const later = ok(laterR) ?? null;
        const history = ok(historyR) ?? null;
        const settings = ok(settingsR) ?? null;
        const balances = ok(balancesR);

        const historySec = history?.items.find((h) => h.video.id === video.id)?.positionSec ?? 0;
        const resumeSec =
          deepLinkSec !== undefined && deepLinkSec > 0
            ? Math.floor(deepLinkSec)
            : resumePositionSec(video, historySec);
        const prefetchSec =
          prefetchSeconds ?? settings?.prefetchSeconds ?? WATCH_DEFAULT_PREFETCH_SEC;
        const captionsTrack = video.renditions.flatMap((r) => r.captions ?? [])[0];
        const channel: Profile = profile ?? {
          pubkey: video.author,
          nip05Status: 'none',
          fetchedAt: 0 as UnixSeconds,
        };
        const data: VideoData = {
          video,
          stats,
          channel,
          avatarSrc: undefined,
          thumbSrc: undefined,
          subscribed: subs?.includes(video.author) ?? false,
          liked: liked?.some((v) => v.id === video.id) ?? false,
          watchLater: later === null ? undefined : later.some((v) => v.id === video.id),
          balances,
          resumeSec,
          prefetchSec,
          captionsSrc: undefined,
          captionsLang: captionsTrack?.lang,
        };
        dataRef.current = data;
        setPhase({ status: 'ready', data });
        setPlayer((prev) => ({
          ...idlePlayerState(video, prev.theater),
          currentTimeSec: resumeSec,
          captions: captionsTrack === undefined ? 'unavailable' : 'off',
        }));

        // T16: every blob is hash-verified by the adapter before it may render. A rejected
        // or unreachable image simply never replaces the placeholder — never an error here.
        const thumb = video.renditions.find((r) => r.image !== undefined)?.image;
        if (thumb !== undefined) {
          adapter.image(thumb.url, thumb.sha256).then(
            (src) => {
              if (!cancelled()) patchData({ thumbSrc: src });
            },
            () => undefined,
          );
        }
        if (channel.picture !== undefined && channel.picture !== '') {
          adapter.image(channel.picture).then(
            (src) => {
              if (!cancelled()) patchData({ avatarSrc: src });
            },
            () => undefined,
          );
        }
        if (captionsTrack !== undefined) {
          adapter.image(captionsTrack.url, captionsTrack.sha256).then(
            (src) => {
              if (!cancelled()) patchData({ captionsSrc: src });
            },
            () => undefined,
          );
        }
      } catch (err: unknown) {
        if (!cancelled()) setPhase({ status: 'error', error: err });
      }
    })();

    return () => {
      ac.abort();
    };
    // `recordProgressNow` is stable per adapter; listed for completeness.
  }, [
    adapter,
    activeId,
    me,
    loadGen,
    prefetchSeconds,
    deepLinkSec,
    detachSession,
    patchData,
    recordProgressNow,
  ]);

  const readyData = phase.status === 'ready' ? phase.data : null;

  // Mini-player handshake, shell → Watch: adopt a handed-back session for this video.
  useEffect(() => {
    if (readyData === null || resumeSession === undefined) return;
    const handed = resumeSession.session;
    if (spentRef.current.has(handed) || resumeSession.videoId !== readyData.video.id) return;
    if (bindingRef.current !== null || connectingRef.current) return;
    spentRef.current.add(handed); // owned from here; a later hand-off releases it again
    pendingAutoplayRef.current = null;
    attachSession(resumeSession.session, readyData, {
      positionSec: resumeSession.positionSec,
      paused: resumeSession.paused,
    });
    setPlayer((prev) => ({
      ...prev,
      volume: resumeSession.volume,
      muted: resumeSession.muted,
      playbackRate: resumeSession.playbackRate,
    }));
  }, [readyData, resumeSession, attachSession]);

  // Autoplay-next: the countdown showed the price; start only if it still holds.
  useEffect(() => {
    const pending = pendingAutoplayRef.current;
    if (readyData === null || pending?.videoId !== readyData.video.id) return;
    pendingAutoplayRef.current = null;
    if (bindingRef.current !== null) return;
    const quote = quoteFor(readyData.video, pending.label);
    if (quote?.label !== pending.label || quote.sats > pending.sats) {
      pushToast(
        'info',
        'Autoplay stopped — the price changed',
        'The price shown in the countdown no longer matches this video. Check it, then press play.',
      );
      return;
    }
    setQuality(pending.label);
    startPlayback(pending.label);
  }, [readyData, startPlayback, pushToast]);

  // ---- hand-off / close -----------------------------------------------------------------------
  const makeHandoff = (b: SessionBinding): WatchHandoff => {
    const st = playerRef.current;
    return {
      session: b.session,
      videoId: b.videoId,
      title: dataRef.current?.video.title ?? '',
      positionSec: positionSecRef.current,
      paused: st.status !== 'playing',
      volume: st.volume,
      muted: st.muted,
      playbackRate: st.playbackRate,
    };
  };
  const makeHandoffRef = useRef(makeHandoff);
  makeHandoffRef.current = makeHandoff;

  /** Watch → shell. Returns false when there is nothing to hand (or nobody to take it). */
  const handOff = useCallback((): boolean => {
    const b = bindingRef.current;
    const take = onMiniPlayerRef.current;
    if (b === null || take === undefined || playerRef.current.status === 'ended') return false;
    recordProgressNow();
    const handoff = makeHandoffRef.current(b);
    spentRef.current.delete(b.session);
    detachSession('hand-off');
    handedOffRef.current = true;
    setHandedOff(true);
    setPeers([]);
    setShowPeers(false);
    setUpNext(null);
    setPlayer((prev) => idlePlayerState(dataRef.current?.video, prev.theater));
    take(b.session, b.videoId, handoff);
    return true;
  }, [detachSession, recordProgressNow]);

  /** Stop playback and payment; back to the priced poster. */
  const closePlayback = useCallback((): void => {
    recordProgressNow();
    detachSession('close');
    connectingRef.current = false;
    setConnecting(false);
    setUpNext(null);
    setShowPeers(false);
    setPeers([]);
    setHandedOff(false);
    handedOffRef.current = false;
    setPlayer((prev) => ({
      ...idlePlayerState(dataRef.current?.video, prev.theater),
      volume: prev.volume,
      muted: prev.muted,
      playbackRate: prev.playbackRate,
    }));
  }, [detachSession, recordProgressNow]);

  // Unmount: cancel every pending fetch; hand the live session to the shell's mini-player
  // when there is one (mini-player on navigate), else close it — never leak a paying session.
  const handOffRef = useRef(handOff);
  handOffRef.current = handOff;
  const recordProgressNowRef = useRef(recordProgressNow);
  recordProgressNowRef.current = recordProgressNow;
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      const b = bindingRef.current;
      if (b !== null && !handOffRef.current()) {
        recordProgressNowRef.current();
        b.unsubPeers();
        b.unsubSpend();
        bindingRef.current = null;
        closeQuietly(b.session, spentRef.current);
      }
      aliveRef.current = false;
    };
  }, []);

  /** Navigation out of the screen: another video closes this session; elsewhere hands off. */
  const leaveTo = useCallback(
    (route: Route): void => {
      if (route.name === 'watch' && route.videoId === activeIdRef.current) return;
      if (bindingRef.current !== null) {
        if (route.name === 'watch' || route.name === 'shorts') closePlayback();
        else handOff();
      }
      navigate(route);
    },
    [closePlayback, handOff, navigate],
  );

  // ---- related videos (never prefetched: metadata + verified thumbnails only) --------------
  const [related, setRelated] = useState<RelatedList>(LOADING_LIST);
  const [relatedGen, setRelatedGen] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setRelated(LOADING_LIST);
    relatedRef.current = [];
    adapter.related(activeId, WATCH_RELATED_COUNT).then(
      (items) => {
        if (ac.signal.aborted) return;
        relatedRef.current = items;
        setRelated({ status: 'ready', items, error: undefined });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setRelated({ status: 'error', items: [], error: err });
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter, activeId, relatedGen]);

  // ---- playlist panel (catalog metadata for the queue; never media) -------------------------
  const [playlistItems, setPlaylistItems] = useState<RelatedList>(LOADING_LIST);
  const playlistKey = playlist === undefined ? '' : playlist.videoIds.join(',');
  useEffect(() => {
    const ids = playlistRef.current?.videoIds.slice(0, WATCH_PLAYLIST_MAX) ?? [];
    playlistItemsRef.current = [];
    if (ids.length === 0) {
      setPlaylistItems({ status: 'ready', items: [], error: undefined });
      return undefined;
    }
    const ac = new AbortController();
    setPlaylistItems(LOADING_LIST);
    void Promise.allSettled(ids.map((x) => adapter.video(x))).then((results) => {
      if (ac.signal.aborted) return;
      const items = results.flatMap((r) =>
        r.status === 'fulfilled' && r.value !== null ? [r.value] : [],
      );
      playlistItemsRef.current = items;
      setPlaylistItems({ status: 'ready', items, error: undefined });
    });
    return () => {
      ac.abort();
    };
  }, [adapter, playlistKey]);

  useEffect(() => {
    for (const v of [...related.items, ...playlistItems.items]) {
      resolveThumb(v);
      resolveProfile(v.author);
      resolveStats(v.id);
    }
  }, [related, playlistItems, resolveThumb, resolveProfile, resolveStats]);

  // ---- the video's end: stop paying, record the final position, offer the next video -----
  const endPlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null || playerRef.current.status !== 'playing') return;
    b.session.pause(); // buffer = money — never pay past the end
    const duration = playerRef.current.durationSec;
    if (duration > 0) positionSecRef.current = duration;
    recordProgressNow();
    setPlayer((prev) => ({
      ...prev,
      status: 'ended',
      currentTimeSec: positionSecRef.current,
      spend:
        spendRef.current === undefined
          ? undefined
          : { total: spendRef.current.total, ratePerMin: 0 as Sats },
    }));
    if (!autoplayRef.current) return;
    const next = nextUp(
      b.videoId,
      playlistRef.current,
      playlistItemsRef.current,
      relatedRef.current,
    );
    const quote = next === null ? undefined : quoteFor(next.video, qualityRef.current);
    if (next !== null && quote !== undefined) {
      setUpNext({ video: next.video, quote, from: next.from, left: WATCH_UP_NEXT_SECONDS });
    }
  }, [recordProgressNow]);
  const endPlaybackRef = useRef(endPlayback);
  endPlaybackRef.current = endPlayback;

  // ---- position clock + progress recording (every ~5 s while playing) ----------------------
  // A real <video> drives the clock; when the element cannot (jsdom, a fixture source) the
  // position advances at the playback rate once per second so history matches wall time.
  useEffect(() => {
    if (player.status !== 'playing') return undefined;
    const t = setInterval(() => {
      const el = videoElRef.current;
      const next =
        el !== null && elementDrivesClock(el) && Number.isFinite(el.currentTime)
          ? el.currentTime
          : positionSecRef.current + playerRef.current.playbackRate;
      positionSecRef.current = next;
      const duration = playerRef.current.durationSec;
      const shown = duration > 0 ? Math.min(next, duration) : next;
      setPlayer((prev) =>
        prev.currentTimeSec === shown ? prev : { ...prev, currentTimeSec: shown },
      );
      if (Math.floor(next) - lastRecordRef.current >= PROGRESS_STEP_SEC) {
        lastRecordRef.current = Math.floor(next);
        recordProgressNowRef.current();
      }
      if (duration > 0 && next >= duration) endPlaybackRef.current();
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [player.status]);

  // ---- up-next countdown ---------------------------------------------------------------------
  const completeUpNext = useCallback((): void => {
    const u = upNextRef.current;
    setUpNext(null);
    if (u === null) return;
    // The price has been on screen for the whole countdown — the one sanctioned autoplay.
    pendingAutoplayRef.current = { videoId: u.video.id, label: u.quote.label, sats: u.quote.sats };
    closePlayback();
    setLocalId(u.video.id);
    navigate({ name: 'watch', videoId: u.video.id });
  }, [closePlayback, navigate]);

  useEffect(() => {
    if (upNext === null) return undefined;
    if (upNext.left <= 0) {
      completeUpNext();
      return undefined;
    }
    const t = setTimeout(() => {
      setUpNext((prev) => (prev === null ? null : { ...prev, left: prev.left - 1 }));
    }, 1000);
    return () => {
      clearTimeout(t);
    };
  }, [upNext, completeUpNext]);

  // ---- playback controls ---------------------------------------------------------------------
  const pausePlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null || playerRef.current.status !== 'playing') return;
    b.session.pause(); // stops paying — not merely a media pause
    recordProgressNow();
    setUpNext(null);
    setPlayer((prev) => ({
      ...prev,
      status: 'paused',
      spend:
        spendRef.current === undefined
          ? undefined
          : { total: spendRef.current.total, ratePerMin: 0 as Sats },
    }));
  }, [recordProgressNow]);

  const resumePlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null) {
      startPlayback();
      return;
    }
    // Replaying a finished video starts from 0 (the history entry has served its purpose).
    if (playerRef.current.status === 'ended') {
      positionSecRef.current = 0;
      lastRecordRef.current = 0;
      const el = videoElRef.current;
      if (el !== null) {
        try {
          el.currentTime = 0;
        } catch {
          // not seekable yet
        }
      }
    }
    // Retry after a media error: reload the element from the session's source first.
    if (playerRef.current.status === 'error') {
      try {
        videoElRef.current?.load();
      } catch {
        // no media pipeline
      }
    }
    b.session.resume();
    setUpNext(null);
    setPlayer((prev) => ({
      ...prev,
      status: 'playing',
      errorMessage: undefined,
      currentTimeSec: positionSecRef.current,
      spend: spendRef.current,
    }));
  }, [startPlayback]);

  /** The element cannot play the stream: stop paying, say so, offer Retry (in the chrome). */
  const failPlayback = useCallback((): void => {
    const b = bindingRef.current;
    if (b === null) return;
    if (playerRef.current.status === 'playing') b.session.pause();
    recordProgressNow();
    setUpNext(null);
    setPlayer((prev) => ({
      ...prev,
      status: 'error',
      errorMessage:
        'This video could not be played here. Payment is paused — nothing more is being paid.',
      spend:
        spendRef.current === undefined
          ? undefined
          : { total: spendRef.current.total, ratePerMin: 0 as Sats },
    }));
  }, [recordProgressNow]);

  const seekTo = useCallback((toSec: number): void => {
    const duration = playerRef.current.durationSec;
    const target = Math.max(0, duration > 0 ? Math.min(toSec, duration) : toSec);
    positionSecRef.current = target;
    lastRecordRef.current = Math.floor(target);
    const el = videoElRef.current;
    if (el !== null) {
      try {
        el.currentTime = target;
      } catch {
        // not seekable yet
      }
    }
    setUpNext(null);
    const wasEnded = playerRef.current.status === 'ended';
    setPlayer((prev) => ({
      ...prev,
      currentTimeSec: target,
      status: wasEnded ? 'playing' : prev.status,
      spend: wasEnded ? spendRef.current : prev.spend,
    }));
    if (wasEnded) bindingRef.current?.session.resume();
  }, []);

  const setVolume = useCallback((volume: number): void => {
    setPlayer((prev) => ({ ...prev, volume, muted: volume <= 0 }));
  }, []);

  const togglePip = useCallback((): void => {
    const el = videoElRef.current;
    const want = !playerRef.current.pip;
    if (el === null || typeof el.requestPictureInPicture !== 'function') {
      pushToast('info', 'Picture-in-picture is not available here');
      return;
    }
    if (want) {
      el.requestPictureInPicture().then(
        () => {
          patchPlayer({ pip: true });
        },
        () => {
          patchPlayer({ pip: false });
          pushToast('info', 'Picture-in-picture is not available here');
        },
      );
    } else if (document.pictureInPictureElement) {
      document.exitPictureInPicture().then(
        () => {
          patchPlayer({ pip: false });
        },
        () => undefined,
      );
    } else {
      patchPlayer({ pip: false });
    }
  }, [patchPlayer, pushToast]);

  const toggleFullscreen = useCallback((): void => {
    if (playerRef.current.mini) return;
    const el = stageRef.current;
    if (!playerRef.current.fullscreen) {
      if (el === null || typeof el.requestFullscreen !== 'function') return;
      el.requestFullscreen().then(
        () => {
          patchPlayer({ fullscreen: true });
        },
        () => {
          patchPlayer({ fullscreen: false });
        },
      );
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else {
      patchPlayer({ fullscreen: false });
    }
  }, [patchPlayer]);

  // Fullscreen can also end via the browser's own affordances (Esc); stay in sync.
  useEffect(() => {
    const onFsChange = (): void => {
      patchPlayer({ fullscreen: Boolean(document.fullscreenElement) });
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, [patchPlayer]);

  /** Mini-player (i): hand the live session to the shell, or float the chrome in place. */
  const toggleMini = useCallback((): void => {
    if (bindingRef.current === null) return;
    if (playerRef.current.mini) {
      patchPlayer({ mini: false });
      return;
    }
    if (handOff()) return;
    if (playerRef.current.fullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
    patchPlayer({ mini: true, fullscreen: false });
  }, [handOff, patchPlayer]);

  /** Quality: pre-play it is a preference (and a price); during play it switches sessions. */
  const chooseRendition = useCallback(
    (label: string): void => {
      const b = bindingRef.current;
      const data = dataRef.current;
      if (b === null || data === null) {
        setQuality(label);
        return;
      }
      if (label === b.session.rendition || switchingRef.current) return;
      const from = quoteFor(data.video, b.session.rendition);
      const to = quoteFor(data.video, label);
      if (to?.label !== label) return;
      switchingRef.current = true;
      const wasPlaying = playerRef.current.status === 'playing';
      b.session.switchRendition(label).then(
        (next) => {
          switchingRef.current = false;
          if (!aliveRef.current || bindingRef.current !== b) {
            closeQuietly(next, spentRef.current);
            return;
          }
          if (next.rendition !== label) {
            // Never pay a price that was not shown: keep the current session.
            closeQuietly(next, spentRef.current);
            pushToast('error', 'Could not switch quality', 'The current quality keeps playing.');
            return;
          }
          b.unsubPeers();
          b.unsubSpend();
          closeQuietly(b.session, spentRef.current);
          if (!wasPlaying) next.pause(); // a paused viewer must not start paying again
          attachSession(next, data, { positionSec: positionSecRef.current, paused: !wasPlaying });
          const delta = from === undefined ? 0 : to.sats - from.sats;
          pushToast(
            'sats',
            `Quality ${label} — ${formatInteger(to.sats)} sats`,
            delta === 0 || from === undefined
              ? 'Same price for the whole video.'
              : `${delta > 0 ? '+' : '−'}${formatInteger(Math.abs(delta))} sats for the whole video vs ${from.label}.`,
          );
        },
        () => {
          switchingRef.current = false;
          pushToast('error', 'Could not switch quality', 'The current quality keeps playing.');
        },
      );
    },
    [attachSession, pushToast],
  );

  const onPlayerAction = useCallback(
    (action: PlayerAction): void => {
      switch (action.type) {
        case 'toggle-play':
          if (bindingRef.current === null) startPlayback();
          else if (playerRef.current.status === 'playing') pausePlayback();
          else resumePlayback();
          break;
        case 'play':
          if (bindingRef.current === null) startPlayback();
          else resumePlayback();
          break;
        case 'pause':
          pausePlayback();
          break;
        case 'seek':
          seekTo(action.toSec);
          break;
        case 'set-volume':
          setVolume(action.volume);
          break;
        case 'toggle-mute':
          setPlayer((prev) => ({
            ...prev,
            muted: !prev.muted,
            volume: prev.muted && prev.volume <= 0 ? 0.5 : prev.volume,
          }));
          break;
        case 'set-rate':
          patchPlayer({ playbackRate: action.rate });
          break;
        case 'set-rendition':
          chooseRendition(action.label);
          break;
        case 'toggle-captions':
          setPlayer((prev) =>
            prev.captions === 'unavailable'
              ? prev
              : { ...prev, captions: prev.captions === 'on' ? 'off' : 'on' },
          );
          break;
        case 'toggle-pip':
          togglePip();
          break;
        case 'toggle-theater':
          setPlayer((prev) => ({ ...prev, theater: !prev.theater }));
          break;
        case 'toggle-fullscreen':
          toggleFullscreen();
          break;
        case 'toggle-mini':
          toggleMini();
          break;
        case 'toggle-peers':
          setShowPeers((s) => !s);
          break;
        case 'close':
          closePlayback();
          break;
      }
    },
    [
      startPlayback,
      pausePlayback,
      resumePlayback,
      seekTo,
      setVolume,
      patchPlayer,
      chooseRendition,
      togglePip,
      toggleFullscreen,
      toggleMini,
      closePlayback,
    ],
  );
  const onPlayerActionRef = useRef(onPlayerAction);
  onPlayerActionRef.current = onPlayerAction;

  // ---- page-wide keyboard (build-plan §6.2 map) ----------------------------------------------
  // The focused Player handles its own keys (and arrows/Home/End). Page-level keys work while
  // a session is live; before playback only `t` (theater) — a stray key must never start
  // paying. Ignored while typing, inside sheets/menus, and for Space/Enter on a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target;
      if (isTextEntryTarget(target)) return;
      if (target instanceof Element) {
        if (target.closest('[role="dialog"], [role="menu"], .nf-player') !== null) return;
        if (
          (e.key === ' ' || e.key === 'Enter') &&
          target.closest('button, a, input, select, summary, [role="button"]') !== null
        ) {
          return;
        }
      }
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') return;
      if (dataRef.current === null || handedOffRef.current) return;
      if (bindingRef.current === null) {
        if (e.key.toLowerCase() === 't') {
          e.preventDefault();
          setPlayer((prev) => ({ ...prev, theater: !prev.theater }));
        }
        return;
      }
      const action = keyboardAction(e, playerRef.current);
      if (action === null) return;
      e.preventDefault();
      onPlayerActionRef.current(action);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // ---- the media element ------------------------------------------------------------------------
  /** Every (re)mounted element — first play, mini ↔ stage — starts where the viewer is. */
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null): (() => void) | undefined => {
      videoElRef.current = el;
      if (el === null) return undefined;
      const st = playerRef.current;
      try {
        el.currentTime = positionSecRef.current;
        el.volume = st.volume;
        el.muted = st.muted;
        el.playbackRate = st.playbackRate;
      } catch {
        // an element that cannot take these yet is fine
      }
      const onEnterPip = (): void => {
        patchPlayer({ pip: true });
      };
      const onLeavePip = (): void => {
        patchPlayer({ pip: false });
      };
      el.addEventListener('enterpictureinpicture', onEnterPip);
      el.addEventListener('leavepictureinpicture', onLeavePip);
      return () => {
        el.removeEventListener('enterpictureinpicture', onEnterPip);
        el.removeEventListener('leavepictureinpicture', onLeavePip);
        if (videoElRef.current === el) videoElRef.current = null;
      };
    },
    [patchPlayer],
  );

  // A new session (rendition switch, adoption) keeps the viewer's position.
  useEffect(() => {
    const el = videoElRef.current;
    if (el === null || binding === null) return;
    try {
      el.currentTime = positionSecRef.current;
    } catch {
      // not seekable yet: the default playback start position applies
    }
  }, [binding]);

  // Transport follows state: playing ⇒ play(), anything else ⇒ pause().
  useEffect(() => {
    const el = videoElRef.current;
    if (el === null || binding === null) return;
    if (player.status === 'playing') mediaPlay(el);
    else mediaPause(el);
  }, [binding, player.status, player.mini]);

  useEffect(() => {
    const el = videoElRef.current;
    if (el === null || binding === null) return;
    try {
      el.volume = player.volume;
      el.muted = player.muted;
      el.playbackRate = player.playbackRate;
    } catch {
      // jsdom / MSE-less runtimes
    }
  }, [binding, player.volume, player.muted, player.playbackRate, player.mini]);

  useEffect(() => {
    const track = videoElRef.current?.textTracks[0];
    if (track !== undefined) track.mode = player.captions === 'on' ? 'showing' : 'hidden';
  }, [binding, player.captions, player.mini]);

  // ---- social actions ------------------------------------------------------------------------------
  const promptSignIn = useCallback((): void => {
    pushToast(
      'info',
      'Sign in to do that',
      'Connect a Nostr signer to like, comment, subscribe and zap.',
      {
        label: 'Connect signer',
        onClick: () => {
          leaveTo({ name: 'settings' });
        },
      },
    );
  }, [leaveTo, pushToast]);

  const [subBusy, setSubBusy] = useState(false);
  const toggleSubscribe = useCallback(
    (pubkey: NostrPubkey, next: boolean): void => {
      if (meRef.current === null) {
        promptSignIn();
        return;
      }
      setSubBusy(true);
      (next ? adapter.subscribe(pubkey) : adapter.unsubscribe(pubkey)).then(
        () => {
          if (!aliveRef.current) return;
          setSubBusy(false);
          patchData({ subscribed: next });
        },
        () => {
          if (!aliveRef.current) return;
          setSubBusy(false);
          pushToast('error', next ? 'Subscribe failed' : 'Unsubscribe failed');
        },
      );
    },
    [adapter, patchData, promptSignIn, pushToast],
  );

  const [likeBusy, setLikeBusy] = useState(false);
  const toggleLike = useCallback((): void => {
    const data = dataRef.current;
    if (data === null) return;
    if (meRef.current === null) {
      promptSignIn();
      return;
    }
    const next = !data.liked;
    setLikeBusy(true);
    adapter.react(data.video.id, next ? '+' : '-').then(
      () => {
        if (!aliveRef.current) return;
        setLikeBusy(false);
        const s = dataRef.current?.stats;
        patchData({
          liked: next,
          ...(s !== undefined
            ? { stats: { ...s, reactions: Math.max(0, s.reactions + (next ? 1 : -1)) } }
            : {}),
        });
      },
      () => {
        if (!aliveRef.current) return;
        setLikeBusy(false);
        pushToast('error', 'Could not register the reaction');
      },
    );
  }, [adapter, patchData, promptSignIn, pushToast]);

  const toggleWatchLater = useCallback((): void => {
    const data = dataRef.current;
    if (data === null) return;
    if (meRef.current === null) {
      promptSignIn();
      return;
    }
    const next = data.watchLater !== true;
    adapter.library.setWatchLater(data.video.id, next).then(
      () => {
        if (!aliveRef.current) return;
        patchData({ watchLater: next });
        pushToast('success', next ? 'Saved to Watch later' : 'Removed from Watch later');
      },
      () => {
        pushToast('error', 'Could not update Watch later');
      },
    );
  }, [adapter, patchData, promptSignIn, pushToast]);

  const [sheet, setSheet] = useState<'none' | 'nutzap' | 'report' | 'keys'>('none');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLSpanElement | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  useEffect(() => {
    setDescOpen(false);
    setMenuOpen(false);
    setSheet('none');
  }, [activeId]);

  const openNutzap = useCallback((): void => {
    if (meRef.current === null) {
      promptSignIn();
      return;
    }
    setSheet('nutzap');
  }, [promptSignIn]);

  const openChannel = useCallback(
    (pubkey: NostrPubkey): void => {
      leaveTo({ name: 'channel', pubkey });
    },
    [leaveTo],
  );
  const openRelated = useCallback(
    (video: VideoManifest): void => {
      leaveTo(
        video.kind === 22
          ? { name: 'shorts', videoId: video.id }
          : { name: 'watch', videoId: video.id },
      );
    },
    [leaveTo],
  );
  const toastError = useCallback(
    (title: string, detail?: string): void => {
      pushToast('error', title, detail);
    },
    [pushToast],
  );
  const goSettings = useCallback((): void => {
    leaveTo({ name: 'settings' });
  }, [leaveTo]);
  const goWallet = useCallback((): void => {
    leaveTo({ name: 'wallet' });
  }, [leaveTo]);

  // ---- render --------------------------------------------------------------------------------------
  const pageHead = (text: string): ReactElement => (
    <h1 id={`${id}-title`} className="nf-watch__sr">
      {text}
    </h1>
  );

  if (phase.status === 'loading') {
    return (
      <section
        className={cx('nf-watch', className)}
        aria-labelledby={`${id}-title`}
        aria-busy="true"
      >
        {pageHead('Loading video')}
        <div className="nf-watch__layout">
          <div className="nf-watch__stage-cell">
            <Skeleton variant="block" aspectRatio="16 / 9" className="nf-watch__stage-skeleton" />
          </div>
          <div className="nf-watch__main">
            <Skeleton variant="text" width="60%" height={28} />
            <ChannelRowSkeleton />
            <Skeleton variant="block" height={96} className="nf-watch__desc-skeleton" />
            <SkeletonLines lines={3} />
          </div>
          <aside className="nf-watch__related" aria-label="Up next">
            <ul className="nf-watch__list" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <li key={i} className="nf-watch__item">
                  <VideoCardSkeleton layout="list" />
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>
    );
  }

  if (phase.status === 'not-found') {
    return (
      <section className={cx('nf-watch', className)} aria-labelledby={`${id}-title`}>
        {pageHead('Video not found')}
        <div className="nf-watch__page-state">
          <EmptyState
            icon="videoOff"
            title="Video not found"
            description="This video may have been deleted, or the link is wrong."
            action="Back to Home"
            onAction={() => {
              navigate({ name: 'home' });
            }}
          />
        </div>
      </section>
    );
  }

  if (phase.status === 'error') {
    const e = describeWatchError(phase.error);
    return (
      <section className={cx('nf-watch', className)} aria-labelledby={`${id}-title`}>
        {pageHead('Watch')}
        <div className="nf-watch__page-state">
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              setLoadGen((g) => g + 1);
            }}
          />
        </div>
      </section>
    );
  }

  // ---- ready ---------------------------------------------------------------------------------------
  const data = phase.data;
  const video = data.video;
  const stats = data.stats;
  const gate = stageGate(data, me);
  const live = binding !== null;
  const liveQuote = live ? quoteFor(video, binding.session.rendition) : undefined;
  const quote = liveQuote ?? quoteFor(video, quality);
  const canChoose = !live && !connecting && !handedOff && gate === 'none';
  const creatorName = data.channel.displayName ?? data.channel.name ?? shortPubkey(video.author);
  const channelNameOf = (v: VideoManifest): string => {
    const p = profiles[v.author];
    return p?.displayName ?? p?.name ?? shortPubkey(v.author);
  };
  const peerProfiles = new Map<NostrPubkey, Profile>();
  const peerAvatars = new Map<NostrPubkey, string>();
  for (const p of peers) {
    const prof = profiles[p.pubkey];
    if (prof !== undefined && prof !== null) peerProfiles.set(p.pubkey, prof);
    const av = avatars[p.pubkey];
    if (av !== undefined) peerAvatars.set(p.pubkey, av);
  }

  // The media slot: a plain <video> while a session lives (URL / service-worker sources; an
  // MSE source is attached by the web shell), the verified poster otherwise.
  const mediaNode = live ? (
    <video
      ref={attachVideo}
      className="nf-watch__video"
      src={binding.session.source.kind === 'mediasource' ? undefined : binding.session.source.url}
      poster={data.thumbSrc}
      playsInline
      preload="metadata"
      onTimeUpdate={(e) => {
        const el = e.currentTarget;
        if (elementDrivesClock(el) && Number.isFinite(el.currentTime)) {
          positionSecRef.current = el.currentTime;
        }
      }}
      onDurationChange={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) patchPlayer({ durationSec: d });
      }}
      onProgress={(e) => {
        const ranges = timeRanges(e.currentTarget.buffered);
        patchPlayer({ buffered: ranges });
      }}
      onPause={(e) => {
        // The element paused on its own (PiP window, media keys, OS): stop paying too.
        if (!e.currentTarget.ended && !switchingRef.current) pausePlayback();
      }}
      onPlay={() => {
        if (playerRef.current.status === 'paused') resumePlayback();
      }}
      onEnded={() => {
        endPlaybackRef.current();
      }}
      onError={failPlayback}
    >
      {data.captionsSrc !== undefined ? (
        <track
          kind="captions"
          src={data.captionsSrc}
          srcLang={data.captionsLang ?? 'en'}
          label={data.captionsLang ?? 'Captions'}
        />
      ) : null}
    </video>
  ) : data.thumbSrc !== undefined ? (
    <img className="nf-watch__poster" src={data.thumbSrc} alt="" />
  ) : safePlaceholder(video) !== undefined ? (
    <img className="nf-watch__poster nf-watch__poster--blur" src={safePlaceholder(video)} alt="" />
  ) : null;

  let stageMode: 'poster' | 'player' | 'gate' | 'note';
  let stageContent: ReactElement;
  if (handedOff) {
    stageMode = 'note';
    stageContent = (
      <>
        {mediaNode}
        <span className="nf-watch__stage-dim" aria-hidden="true" />
        <StageNote icon="miniPlayer" title="Playing in the mini-player">
          It keeps playing while you browse.
        </StageNote>
      </>
    );
  } else if (playError !== undefined && !live) {
    stageMode = 'gate';
    const kind = playErrorKind(playError);
    stageContent =
      kind === 'no-seeders' ? (
        <EmptyState
          preset="no-seeders-online"
          onAction={() => {
            startPlayback();
          }}
        />
      ) : kind === 'no-balance' ? (
        <EmptyState preset="no-balance-at-mint" onAction={goWallet} />
      ) : (
        <ErrorState
          compact
          title={kind === 'relay-down' ? 'Relay down' : 'Playback did not start'}
          description={
            kind === 'relay-down'
              ? 'None of your relays answered. The swarm may still be there — retry in a moment.'
              : 'Nothing was played and nothing more was paid.'
          }
          detail={messageOf(playError)}
          onRetry={() => {
            startPlayback();
          }}
        />
      );
  } else if (gate !== 'none' && !live) {
    stageMode = 'gate';
    stageContent =
      gate === 'signer' ? (
        <EmptyState
          preset="signer-not-detected"
          description="Watching pays seeders per block from your NIP-60 wallet, so a signer is required. Everything else on this page works without one."
          onAction={goSettings}
        />
      ) : gate === 'seeders' ? (
        <EmptyState
          preset="no-seeders-online"
          description="Nobody is seeding this video right now, so there is nothing to pay for. Try again in a little while."
          onAction={() => {
            setLoadGen((g) => g + 1);
          }}
        />
      ) : (
        <EmptyState
          preset="no-balance-at-mint"
          description={`This video is paid at ${video.price.mints.map((m) => mintHost(m)).join(' or ')}, and your wallet holds nothing there yet.`}
          onAction={goWallet}
        />
      );
  } else if (live && player.mini) {
    stageMode = 'note';
    stageContent = (
      <StageNote
        icon="miniPlayer"
        title="Playing in the mini-player"
        action={{
          label: 'Bring it back',
          onClick: () => {
            patchPlayer({ mini: false });
          },
        }}
      />
    );
  } else if (live || connecting) {
    stageMode = 'player';
    stageContent = (
      <Player
        media={mediaNode}
        state={connecting && !live ? { ...player, status: 'loading' } : player}
        renditions={video.renditions}
        policy={video.price}
        title={video.title}
        showPeers={showPeers}
        onAction={onPlayerAction}
      />
    );
  } else {
    stageMode = 'poster';
    stageContent = (
      <>
        {mediaNode}
        <div className="nf-watch__poster-overlay">
          <IconButton
            className="nf-watch__bigplay"
            icon="play"
            label={
              quote !== undefined
                ? `Play — costs ${formatInteger(quote.sats)} sats (${quote.label})`
                : 'Play'
            }
            tone="overlay"
            size="lg"
            onClick={() => {
              startPlayback();
            }}
          />
          {data.resumeSec > 0 ? (
            <span className="nf-watch__resume">Resume from {formatDuration(data.resumeSec)}</span>
          ) : null}
        </div>
        {data.resumeSec > 0 && video.durationSec !== undefined && video.durationSec > 0 ? (
          <span className="nf-watch__resume-bar" aria-hidden="true">
            <span
              className="nf-watch__resume-fill"
              style={{
                width: `${Math.min(100, (data.resumeSec / video.durationSec) * 100).toFixed(1)}%`,
              }}
            />
          </span>
        ) : null}
      </>
    );
  }

  return (
    <section
      className={cx('nf-watch', player.theater && 'nf-watch--theater', className)}
      aria-labelledby={`${id}-title`}
    >
      <div className="nf-watch__layout">
        <div className="nf-watch__stage-cell">
          <div className={cx('nf-watch__stage', `nf-watch__stage--${stageMode}`)} ref={stageRef}>
            <PricePanel
              quote={quote}
              renditions={video.renditions}
              policy={video.price}
              onChoose={canChoose ? chooseRendition : undefined}
              mints={live ? undefined : video.price.mints}
              live={live}
            />
            {stageContent}
            {live && showPeers && !player.mini ? (
              <PeerOverlay
                peers={peers}
                spend={player.spend}
                paused={player.status !== 'playing'}
                loading={!peersSeen}
                profiles={peerProfiles}
                avatars={peerAvatars}
                policy={video.price}
                rendition={binding.session.rendition}
                onClose={() => {
                  setShowPeers(false);
                }}
              />
            ) : null}
            {upNext !== null ? (
              <UpNextOverlay
                video={upNext.video}
                quote={upNext.quote}
                channelName={channelNameOf(upNext.video)}
                thumbSrc={thumbs[upNext.video.id]}
                secondsLeft={upNext.left}
                totalSeconds={WATCH_UP_NEXT_SECONDS}
                from={upNext.from}
                onCancel={() => {
                  setUpNext(null);
                }}
                onPlayNow={completeUpNext}
              />
            ) : null}
          </div>
        </div>

        <div className="nf-watch__main">
          <h1 id={`${id}-title`} className="nf-watch__title">
            {video.title}
          </h1>
          <div className="nf-watch__channelbar">
            <ChannelRow
              profile={data.channel}
              avatarSrc={data.avatarSrc}
              subscribed={data.subscribed}
              satsToCreator={stats?.satsToCreator}
              busy={subBusy}
              onSubscribe={toggleSubscribe}
              onOpen={openChannel}
              className="nf-watch__channel"
            />
            <div className="nf-watch__actions">
              {live && player.status === 'playing' && player.spend !== undefined ? (
                <SatsBadge
                  variant="rate"
                  sats={player.spend.ratePerMin}
                  prefix="streaming"
                  className="nf-watch__spend"
                  label={`Streaming ${formatInteger(player.spend.ratePerMin)} sats per minute — ${formatInteger(player.spend.total)} sats so far`}
                />
              ) : null}
              {live && player.status !== 'playing' ? (
                <span className="nf-watch__paystate" role="status">
                  <Icon name="pause" size={16} />
                  {player.status === 'ended'
                    ? 'Finished — not paying'
                    : player.status === 'error'
                      ? 'Stopped — not paying'
                      : 'Paused — not paying'}
                  {player.spend !== undefined
                    ? ` · ${formatInteger(player.spend.total)} sats so far`
                    : ''}
                </span>
              ) : null}
              <Button
                variant="secondary"
                size="md"
                pressed={data.liked}
                loading={likeBusy}
                aria-label={data.liked ? 'Remove your like' : 'Like this video'}
                onClick={toggleLike}
                className="nf-watch__like"
              >
                {data.liked ? 'Liked' : 'Like'}
                {(stats?.reactions ?? 0) > 0 ? ` · ${formatInteger(stats?.reactions ?? 0)}` : ''}
              </Button>
              <Button variant="accent" size="md" icon="bolt" onClick={openNutzap}>
                Nutzap
              </Button>
              <span
                className="nf-watch__overflow"
                ref={menuWrapRef}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && menuOpen) {
                    e.stopPropagation();
                    setMenuOpen(false);
                  }
                }}
                onBlur={(e) => {
                  const next: EventTarget | null = e.relatedTarget;
                  if (!(next instanceof Node) || menuWrapRef.current?.contains(next) !== true) {
                    setMenuOpen(false);
                  }
                }}
              >
                <IconButton
                  icon="moreVert"
                  label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => {
                    setMenuOpen((o) => !o);
                  }}
                />
                {menuOpen ? (
                  <div className="nf-watch__menu" role="menu" aria-label="More actions">
                    <button
                      type="button"
                      role="menuitem"
                      className="nf-watch__menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        toggleWatchLater();
                      }}
                    >
                      {data.watchLater === true ? 'Remove from Watch later' : 'Save to Watch later'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="nf-watch__menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setSheet('keys');
                      }}
                    >
                      Keyboard shortcuts
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="nf-watch__menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setSheet('report');
                      }}
                    >
                      Report video
                    </button>
                  </div>
                ) : null}
              </span>
            </div>
          </div>

          <div className={cx('nf-watch__desc', descOpen && 'nf-watch__desc--open')}>
            <p className="nf-watch__desc-meta">
              {stats !== undefined ? (
                <span className="nf-watch__desc-stat">{formatPaidViews(stats.paidViews)}</span>
              ) : null}
              <span className="nf-watch__desc-stat">
                {formatRelativeTime(video.publishedAt, nowSec)}
              </span>
              {stats !== undefined ? (
                <span className="nf-watch__desc-stat">
                  {formatInteger(stats.seedersOnline)}{' '}
                  {stats.seedersOnline === 1 ? 'seeder' : 'seeders'} online
                </span>
              ) : null}
              {video.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="nf-watch__tag"
                  onClick={() => {
                    leaveTo({ name: 'search', q: t });
                  }}
                >
                  #{t}
                </button>
              ))}
            </p>
            <Markdown source={video.description} className="nf-watch__desc-body" />
            <button
              type="button"
              className="nf-watch__desc-toggle"
              aria-expanded={descOpen}
              onClick={() => {
                setDescOpen((o) => !o);
              }}
            >
              {descOpen ? 'Show less' : '…more'}
            </button>
          </div>

          <WatchComments
            key={video.id}
            adapter={adapter}
            videoId={video.id}
            me={me}
            nowSec={nowSec}
            totalHint={stats?.comments}
            resolvers={resolvers}
            onOpenChannel={openChannel}
            onSignIn={goSettings}
            onError={toastError}
            idPrefix={id}
          />
        </div>

        <WatchRelated
          related={related}
          onRetry={() => {
            setRelatedGen((g) => g + 1);
          }}
          playlist={playlist}
          playlistItems={playlistItems}
          currentId={video.id}
          resolvers={resolvers}
          nowSec={nowSec}
          autoplay={autoplay}
          onToggleAutoplay={() => {
            setAutoplay((a) => !a);
          }}
          onOpen={openRelated}
          onOpenChannel={openChannel}
          idPrefix={id}
        />
      </div>

      {live && player.mini ? (
        <div className="nf-watch__mini">
          <Player
            media={mediaNode}
            state={player}
            renditions={video.renditions}
            policy={video.price}
            title={video.title}
            onAction={onPlayerAction}
          />
        </div>
      ) : miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-watch__mini">{miniPlayer}</div>
      ) : null}

      <NutzapSheet
        open={sheet === 'nutzap'}
        onClose={() => {
          setSheet('none');
        }}
        adapter={adapter}
        video={video}
        creatorName={creatorName}
        balances={data.balances}
        onSent={(amount, mint) => {
          setSheet('none');
          pushToast(
            'sats',
            `Nutzap sent — ${formatInteger(amount)} sats`,
            `To ${creatorName} via ${mintHost(mint)}.`,
          );
          adapter.stats(video.id).then(
            (s) => {
              if (aliveRef.current && dataRef.current?.video.id === video.id)
                patchData({ stats: s });
            },
            () => undefined,
          );
          adapter.wallet.balances().then(
            (b) => {
              if (aliveRef.current && dataRef.current?.video.id === video.id)
                patchData({ balances: b });
            },
            () => undefined,
          );
        }}
        onError={(message) => {
          pushToast('error', 'Nutzap failed', message);
        }}
        onTopUp={goWallet}
        idPrefix={id}
      />
      <ReportSheet
        open={sheet === 'report'}
        onClose={() => {
          setSheet('none');
        }}
        adapter={adapter}
        video={video}
        onSent={() => {
          setSheet('none');
          pushToast(
            'success',
            'Report sent',
            'Thank you — relays and gateways use reports for moderation.',
          );
        }}
        onError={(message) => {
          pushToast('error', 'Report failed', message);
        }}
      />
      <ShortcutsSheet
        open={sheet === 'keys'}
        onClose={() => {
          setSheet('none');
        }}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </section>
  );
}
