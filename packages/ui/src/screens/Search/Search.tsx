/**
 * Search screen (build-plan §6.1 row "Search"; §2.2 "NIP-50 relay search + local index").
 *
 * A search box with filters (upload date, duration, tags, creator) over a YouTube-style
 * results list: one row per hit — thumbnail left; title, channel, paid views, date and a
 * two-line description snippet right — with kind-22 hits pulled into a "Shorts" shelf and,
 * when the query names a channel that appears in the results, that channel on top.
 *
 * Typing is debounced (~300 ms), Enter submits immediately and announces the route, `/`
 * focuses the box from anywhere. Every search carries a sequence number and every effect a
 * cancellation flag, so a slow answer to an older query can never overwrite a newer one
 * (the contract's `search` takes no AbortSignal — see docs/contract-requests/L5-Search.md).
 * Skeleton rows while in flight, a designed "no results" state that echoes the query, a
 * retryable ErrorState for relay failures, infinite scroll with a "Load more" fallback.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 * Thumbnails and avatars pass through `adapter.image(url, sha256)` (T16); descriptions only
 * through `Markdown`; every row's SatsBadge price sits on its thumbnail, before any control
 * that leads to playback.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type SyntheticEvent,
} from 'react';
import type {
  NetworkAdapter,
  NostrEventId,
  NostrPubkey,
  Page,
  Profile,
  SearchFilters,
  UnixSeconds,
  VideoManifest,
  VideoStats,
} from '@sovit/core';
import {
  Button,
  ChannelRow,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Markdown,
  VideoCard,
  VideoCardSkeleton,
  cx,
  isTextEntryTarget,
  shortPubkey,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';

/** Keystrokes (query box and tags box) are batched by this much before a search runs. */
export const SEARCH_DEBOUNCE_MS = 300;

/** Skeleton rows while a search is in flight. */
export const SEARCH_SKELETON_ROWS = 6;

/** The Shorts shelf goes after this many video rows (YouTube puts it a few rows down). */
const SHORTS_SHELF_AFTER = 3;
/** Description snippet: parsed from at most this many characters, clamped to 2 lines. */
const SNIPPET_MAX_CHARS = 280;
const MAX_CHANNEL_MATCHES = 2;
const MAX_TAG_SUGGESTIONS = 8;
const MAX_TAGS = 10;

export type SearchUploadDate = 'any' | 'hour' | 'day' | 'week' | 'month' | 'year';
export type SearchDuration = 'any' | 'short' | 'medium' | 'long';

/** Upload-date presets; `seconds` is subtracted from "now" to build `filters.since`. */
export const SEARCH_UPLOAD_DATES: readonly {
  readonly id: Exclude<SearchUploadDate, 'any'>;
  readonly label: string;
  readonly seconds: number;
}[] = [
  { id: 'hour', label: 'Last hour', seconds: 3_600 },
  { id: 'day', label: 'Last 24 hours', seconds: 86_400 },
  { id: 'week', label: 'Last 7 days', seconds: 604_800 },
  { id: 'month', label: 'Last 30 days', seconds: 2_592_000 },
  { id: 'year', label: 'Last year', seconds: 31_536_000 },
];

/** Duration presets (the §6.1 "duration" filter). Bounds are inclusive. */
export const SEARCH_DURATIONS: readonly {
  readonly id: Exclude<SearchDuration, 'any'>;
  readonly label: string;
  readonly minSec?: number;
  readonly maxSec?: number;
}[] = [
  { id: 'short', label: 'Under 4 minutes', maxSec: 239 },
  { id: 'medium', label: '4–20 minutes', minSec: 240, maxSec: 1_200 },
  { id: 'long', label: 'Over 20 minutes', minSec: 1_201 },
];

/** The screen's filter state. `author` is '' (all creators) or a channel's pubkey. */
export interface SearchFilterState {
  readonly uploaded: SearchUploadDate;
  readonly duration: SearchDuration;
  /** Normalised hashtags: lower-case, no `#`, de-duplicated, at most 10. */
  readonly tags: readonly string[];
  readonly author: NostrPubkey | '';
}

export const DEFAULT_SEARCH_FILTERS: SearchFilterState = {
  uploaded: 'any',
  duration: 'any',
  tags: [],
  author: '',
};

