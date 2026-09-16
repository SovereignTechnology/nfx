/**
 * Home screen (build-plan §6.1 row "Home"): a YouTube-style grid of `VideoCard`s behind a
 * chip bar of three feeds — Subscriptions, Trending (ranked by sats/hour), Tags you follow —
 * with infinite scroll, skeleton loaders, a setting-driven hover-preview affordance and
 * designed empty/error states.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 * Thumbnails and avatars pass through `adapter.image(url, sha256)` (T16) before display and
 * the card shows its blur-up placeholder until then. No blob bytes are fetched here: the
 * hover preview is an *affordance* (play glyph + what ~3 s would cost) — playback, and
 * therefore payment, only ever starts on the Watch screen after the price was shown.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type {
  FeedQuery,
  NostrEventId,
  NostrPubkey,
  Profile,
  Rendition,
  Sats,
  UnixSeconds,
  VideoManifest,
  VideoStats,
} from '@sovit/core';
import {
  Button,
  ChannelRow,
  ChannelRowSkeleton,
  EmptyState,
  ErrorState,
  Icon,
  SatsBadge,
  VideoCard,
  VideoCardSkeleton,
  cx,
  renditionPriceSats,
} from '../../components/index.js';
import type { Route, ScreenProps } from '../shared/route.js';

/** The three Home feeds; kept in sync with `Route['tab']` for `name: 'home'`. */
export type HomeTab = NonNullable<Extract<Route, { readonly name: 'home' }>['tab']>;

export const HOME_TABS: readonly { readonly id: HomeTab; readonly label: string }[] = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'trending', label: 'Trending' },
  { id: 'tags', label: 'Your tags' },
];

/** Default page size; YouTube shows 3–4 rows of 4 before it fetches more. */
export const HOME_PAGE_SIZE = 12;

/** Seconds of video a hover preview would pull (build-plan §6.1 "first ~3 s"). */
export const PREVIEW_SECONDS = 3;

export interface HomeProps extends ScreenProps {
  /** Initial feed. Defaults to Subscriptions, or Trending when nobody is signed in. */
  readonly tab?: HomeTab | undefined;
  /**
   * `Settings.hoverPreview`, resolved by the shell (default on for desktop, off for web —
   * build-plan §6.1). When on, hovering/focusing a card shows the preview affordance.
   */
  readonly hoverPreview?: boolean | undefined;
  /**
   * Tags the viewer follows (their NIP-51 interest list), resolved by the shell. Passed to
   * `adapter.feed({ source: 'tags', tags })`; when omitted the adapter decides what "your
   * tags" means (the mock returns nothing, which is the "no tags followed" state).
   */
  readonly followedTags?: readonly string[] | undefined;
  /** "now" for relative timestamps; stories/tests pin it so PNGs are diffable. */
  readonly now?: UnixSeconds | number | undefined;
  /** Videos per `adapter.feed` page. */
  readonly pageSize?: number | undefined;
  readonly className?: string | undefined;
}

type FeedStatus = 'idle' | 'loading' | 'ready' | 'error';

interface FeedState {
  readonly status: FeedStatus;
  readonly items: readonly VideoManifest[];
  readonly next: string | undefined;
  readonly error: unknown;
  readonly more: 'idle' | 'loading' | 'error';
  readonly moreError: unknown;
  /** Subscriptions only: the feed is empty because the viewer follows nobody. */
  readonly noSubscriptions: boolean;
}

const EMPTY_FEED: FeedState = {
  status: 'idle',
  items: [],
  next: undefined,
  error: undefined,
  more: 'idle',
  moreError: undefined,
  noSubscriptions: false,
};

type Feeds = Readonly<Record<HomeTab, FeedState>>;

const INITIAL_FEEDS: Feeds = {
  subscriptions: EMPTY_FEED,
  trending: EMPTY_FEED,
  tags: EMPTY_FEED,
};

interface Suggestion {
  readonly profile: Profile;
  readonly busy: boolean;
  readonly subscribed: boolean;
}

interface SuggestionsState {
  readonly status: FeedStatus;
  readonly list: readonly Suggestion[];
}

/** `'pending'` until `adapter.me()` answers; `null` = signed out. */
type Me = 'pending' | NostrPubkey | null;

