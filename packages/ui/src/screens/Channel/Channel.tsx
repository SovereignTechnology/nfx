/**
 * Channel screen (build-plan §6.1 row "Channel"): banner, avatar, the channel title with its
 * NIP-05 state (verified / unverified / failed / absent all look different), a Subscribe
 * button, "Seeding N videos" when the channel runs a seeder, and tabs — Videos / Shorts /
 * Playlists / About.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 *
 * - T16: every image (banner, avatar, thumbnails, playlist thumbs) goes through
 *   `adapter.image(url, sha256)` before display, with a `Skeleton` while it is pending. Only
 *   NIP-71 thumbnails carry an `x` hash — kind-0 `picture`/`banner` URLs are resolved hashless.
 *   A rejected image leaves the placeholder (initials for the avatar, a plain block for the
 *   banner); nothing unverified is ever put in an `<img>`.
 * - Price before play: video/short cards carry L4's `SatsBadge` price on the thumbnail. The
 *   one play-shaped control this screen adds — a playlist's "Play all" thumbnail — exists only
 *   once the playlist's first video is resolved, and renders that video's price (`SatsBadge`)
 *   before the play glyph in DOM order. Playback itself (and payment) only starts on Watch.
 * - Text (channel description, playlist descriptions) renders through `Markdown` only.
 * - Navigation is `navigate(Route)`; errors land in `ErrorState` — nothing throws to the
 *   shell; every effect cancels on unmount or pubkey change.
 *
 * "Seeding N videos" (CONTRACTS_VERSION 3 reading): the adapter exposes no author-scoped
 * kind-10019 lookup. What exists is (a) `adapter.seeder.status()` — the LOCAL node's seeder,
 * authoritative when you are looking at your own channel — and (b) `VideoStats.seedersOnline`,
 * a per-video count of ANY seeder announcing that core. (b) cannot say whether the channel
 * itself runs a seeder (a popular video has seeders whoever made it), so it is shown only as
 * "availability" on the About tab; the header indicator comes from (a), or from the
 * `seedingVideos` prop when the shell knows (see docs/contract-requests/L5-Channel.md).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type {
  NostrEventId,
  NostrPubkey,
  Playlist,
  Profile,
  SeederStatus,
  Sha256Hex,
  UnixSeconds,
  VideoManifest,
  VideoStats,
} from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Markdown,
  MarkdownTreeView,
  ProfileAvatar,
  SatsBadge,
  Skeleton,
  VideoCard,
  VideoCardSkeleton,
  cheapestRenditionSats,
  cx,
  formatInteger,
  formatSats,
  parseMarkdown,
  shortPubkey,
} from '../../components/index.js';
import type { Route, ScreenProps } from '../shared/route.js';

/** The four Channel tabs; kept in sync with `Route['tab']` for `name: 'channel'`. */
export type ChannelTab = NonNullable<Extract<Route, { readonly name: 'channel' }>['tab']>;

export const CHANNEL_TABS: readonly { readonly id: ChannelTab; readonly label: string }[] = [
  { id: 'videos', label: 'Videos' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'about', label: 'About' },
];

/** Author-feed page size (kind 21 and 22 arrive together and are split client-side). */
export const CHANNEL_PAGE_SIZE = 24;

export interface ChannelProps extends ScreenProps {
  /** The channel's pubkey (route prop). */
  readonly pubkey: NostrPubkey;
  /** Initial tab (route prop). Defaults to `videos`; a changed prop is followed. */
  readonly tab?: ChannelTab | undefined;
  /**
   * How many videos this channel's own seeder serves, when the shell knows it runs one (its
   * kind-10019 seeder announcement). CONTRACTS_VERSION 3 has no author-scoped seeder lookup,
   * so this is a shell-supplied prop, like Home's `followedTags`. On your own channel the
   * local `adapter.seeder` status is used instead.
   */
  readonly seedingVideos?: number | undefined;
  /** "now" for relative timestamps; stories/tests pin it so PNGs are diffable. */
  readonly now?: UnixSeconds | number | undefined;
  /** Author-feed page size (`FeedQuery.limit`). */
  readonly pageSize?: number | undefined;
  readonly className?: string | undefined;
}

type LoadStatus = 'loading' | 'ready' | 'error';

interface ProfileState {
  readonly status: LoadStatus;
  /** `null` with status `ready` = the relays know no kind 0 for this pubkey. */
  readonly profile: Profile | null;
  readonly error?: unknown;
}

interface VideosState {
  readonly status: LoadStatus;
  readonly items: readonly VideoManifest[];
  /** Cursor of the next author-feed page; `undefined` = everything is loaded. */
  readonly next: string | undefined;
  /** The "Show more" page. */
  readonly more: 'idle' | 'loading' | 'error';
  readonly error?: unknown;
}

interface PlaylistsState {
  readonly status: 'idle' | LoadStatus;
  readonly items: readonly Playlist[];
  readonly error?: unknown;
}