/** "space, #Ceramics  music" → ['space', 'ceramics', 'music'] (commas or spaces separate). */
export function parseSearchTags(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const tag = raw.replace(/^#+/, '').trim().toLowerCase();
    if (tag !== '' && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Fills defaults and drops unknown preset ids / malformed tags (props may come from a URL). */
export function normalizeSearchFilters(
  partial: Partial<SearchFilterState> | undefined,
): SearchFilterState {
  const p = partial ?? {};
  const uploaded: SearchUploadDate =
    p.uploaded !== undefined && SEARCH_UPLOAD_DATES.some((o) => o.id === p.uploaded)
      ? p.uploaded
      : 'any';
  const duration: SearchDuration =
    p.duration !== undefined && SEARCH_DURATIONS.some((o) => o.id === p.duration)
      ? p.duration
      : 'any';
  return {
    uploaded,
    duration,
    tags: parseSearchTags((p.tags ?? []).join(',')),
    author: typeof p.author === 'string' ? p.author : '',
  };
}

/** True when any filter differs from the defaults. */
export function hasActiveSearchFilters(filters: SearchFilterState): boolean {
  return (
    filters.uploaded !== 'any' ||
    filters.duration !== 'any' ||
    filters.tags.length > 0 ||
    filters.author !== ''
  );
}

/** Stable identity of a filter state (the search effect re-runs when this changes). */
function filtersKey(f: SearchFilterState): string {
  return JSON.stringify([f.uploaded, f.duration, f.tags, f.author]);
}

/**
 * Maps the filter state onto the contract's `SearchFilters`. `undefined` when nothing is
 * set, so the adapter is called without a `filters` key at all.
 */
export function buildSearchFilters(
  state: SearchFilterState,
  now: UnixSeconds | number,
): SearchFilters | undefined {
  const out: {
    since?: UnixSeconds;
    minDurationSec?: number;
    maxDurationSec?: number;
    tags?: readonly string[];
    author?: NostrPubkey;
  } = {};
  if (state.uploaded !== 'any') {
    const preset = SEARCH_UPLOAD_DATES.find((o) => o.id === state.uploaded);
    if (preset) out.since = Math.max(0, Math.floor(now) - preset.seconds) as UnixSeconds;
  }
  if (state.duration !== 'any') {
    const preset = SEARCH_DURATIONS.find((o) => o.id === state.duration);
    if (preset?.minSec !== undefined) out.minDurationSec = preset.minSec;
    if (preset?.maxSec !== undefined) out.maxDurationSec = preset.maxSec;
  }
  if (state.tags.length > 0) out.tags = [...state.tags];
  if (state.author !== '') out.author = state.author;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Does this query name the channel? Case-insensitive; the query must start a word of the
 * display name or handle (so "tide" finds "Low Tide Sessions" but "a" finds nothing), or be
 * the start of the NIP-05 name. Needs at least two characters.
 */
export function matchesChannelQuery(profile: Profile, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 2) return false;
  const names = [profile.displayName, profile.name]
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map((n) => n.toLowerCase().replace(/\s+/g, ' '));
  for (const n of names) {
    if (n.startsWith(q) || n.includes(` ${q}`)) return true;
  }
  const local = profile.nip05?.split('@')[0]?.toLowerCase();
  return local !== undefined && local !== '' && local !== '_' && local.startsWith(q);
}

/** Human copy for a failed `adapter.search`. Never a stack trace (the shell logs those). */
export function describeSearchError(
  err: unknown,
  context: 'search' | 'more' = 'search',
): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const what = context === 'more' ? 'the next page could not load' : 'the search could not run';
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description: `None of your relays answered, so ${what}. Check your connection or your relay list in Settings, then retry.`,
      detail: message,
    };
  }
  return {
    title: 'Search failed',
    description:
      context === 'more'
        ? 'The next page did not arrive. The results above are unaffected; try again.'
        : 'We could not run that search. Try again in a moment.',
    detail: message || undefined,
  };
}

export interface SearchProps extends ScreenProps {
  /**
   * The query from the route (`{ name: 'search', q }`). A change is followed (the box and
   * the results adopt it); typing does not navigate until the viewer submits.
   */
  readonly q?: string | undefined;
  /**
   * Filters from the shell (e.g. its URL). Followed whenever their content changes. The
   * v3 `Route` has no filter fields, so the shell owns their persistence for now.
   */
  readonly filters?: Partial<SearchFilterState> | undefined;
  /** Every filter change the viewer makes, so a shell can mirror it into its URL. */
  readonly onFiltersChange?: ((filters: SearchFilterState) => void) | undefined;
  /** "now" for date presets + relative timestamps; pinned in stories/tests for diffability. */
  readonly now?: UnixSeconds | number | undefined;
  readonly className?: string | undefined;
}

