/**
 * Library screen (build-plan §6.1 row "Library"): the viewer's NIP-51 lists behind a chip bar
 * of four tabs — History (grouped by day, resume where you left off), Watch later (remove
 * with Undo), Playlists (grid, private indicator, create, open) and Liked.
 *
 * Talks ONLY to `NetworkAdapter` (`me`, `signer`, `library.*`, `video`, `profile`, `image`);
 * renders ONLY `@sovit/ui` components + semantic HTML. Every video renders through
 * `VideoCard`, which carries its `SatsBadge` price; the screen's own play-shaped controls
 * (the history "Resume" buttons) come after the card in DOM order. Nothing here plays or
 * pays — Watch does that after it has shown the price. Thumbnails, covers and avatars pass
 * through `adapter.image(url, sha256)` (T16) before they are displayed.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import type {
  NetworkAdapter,
  NostrEventId,
  NostrPubkey,
  Playlist,
  Profile,
  SignerStatus,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Markdown,
  Sheet,
  Skeleton,
  SkeletonLines,
  ToastStack,
  VideoCard,
  VideoCardSkeleton,
  cx,
  formatDuration,
  type ToastItem,
} from '../../components/index.js';
import type { Route, ScreenProps } from '../shared/route.js';
import {
  countLabel,
  describeLibraryError,
  groupHistoryByDay,
  historyProgress,
} from './libraryFormat.js';
import { PlaylistForm, type PlaylistFormValues } from './PlaylistForm.js';

/** The four Library tabs; kept in sync with `Route['tab']` for `name: 'library'`. */
export type LibraryTab = NonNullable<Extract<Route, { readonly name: 'library' }>['tab']>;

export const LIBRARY_TABS: readonly { readonly id: LibraryTab; readonly label: string }[] = [
  { id: 'history', label: 'History' },
  { id: 'watch-later', label: 'Watch later' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'liked', label: 'Liked' },
];

/** One `library.history` row: the video, how far the viewer got, when. */
export type HistoryEntry = Awaited<
  ReturnType<NetworkAdapter['library']['history']>
>['items'][number];