const SUGGESTION_COUNT = 5;

/** Human copy for a failed adapter call. Never a stack trace (the shell logs those). */
export function describeError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, so there is nothing to show. Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not load this feed. Try again in a moment.',
    detail: message || undefined,
  };
}

/**
 * What ~3 s of this video would cost at its cheapest rendition (whole blocks, at least one).
 * Shown on the hover affordance so the "a preview costs a few blocks" trade-off is visible
 * before anything is pulled.
 */
export function previewCostSats(video: VideoManifest): Sats | undefined {
  let cheapest: Rendition | undefined;
  let cheapestPrice = Number.POSITIVE_INFINITY;
  for (const r of video.renditions) {
    const p = renditionPriceSats(r, video.price);
    if (p < cheapestPrice) {
      cheapest = r;
      cheapestPrice = p;
    }
  }
  if (!cheapest) return undefined;
  const bytesPerSec =
    cheapest.bitrateKbps !== undefined && cheapest.bitrateKbps > 0
      ? cheapest.bitrateKbps * 125
      : video.durationSec !== undefined && video.durationSec > 0
        ? cheapest.size / video.durationSec
        : cheapest.size;
  const blockSize = video.price.blockSize > 0 ? video.price.blockSize : 1;
  const blocks = Math.max(1, Math.ceil((bytesPerSec * PREVIEW_SECONDS) / blockSize));
  return (blocks * video.price.satsPerBlock) as Sats;
}