type SearchRequest = Parameters<NetworkAdapter['search']>[0];

interface ResultsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** The committed query these results (or this failure) belong to. */
  readonly query: string;
  /** The exact first-page request, reused (plus `cursor`) for every further page. */
  readonly request: SearchRequest | undefined;
  readonly items: readonly VideoManifest[];
  readonly next: string | undefined;
  readonly error: unknown;
  readonly more: 'idle' | 'loading' | 'error';
  readonly moreError: unknown;
}

const IDLE_RESULTS: ResultsState = {
  status: 'idle',
  query: '',
  request: undefined,
  items: [],
  next: undefined,
  error: undefined,
  more: 'idle',
  moreError: undefined,
};

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

/** Calls the adapter, turning a synchronous throw into a rejection (never thrown to React). */
function runSearch(adapter: NetworkAdapter, req: SearchRequest): Promise<Page<VideoManifest>> {
  try {
    return adapter.search(req);
  } catch (err: unknown) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function profileName(profile: Profile | null | undefined, pubkey: string): string {
  return profile?.displayName ?? profile?.name ?? shortPubkey(pubkey);
}

export function Search({
  adapter,
  navigate,
  miniPlayer,
  q,
  filters: filtersProp,
  onFiltersChange,
  now,
  className,
}: SearchProps): ReactElement {
  const id = useId();
  // One "now" per mount when the prop is absent: a clock read on every render would change
  // relative timestamps mid-scroll (and must never feed an effect's dependencies).
  const [mountedAt] = useState(() => Math.floor(Date.now() / 1000));
  const nowSec = now ?? mountedAt;
  const nowRef = useRef(now);
  nowRef.current = now;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- query text + committed query ------------------------------------------------
  const [text, setText] = useState(q ?? '');
  const [committed, setCommitted] = useState(() => (q ?? '').trim());

  // Debounce: a pause in typing commits the query; no click needed.
  useEffect(() => {
    const next = text.trim();
    if (next === committed) return;
    const t = setTimeout(() => {
      setCommitted(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [text, committed]);

  // Follow a route change (deep link / shell navigation); a re-applied value is a no-op.
  const lastQueryProp = useRef(q);
  useEffect(() => {
    if (q === undefined || q === lastQueryProp.current) return;
    lastQueryProp.current = q;
    setText(q);
    setCommitted(q.trim());
  }, [q]);

  // ---- filters ---------------------------------------------------------------------
  const [filters, setFilters] = useState<SearchFilterState>(() =>
    normalizeSearchFilters(filtersProp),
  );
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [tagsText, setTagsText] = useState(() => filters.tags.join(', '));
  const [filtersOpen, setFiltersOpen] = useState(() => hasActiveSearchFilters(filters));
  const filtersActive = hasActiveSearchFilters(filters);
  const onFiltersChangeRef = useRef(onFiltersChange);
  onFiltersChangeRef.current = onFiltersChange;

  /** The one way the viewer changes filters: state + the shell callback, no-op if equal. */
  const applyFilters = useCallback((next: SearchFilterState): void => {
    if (filtersKey(next) === filtersKey(filtersRef.current)) return;
    filtersRef.current = next;
    setFilters(next);
    onFiltersChangeRef.current?.(next);
  }, []);

  // Follow the `filters` prop by content (a shell may pass a fresh object every render).
  const propFiltersKey =
    filtersProp === undefined ? undefined : filtersKey(normalizeSearchFilters(filtersProp));
  const filtersPropRef = useRef(filtersProp);
  filtersPropRef.current = filtersProp;
  const lastFiltersProp = useRef(propFiltersKey);
  useEffect(() => {
    if (propFiltersKey === undefined || propFiltersKey === lastFiltersProp.current) return;
    lastFiltersProp.current = propFiltersKey;
    const next = normalizeSearchFilters(filtersPropRef.current);
    filtersRef.current = next;
    setFilters(next);
    setTagsText(next.tags.join(', '));
  }, [propFiltersKey]);

  // The tags box is debounced like the query box; Enter commits at once.
  const commitTags = useCallback(
    (raw: string): void => {
      applyFilters({ ...filtersRef.current, tags: parseSearchTags(raw) });
    },
    [applyFilters],
  );
  const committedTagsKey = filters.tags.join(',');
  useEffect(() => {
    if (parseSearchTags(tagsText).join(',') === committedTagsKey) return;
    const t = setTimeout(() => {
      commitTags(tagsText);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [tagsText, committedTagsKey, commitTags]);

  const setTags = (tags: readonly string[]): void => {
    setTagsText(tags.join(', '));
    applyFilters({ ...filtersRef.current, tags: parseSearchTags(tags.join(',')) });
  };

  const clearFilters = (): void => {
    setTagsText('');
    applyFilters(DEFAULT_SEARCH_FILTERS);
  };

  // ---- search ----------------------------------------------------------------------
  const [results, setResults] = useState<ResultsState>(IDLE_RESULTS);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const [reload, setReload] = useState(0);
  /** Bumped by every new search; a response whose number is stale is dropped. */
  const seq = useRef(0);
  const fKey = filtersKey(filters);

  useEffect(() => {
    const mySeq = ++seq.current;
    if (committed === '') {
      setResults(IDLE_RESULTS);
      return;
    }
    let live = true;
    const f = buildSearchFilters(
      filtersRef.current,
      nowRef.current ?? Math.floor(Date.now() / 1000),
    );
    const request: SearchRequest = { text: committed, ...(f ? { filters: f } : {}) };
    setResults({ ...IDLE_RESULTS, status: 'loading', query: committed, request });
    runSearch(adapter, request).then(
      (page) => {
        if (!live || seq.current !== mySeq) return;
        setResults({
          ...IDLE_RESULTS,
          status: 'ready',
          query: committed,
          request,
          items: dedupe([], page.items),
          next: page.next,
        });
      },
      (err: unknown) => {
        if (!live || seq.current !== mySeq) return;
        setResults({ ...IDLE_RESULTS, status: 'error', query: committed, request, error: err });
      },
    );
    return () => {
      live = false;
    };
  }, [adapter, committed, fKey, reload]);

  // ---- load more (cursor pagination; the contract's search takes no limit) ----------
  const loadMore = useCallback((): void => {
    const cur = resultsRef.current;
    if (cur.status !== 'ready' || cur.more === 'loading' || cur.next === undefined) return;
    if (cur.request === undefined) return;
    const request = cur.request;
    const mySeq = seq.current;
    // Mark synchronously too, so an observer callback and a click in the same tick cannot
    // both fetch the same page.
    resultsRef.current = { ...cur, more: 'loading', moreError: undefined };
    setResults((prev) => ({ ...prev, more: 'loading', moreError: undefined }));
    runSearch(adapter, { ...request, cursor: cur.next }).then(
      (page) => {
        if (!alive.current || seq.current !== mySeq) return;
        setResults((prev) =>
          prev.more === 'loading' && prev.request === request
            ? {
                ...prev,
                items: dedupe(prev.items, page.items),
                next: page.next,
                more: 'idle',
              }
            : prev,
        );
      },
      (err: unknown) => {
        if (!alive.current || seq.current !== mySeq) return;
        setResults((prev) =>
          prev.more === 'loading' && prev.request === request
            ? { ...prev, more: 'error', moreError: err }
            : prev,
        );
      },
    );
  }, [adapter]);

  // ---- infinite scroll: sentinel + IntersectionObserver; button fallback (jsdom) -----
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const hasMore =
    results.status === 'ready' && results.next !== undefined && results.more === 'idle';
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
    // `results.items` is a dep because the sentinel unmounts while a page loads and remounts
    // as a NEW element afterwards — without re-observing, infinite scroll stops at page 2.
  }, [canObserve, hasMore, loadMore, results.items]);

  // ---- identity: only for Subscribe on channel results + the creator filter ---------
  const [me, setMe] = useState<'pending' | NostrPubkey | null>('pending');
  const [subs, setSubs] = useState<ReadonlySet<NostrPubkey>>(() => new Set());
  const [subBusy, setSubBusy] = useState<ReadonlySet<NostrPubkey>>(() => new Set());

  // ---- per-row resolution: thumbnails (T16), channel profiles, avatars, stats --------
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [profiles, setProfiles] = useState<Readonly<Record<string, Profile | null>>>({});
  const [avatars, setAvatars] = useState<Readonly<Record<string, string>>>({});
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats>>>({});
  /** Creators seen in any result this session, first-seen order (the creator filter). */
  const [seenAuthors, setSeenAuthors] = useState<readonly NostrPubkey[]>([]);
  const requested = useRef({
    thumbs: new Set<NostrEventId>(),
    profiles: new Set<NostrPubkey>(),
    avatars: new Set<NostrPubkey>(),
    stats: new Set<NostrEventId>(),
  });

  const resolveProfile = useCallback(
    (pubkey: NostrPubkey): void => {
      const req = requested.current.profiles;
      if (req.has(pubkey)) return;
      req.add(pubkey);
      adapter.profile(pubkey).then(
        (p) => {
          if (alive.current) setProfiles((prev) => ({ ...prev, [pubkey]: p }));
        },
        () => {
          if (alive.current) setProfiles((prev) => ({ ...prev, [pubkey]: null }));
        },
      );
    },
    [adapter],
  );

  useEffect(() => {
    let live = true;
    const isLive = (): boolean => live; // read through a call: `live` flips in the cleanup
    adapter
      .me()
      .then(
        async (pk) => {
          if (!isLive()) return;
          setMe(pk);
          if (pk === null) return;
          const list = await adapter.subscriptions();
          if (!isLive()) return;
          setSubs(new Set(list));
          for (const p of list) resolveProfile(p);
        },
        () => {
          if (live) setMe(null);
        },
      )
      .catch(() => undefined); // subscriptions unavailable → the filter lists result creators only
    return () => {
      live = false;
    };
  }, [adapter, resolveProfile]);

  useEffect(() => {
    const fresh: NostrPubkey[] = [];
    for (const video of results.items) {
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
      if (!req.profiles.has(video.author)) fresh.push(video.author);
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
    if (fresh.length > 0) {
      setSeenAuthors((prev) => [...prev, ...fresh.filter((pk) => !prev.includes(pk))]);
    }
  }, [results.items, adapter, resolveProfile]);

  // ---- channel results (derived: the v3 contract returns videos only) ----------------
  const channelMatches = useMemo((): readonly Profile[] => {
    if (results.status !== 'ready' || filters.author !== '') return [];
    const out: Profile[] = [];
    const seen = new Set<string>();
    for (const video of results.items) {
      if (seen.has(video.author)) continue;
      seen.add(video.author);
      const profile = profiles[video.author];
      if (profile && matchesChannelQuery(profile, results.query)) out.push(profile);
      if (out.length >= MAX_CHANNEL_MATCHES) break;
    }
    return out;
  }, [results.status, results.items, results.query, profiles, filters.author]);

  useEffect(() => {
    for (const profile of channelMatches) {
      const req = requested.current.avatars;
      if (req.has(profile.pubkey) || !profile.picture) continue;
      req.add(profile.pubkey);
      adapter.image(profile.picture).then(
        (src) => {
          if (alive.current) setAvatars((prev) => ({ ...prev, [profile.pubkey]: src }));
        },
        () => undefined,
      );
    }
  }, [channelMatches, adapter]);

  const toggleSubscribe = (pubkey: NostrPubkey, next: boolean): void => {
    if (me === null) {
      navigate({ name: 'settings' }); // signed out: connect a signer first
      return;
    }
    if (me === 'pending' || subBusy.has(pubkey)) return;
    const setBusy = (on: boolean): void => {
      setSubBusy((prev) => {
        const s = new Set(prev);
        if (on) s.add(pubkey);
        else s.delete(pubkey);
        return s;
      });
    };
    setBusy(true);
    (next ? adapter.subscribe(pubkey) : adapter.unsubscribe(pubkey)).then(
      () => {
        if (!alive.current) return;
        setBusy(false);
        setSubs((prev) => {
          const s = new Set(prev);
          if (next) s.add(pubkey);
          else s.delete(pubkey);
          return s;
        });
      },
      () => {
        if (alive.current) setBusy(false);
      },
    );
  };

  // ---- "/" focuses the search box (YouTube idiom; skip while typing anywhere) ---------
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // ---- submit: Enter or the Search button commits now and announces the route --------
  const submitSearch = (): void => {
    const value = text.trim();
    setCommitted(value);
    if (value !== '') navigate({ name: 'search', q: value });
  };

  const onSubmit = (e: SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault();
    submitSearch();
  };

  // Explicit Enter handling on the input: implicit form submission is not reliable in
  // every runtime (jsdom never fires it); preventDefault stops a second, native submit.
  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSearch();
    }
  };

  // ---- derived view data -------------------------------------------------------------
  const openVideo = (video: VideoManifest): void => {
    navigate(
      video.kind === 22
        ? { name: 'shorts', videoId: video.id }
        : { name: 'watch', videoId: video.id },
    );
  };
  const openChannel = (pubkey: NostrPubkey): void => {
    navigate({ name: 'channel', pubkey });
  };

  const byName = (a: NostrPubkey, b: NostrPubkey): number =>
    profileName(profiles[a], a).localeCompare(profileName(profiles[b], b));
  const subscribedCreators = [...subs].sort(byName);
  const resultCreators = seenAuthors.filter((pk) => !subs.has(pk)).sort(byName);
  const orphanAuthor =
    filters.author !== '' && !subs.has(filters.author) && !seenAuthors.includes(filters.author)
      ? filters.author
      : undefined;
  const creatorCount = subscribedCreators.length + resultCreators.length + (orphanAuthor ? 1 : 0);

  const tagSuggestions = useMemo((): readonly string[] => {
    const counts = new Map<string, number>();
    for (const v of results.items)
      for (const t of v.tags) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) ?? 0) + 1);
    return [...counts.entries()]
      .filter(([t]) => !filters.tags.includes(t))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAG_SUGGESTIONS)
      .map(([t]) => t);
  }, [results.items, filters.tags]);

  const chips: { readonly key: string; readonly label: string; readonly remove: () => void }[] = [];
  if (filters.uploaded !== 'any') {
    chips.push({
      key: 'uploaded',
      label: SEARCH_UPLOAD_DATES.find((o) => o.id === filters.uploaded)?.label ?? '',
      remove: () => {
        applyFilters({ ...filtersRef.current, uploaded: 'any' });
      },
    });
  }
  if (filters.duration !== 'any') {
    chips.push({
      key: 'duration',
      label: SEARCH_DURATIONS.find((o) => o.id === filters.duration)?.label ?? '',
      remove: () => {
        applyFilters({ ...filtersRef.current, duration: 'any' });
      },
    });
  }
  for (const tag of filters.tags) {
    chips.push({
      key: `tag:${tag}`,
      label: `#${tag}`,
      remove: () => {
        setTags(filtersRef.current.tags.filter((t) => t !== tag));
      },
    });
  }
  if (filters.author !== '') {
    chips.push({
      key: 'author',
      label: profileName(profiles[filters.author], filters.author),
      remove: () => {
        applyFilters({ ...filtersRef.current, author: '' });
      },
    });
  }

  // ---- render ----------------------------------------------------------------------
  const skeletonRows = (count: number): ReactElement => (
    <ol className="nf-search__list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="nf-search__item">
          <VideoCardSkeleton layout="list" />
        </li>
      ))}
    </ol>
  );

  const row = (video: VideoManifest): ReactElement => (
    <li key={video.id} className="nf-search__item">
      <VideoCard
        layout="list"
        video={video}
        channel={profiles[video.author] ?? undefined}
        thumbnailSrc={thumbs[video.id]}
        stats={stats[video.id]}
        now={nowSec}
        onOpen={openVideo}
        onOpenChannel={openChannel}
      />
      {video.description.trim() !== '' ? (
        <div className="nf-search__snippet">
          <Markdown source={video.description} maxChars={SNIPPET_MAX_CHARS} />
        </div>
      ) : null}
    </li>
  );

  const radioGroup = <K extends 'uploaded' | 'duration'>(
    key: K,
    legend: string,
    options: readonly { readonly id: SearchFilterState[K]; readonly label: string }[],
  ): ReactElement => (
    <fieldset className="nf-search__group">
      <legend className="nf-search__group-title">{legend}</legend>
      {options.map((o) => {
        const checked = filters[key] === o.id;
        return (
          <label
            key={o.id}
            className={cx('nf-search__option', checked && 'nf-search__option--checked')}
          >
            <input
              type="radio"
              className="nf-search__radio"
              name={`${id}-${key}`}
              value={o.id}
              checked={checked}
              onChange={() => {
                applyFilters({ ...filtersRef.current, [key]: o.id });
              }}
            />
            <span>{o.label}</span>
            {checked ? <Icon name="check" size={16} className="nf-search__option-check" /> : null}
          </label>
        );
      })}
    </fieldset>
  );

  const onAuthorChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    applyFilters({ ...filtersRef.current, author: e.currentTarget.value as NostrPubkey | '' });
  };

  const renderResults = (): ReactElement => {
    const videos = results.items.filter((v) => v.kind !== 22);
    const shorts = results.items.filter((v) => v.kind === 22);
    const total = results.items.length;
    const plus = results.next !== undefined ? '+' : '';
    return (
      <>
        <p className="nf-search__count" role="status">
          {total}
          {plus} result{total === 1 && plus === '' ? '' : 's'} for “{results.query}”
        </p>
        {channelMatches.length > 0 ? (
          <section className="nf-search__channels" aria-labelledby={`${id}-channels`}>
            <h2 id={`${id}-channels`} className="nf-search__sr">
              Channels
            </h2>
            <ul className="nf-search__channel-list">
              {channelMatches.map((profile) => (
                <li key={profile.pubkey} className="nf-search__channel">
                  <ChannelRow
                    profile={profile}
                    avatarSrc={avatars[profile.pubkey]}
                    size="lg"
                    subscribed={subs.has(profile.pubkey)}
                    busy={subBusy.has(profile.pubkey)}
                    onSubscribe={toggleSubscribe}
                    onOpen={openChannel}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {videos.length > 0 ? (
          <h2 id={`${id}-videos`} className="nf-search__sr">
            Videos
          </h2>
        ) : null}
        {videos.length > 0 ? (
          <ol className="nf-search__list" aria-labelledby={`${id}-videos`}>
            {videos.slice(0, SHORTS_SHELF_AFTER).map(row)}
          </ol>
        ) : null}
        {shorts.length > 0 ? (
          <section className="nf-search__shorts" aria-labelledby={`${id}-shorts`}>
            <h2 id={`${id}-shorts`} className="nf-search__shorts-title">
              <Icon name="play" size={20} />
              Shorts
            </h2>
            <ul className="nf-search__shorts-list">
              {shorts.map((video) => (
                <li key={video.id} className="nf-search__short">
                  <VideoCard
                    layout="grid"
                    video={video}
                    channel={profiles[video.author] ?? undefined}
                    thumbnailSrc={thumbs[video.id]}
                    stats={stats[video.id]}
                    now={nowSec}
                    onOpen={openVideo}
                    onOpenChannel={openChannel}
                    hideChannel
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {videos.length > SHORTS_SHELF_AFTER ? (
          <ol
            className="nf-search__list"
            start={SHORTS_SHELF_AFTER + 1}
            aria-labelledby={`${id}-videos`}
          >
            {videos.slice(SHORTS_SHELF_AFTER).map(row)}
          </ol>
        ) : null}
        {results.more === 'loading' ? skeletonRows(2) : null}
        {results.more === 'error' ? (
          <ErrorState
            compact
            title="Could not load more"
            description={describeSearchError(results.moreError, 'more').description}
            detail={describeSearchError(results.moreError, 'more').detail}
            onRetry={loadMore}
          />
        ) : null}
        {hasMore ? (
          <div className="nf-search__more">
            <div ref={sentinelRef} className="nf-search__sentinel" aria-hidden="true" />
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

  const renderBody = (): ReactElement => {
    switch (results.status) {
      case 'idle':
        return (
          <EmptyState
            icon="search"
            title="Search Nutflix"
            description="Find videos by title, tag or creator. Results appear as you type; press / anywhere to jump to the search box. Every price is shown before playback starts."
          />
        );
      case 'loading':
        return (
          <>
            <p className="nf-search__count" role="status">
              Searching for “{results.query}”…
            </p>
            {skeletonRows(SEARCH_SKELETON_ROWS)}
          </>
        );
      case 'error': {
        const e = describeSearchError(results.error);
        return (
          <ErrorState
            title={e.title}
            description={e.description}
            detail={e.detail}
            onRetry={() => {
              setReload((r) => r + 1);
            }}
          />
        );
      }
      case 'ready':
        if (results.items.length > 0) return renderResults();
        return (
          <EmptyState
            preset="no-results"
            description={
              <>
                Nothing matched <strong>“{results.query}”</strong>
                {filtersActive ? ' with these filters' : ''}. Try different words
                {filtersActive ? ', fewer filters or a broader date range' : ' or a tag'}. Search
                runs on relays that support it plus the channels you follow, so some videos may not
                be found.
              </>
            }
            {...(filtersActive ? { action: 'Clear filters', onAction: clearFilters } : {})}
          />
        );
    }
  };

  const busy = results.status === 'loading' || results.more === 'loading';

  return (
    <section className={cx('nf-search', className)} aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="nf-search__sr">
        Search
      </h1>
      <form className="nf-search__bar" role="search" aria-label="Search videos" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          id={`${id}-input`}
          className="nf-search__input"
          type="search"
          name="q"
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search videos"
          aria-keyshortcuts="/"
        />
        <IconButton type="submit" icon="search" label="Search" />
      </form>

      <div className="nf-search__toolbar">
        <Button
          variant={filtersOpen ? 'primary' : 'secondary'}
          size="sm"
          className="nf-search__filters-toggle"
          aria-expanded={filtersOpen}
          aria-controls={`${id}-filters`}
          onClick={() => {
            setFiltersOpen((open) => !open);
          }}
        >
          {chips.length > 0 ? `Filters (${String(chips.length)})` : 'Filters'}
        </Button>
        {chips.map((chip) => (
          <Button
            key={chip.key}
            variant="secondary"
            size="sm"
            icon="close"
            className="nf-search__chip"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={chip.remove}
          >
            {chip.label}
          </Button>
        ))}
        {filtersActive ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {filtersOpen ? (
        <div
          className="nf-search__filters"
          id={`${id}-filters`}
          role="group"
          aria-label="Search filters"
        >
          {radioGroup('uploaded', 'Upload date', [
            { id: 'any', label: 'Any time' },
            ...SEARCH_UPLOAD_DATES,
          ])}
          {radioGroup('duration', 'Duration', [
            { id: 'any', label: 'Any duration' },
            ...SEARCH_DURATIONS,
          ])}
          <div className="nf-search__group">
            <label className="nf-search__group-title" htmlFor={`${id}-f-tags`}>
              Tags
            </label>
            <input
              id={`${id}-f-tags`}
              className="nf-search__field"
              type="text"
              value={tagsText}
              placeholder="ceramics, space"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${id}-f-tags-hint`}
              onChange={(e) => {
                setTagsText(e.currentTarget.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTags(e.currentTarget.value);
                }
              }}
            />
            <span id={`${id}-f-tags-hint`} className="nf-search__hint">
              Any of these tags. Separate with commas.
            </span>
            {tagSuggestions.length > 0 ? (
              <div className="nf-search__suggest" aria-label="Tags in these results" role="group">
                {tagSuggestions.map((tag) => (
                  <Button
                    key={tag}
                    variant="ghost"
                    size="sm"
                    className="nf-search__suggest-tag"
                    aria-label={`Add tag ${tag}`}
                    onClick={() => {
                      setTags([...filtersRef.current.tags, tag]);
                    }}
                  >
                    #{tag}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="nf-search__group">
            <label className="nf-search__group-title" htmlFor={`${id}-f-creator`}>
              Creator
            </label>
            <select
              id={`${id}-f-creator`}
              className="nf-search__field"
              value={filters.author}
              onChange={onAuthorChange}
              disabled={creatorCount === 0}
            >
              <option value="">All creators</option>
              {orphanAuthor ? (
                <option value={orphanAuthor}>
                  {profileName(profiles[orphanAuthor], orphanAuthor)}
                </option>
              ) : null}
              {subscribedCreators.length > 0 ? (
                <optgroup label="Your subscriptions">
                  {subscribedCreators.map((pk) => (
                    <option key={pk} value={pk}>
                      {profileName(profiles[pk], pk)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {resultCreators.length > 0 ? (
                <optgroup label="Seen in results">
                  {resultCreators.map((pk) => (
                    <option key={pk} value={pk}>
                      {profileName(profiles[pk], pk)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
        </div>
      ) : null}

      <div
        className="nf-search__results"
        role="region"
        aria-label="Search results"
        aria-busy={busy || undefined}
      >
        {renderBody()}
      </div>
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-search__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