/** `'pending'` until `adapter.me()` (and, when signed in, `adapter.subscriptions()`) answer. */
type Identity =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly me: NostrPubkey | null; readonly subscribed: boolean }
  | { readonly status: 'error'; readonly error: unknown };

/** A T16-resolved image: the displayable URL, or `null` when `adapter.image` rejected it. */
type ImageCache = Readonly<Record<string, string | null>>;

type ImageState =
  | { readonly status: 'none' }
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly src: string }
  | { readonly status: 'failed' };

const imageKey = (url: string, sha256: Sha256Hex | undefined): string => `${sha256 ?? '-'} ${url}`;

/** The thumbnail of a video: the first rendition that carries one. */
function thumbOf(
  video: VideoManifest,
): { readonly url: string; readonly sha256?: Sha256Hex } | undefined {
  return video.renditions.find((r) => r.image !== undefined)?.image;
}

/** Human copy for a failed adapter call. Never a stack trace (the shell logs those). */
export function describeChannelError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, so this channel cannot be loaded. Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not load this channel. Try again in a moment.',
    detail: message || undefined,
  };
}

/**
 * What the header shows for the channel's NIP-05 identifier:
 * - `verified` — a live lookup confirmed the identifier maps to this pubkey (check mark);
 * - `unverified` — an identifier is claimed but has not been confirmed (flagged, no check);
 * - `failed` — the lookup ran and the domain does NOT list this pubkey (struck through, warned);
 * - `none` — no identifier; the short pubkey is shown instead.
 */
export type Nip05State = 'verified' | 'unverified' | 'failed' | 'none';

export function nip05State(profile: Pick<Profile, 'nip05' | 'nip05Status'>): Nip05State {
  if (profile.nip05 === undefined || profile.nip05.trim() === '') return 'none';
  if (profile.nip05Status === 'verified') return 'verified';
  if (profile.nip05Status === 'failed') return 'failed';
  return 'unverified';
}

/** NIP-05 line for the About tab's details list. */
export function describeNip05(profile: Pick<Profile, 'nip05' | 'nip05Status'>): string {
  const state = nip05State(profile);
  if (state === 'none' || profile.nip05 === undefined) return 'Not set';
  const status =
    state === 'verified' ? 'verified' : state === 'failed' ? 'verification failed' : 'not verified';
  return `${profile.nip05} — ${status}`;
}

function countLabel(n: number, singular: string, plural: string): string {
  return `${formatInteger(n)} ${n === 1 ? singular : plural}`;
}

/** Header copy for the channel's seeder: "Seeding 1 video" / "Seeding 12 videos". */
export function seedingLabel(videos: number): string {
  return `Seeding ${countLabel(videos, 'video', 'videos')}`;
}

function Nip05Identity({
  profile,
  state,
}: {
  readonly profile: Profile;
  readonly state: Nip05State;
}): ReactElement {
  const claimed = profile.nip05 ?? '';
  switch (state) {
    case 'verified':
      return (
        <span className="nf-channelpage__nip05 nf-channelpage__nip05--verified">{claimed}</span>
      );
    case 'unverified':
      return (
        <span className="nf-channelpage__nip05 nf-channelpage__nip05--unverified">
          <span className="nf-channelpage__nip05-id">{claimed}</span>
          <span
            className="nf-channelpage__nip05-flag"
            title="This NIP-05 identifier has not been checked against its domain yet."
          >
            <Icon name="info" size={14} />
            <span>Unverified</span>
          </span>
        </span>
      );
    case 'failed':
      return (
        <span className="nf-channelpage__nip05 nf-channelpage__nip05--failed">
          <s className="nf-channelpage__nip05-id">{claimed}</s>
          <span
            className="nf-channelpage__nip05-flag nf-channelpage__nip05-flag--failed"
            title="The domain does not list this public key. The identifier is not proof of who runs this channel."
          >
            <Icon name="error" size={14} />
            <span>Verification failed</span>
          </span>
        </span>
      );
    case 'none':
      return (
        <code className="nf-channelpage__pubkey" title="Public key">
          {shortPubkey(profile.pubkey)}
        </code>
      );
  }
}