function needsIdentity(tab: HomeTab): boolean {
  return tab !== 'trending';
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

export function Home({
  adapter,
  navigate,
  miniPlayer,
  tab,
  hoverPreview = false,
  followedTags,
  now,
  pageSize = HOME_PAGE_SIZE,
  className,
}: HomeProps): ReactElement {
  const id = useId();
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const tagsKey = followedTags?.join('\u0000');
  const followedTagsRef = useRef(followedTags);
  followedTagsRef.current = followedTags;

  // ---- tab -------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<HomeTab>(tab ?? 'subscriptions');
  const userChoseTab = useRef(tab !== undefined);
  useEffect(() => {
    if (tab !== undefined) {
      userChoseTab.current = true;
      setActiveTab(tab);
    }
  }, [tab]);

  const selectTab = useCallback(
    (next: HomeTab): void => {
      userChoseTab.current = true;
      setActiveTab(next);
      navigate({ name: 'home', tab: next });
    },
    [navigate],
  );

  // ---- identity --------------------------------------------------------------------
  const [me, setMe] = useState<Me>('pending');
  const [identityError, setIdentityError] = useState<unknown>(undefined);
  const [identityGen, setIdentityGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setIdentityError(undefined);
    adapter.me().then(
      (pk) => {
        if (cancelled) return;
        setMe(pk);
        // A signed-out visitor lands on Trending unless the route asked for a feed.
        if (pk === null && !userChoseTab.current) setActiveTab('trending');
      },
      (err: unknown) => {
        if (!cancelled) setIdentityError(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, identityGen]);

  // ---- feeds -----------------------------------------------------------------------
  const [feeds, setFeeds] = useState<Feeds>(INITIAL_FEEDS);
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const [reload, setReload] = useState<Readonly<Record<HomeTab, number>>>({
    subscriptions: 0,
    trending: 0,
    tags: 0,
  });
  const fetchedKey = useRef<Record<HomeTab, string>>({ subscriptions: '', trending: '', tags: '' });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patchFeed = useCallback((t: HomeTab, patch: Partial<FeedState>): void => {
    setFeeds((prev) => ({ ...prev, [t]: { ...prev[t], ...patch } }));
  }, []);

  const query = useCallback(
    (t: HomeTab, cursor?: string): FeedQuery => {
      const tags = followedTagsRef.current;
      return {
        source: t,
        limit: pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(t === 'tags' && tags !== undefined ? { tags } : {}),
      };
    },
    [pageSize],
  );

  const retry = useCallback((t: HomeTab): void => {
    setIdentityGen((g) => g + 1);
    setReload((r) => ({ ...r, [t]: r[t] + 1 }));
  }, []);

  useEffect(() => {
    const t = activeTab;
    if (needsIdentity(t) && (me === 'pending' || me === null)) return;
    const key =
      t === 'tags' ? `${reload[t]}|${tagsKey ?? ''}|${pageSize}` : `${reload[t]}|${pageSize}`;
    if (fetchedKey.current[t] === key) return;
    fetchedKey.current[t] = key;
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    let done = false;
    setFeeds((prev) => ({ ...prev, [t]: { ...EMPTY_FEED, status: 'loading' } }));
    void (async (): Promise<void> => {
      try {
        const page = await adapter.feed(query(t));
        if (cancelled()) return;
        let noSubscriptions = false;
        if (t === 'subscriptions' && page.items.length === 0) {
          const subs = await adapter.subscriptions();
          if (cancelled()) return;
          noSubscriptions = subs.length === 0;
        }
        done = true;
        setFeeds((prev) => ({
          ...prev,
          [t]: {
            ...EMPTY_FEED,
            status: 'ready',
            items: dedupe([], page.items),
            next: page.next,
            noSubscriptions,
          },
        }));
      } catch (err: unknown) {
        if (cancelled()) return;
        done = true;
        setFeeds((prev) => ({ ...prev, [t]: { ...EMPTY_FEED, status: 'error', error: err } }));
      }
    })();
    return () => {
      ac.abort();
      // An interrupted load must run again next time this tab is shown.
      if (!done) fetchedKey.current[t] = '';
    };
  }, [activeTab, adapter, me, pageSize, query, reload, tagsKey]);

  const loadMore = useCallback((): void => {
    const t = activeTab;
    const f = feedsRef.current[t];
    if (f.status !== 'ready' || f.more === 'loading' || f.next === undefined) return;
    const gen = reload[t];
    patchFeed(t, { more: 'loading', moreError: undefined });
    adapter.feed(query(t, f.next)).then(
      (page) => {
        if (!alive.current || reload[t] !== gen) return;
        setFeeds((prev) => ({
          ...prev,
          [t]: {
            ...prev[t],
            items: dedupe(prev[t].items, page.items),
            next: page.next,
            more: 'idle',
          },
        }));
      },
      (err: unknown) => {
        if (!alive.current || reload[t] !== gen) return;
        patchFeed(t, { more: 'error', moreError: err });
      },
    );
  }, [activeTab, adapter, patchFeed, query, reload]);

  // ---- per-item resolution: thumbnails (T16), channel profiles + avatars, stats ---------
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [profiles, setProfiles] = useState<Readonly<Record<string, Profile | null>>>({});
  const [avatars, setAvatars] = useState<Readonly<Record<string, string>>>({});
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats>>>({});
  const requested = useRef({
    thumbs: new Set<NostrEventId>(),
    profiles: new Set<NostrPubkey>(),
    stats: new Set<NostrEventId>(),
  });

  const resolveAvatar = useCallback(
    (pubkey: NostrPubkey, picture: string | undefined): void => {
      if (!picture) return;
      adapter.image(picture).then(
        (src) => {
          if (alive.current) setAvatars((prev) => ({ ...prev, [pubkey]: src }));
        },
        () => undefined,
      );
    },
    [adapter],
  );

  const resolveProfile = useCallback(
    (pubkey: NostrPubkey): void => {
      const req = requested.current.profiles;
      if (req.has(pubkey)) return;
      req.add(pubkey);
      adapter.profile(pubkey).then(
        (p) => {
          if (!alive.current) return;
          setProfiles((prev) => ({ ...prev, [pubkey]: p }));
          resolveAvatar(pubkey, p?.picture);
        },
        () => {
          if (alive.current) setProfiles((prev) => ({ ...prev, [pubkey]: null }));
        },
      );
    },
    [adapter, resolveAvatar],
  );

  const activeItems = feeds[activeTab].items;
  useEffect(() => {
    for (const video of activeItems) {
      const req = requested.current;
      if (!req.thumbs.has(video.id)) {
        req.thumbs.add(video.id);
        const image = video.renditions[0]?.image;
        if (image) {
          adapter.image(image.url, image.sha256).then(
            (src) => {
              if (alive.current) setThumbs((prev) => ({ ...prev, [video.id]: src }));
            },
            () => undefined, // hash mismatch / unreachable → the blur-up placeholder stays
          );
        }
      }
      resolveProfile(video.author);
      if (!req.stats.has(video.id)) {
        req.stats.add(video.id);
        adapter.stats(video.id).then(
          (s) => {
            if (alive.current) setStats((prev) => ({ ...prev, [video.id]: s }));
          },
          () => undefined,
        );
      }
    }
  }, [activeItems, adapter, resolveProfile]);

  // ---- suggested channels (subscriptions tab, nobody followed) ------------------------
  const [suggestions, setSuggestions] = useState<SuggestionsState>({ status: 'idle', list: [] });
  const wantSuggestions =
    activeTab === 'subscriptions' &&
    feeds.subscriptions.status === 'ready' &&
    feeds.subscriptions.noSubscriptions;
  const suggestionsKey = useRef('');
  useEffect(() => {
    if (!wantSuggestions) return;
    // One fetch per subscriptions-feed generation; an interrupted one runs again.
    const key = String(reload.subscriptions);
    if (suggestionsKey.current === key) return;
    suggestionsKey.current = key;
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    let done = false;
    setSuggestions({ status: 'loading', list: [] });
    void (async (): Promise<void> => {
      try {
        const page = await adapter.feed({ source: 'trending', limit: 24 });
        if (cancelled()) return;
        const authors: NostrPubkey[] = [];
        for (const v of page.items) {
          if (v.author !== me && !authors.includes(v.author)) authors.push(v.author);
          if (authors.length >= SUGGESTION_COUNT) break;
        }
        const resolved = await Promise.all(authors.map((pk) => adapter.profile(pk)));
        if (cancelled()) return;
        const list: Suggestion[] = [];
        resolved.forEach((p, i) => {
          const pubkey = authors[i];
          if (pubkey === undefined) return;
          const profile: Profile = p ?? {
            pubkey,
            nip05Status: 'none',
            fetchedAt: 0 as UnixSeconds,
          };
          list.push({ profile, busy: false, subscribed: false });
          resolveAvatar(pubkey, profile.picture);
        });
        done = true;
        setSuggestions({ status: 'ready', list });
      } catch {
        if (cancelled()) return;
        done = true;
        setSuggestions({ status: 'error', list: [] });
      }
    })();
    return () => {
      ac.abort();
      if (!done) suggestionsKey.current = '';
    };
  }, [adapter, me, reload.subscriptions, resolveAvatar, wantSuggestions]);

  const subscribeSuggested = useCallback(
    (pubkey: NostrPubkey): void => {
      const mark = (patch: Partial<Suggestion>): void => {
        setSuggestions((prev) => ({
          ...prev,
          list: prev.list.map((s) => (s.profile.pubkey === pubkey ? { ...s, ...patch } : s)),
        }));
      };
      mark({ busy: true });
      adapter.subscribe(pubkey).then(
        () => {
          if (!alive.current) return;
          mark({ busy: false, subscribed: true });
          setReload((r) => ({ ...r, subscriptions: r.subscriptions + 1 }));
        },
        () => {
          if (alive.current) mark({ busy: false });
        },
      );
    },
    [adapter],
  );

  // ---- infinite scroll -----------------------------------------------------------------
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const feed = feeds[activeTab];
  const hasMore = feed.status === 'ready' && feed.next !== undefined;
  const canObserve = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || !canObserve) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
    // `feed.more` is a dep because the sentinel unmounts while a page loads and remounts as
    // a NEW element afterwards — without re-observing, infinite scroll would stop at page 2.
  }, [canObserve, feed.more, hasMore, loadMore]);

  // ---- hover preview affordance --------------------------------------------------------
  const [previewId, setPreviewId] = useState<NostrEventId | null>(null);
  const leaveItem = (e: FocusEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setPreviewId(null);
  };

  // ---- tabs keyboard ---------------------------------------------------------------
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
    const target = HOME_TABS[nextIndex];
    tabs[nextIndex]?.focus();
    if (target) selectTab(target.id);
  };

  // ---- render ----------------------------------------------------------------------
  const openVideo = (video: VideoManifest): void => {
    navigate({ name: 'watch', videoId: video.id });
  };
  /** Kind 22 opens the vertical Shorts feed at that video (build-plan §6.1 "Shorts"). */
  const openShort = (video: VideoManifest): void => {
    navigate({ name: 'shorts', videoId: video.id });
  };
  const openChannel = (pubkey: NostrPubkey): void => {
    navigate({ name: 'channel', pubkey });
  };
  const goSettings = (): void => {
    navigate({ name: 'settings' });
  };
  const goTrending = (): void => {
    selectTab('trending');
  };

  const skeletonGrid = (count: number): ReactElement => (
    <ul className="nf-home__grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="nf-home__item">
          <VideoCardSkeleton />
        </li>
      ))}
    </ul>
  );

  const renderEmpty = (): ReactElement => {
    if (activeTab === 'subscriptions') {
      if (feed.noSubscriptions) {
        return (
          <div className="nf-home__empty">
            <EmptyState preset="no-subscriptions" onAction={goTrending} />
            <section className="nf-home__suggest" aria-labelledby={`${id}-suggest`}>
              <h2 id={`${id}-suggest`} className="nf-home__suggest-title">
                Suggested channels
              </h2>
              {suggestions.status === 'ready' && suggestions.list.length > 0 ? (
                <ul className="nf-home__suggest-list">
                  {suggestions.list.map((s) => (
                    <li key={s.profile.pubkey}>
                      <ChannelRow
                        profile={s.profile}
                        avatarSrc={avatars[s.profile.pubkey]}
                        subscribed={s.subscribed}
                        busy={s.busy}
                        onSubscribe={(pk, next) => {
                          if (next) subscribeSuggested(pk);
                        }}
                        onOpen={openChannel}
                      />
                    </li>
                  ))}
                </ul>
              ) : suggestions.status === 'error' ||
                (suggestions.status === 'ready' && suggestions.list.length === 0) ? (
                <p className="nf-home__suggest-none">
                  No channels to suggest right now — see what is trending instead.
                </p>
              ) : (
                <ul className="nf-home__suggest-list" aria-busy="true">
                  {Array.from({ length: 3 }, (_, i) => (
                    <li key={i}>
                      <ChannelRowSkeleton />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        );
      }
      return (
        <EmptyState
          preset="no-videos"
          title="Nothing new from your subscriptions"
          description="The channels you follow have not published a video yet. Meanwhile, see what people are paying for."
          action="Explore trending"
          onAction={goTrending}
        />
      );
    }
    if (activeTab === 'tags') {
      const tags = followedTags ?? [];
      return tags.length > 0 ? (
        <EmptyState
          icon="search"
          title="No videos for your tags"
          description={`Nothing tagged ${tags.map((t) => `#${t}`).join(', ')} has been published yet. Follow more tags, or see what is trending.`}
          action="Explore trending"
          onAction={goTrending}
        />
      ) : (
        <EmptyState
          icon="search"
          title="No videos for your tags"
          description="You are not following any tags yet. Follow a tag from a video and new uploads carrying it will land here."
          action="Explore trending"
          onAction={goTrending}
        />
      );
    }
    return (
      <EmptyState
        preset="no-videos"
        title="Nothing trending yet"
        description="Trending ranks videos by the sats viewers paid for them in the last hours. Nothing has been paid for yet — check back soon."
      />
    );
  };

  const renderItem = (video: VideoManifest, short: boolean): ReactElement => {
    const profile = profiles[video.author] ?? undefined;
    const showPreview = hoverPreview && previewId === video.id;
    const cost = showPreview ? previewCostSats(video) : undefined;
    return (
      <li
        key={video.id}
        className="nf-home__item"
        onPointerEnter={() => {
          if (hoverPreview) setPreviewId(video.id);
        }}
        onPointerLeave={() => {
          setPreviewId((cur) => (cur === video.id ? null : cur));
        }}
        onFocus={() => {
          if (hoverPreview) setPreviewId(video.id);
        }}
        onBlur={leaveItem}
      >
        <VideoCard
          video={video}
          channel={profile}
          thumbnailSrc={thumbs[video.id]}
          avatarSrc={avatars[video.author]}
          stats={stats[video.id]}
          now={nowSec}
          onOpen={short ? openShort : openVideo}
          onOpenChannel={openChannel}
        />
        {showPreview ? (
          <span className="nf-home__preview" aria-hidden="true">
            <Icon name="play" size={16} />
            <span className="nf-home__preview-label">Preview</span>
            {cost !== undefined ? (
              <SatsBadge sats={cost} size="sm" overlay label={`Preview costs about ${cost} sats`} />
            ) : null}
          </span>
        ) : null}
      </li>
    );
  };

  const renderBody = (): ReactElement => {
    if (needsIdentity(activeTab)) {
      if (identityError !== undefined) {
        const e = describeError(identityError);
        return (
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              retry(activeTab);
            }}
          />
        );
      }
      if (me === 'pending') return skeletonGrid(Math.min(pageSize, HOME_PAGE_SIZE));
      if (me === null) {
        return (
          <EmptyState
            preset="signer-not-detected"
            title={
              activeTab === 'subscriptions'
                ? 'Sign in to see your subscriptions'
                : 'Sign in to see videos for your tags'
            }
            description="Connect a Nostr signer (NIP-07 extension, NIP-46 remote signer, or a local key) and the channels and tags you follow show up here. Trending needs no sign-in."
            onAction={goSettings}
          />
        );
      }
    }
    switch (feed.status) {
      case 'idle':
      case 'loading':
        return skeletonGrid(Math.min(pageSize, HOME_PAGE_SIZE));
      case 'error': {
        const e = describeError(feed.error);
        return (
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              retry(activeTab);
            }}
          />
        );
      }
      case 'ready':
        break;
    }
    if (feed.items.length === 0) return renderEmpty();
    const longs = feed.items.filter((v) => v.kind === 21);
    const shorts = feed.items.filter((v) => v.kind === 22);
    return (
      <>
        {longs.length > 0 ? (
          <ul className="nf-home__grid">{longs.map((v) => renderItem(v, false))}</ul>
        ) : null}
        {shorts.length > 0 ? (
          <section className="nf-home__shorts" aria-labelledby={`${id}-shorts`}>
            <h2 id={`${id}-shorts`} className="nf-home__shorts-title">
              Shorts
            </h2>
            <ul className="nf-home__shorts-list">{shorts.map((v) => renderItem(v, true))}</ul>
          </section>
        ) : null}
        {feed.more === 'loading' ? (
          <ul className="nf-home__grid" aria-hidden="true">
            {Array.from({ length: Math.min(4, pageSize) }, (_, i) => (
              <li key={i} className="nf-home__item">
                <VideoCardSkeleton />
              </li>
            ))}
          </ul>
        ) : null}
        {feed.more === 'error' ? (
          <ErrorState
            compact
            title="Could not load more"
            description={describeError(feed.moreError).description}
            detail={describeError(feed.moreError).detail}
            onRetry={loadMore}
          />
        ) : null}
        {hasMore && feed.more === 'idle' ? (
          <div className="nf-home__more">
            <div ref={sentinelRef} className="nf-home__sentinel" aria-hidden="true" />
            {canObserve ? null : (
              <Button variant="secondary" onClick={loadMore}>
                Load more
              </Button>
            )}
          </div>
        ) : null}
      </>
    );
  };

  const busy =
    (needsIdentity(activeTab) && me === 'pending' && identityError === undefined) ||
    feed.status === 'loading' ||
    feed.more === 'loading';

  return (
    <section className={cx('nf-home', className)} aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="nf-home__sr">
        Home
      </h1>
      <div className="nf-home__bar">
        <div
          role="tablist"
          aria-label="Home feeds"
          className="nf-home__tabs"
          onKeyDown={onTabKeyDown}
        >
          {HOME_TABS.map((t) => {
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
                className="nf-home__tab"
                onClick={() => {
                  selectTab(t.id);
                }}
              >
                {t.label}
              </Button>
            );
          })}
        </div>
        {activeTab === 'trending' ? (
          <p className="nf-home__hint">Ranked by sats paid per hour</p>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${activeTab}`}
        className="nf-home__panel"
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        {renderBody()}
      </div>
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-home__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