export interface LibraryProps extends ScreenProps {
  /** Initial/controlled tab (`Route['tab']`). Defaults to History (Playlists with `playlistId`). */
  readonly tab?: LibraryTab | undefined;
  /**
   * Opens this playlist (its NIP-51 `d` tag) on the Playlists tab. `Route` has no field for it
   * yet (docs/contract-requests/L5-Library.md), so a shell that wants deep links passes it.
   */
  readonly playlistId?: string | undefined;
  /** "now" for day grouping and relative timestamps; stories/tests pin it. */
  readonly now?: UnixSeconds | number | undefined;
  /** IANA zone the history days are cut in. Default: the viewer's own. Stories pin `'UTC'`. */
  readonly timeZone?: string | undefined;
  readonly className?: string | undefined;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface Slice<T> {
  readonly status: Status;
  readonly data: T;
  readonly error: unknown;
}

interface HistoryData {
  readonly items: readonly HistoryEntry[];
  readonly next: string | undefined;
  readonly more: 'idle' | 'loading' | 'error';
  readonly moreError: unknown;
}

interface Slices {
  readonly history: Slice<HistoryData>;
  readonly 'watch-later': Slice<readonly VideoManifest[]>;
  readonly playlists: Slice<readonly Playlist[]>;
  readonly liked: Slice<readonly VideoManifest[]>;
}

const INITIAL_SLICES: Slices = {
  history: {
    status: 'idle',
    data: { items: [], next: undefined, more: 'idle', moreError: undefined },
    error: undefined,
  },
  'watch-later': { status: 'idle', data: [], error: undefined },
  playlists: { status: 'idle', data: [], error: undefined },
  liked: { status: 'idle', data: [], error: undefined },
};

type Identity =
  | { readonly state: 'pending' }
  | { readonly state: 'error'; readonly error: unknown }
  | { readonly state: 'signed-out'; readonly signer: SignerStatus | undefined }
  | { readonly state: 'signed-in'; readonly pubkey: NostrPubkey };

/** `adapter.video(id)` outcome: the manifest, `null` = not found, `'error'` = the call failed. */
type VideoLookup = VideoManifest | null | 'error';

interface CreateState {
  readonly open: boolean;
  readonly busy: boolean;
  readonly error: unknown;
  /** Bumped per opening so the form starts empty each time. */
  readonly gen: number;
}

const ZERO_COUNTS: Readonly<Record<LibraryTab, number>> = {
  history: 0,
  'watch-later': 0,
  playlists: 0,
  liked: 0,
};

const SIGNED_OUT_TITLE: Readonly<Record<LibraryTab, string>> = {
  history: 'Sign in to see your history',
  'watch-later': 'Sign in to see your Watch later list',
  playlists: 'Sign in to see your playlists',
  liked: 'Sign in to see the videos you liked',
};

/** One-line fact under the chip bar per tab (the Library-specific thing worth a line). */
const TAB_HINT: Readonly<
  Record<
    LibraryTab,
    { readonly icon: 'key' | 'bolt' | 'people'; readonly text: string } | undefined
  >
> = {
  history: { icon: 'key', text: 'Only you can see your history — it is encrypted to your key' },
  'watch-later': { icon: 'bolt', text: 'Saving is free — you pay only for what you play' },
  playlists: undefined,
  liked: { icon: 'people', text: 'Likes are public Nostr reactions' },
};

function ready<T>(data: T): Slice<T> {
  return { status: 'ready', data, error: undefined };
}

function historyKey(e: HistoryEntry): string {
  return `${e.video.id}:${e.at}`;
}

function dedupeHistory(
  existing: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
): readonly HistoryEntry[] {
  const seen = new Set(existing.map(historyKey));
  const out = [...existing];
  for (const e of incoming) {
    const k = historyKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

/** Re-inserts `video` at `index` (clamped); a no-op if it is already there. */
function insertAt(
  list: readonly VideoManifest[],
  index: number,
  video: VideoManifest,
): readonly VideoManifest[] {
  if (list.some((v) => v.id === video.id)) return list;
  const i = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, i), video, ...list.slice(i)];
}

function isVideo(v: VideoLookup | undefined): v is VideoManifest {
  return typeof v === 'object' && v !== null;
}

export function Library({
  adapter,
  navigate,
  miniPlayer,
  tab,
  playlistId,
  now,
  timeZone,
  className,
}: LibraryProps): ReactElement {
  const id = useId();
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- tab + open playlist (the route is the source of truth; local state follows it) --------
  const [activeTab, setActiveTab] = useState<LibraryTab>(
    tab ?? (playlistId !== undefined ? 'playlists' : 'history'),
  );
  const [openPlaylist, setOpenPlaylist] = useState<string | undefined>(playlistId);
  useEffect(() => {
    if (tab !== undefined) setActiveTab(tab);
  }, [tab]);
  useEffect(() => {
    if (playlistId !== undefined) setOpenPlaylist(playlistId);
  }, [playlistId]);

  const selectTab = useCallback(
    (next: LibraryTab): void => {
      setActiveTab(next);
      setOpenPlaylist(undefined);
      navigate({ name: 'library', tab: next });
    },
    [navigate],
  );

  // ---- identity: the whole Library needs a signer --------------------------------------
  const [identity, setIdentity] = useState<Identity>({ state: 'pending' });
  const [identityGen, setIdentityGen] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    setIdentity((prev) => (prev.state === 'pending' ? prev : { state: 'pending' }));
    void (async (): Promise<void> => {
      try {
        const pubkey = await adapter.me();
        if (cancelled()) return;
        if (pubkey !== null) {
          setIdentity({ state: 'signed-in', pubkey });
          return;
        }
        // Signed out: ask the signer why, so a locked signer gets "unlock", not "sign in".
        let signer: SignerStatus | undefined;
        try {
          signer = await adapter.signer();
        } catch {
          signer = undefined;
        }
        if (!cancelled()) setIdentity({ state: 'signed-out', signer });
      } catch (err: unknown) {
        if (!cancelled()) setIdentity({ state: 'error', error: err });
      }
    })();
    return () => {
      ac.abort();
    };
  }, [adapter, identityGen]);

  // ---- per-tab lists (cached for the session; an interrupted load re-runs) ---------------
  const [slices, setSlices] = useState<Slices>(INITIAL_SLICES);
  const slicesRef = useRef(slices);
  slicesRef.current = slices;
  const [reload, setReload] = useState<Readonly<Record<LibraryTab, number>>>(ZERO_COUNTS);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const fetchedKey = useRef<Record<LibraryTab, string>>({
    history: '',
    'watch-later': '',
    playlists: '',
    liked: '',
  });

  const updateSlice = useCallback(
    <K extends LibraryTab>(k: K, fn: (prev: Slices[K]) => Slices[K]): void => {
      setSlices((prev) => ({ ...prev, [k]: fn(prev[k]) }));
    },
    [],
  );

  useEffect(() => {
    if (identity.state !== 'signed-in') return;
    const t = activeTab;
    const key = String(reload[t]);
    if (fetchedKey.current[t] === key) return;
    fetchedKey.current[t] = key;
    let cancelled = false;
    let done = false;
    const lib = adapter.library;
    setSlices((prev) => ({ ...prev, [t]: { ...INITIAL_SLICES[t], status: 'loading' } }));
    const load = async (): Promise<(prev: Slices) => Slices> => {
      switch (t) {
        case 'history': {
          const page = await lib.history();
          const data: HistoryData = {
            items: dedupeHistory([], page.items),
            next: page.next,
            more: 'idle',
            moreError: undefined,
          };
          return (prev) => ({ ...prev, history: ready(data) });
        }
        case 'watch-later': {
          const list = await lib.watchLater();
          return (prev) => ({ ...prev, 'watch-later': ready(list) });
        }
        case 'playlists': {
          const list = await lib.playlists();
          return (prev) => ({ ...prev, playlists: ready(list) });
        }
        case 'liked': {
          const list = await lib.liked();
          return (prev) => ({ ...prev, liked: ready(list) });
        }
      }
    };
    load().then(
      (apply) => {
        if (cancelled) return;
        done = true;
        setSlices(apply);
      },
      (err: unknown) => {
        if (cancelled) return;
        done = true;
        setSlices((prev) => ({
          ...prev,
          [t]: { ...INITIAL_SLICES[t], status: 'error', error: err },
        }));
      },
    );
    return () => {
      cancelled = true;
      // An interrupted load must run again the next time this tab is shown.
      if (!done) fetchedKey.current[t] = '';
    };
  }, [activeTab, adapter, identity, reload]);

  const retry = useCallback(
    (t: LibraryTab): void => {
      if (identity.state === 'error') setIdentityGen((g) => g + 1);
      setReload((r) => ({ ...r, [t]: r[t] + 1 }));
    },
    [identity.state],
  );

  const loadMoreHistory = useCallback((): void => {
    const h = slicesRef.current.history;
    if (h.status !== 'ready' || h.data.more === 'loading' || h.data.next === undefined) return;
    const gen = reloadRef.current.history;
    updateSlice('history', (s) => ({
      ...s,
      data: { ...s.data, more: 'loading', moreError: undefined },
    }));
    adapter.library.history(h.data.next).then(
      (page) => {
        if (!alive.current || reloadRef.current.history !== gen) return;
        updateSlice('history', (s) => ({
          ...s,
          data: {
            ...s.data,
            items: dedupeHistory(s.data.items, page.items),
            next: page.next,
            more: 'idle',
          },
        }));
      },
      (err: unknown) => {
        if (!alive.current || reloadRef.current.history !== gen) return;
        updateSlice('history', (s) => ({
          ...s,
          data: { ...s.data, more: 'error', moreError: err },
        }));
      },
    );
  }, [adapter, updateSlice]);

  // ---- per-video resolution: thumbnails (T16), channel profiles + avatars, playlist ids --
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [profiles, setProfiles] = useState<Readonly<Record<string, Profile | null>>>({});
  const [avatars, setAvatars] = useState<Readonly<Record<string, string>>>({});
  const [videos, setVideos] = useState<Readonly<Record<string, VideoLookup>>>({});
  const requested = useRef({
    thumbs: new Set<string>(),
    profiles: new Set<string>(),
    videos: new Set<string>(),
  });

  const resolveMedia = useCallback(
    (list: readonly VideoManifest[]): void => {
      const req = requested.current;
      for (const video of list) {
        if (!req.thumbs.has(video.id)) {
          req.thumbs.add(video.id);
          const image = video.renditions[0]?.image;
          if (image) {
            adapter.image(image.url, image.sha256).then(
              (src) => {
                if (alive.current) setThumbs((prev) => ({ ...prev, [video.id]: src }));
              },
              () => undefined, // hash mismatch / unreachable → the placeholder stays
            );
          }
        }
        const author = video.author;
        if (!req.profiles.has(author)) {
          req.profiles.add(author);
          adapter.profile(author).then(
            (p) => {
              if (!alive.current) return;
              setProfiles((prev) => ({ ...prev, [author]: p }));
              if (p?.picture) {
                adapter.image(p.picture).then(
                  (src) => {
                    if (alive.current) setAvatars((prev) => ({ ...prev, [author]: src }));
                  },
                  () => undefined,
                );
              }
            },
            () => {
              if (alive.current) setProfiles((prev) => ({ ...prev, [author]: null }));
            },
          );
        }
      }
    },
    [adapter],
  );

  const resolveVideos = useCallback(
    (ids: readonly NostrEventId[]): void => {
      const req = requested.current.videos;
      for (const vid of ids) {
        if (req.has(vid)) continue;
        req.add(vid);
        adapter.video(vid).then(
          (v) => {
            if (!alive.current) return;
            setVideos((prev) => ({ ...prev, [vid]: v }));
            if (v) resolveMedia([v]);
          },
          () => {
            if (alive.current) setVideos((prev) => ({ ...prev, [vid]: 'error' }));
          },
        );
      }
    },
    [adapter, resolveMedia],
  );

  const retryVideos = useCallback(
    (ids: readonly NostrEventId[]): void => {
      for (const vid of ids) requested.current.videos.delete(vid);
      const drop = new Set<string>(ids);
      setVideos((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !drop.has(k))));
      resolveVideos(ids);
    },
    [resolveVideos],
  );

  const historyItems = slices.history.data.items;
  useEffect(() => {
    resolveMedia(historyItems.map((e) => e.video));
  }, [historyItems, resolveMedia]);
  const watchLater = slices['watch-later'].data;
  useEffect(() => {
    resolveMedia(watchLater);
  }, [watchLater, resolveMedia]);
  const liked = slices.liked.data;
  useEffect(() => {
    resolveMedia(liked);
  }, [liked, resolveMedia]);
  const playlists = slices.playlists.data;
  useEffect(() => {
    // Covers: the first video of each playlist.
    resolveVideos(playlists.flatMap((p) => p.videoIds.slice(0, 1)));
  }, [playlists, resolveVideos]);
  const shownPlaylist =
    activeTab === 'playlists' && openPlaylist !== undefined
      ? playlists.find((p) => p.id === openPlaylist)
      : undefined;
  useEffect(() => {
    if (shownPlaylist) resolveVideos(shownPlaylist.videoIds);
  }, [shownPlaylist, resolveVideos]);

  // ---- toasts (Undo / rollback notices) ---------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const nextToastId = (): string => {
    toastSeq.current += 1;
    return `library-toast-${toastSeq.current}`;
  };
  const pushToast = useCallback((item: ToastItem): void => {
    setToasts((prev) => [...prev.slice(-2), item]);
  }, []);
  const dismissToast = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  // ---- Watch later: optimistic remove, Undo, rollback on error ---------------------------
  const setWatchLaterList = (
    fn: (prev: readonly VideoManifest[]) => readonly VideoManifest[],
  ): void => {
    updateSlice('watch-later', (s) => ({ ...s, data: fn(s.data) }));
  };

  const removeFromWatchLater = (video: VideoManifest): void => {
    const index = slicesRef.current['watch-later'].data.findIndex((v) => v.id === video.id);
    if (index < 0) return;
    setWatchLaterList((prev) => prev.filter((v) => v.id !== video.id));
    adapter.library.setWatchLater(video.id, false).then(
      () => {
        if (!alive.current) return;
        const toastId = nextToastId();
        pushToast({
          id: toastId,
          tone: 'info',
          title: 'Removed from Watch later',
          description: video.title,
          action: {
            label: 'Undo',
            onClick: () => {
              dismissToast(toastId);
              restoreToWatchLater(video, index);
            },
          },
        });
      },
      (err: unknown) => {
        if (!alive.current) return;
        setWatchLaterList((prev) => insertAt(prev, index, video));
        const toastId = nextToastId();
        pushToast({
          id: toastId,
          tone: 'error',
          title: 'Could not remove from Watch later',
          description: `“${video.title}” is back in your list. ${describeLibraryError(err).title}.`,
          action: {
            label: 'Retry',
            onClick: () => {
              dismissToast(toastId);
              removeFromWatchLater(video);
            },
          },
        });
      },
    );
  };

  const restoreToWatchLater = (video: VideoManifest, index: number): void => {
    setWatchLaterList((prev) => insertAt(prev, index, video));
    adapter.library.setWatchLater(video.id, true).then(
      () => undefined,
      (err: unknown) => {
        if (!alive.current) return;
        setWatchLaterList((prev) => prev.filter((v) => v.id !== video.id));
        pushToast({
          id: nextToastId(),
          tone: 'error',
          title: 'Could not put it back',
          description: `“${video.title}” is still removed. ${describeLibraryError(err).title}.`,
        });
      },
    );
  };

  // ---- Playlists: create, open, back ------------------------------------------------------
  const [create, setCreate] = useState<CreateState>({
    open: false,
    busy: false,
    error: undefined,
    gen: 0,
  });
  const openCreate = (): void => {
    setCreate((c) => ({ open: true, busy: false, error: undefined, gen: c.gen + 1 }));
  };
  const closeCreate = (): void => {
    setCreate((c) => ({ ...c, open: false }));
  };
  const submitCreate = (v: PlaylistFormValues): void => {
    setCreate((c) => ({ ...c, busy: true, error: undefined }));
    adapter.library
      .savePlaylist({
        title: v.title,
        videoIds: [],
        isPrivate: v.isPrivate,
        ...(v.description ? { description: v.description } : {}),
      })
      .then(
        (saved) => {
          if (!alive.current) return;
          updateSlice('playlists', (s) => ({
            ...s,
            data: [saved, ...s.data.filter((p) => p.id !== saved.id)],
          }));
          setCreate((c) => ({ ...c, open: false, busy: false }));
          pushToast({
            id: nextToastId(),
            tone: 'success',
            title: saved.isPrivate ? 'Private playlist created' : 'Playlist created',
            description: saved.title,
          });
        },
        (err: unknown) => {
          if (alive.current) setCreate((c) => ({ ...c, busy: false, error: err }));
        },
      );
  };

  const panelRef = useRef<HTMLDivElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusDetail = useRef(false);
  const returnFocusTo = useRef<string | undefined>(undefined);
  const showPlaylist = (plId: string): void => {
    focusDetail.current = true;
    setOpenPlaylist(plId);
  };
  const closePlaylist = (): void => {
    returnFocusTo.current = openPlaylist;
    setOpenPlaylist(undefined);
  };
  useEffect(() => {
    if (openPlaylist !== undefined) {
      if (focusDetail.current) {
        focusDetail.current = false;
        detailHeadingRef.current?.focus();
      }
      return;
    }
    const back = returnFocusTo.current;
    if (back === undefined) return;
    returnFocusTo.current = undefined;
    // Ids come from relays: compare the attribute rather than building a selector from it.
    const tiles = panelRef.current?.querySelectorAll<HTMLElement>('[data-playlist-id]') ?? [];
    for (const el of tiles) {
      if (el.dataset['playlistId'] === back) {
        el.focus();
        break;
      }
    }
  }, [openPlaylist]);

  // ---- infinite scroll (History) ---------------------------------------------------------
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const history = slices.history;
  const hasMoreHistory =
    activeTab === 'history' && history.status === 'ready' && history.data.next !== undefined;
  const canObserve = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMoreHistory || !canObserve) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreHistory();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
    // `more` is a dep: the sentinel re-mounts as a new element after each page.
  }, [canObserve, hasMoreHistory, history.data.more, loadMoreHistory]);

  // ---- tabs keyboard (roving tabindex, automatic activation) ------------------------------
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = tabs.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    let nextIndex: number | undefined;
    if (e.key === 'ArrowRight') nextIndex = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    e.preventDefault();
    const target = LIBRARY_TABS[nextIndex];
    tabs[nextIndex]?.focus();
    if (target) selectTab(target.id);
  };

  // ---- navigation -------------------------------------------------------------------------
  const openVideo = (video: VideoManifest): void => {
    navigate(
      video.kind === 22
        ? { name: 'shorts', videoId: video.id }
        : { name: 'watch', videoId: video.id },
    );
  };
  /** History: resume at the recorded position (`t`), unless finished or barely started. */
  const openHistoryEntry = (entry: HistoryEntry): void => {
    const v = entry.video;
    if (v.kind === 22) {
      navigate({ name: 'shorts', videoId: v.id });
      return;
    }
    const p = historyProgress(entry.positionSec, v.durationSec);
    navigate(
      p.state === 'resume'
        ? { name: 'watch', videoId: v.id, t: p.at }
        : { name: 'watch', videoId: v.id },
    );
  };
  const openChannel = (pubkey: NostrPubkey): void => {
    navigate({ name: 'channel', pubkey });
  };
  const goSettings = (): void => {
    navigate({ name: 'settings' });
  };
  const goTrending = (): void => {
    navigate({ name: 'home', tab: 'trending' });
  };

  // ---- render helpers ----------------------------------------------------------------------
  const card = (
    video: VideoManifest,
    layout: 'grid' | 'list',
    onOpen: (v: VideoManifest) => void,
    progress?: number,
  ): ReactElement => (
    <VideoCard
      video={video}
      layout={layout}
      channel={profiles[video.author] ?? undefined}
      thumbnailSrc={thumbs[video.id]}
      avatarSrc={avatars[video.author]}
      now={nowSec}
      progress={progress}
      onOpen={onOpen}
      onOpenChannel={openChannel}
    />
  );

  const visibility = (isPrivate: boolean): ReactElement => (
    <span
      className={cx('nf-library__visibility', isPrivate && 'nf-library__visibility--private')}
      title={
        isPrivate
          ? 'Private: encrypted to your key, only you can see it'
          : 'Public: anyone can see it on your channel'
      }
    >
      <Icon name={isPrivate ? 'key' : 'people'} size={14} />
      {isPrivate ? 'Private' : 'Public'}
    </span>
  );

  const errorBlock = (err: unknown, t: LibraryTab): ReactElement => {
    const e = describeLibraryError(err);
    return (
      <ErrorState
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={() => {
          retry(t);
        }}
      />
    );
  };

  const listSkeleton = (rows: number): ReactElement => (
    <ul className="nf-library__rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="nf-library__row">
          <VideoCardSkeleton layout="list" />
        </li>
      ))}
    </ul>
  );

  const collectionSkeleton = (): ReactElement => (
    <div className="nf-library__collection" aria-hidden="true">
      <div className="nf-library__hero">
        <Skeleton variant="block" aspectRatio="16 / 9" className="nf-library__hero-cover" />
        <Skeleton variant="text" width="70%" height={28} />
        <SkeletonLines lines={2} />
      </div>
      <div className="nf-library__collection-body">
        <ol className="nf-library__list">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="nf-library__item">
              <span className="nf-library__index" />
              <VideoCardSkeleton layout="list" />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );

  const skeletonFor = (t: LibraryTab): ReactElement => {
    switch (t) {
      case 'history':
        return (
          <div className="nf-library__history" aria-hidden="true">
            <Skeleton variant="text" width={120} height={24} />
            {listSkeleton(5)}
          </div>
        );
      case 'watch-later':
        return collectionSkeleton();
      case 'playlists':
        return openPlaylist !== undefined ? (
          collectionSkeleton()
        ) : (
          <ul className="nf-library__tiles" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="nf-library__tile">
                <Skeleton variant="block" aspectRatio="16 / 9" className="nf-library__tile-cover" />
                <Skeleton variant="text" width="80%" height={16} />
                <Skeleton variant="text" width="40%" height={12} />
              </li>
            ))}
          </ul>
        );
      case 'liked':
        return (
          <ul className="nf-library__grid" aria-hidden="true">
            {Array.from({ length: 8 }, (_, i) => (
              <li key={i} className="nf-library__cell">
                <VideoCardSkeleton />
              </li>
            ))}
          </ul>
        );
    }
  };

  /** Cover art for a collection: the first video's verified thumbnail. */
  const cover = (first: NostrEventId | undefined, lookup: VideoLookup | undefined): ReactNode => {
    if (first === undefined || lookup === null || lookup === 'error') {
      return (
        <span className="nf-library__cover-empty">
          <Icon name="videoOff" size={32} />
        </span>
      );
    }
    const src = isVideo(lookup) ? thumbs[lookup.id] : undefined;
    if (src === undefined) return <Skeleton variant="block" aspectRatio="16 / 9" />;
    return <img className="nf-library__cover-img" src={src} alt="" />;
  };

  const hero = (opts: {
    readonly title: string;
    readonly meta: ReactNode;
    readonly note?: string | undefined;
    readonly description?: string | undefined;
    readonly coverNode: ReactNode;
    readonly back?: ReactNode;
    readonly headingRef?: Ref<HTMLHeadingElement>;
  }): ReactElement => (
    <header className="nf-library__hero">
      {opts.back}
      <div className="nf-library__hero-cover" aria-hidden="true">
        {opts.coverNode}
      </div>
      <h2
        id={`${id}-collection`}
        ref={opts.headingRef}
        tabIndex={-1}
        className="nf-library__hero-title"
      >
        {opts.title}
      </h2>
      <p className="nf-library__hero-meta">{opts.meta}</p>
      {opts.description ? (
        <Markdown source={opts.description} className="nf-library__hero-desc" />
      ) : null}
      {opts.note ? <p className="nf-library__hero-note">{opts.note}</p> : null}
    </header>
  );

  // ---- panels --------------------------------------------------------------------------------
  const renderHistory = (): ReactElement => {
    const s = slices.history;
    if (s.status === 'idle' || s.status === 'loading') return skeletonFor('history');
    if (s.status === 'error') return errorBlock(s.error, 'history');
    if (s.data.items.length === 0) {
      return <EmptyState preset="no-history" action="Explore trending" onAction={goTrending} />;
    }
    const groups = groupHistoryByDay(s.data.items, nowSec, timeZone);
    return (
      <div className="nf-library__history">
        <h2 className="nf-library__sr">Watch history</h2>
        {groups.map((g) => (
          <section key={g.key} className="nf-library__day" aria-labelledby={`${id}-day-${g.key}`}>
            <h3 id={`${id}-day-${g.key}`} className="nf-library__day-title">
              {g.label}
            </h3>
            <ul className="nf-library__rows">
              {g.entries.map((e) => {
                const v = e.video;
                const p = historyProgress(e.positionSec, v.durationSec);
                const short = v.kind === 22;
                const label =
                  !short && p.state === 'resume'
                    ? `Resume at ${formatDuration(p.at)}`
                    : p.state === 'start'
                      ? 'Watch'
                      : 'Watch again';
                const open = (): void => {
                  openHistoryEntry(e);
                };
                return (
                  <li key={historyKey(e)} className="nf-library__row">
                    {card(v, 'list', open, p.fraction)}
                    <div className="nf-library__row-aside">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={label === 'Watch again' ? 'replay' : 'play'}
                        className="nf-library__resume"
                        aria-label={`${label}: ${v.title}`}
                        onClick={open}
                      >
                        {label}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {s.data.more === 'loading' ? listSkeleton(3) : null}
        {s.data.more === 'error' ? (
          <ErrorState
            compact
            title="Could not load more"
            description={describeLibraryError(s.data.moreError).description}
            detail={describeLibraryError(s.data.moreError).detail}
            onRetry={loadMoreHistory}
          />
        ) : null}
        {hasMoreHistory && s.data.more === 'idle' ? (
          <div className="nf-library__more">
            <div ref={sentinelRef} className="nf-library__sentinel" aria-hidden="true" />
            {canObserve ? null : (
              <Button variant="secondary" onClick={loadMoreHistory}>
                Load more
              </Button>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const renderWatchLater = (): ReactElement => {
    const s = slices['watch-later'];
    if (s.status === 'idle' || s.status === 'loading') return skeletonFor('watch-later');
    if (s.status === 'error') return errorBlock(s.error, 'watch-later');
    if (s.data.length === 0) {
      return (
        <EmptyState
          icon="play"
          title="Nothing saved for later"
          description="Save a video to Watch later and it waits here. Saving costs nothing — you only pay for what you play."
          action="Explore trending"
          onAction={goTrending}
        />
      );
    }
    const first = s.data[0];
    return (
      <div className="nf-library__collection">
        {hero({
          title: 'Watch later',
          meta: countLabel(s.data.length, 'video'),
          note: 'Saved videos cost nothing until you press play.',
          coverNode: cover(first?.id, first),
        })}
        <div className="nf-library__collection-body">
          <ol className="nf-library__list" aria-labelledby={`${id}-collection`}>
            {s.data.map((v, i) => (
              <li key={v.id} className="nf-library__item">
                <span className="nf-library__index" aria-hidden="true">
                  {i + 1}
                </span>
                {card(v, 'list', openVideo)}
                <IconButton
                  icon="close"
                  size="sm"
                  label={`Remove “${v.title}” from Watch later`}
                  className="nf-library__remove"
                  onClick={() => {
                    removeFromWatchLater(v);
                  }}
                />
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  };

  const renderPlaylistDetail = (): ReactElement => {
    const s = slices.playlists;
    if (s.status === 'idle' || s.status === 'loading') return skeletonFor('playlists');
    if (s.status === 'error') return errorBlock(s.error, 'playlists');
    const back = (
      <Button
        variant="ghost"
        size="sm"
        icon="chevronLeft"
        className="nf-library__back"
        onClick={closePlaylist}
      >
        All playlists
      </Button>
    );
    const pl = shownPlaylist;
    if (!pl) {
      return (
        <EmptyState
          icon="search"
          title="Playlist not found"
          description="It may have been deleted, or none of your relays has it."
          action="All playlists"
          onAction={closePlaylist}
        />
      );
    }
    const firstId = pl.videoIds[0];
    const coverLookup =
      pl.videoIds.map((vid) => videos[vid]).find(isVideo) ??
      (firstId !== undefined ? videos[firstId] : undefined);
    return (
      <div className="nf-library__collection">
        {hero({
          title: pl.title,
          meta: (
            <>
              {visibility(pl.isPrivate)}
              <span aria-hidden="true"> · </span>
              <span>{countLabel(pl.videoIds.length, 'video')}</span>
            </>
          ),
          description: pl.description,
          coverNode: cover(isVideo(coverLookup) ? coverLookup.id : firstId, coverLookup),
          back,
          headingRef: detailHeadingRef,
        })}
        <div className="nf-library__collection-body">
          {pl.videoIds.length === 0 ? (
            <EmptyState
              icon="videoOff"
              title="This playlist is empty"
              description="Add videos to it from the Watch page with Save."
              compact
            />
          ) : (
            <ol className="nf-library__list" aria-labelledby={`${id}-collection`}>
              {pl.videoIds.map((vid, i) => {
                const lookup = videos[vid];
                return (
                  <li key={`${vid}:${i}`} className="nf-library__item">
                    <span className="nf-library__index" aria-hidden="true">
                      {i + 1}
                    </span>
                    {isVideo(lookup) ? (
                      card(lookup, 'list', openVideo)
                    ) : lookup === undefined ? (
                      <VideoCardSkeleton layout="list" />
                    ) : (
                      <div className="nf-library__unavailable">
                        <span className="nf-library__unavailable-thumb" aria-hidden="true">
                          <Icon name="videoOff" size={28} />
                        </span>
                        <div className="nf-library__unavailable-text">
                          <p className="nf-library__unavailable-title">
                            {lookup === null ? 'Video unavailable' : 'Could not load this video'}
                          </p>
                          <p className="nf-library__unavailable-desc">
                            {lookup === null
                              ? 'It was deleted, or none of your relays has it.'
                              : 'Your relays did not answer for this one.'}
                          </p>
                        </div>
                        {lookup === 'error' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="refresh"
                            onClick={() => {
                              retryVideos([vid]);
                            }}
                          >
                            Retry
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    );
  };

  const renderPlaylists = (): ReactElement => {
    if (openPlaylist !== undefined) return renderPlaylistDetail();
    const s = slices.playlists;
    if (s.status === 'idle' || s.status === 'loading') return skeletonFor('playlists');
    if (s.status === 'error') return errorBlock(s.error, 'playlists');
    if (s.data.length === 0) {
      return (
        <EmptyState
          icon="videoOff"
          title="No playlists yet"
          description="Group videos into playlists. Private ones are encrypted to your key so only you can see them; public ones show on your channel."
          action="New playlist"
          onAction={openCreate}
        />
      );
    }
    return (
      <>
        <div className="nf-library__toolbar">
          <h2 className="nf-library__count">{countLabel(s.data.length, 'playlist')}</h2>
          <Button variant="primary" className="nf-library__new" onClick={openCreate}>
            New playlist
          </Button>
        </div>
        <ul className="nf-library__tiles">
          {s.data.map((pl) => {
            const first = pl.videoIds[0];
            const lookup = first !== undefined ? videos[first] : undefined;
            const count = countLabel(pl.videoIds.length, 'video');
            const open = (): void => {
              showPlaylist(pl.id);
            };
            return (
              <li key={pl.id} className="nf-library__tile">
                <button
                  type="button"
                  className="nf-library__tile-cover"
                  tabIndex={-1}
                  aria-label={`${pl.title}, ${count}`}
                  onClick={open}
                >
                  {cover(first, lookup)}
                  <span className="nf-library__tile-count">{count}</span>
                </button>
                <h3 className="nf-library__tile-title">
                  <button
                    type="button"
                    className="nf-library__tile-open"
                    data-playlist-id={pl.id}
                    onClick={open}
                  >
                    {pl.title}
                  </button>
                </h3>
                <p className="nf-library__tile-meta">
                  {visibility(pl.isPrivate)}
                  <span aria-hidden="true"> · </span>
                  <span>View full playlist</span>
                </p>
              </li>
            );
          })}
        </ul>
      </>
    );
  };

  const renderLiked = (): ReactElement => {
    const s = slices.liked;
    if (s.status === 'idle' || s.status === 'loading') return skeletonFor('liked');
    if (s.status === 'error') return errorBlock(s.error, 'liked');
    if (s.data.length === 0) {
      return (
        <EmptyState
          icon="check"
          title="No liked videos yet"
          description="Like a video and it shows up here. Likes are public Nostr reactions — anyone can see them."
          action="Explore trending"
          onAction={goTrending}
        />
      );
    }
    // Shorts (kind 22) go to their own shelf, as on Home: 9:16 cards break the grid rhythm.
    const longs = s.data.filter((v) => v.kind !== 22);
    const shorts = s.data.filter((v) => v.kind === 22);
    return (
      <>
        <h2 className="nf-library__count">{countLabel(s.data.length, 'liked video')}</h2>
        {longs.length > 0 ? (
          <ul className="nf-library__grid">
            {longs.map((v) => (
              <li key={v.id} className="nf-library__cell">
                {card(v, 'grid', openVideo)}
              </li>
            ))}
          </ul>
        ) : null}
        {shorts.length > 0 ? (
          <section className="nf-library__shorts" aria-labelledby={`${id}-liked-shorts`}>
            <h3 id={`${id}-liked-shorts`} className="nf-library__day-title">
              Shorts
            </h3>
            <ul className="nf-library__shorts-list">
              {shorts.map((v) => (
                <li key={v.id} className="nf-library__cell">
                  {card(v, 'grid', openVideo)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </>
    );
  };

  const renderBody = (): ReactElement => {
    switch (identity.state) {
      case 'pending':
        return skeletonFor(activeTab);
      case 'error':
        return errorBlock(identity.error, activeTab);
      case 'signed-out': {
        const signer = identity.signer;
        const locked = signer?.locked === true && typeof signer.pubkey === 'string';
        return locked ? (
          <EmptyState
            preset="signer-not-detected"
            title="Your signer is locked"
            description="Unlock it to see your library. History, Watch later and private playlists are encrypted to your key, so they can only be read while your signer is unlocked."
            action="Unlock in Settings"
            onAction={goSettings}
          />
        ) : (
          <EmptyState
            preset="signer-not-detected"
            title={SIGNED_OUT_TITLE[activeTab]}
            description="Your library lives on Nostr as lists tied to your key (NIP-51); private ones are encrypted so only you can read them. Connect a signer — a NIP-07 extension, a NIP-46 remote signer or a local key — to see it here."
            onAction={goSettings}
          />
        );
      }
      case 'signed-in':
        break;
    }
    switch (activeTab) {
      case 'history':
        return renderHistory();
      case 'watch-later':
        return renderWatchLater();
      case 'playlists':
        return renderPlaylists();
      case 'liked':
        return renderLiked();
    }
  };

  const slice = slices[activeTab];
  const busy =
    identity.state === 'pending' ||
    (identity.state === 'signed-in' &&
      (slice.status === 'idle' ||
        slice.status === 'loading' ||
        (activeTab === 'history' && history.data.more === 'loading')));
  const hint = identity.state === 'signed-in' ? TAB_HINT[activeTab] : undefined;

  return (
    <section className={cx('nf-library', className)} aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="nf-library__title">
        Library
      </h1>
      <div className="nf-library__bar">
        <div
          role="tablist"
          aria-label="Library lists"
          className="nf-library__tabs"
          onKeyDown={onTabKeyDown}
        >
          {LIBRARY_TABS.map((t) => {
            const selected = t.id === activeTab;
            return (
              <Button
                key={t.id}
                id={`${id}-tab-${t.id}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                variant={selected ? 'primary' : 'secondary'}
                className="nf-library__tab"
                onClick={() => {
                  selectTab(t.id);
                }}
              >
                {t.label}
              </Button>
            );
          })}
        </div>
        {hint ? (
          <p className="nf-library__hint">
            <Icon name={hint.icon} size={14} />
            {hint.text}
          </p>
        ) : null}
      </div>
      <div
        ref={panelRef}
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${activeTab}`}
        className="nf-library__panel"
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        {renderBody()}
      </div>
      <Sheet open={create.open} onClose={closeCreate} title="New playlist">
        {create.open ? (
          <PlaylistForm
            key={create.gen}
            busy={create.busy}
            error={create.error}
            onSubmit={submitCreate}
            onCancel={closeCreate}
          />
        ) : null}
      </Sheet>
      <ToastStack toasts={toasts} onDismiss={dismissToast} inline className="nf-library__toasts" />
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-library__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