export function Channel({
  adapter,
  navigate,
  miniPlayer,
  pubkey,
  tab,
  seedingVideos,
  now,
  pageSize = CHANNEL_PAGE_SIZE,
  className,
}: ChannelProps): ReactElement {
  const id = useId();
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  /** Guards every late resolution (images, stats, pages) against setState-after-unmount. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- tab ---------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<ChannelTab>(tab ?? 'videos');
  useEffect(() => {
    if (tab !== undefined) setActiveTab(tab);
  }, [tab]);

  const selectTab = useCallback(
    (next: ChannelTab): void => {
      setActiveTab(next);
      navigate({ name: 'channel', pubkey, tab: next });
    },
    [navigate, pubkey],
  );

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
    const target = CHANNEL_TABS[nextIndex];
    tabs[nextIndex]?.focus();
    if (target) selectTab(target.id);
  };

  // ---- images (T16): one cache for banner, avatar, thumbnails, playlist thumbs ------------
  const [images, setImages] = useState<ImageCache>({});
  const requestedImages = useRef(new Set<string>());
  const requestImage = useCallback(
    (url: string, sha256: Sha256Hex | undefined): void => {
      const key = imageKey(url, sha256);
      if (requestedImages.current.has(key)) return;
      requestedImages.current.add(key);
      const call = sha256 === undefined ? adapter.image(url) : adapter.image(url, sha256);
      call.then(
        (src) => {
          if (alive.current) setImages((prev) => ({ ...prev, [key]: src }));
        },
        () => {
          // hash mismatch / unreachable → the placeholder stays (never the raw URL)
          if (alive.current) setImages((prev) => ({ ...prev, [key]: null }));
        },
      );
    },
    [adapter],
  );
  const imageFor = (url: string | undefined, sha256?: Sha256Hex): ImageState => {
    if (url === undefined) return { status: 'none' };
    const v = images[imageKey(url, sha256)];
    if (v === undefined) return { status: 'pending' };
    return v === null ? { status: 'failed' } : { status: 'ready', src: v };
  };

  // ---- identity (viewer) ---------------------------------------------------------------
  const [identity, setIdentity] = useState<Identity>({ status: 'pending' });
  const [identityGen, setIdentityGen] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    setIdentity({ status: 'pending' });
    adapter.me().then(
      (me) => {
        if (cancelled()) return;
        if (me === null) {
          setIdentity({ status: 'ready', me: null, subscribed: false });
          return;
        }
        adapter.subscriptions().then(
          (subs) => {
            if (cancelled()) return;
            setIdentity({ status: 'ready', me, subscribed: subs.includes(pubkey) });
          },
          (err: unknown) => {
            if (!cancelled()) setIdentity({ status: 'error', error: err });
          },
        );
      },
      (err: unknown) => {
        if (!cancelled()) setIdentity({ status: 'error', error: err });
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter, pubkey, identityGen]);

  const ownChannel = identity.status === 'ready' && identity.me === pubkey;

  const [subBusy, setSubBusy] = useState(false);
  const onSubscribe = useCallback((): void => {
    if (identity.status === 'error') {
      setIdentityGen((g) => g + 1);
      return;
    }
    if (identity.status !== 'ready') return;
    if (identity.me === null) {
      // Subscribing needs a signer; send signed-out visitors to connect one.
      navigate({ name: 'settings' });
      return;
    }
    if (subBusy) return;
    const next = !identity.subscribed;
    setSubBusy(true);
    const call = next ? adapter.subscribe(pubkey) : adapter.unsubscribe(pubkey);
    call.then(
      () => {
        if (!alive.current) return;
        setSubBusy(false);
        setIdentity({ status: 'ready', me: identity.me, subscribed: next });
      },
      () => {
        // Leave the previous state in place; the next click retries.
        if (alive.current) setSubBusy(false);
      },
    );
  }, [adapter, identity, navigate, pubkey, subBusy]);

  // ---- own channel: the local seeder (live) ----------------------------------------------
  const [ownSeeder, setOwnSeeder] = useState<SeederStatus | null>(null);
  useEffect(() => {
    if (!ownChannel) return;
    let cancelled = false;
    adapter.seeder.status().then(
      (s) => {
        if (!cancelled) setOwnSeeder(s);
      },
      () => undefined, // no local seeder (e.g. web) → no indicator
    );
    const off = adapter.seeder.onStatus((s) => {
      if (!cancelled) setOwnSeeder(s);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [adapter, ownChannel]);

  /** The header's "Seeding N videos": own seeder when it is this channel's, else the prop. */
  const seedingCount: number | undefined =
    ownChannel && ownSeeder !== null && ownSeeder.pubkey === pubkey
      ? ownSeeder.enabled
        ? ownSeeder.videos
        : undefined
      : seedingVideos;

  // ---- channel profile (kind 0) ---------------------------------------------------------
  const [profileState, setProfileState] = useState<ProfileState>({
    status: 'loading',
    profile: null,
  });
  const [profileGen, setProfileGen] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setProfileState({ status: 'loading', profile: null });
    adapter.profile(pubkey).then(
      (p) => {
        if (!ac.signal.aborted) setProfileState({ status: 'ready', profile: p });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setProfileState({ status: 'error', profile: null, error: err });
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter, pubkey, profileGen]);

  // ---- author feed (kind 21 + 22, split client-side), paged ------------------------------
  const [videos, setVideos] = useState<VideosState>({
    status: 'loading',
    items: [],
    next: undefined,
    more: 'idle',
  });
  const [videosGen, setVideosGen] = useState(0);
  const moreAc = useRef<AbortController | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setVideos({ status: 'loading', items: [], next: undefined, more: 'idle' });
    adapter.feed({ source: 'author', author: pubkey, limit: pageSize }).then(
      (page) => {
        if (!ac.signal.aborted)
          setVideos({ status: 'ready', items: page.items, next: page.next, more: 'idle' });
      },
      (err: unknown) => {
        if (!ac.signal.aborted)
          setVideos({ status: 'error', items: [], next: undefined, more: 'idle', error: err });
      },
    );
    return () => {
      ac.abort();
      moreAc.current?.abort();
      moreAc.current = null;
    };
  }, [adapter, pubkey, pageSize, videosGen]);

  const loadMore = (): void => {
    if (videos.status !== 'ready' || videos.next === undefined || videos.more === 'loading') return;
    const cursor = videos.next;
    moreAc.current?.abort();
    const ac = new AbortController();
    moreAc.current = ac;
    setVideos((v) => ({ ...v, more: 'loading' }));
    adapter.feed({ source: 'author', author: pubkey, limit: pageSize, cursor }).then(
      (page) => {
        if (ac.signal.aborted || !alive.current) return;
        setVideos((v) => {
          const seen = new Set(v.items.map((x) => x.id));
          return {
            ...v,
            items: [...v.items, ...page.items.filter((x) => !seen.has(x.id))],
            next: page.next,
            more: 'idle',
          };
        });
      },
      () => {
        if (!ac.signal.aborted && alive.current) setVideos((v) => ({ ...v, more: 'error' }));
      },
    );
  };

  // ---- per-video resolution: thumbnails (T16, hash-verified) + stats (views, availability)
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats>>>({});
  const requestedStats = useRef(new Set<NostrEventId>());
  useEffect(() => {
    if (videos.status !== 'ready') return;
    for (const v of videos.items) {
      const image = thumbOf(v);
      if (image) requestImage(image.url, image.sha256);
      if (requestedStats.current.has(v.id)) continue;
      requestedStats.current.add(v.id);
      adapter.stats(v.id).then(
        (s) => {
          if (alive.current) setStats((prev) => ({ ...prev, [v.id]: s }));
        },
        () => undefined, // a failed stat never blocks the card; it just lacks paid views
      );
    }
  }, [adapter, videos, requestImage]);

  // ---- which profile the header shows ----------------------------------------------------
  // A pubkey with videos but no kind 0 is still a channel (plenty of Nostr keys never publish
  // a profile): it renders under its short pubkey. "Not found" = no profile AND no videos.
  const fallbackProfile = useMemo<Profile>(
    () => ({ pubkey, nip05Status: 'none', fetchedAt: 0 as UnixSeconds }),
    [pubkey],
  );
  const profileMissing = profileState.status === 'ready' && profileState.profile === null;
  const profile: Profile | null =
    profileState.status !== 'ready'
      ? null
      : (profileState.profile ??
        (videos.status === 'ready' && videos.items.length > 0 ? fallbackProfile : null));
  const name = profile ? (profile.displayName ?? profile.name ?? shortPubkey(pubkey)) : '';
  const about = profile?.about?.trim() ?? '';
  /** Header teaser: the description's first paragraph only, still via the Markdown subset. */
  const blurb = useMemo(() => (about === '' ? [] : parseMarkdown(about).slice(0, 1)), [about]);

  useEffect(() => {
    if (profile === null) return;
    if (profile.banner !== undefined) requestImage(profile.banner, undefined);
    if (profile.picture !== undefined) requestImage(profile.picture, undefined);
  }, [profile, requestImage]);

  // ---- playlists (NIP-51 kind 30005 video sets by this author), lazy per tab --------------
  const [playlists, setPlaylists] = useState<PlaylistsState>({ status: 'idle', items: [] });
  const [playlistsGen, setPlaylistsGen] = useState(0);
  const playlistsKey = useRef('');
  useEffect(() => {
    if (activeTab !== 'playlists') return;
    const key = `${pubkey}|${String(playlistsGen)}`;
    if (playlistsKey.current === key) return;
    playlistsKey.current = key;
    const ac = new AbortController();
    let done = false;
    setPlaylists({ status: 'loading', items: [] });
    adapter.library.playlists(pubkey).then(
      (items) => {
        if (ac.signal.aborted) return;
        done = true;
        setPlaylists({ status: 'ready', items });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        done = true;
        setPlaylists({ status: 'error', items: [], error: err });
      },
    );
    return () => {
      ac.abort();
      if (!done) playlistsKey.current = ''; // interrupted → refetch when the tab returns
    };
  }, [adapter, activeTab, pubkey, playlistsGen]);

  // Each playlist's first video: its price (shown before "Play all") and its thumbnail.
  const [firstVideos, setFirstVideos] = useState<Readonly<Record<string, VideoManifest | null>>>(
    {},
  );
  const requestedFirst = useRef(new Set<NostrEventId>());
  useEffect(() => {
    if (playlists.status !== 'ready') return;
    for (const p of playlists.items) {
      const first = p.videoIds[0];
      if (first === undefined || requestedFirst.current.has(first)) continue;
      requestedFirst.current.add(first);
      adapter.video(first).then(
        (v) => {
          if (alive.current) setFirstVideos((prev) => ({ ...prev, [first]: v }));
        },
        () => {
          if (alive.current) setFirstVideos((prev) => ({ ...prev, [first]: null }));
        },
      );
    }
  }, [adapter, playlists]);
  useEffect(() => {
    for (const v of Object.values(firstVideos)) {
      const image = v ? thumbOf(v) : undefined;
      if (image) requestImage(image.url, image.sha256);
    }
  }, [firstVideos, requestImage]);

  // ---- navigation ------------------------------------------------------------------------
  const openVideo = (video: VideoManifest): void => {
    navigate({ name: 'watch', videoId: video.id });
  };
  const openShort = (video: VideoManifest): void => {
    navigate({ name: 'shorts', videoId: video.id });
  };
  const openUpload = (): void => {
    navigate({ name: 'studio', tab: 'upload' });
  };

  const retryAll = (): void => {
    setProfileGen((g) => g + 1);
    setVideosGen((g) => g + 1);
    setIdentityGen((g) => g + 1);
  };

  // ---- render ------------------------------------------------------------------------------

  const skeletonGrid = (count: number, shorts: boolean): ReactElement => (
    <ul
      className={shorts ? 'nf-channelpage__shorts-grid' : 'nf-channelpage__grid'}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="nf-channelpage__item">
          <VideoCardSkeleton />
        </li>
      ))}
    </ul>
  );

  const renderVideoEmpty = (shorts: boolean): ReactElement => {
    if (videos.next !== undefined) {
      // This page had none of this kind, but older uploads might.
      return (
        <EmptyState
          icon="videoOff"
          title={shorts ? 'No shorts in the latest uploads' : 'No videos in the latest uploads'}
          description={`Only this channel's ${countLabel(videos.items.length, 'newest upload is', 'newest uploads are')} loaded so far. Older ones may include some.`}
          action="Load older uploads"
          onAction={loadMore}
        />
      );
    }
    if (ownChannel) {
      return shorts ? (
        <EmptyState
          icon="videoOff"
          title="You have not published any shorts"
          description="Upload a vertical clip as a short and it shows up here, priced like any other video."
          action="Upload a short"
          onAction={openUpload}
        />
      ) : (
        <EmptyState
          icon="videoOff"
          title="You have not published any videos"
          description="Upload a video, set its price, and it shows up here and in your subscribers' feeds."
          action="Upload a video"
          onAction={openUpload}
        />
      );
    }
    return shorts ? (
      <EmptyState
        icon="videoOff"
        title="No shorts yet"
        description="Short vertical videos from this channel will show up here."
      />
    ) : (
      <EmptyState preset="no-videos" />
    );
  };

  const renderVideoPanel = (shorts: boolean): ReactElement => {
    if (videos.status === 'loading') return skeletonGrid(8, shorts);
    if (videos.status === 'error') {
      const e = describeChannelError(videos.error);
      return (
        <ErrorState
          title={e.title}
          description={e.description}
          detail={e.detail}
          onRetry={() => {
            setVideosGen((g) => g + 1);
          }}
        />
      );
    }
    const items = videos.items.filter((v) => v.kind === (shorts ? 22 : 21));
    if (items.length === 0 && videos.more !== 'loading') return renderVideoEmpty(shorts);
    return (
      <div className="nf-channelpage__list">
        <ul className={shorts ? 'nf-channelpage__shorts-grid' : 'nf-channelpage__grid'}>
          {items.map((v) => {
            const image = thumbOf(v);
            const thumb = imageFor(image?.url, image?.sha256);
            const s = stats[v.id];
            return (
              <li key={v.id} className="nf-channelpage__item">
                <VideoCard
                  video={v}
                  hideChannel
                  thumbnailSrc={thumb.status === 'ready' ? thumb.src : undefined}
                  stats={s}
                  now={nowSec}
                  onOpen={shorts ? openShort : openVideo}
                />
              </li>
            );
          })}
          {videos.more === 'loading'
            ? Array.from({ length: 4 }, (_, i) => (
                <li key={`more-${String(i)}`} className="nf-channelpage__item" aria-hidden="true">
                  <VideoCardSkeleton />
                </li>
              ))
            : null}
        </ul>
        {videos.more === 'error' ? (
          <ErrorState
            compact
            title="Could not load more"
            description="The next page of this channel did not arrive. The videos above are still here."
            onRetry={loadMore}
          />
        ) : videos.next !== undefined && videos.more === 'idle' ? (
          <div className="nf-channelpage__more-row">
            <Button variant="secondary" onClick={loadMore}>
              Show more
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderPlaylistThumb = (p: Playlist): ReactElement => {
    const count = (
      <span className="nf-channelpage__playlist-count">
        {countLabel(p.videoIds.length, 'video', 'videos')}
      </span>
    );
    const first = p.videoIds[0];
    const firstVideo = first === undefined ? undefined : firstVideos[first];
    if (first !== undefined && firstVideo === undefined) {
      // first video still resolving: no play affordance until its price is known
      return (
        <span className="nf-channelpage__playlist-thumb" aria-hidden="true">
          <Skeleton variant="block" />
          {count}
        </span>
      );
    }
    const price = firstVideo
      ? cheapestRenditionSats(firstVideo.renditions, firstVideo.price)
      : undefined;
    if (!firstVideo || !price) {
      // empty set, or its first video is gone: nothing to play, so nothing play-shaped
      return (
        <span className="nf-channelpage__playlist-thumb" aria-hidden="true">
          <span className="nf-channelpage__playlist-placeholder">
            <Icon name="videoOff" size={28} />
          </span>
          {count}
        </span>
      );
    }
    const image = thumbOf(firstVideo);
    const thumb = imageFor(image?.url, image?.sha256);
    const priceText = `${price.from ? 'from ' : ''}${formatSats(price.sats)}`;
    return (
      <button
        type="button"
        className="nf-channelpage__playlist-thumb"
        aria-label={`Play all: ${p.title}. First video ${priceText}`}
        onClick={() => {
          openVideo(firstVideo);
        }}
      >
        {thumb.status === 'ready' ? (
          <img src={thumb.src} alt="" loading="lazy" decoding="async" />
        ) : thumb.status === 'pending' ? (
          <Skeleton variant="block" />
        ) : (
          <span className="nf-channelpage__playlist-placeholder" aria-hidden="true">
            <Icon name="videoOff" size={28} />
          </span>
        )}
        {/* price first (DOM order), then the play affordance */}
        <SatsBadge
          className="nf-channelpage__playlist-price"
          sats={price.sats}
          variant="price"
          size="sm"
          overlay
          compact
          label={`First video ${priceText}`}
          {...(price.from ? { prefix: 'from' } : {})}
        />
        {count}
        <span className="nf-channelpage__playlist-play" aria-hidden="true">
          <Icon name="play" size={20} />
          <span>Play all</span>
        </span>
      </button>
    );
  };

  const renderPlaylistsPanel = (): ReactElement => {
    if (playlists.status === 'idle' || playlists.status === 'loading') {
      return (
        <ul className="nf-channelpage__playlists" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="nf-channelpage__playlist">
              <span className="nf-channelpage__playlist-thumb">
                <Skeleton variant="block" />
              </span>
              <span className="nf-channelpage__playlist-body">
                <Skeleton variant="text" width="70%" height={16} />
                <Skeleton variant="text" width="40%" height={14} />
              </span>
            </li>
          ))}
        </ul>
      );
    }
    if (playlists.status === 'error') {
      const e = describeChannelError(playlists.error);
      return (
        <ErrorState
          title={e.title}
          description={e.description}
          detail={e.detail}
          onRetry={() => {
            setPlaylistsGen((g) => g + 1);
          }}
        />
      );
    }
    if (playlists.items.length === 0) {
      return ownChannel ? (
        <EmptyState
          icon="videoOff"
          title="You have no playlists yet"
          description="Playlists you create in your Library are published as NIP-51 video sets and show up here."
          action="Open Library"
          onAction={() => {
            navigate({ name: 'library', tab: 'playlists' });
          }}
        />
      ) : (
        <EmptyState
          icon="videoOff"
          title="No playlists yet"
          description="When this channel curates a set of videos, it shows up here."
        />
      );
    }
    return (
      <ul className="nf-channelpage__playlists">
        {playlists.items.map((p, i) => {
          const first = p.videoIds[0];
          const firstVideo = first === undefined ? undefined : firstVideos[first];
          // Same rule as the thumbnail: the title only plays once the price is known.
          const playTarget =
            firstVideo && cheapestRenditionSats(firstVideo.renditions, firstVideo.price)
              ? firstVideo
              : undefined;
          const titleId = `${id}-pl-${String(i)}`;
          return (
            <li key={`${p.author}:${p.id}`} className="nf-channelpage__playlist">
              {renderPlaylistThumb(p)}
              <div className="nf-channelpage__playlist-body">
                <h3 id={titleId} className="nf-channelpage__playlist-title">
                  {playTarget ? (
                    <button
                      type="button"
                      className="nf-channelpage__playlist-open"
                      onClick={() => {
                        openVideo(playTarget);
                      }}
                    >
                      {p.title}
                    </button>
                  ) : (
                    p.title
                  )}
                </h3>
                <p className="nf-channelpage__playlist-meta">
                  <span>{countLabel(p.videoIds.length, 'video', 'videos')}</span>
                  {p.isPrivate ? (
                    <span
                      className="nf-channelpage__playlist-private"
                      title="Encrypted: only the author can see this set"
                    >
                      Private
                    </span>
                  ) : null}
                </p>
                {first !== undefined && firstVideo === null ? (
                  <p className="nf-channelpage__playlist-note">
                    The first video in this playlist is no longer available.
                  </p>
                ) : null}
                {p.description !== undefined && p.description.trim() !== '' ? (
                  <Markdown
                    source={p.description}
                    className="nf-channelpage__playlist-desc"
                    maxChars={400}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  };

  const renderAvailability = (): string | null => {
    if (videos.status !== 'ready' || videos.items.length === 0) return null;
    const known = videos.items.filter((v) => stats[v.id] !== undefined);
    if (known.length < videos.items.length) return 'Checking seeders…';
    const seeded = known.filter((v) => (stats[v.id]?.seedersOnline ?? 0) > 0).length;
    return seeded === 0
      ? 'No seeders online for these videos right now'
      : `Seeders online for ${formatInteger(seeded)} of ${countLabel(known.length, 'video', 'videos')}`;
  };

  const renderAboutPanel = (): ReactElement => {
    if (!profile) {
      return (
        <div className="nf-channelpage__about" aria-hidden="true">
          <Skeleton variant="text" width="30%" height={20} />
          <Skeleton variant="text" width="90%" />
          <Skeleton variant="text" width="75%" />
        </div>
      );
    }
    const availability = renderAvailability();
    return (
      <div className="nf-channelpage__about">
        <section className="nf-channelpage__about-section" aria-labelledby={`${id}-desc`}>
          <h2 id={`${id}-desc`} className="nf-channelpage__section-title">
            Description
          </h2>
          {about !== '' ? (
            <Markdown source={about} className="nf-channelpage__desc" />
          ) : (
            <EmptyState
              icon="info"
              title="No description yet"
              description={
                ownChannel
                  ? 'You have not added a channel description to your Nostr profile.'
                  : `${name} has not added a channel description.`
              }
              compact
            />
          )}
        </section>
        <section className="nf-channelpage__about-section" aria-labelledby={`${id}-details`}>
          <h2 id={`${id}-details`} className="nf-channelpage__section-title">
            Details
          </h2>
          <dl className="nf-channelpage__details">
            <div className="nf-channelpage__detail">
              <dt>NIP-05</dt>
              <dd>{describeNip05(profile)}</dd>
            </div>
            <div className="nf-channelpage__detail">
              <dt>Public key</dt>
              <dd>
                <code>{shortPubkey(profile.pubkey)}</code>
              </dd>
            </div>
            {profile.lud16 !== undefined ? (
              <div className="nf-channelpage__detail">
                <dt>Lightning address</dt>
                <dd>{profile.lud16}</dd>
              </div>
            ) : null}
            {seedingCount !== undefined && seedingCount > 0 ? (
              <div className="nf-channelpage__detail">
                <dt>Seeder</dt>
                <dd>Runs a seeder · {seedingLabel(seedingCount).toLowerCase()}</dd>
              </div>
            ) : ownChannel && ownSeeder !== null ? (
              <div className="nf-channelpage__detail">
                <dt>Seeder</dt>
                <dd>Seeding is off on this device</dd>
              </div>
            ) : null}
            {availability !== null ? (
              <div className="nf-channelpage__detail">
                <dt>Availability</dt>
                <dd>{availability}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      </div>
    );
  };

  const panelBusy =
    activeTab === 'videos' || activeTab === 'shorts'
      ? videos.status === 'loading' || videos.more === 'loading'
      : activeTab === 'playlists'
        ? playlists.status === 'idle' || playlists.status === 'loading'
        : profile === null;

  const renderPanel = (): ReactElement => {
    if (activeTab === 'about') return renderAboutPanel();
    if (activeTab === 'playlists') return renderPlaylistsPanel();
    return renderVideoPanel(activeTab === 'shorts');
  };

  // ---- failure planes: the profile failed, or there is no such channel -------------------
  // (no kind 0 + a failed feed = nothing to show at all, so it is a page-level error too)
  if (profileState.status === 'error' || (profileMissing && videos.status === 'error')) {
    const e = describeChannelError(
      profileState.status === 'error' ? profileState.error : videos.error,
    );
    return (
      <section className={cx('nf-channelpage', className)} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="nf-channelpage__sr">
          Channel
        </h1>
        <ErrorState
          title={e.title}
          description={e.description}
          detail={e.detail}
          onRetry={retryAll}
        />
      </section>
    );
  }
  if (profileMissing && videos.status === 'ready' && videos.items.length === 0) {
    return (
      <section className={cx('nf-channelpage', className)} aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="nf-channelpage__sr">
          Channel not found
        </h1>
        <ErrorState
          title="Channel not found"
          description="None of your relays has a profile or any videos for this public key. The link may be wrong, or the channel has not published anything yet."
          detail={`pubkey ${shortPubkey(pubkey)}`}
          onRetry={retryAll}
        />
      </section>
    );
  }

  const loading = profile === null;
  const nip05 = profile ? nip05State(profile) : 'none';
  const subscribed = identity.status === 'ready' && identity.subscribed;
  const banner = imageFor(profile?.banner);
  const avatar = imageFor(profile?.picture);
  const uploads =
    videos.status === 'ready' && videos.items.length > 0
      ? `${formatInteger(videos.items.length)}${videos.next !== undefined ? '+' : ''} ${
          videos.items.length === 1 && videos.next === undefined ? 'video' : 'videos'
        }`
      : undefined;

  return (
    <section className={cx('nf-channelpage', className)} aria-labelledby={`${id}-title`}>
      {/* decorative: the banner is never information, so it is hidden from the a11y tree */}
      {loading || banner.status !== 'none' ? (
        <div className="nf-channelpage__banner" aria-hidden="true">
          {loading || banner.status === 'pending' ? (
            <Skeleton variant="block" className="nf-channelpage__banner-skeleton" />
          ) : banner.status === 'ready' ? (
            <img className="nf-channelpage__banner-img" src={banner.src} alt="" />
          ) : null}
        </div>
      ) : null}
      <div className="nf-channelpage__head" data-nip05={loading ? undefined : nip05}>
        {loading || avatar.status === 'pending' ? (
          <span className="nf-channelpage__avatar-skeleton" aria-hidden="true">
            <Skeleton variant="circle" width={80} height={80} />
          </span>
        ) : (
          <ProfileAvatar
            profile={profile}
            src={avatar.status === 'ready' ? avatar.src : undefined}
            size="xl"
          />
        )}
        <div className="nf-channelpage__headtext">
          {loading ? (
            <>
              <h1 id={`${id}-title`} className="nf-channelpage__sr">
                Channel
              </h1>
              <Skeleton variant="text" width="35%" height={28} />
              <Skeleton variant="text" width="25%" height={14} />
            </>
          ) : (
            <>
              <h1 id={`${id}-title`} className="nf-channelpage__title">
                <span className="nf-channelpage__name">{name}</span>
                {nip05 === 'verified' ? (
                  <Icon
                    name="verified"
                    size={20}
                    label="NIP-05 verified"
                    className="nf-channelpage__verified"
                  />
                ) : null}
              </h1>
              <p className="nf-channelpage__sub">
                {profileMissing ? (
                  <span className="nf-channelpage__noprofile">No profile published</span>
                ) : (
                  <Nip05Identity profile={profile} state={nip05} />
                )}
                {uploads !== undefined ? (
                  <>
                    <span aria-hidden="true" className="nf-channelpage__dot">
                      ·
                    </span>
                    <span>{uploads}</span>
                  </>
                ) : null}
              </p>
              {blurb.length > 0 ? (
                <div className="nf-channelpage__blurb">
                  <MarkdownTreeView tree={blurb} className="nf-channelpage__blurb-md" />
                  <button
                    type="button"
                    className="nf-channelpage__blurb-more"
                    aria-label={`More about ${name}`}
                    onClick={() => {
                      selectTab('about');
                    }}
                  >
                    more
                  </button>
                </div>
              ) : null}
              {seedingCount !== undefined && seedingCount > 0 ? (
                <p className="nf-channelpage__seeding">
                  <Icon name="seed" size={14} />
                  <span>{seedingLabel(seedingCount)}</span>
                </p>
              ) : null}
            </>
          )}
        </div>
        <div className="nf-channelpage__actions">
          {identity.status === 'pending' ? (
            <Skeleton variant="block" width={104} height={36} />
          ) : ownChannel ? (
            <Button
              variant="secondary"
              onClick={() => {
                navigate({ name: 'studio', tab: 'videos' });
              }}
            >
              Manage videos
            </Button>
          ) : (
            <Button
              variant={subscribed ? 'secondary' : 'primary'}
              pressed={subscribed}
              loading={subBusy}
              aria-label={
                subscribed
                  ? `Unsubscribe from ${name || 'this channel'}`
                  : identity.status === 'ready' && identity.me === null
                    ? `Connect a signer to subscribe to ${name || 'this channel'}`
                    : `Subscribe to ${name || 'this channel'}`
              }
              onClick={onSubscribe}
            >
              {subscribed ? 'Subscribed' : 'Subscribe'}
            </Button>
          )}
        </div>
      </div>
      <div className="nf-channelpage__bar">
        <div
          role="tablist"
          aria-label="Channel sections"
          className="nf-channelpage__tabs"
          onKeyDown={onTabKeyDown}
        >
          {CHANNEL_TABS.map((t) => {
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
                className="nf-channelpage__tab"
                onClick={() => {
                  selectTab(t.id);
                }}
              >
                {t.label}
              </Button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${activeTab}`}
        className="nf-channelpage__panel"
        aria-busy={panelBusy || undefined}
        tabIndex={-1}
      >
        {renderPanel()}
      </div>
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-channelpage__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
