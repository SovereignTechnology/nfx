/**
 * MockNetworkAdapter — fixture videos, fake sats, simulated playback spend.
 *
 * Used by every `@sovit/ui` screen (L5) and Storybook. Deterministic by default; the
 * `latencyMs` option adds a fixed delay so skeleton/loading states are reachable, and
 * `failWith` forces error states ("no seeders online", "signer not detected", ...).
 */
import type {
  Comment,
  FeedQuery,
  MintUrl,
  NetworkAdapter,
  Notification,
  NostrEventId,
  NostrPubkey,
  Page,
  PeerSpend,
  Playlist,
  PlaySession,
  Profile,
  RelayUrl,
  Sats,
  SearchFilters,
  SeederStatus,
  Settings,
  Sha256Hex,
  SignerStatus,
  UnixSeconds,
  Unsubscribe,
  UploadInput,
  UploadProgress,
  VideoManifest,
  VideoStats,
  Wallet,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import {
  CHANNELS,
  FIXTURE_NOW,
  ME,
  MINTS,
  MY_PROFILE,
  VIDEOS,
  asEventId,
  asPubkey,
  commentTags,
  fixtureComments,
  sats,
  unix,
} from './fixtures.js';
import { MockWallet } from './mock-wallet.js';

export type MockFailure = 'no-seeders' | 'no-signer' | 'no-balance' | 'relay-down';

export interface MockNetworkAdapterOptions {
  readonly wallet?: Wallet;
  readonly latencyMs?: number;
  readonly failWith?: MockFailure;
  readonly signedIn?: boolean;
  readonly seeding?: boolean;
  readonly now?: () => UnixSeconds;
  /** Simulated playback throughput for spend ticking (blocks/second). */
  readonly blocksPerSecond?: number;
  /** Interval driver, injectable for tests. Defaults to `setInterval`. */
  readonly setInterval?: (fn: () => void, ms: number) => () => void;
}

export class MockNetworkAdapter implements NetworkAdapter {
  readonly platform = 'mock' as const;
  readonly wallet: Wallet;

  private readonly opts: MockNetworkAdapterOptions;
  private readonly now: () => UnixSeconds;
  private readonly subs = new Set<NostrPubkey>([
    CHANNELS[0]?.pubkey ?? ME,
    CHANNELS[2]?.pubkey ?? ME,
  ]);
  private readonly watchLaterIds = new Set<NostrEventId>([VIDEOS[3]?.id ?? asEventId('none')]);
  private readonly likedIds = new Set<NostrEventId>([VIDEOS[1]?.id ?? asEventId('none')]);
  private readonly dislikedIds = new Set<NostrEventId>();
  private readonly progress = new Map<NostrEventId, { positionSec: number; at: UnixSeconds }>();
  private readonly extraComments = new Map<NostrEventId, Comment[]>();
  private readonly playlists: Playlist[] = [
    {
      id: 'ceramics-binge',
      author: ME,
      title: 'Ceramics binge',
      videoIds: VIDEOS.filter((v) => v.tags.includes('ceramics')).map((v) => v.id),
      isPrivate: false,
    },
  ];
  private settingsState: Settings;
  private readonly notifListeners = new Set<(n: Notification) => void>();
  private readonly seederListeners = new Set<(s: SeederStatus) => void>();
  private readonly banned: { pubkey: NostrPubkey; reason: string; at: UnixSeconds }[] = [
    { pubkey: asPubkey('freeloader'), reason: 'window-exceeded', at: unix(FIXTURE_NOW - 7200) },
  ];

  constructor(opts: MockNetworkAdapterOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? ((): UnixSeconds => unix(Math.floor(Date.now() / 1000)));
    this.wallet =
      opts.wallet ??
      new MockWallet(
        opts.failWith === 'no-balance' ? { balances: { [MINTS.a]: 0, [MINTS.b]: 0 } } : {},
      );
    this.settingsState = {
      relays: [
        { url: 'wss://relay.fixture-1.example' as RelayUrl, read: true, write: true },
        { url: 'wss://relay.fixture-2.example' as RelayUrl, read: true, write: false },
      ],
      defaultMints: [MINTS.a],
      seeding: { enabled: opts.seeding ?? true, diskCapBytes: 50 * 1024 ** 3 },
      prefetchSeconds: 30,
      hoverPreview: true,
      theme: 'dark',
    };
  }

  private async delay<T>(v: T): Promise<T> {
    if (this.opts.failWith === 'relay-down') throw new Error('relay-down: no relays reachable');
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    return v;
  }

  // ---- identity
  signer(): Promise<SignerStatus> {
    const none = this.opts.failWith === 'no-signer' || this.opts.signedIn === false;
    return this.delay(
      none
        ? {
            kind: 'nip07',
            pubkey: null,
            locked: true,
            supportsSignSecret: false,
            detail: 'no signer detected',
          }
        : { kind: 'local', pubkey: ME, locked: false, supportsSignSecret: true },
    );
  }
  me(): Promise<NostrPubkey | null> {
    return this.delay(
      this.opts.failWith === 'no-signer' || this.opts.signedIn === false ? null : ME,
    );
  }
  profile(pubkey: NostrPubkey): Promise<Profile | null> {
    if (pubkey === ME) return this.delay(MY_PROFILE);
    return this.delay(CHANNELS.find((c) => c.pubkey === pubkey)?.profile ?? null);
  }

  // ---- catalog
  feed(q: FeedQuery): Promise<Page<VideoManifest>> {
    let items = [...VIDEOS];
    switch (q.source) {
      case 'subscriptions':
        items = items.filter((v) => this.subs.has(v.author) && v.kind === 21);
        break;
      case 'trending':
        items = items
          .filter((v) => v.kind === 21)
          .sort((a, b) => this.trendScore(b) - this.trendScore(a));
        break;
      case 'tags':
        items = items.filter((v) => v.tags.some((t) => q.tags?.includes(t)));
        break;
      case 'author':
        items = items.filter((v) => v.author === q.author);
        break;
      case 'shorts':
        items = items.filter((v) => v.kind === 22);
        break;
    }
    if (q.source !== 'trending') items.sort((a, b) => b.publishedAt - a.publishedAt);
    return this.delay(paginate(items, q.cursor, q.limit ?? 8));
  }
  video(id: NostrEventId): Promise<VideoManifest | null> {
    return this.delay(VIDEOS.find((v) => v.id === id) ?? null);
  }
  stats(id: NostrEventId): Promise<VideoStats> {
    const v = VIDEOS.find((x) => x.id === id);
    const seed = v ? VIDEOS.indexOf(v) + 1 : 0;
    // Other viewers' reactions are fixed per fixture; the mock viewer's own one is added on top.
    const mine = this.likedIds.has(id) ? 'like' : this.dislikedIds.has(id) ? 'dislike' : undefined;
    const likes = seed * 9 + 3 + (mine === 'like' ? 1 : 0);
    const dislikes = seed * 2 + (mine === 'dislike' ? 1 : 0);
    return this.delay({
      paidViews: seed * 37 + 12,
      satsToCreator: sats(seed * 1830 + 240),
      reactions: likes + dislikes,
      likes,
      dislikes,
      ...(mine === undefined ? {} : { myReaction: mine }),
      comments: fixtureComments(id).length + (this.extraComments.get(id)?.length ?? 0),
      seedersOnline: this.opts.failWith === 'no-seeders' ? 0 : 1 + (seed % 4),
    });
  }
  related(id: NostrEventId, limit = 6): Promise<readonly VideoManifest[]> {
    const v = VIDEOS.find((x) => x.id === id);
    if (!v) return this.delay([]);
    const score = (o: VideoManifest): number =>
      (o.author === v.author ? 2 : 0) + o.tags.filter((t) => v.tags.includes(t)).length;
    return this.delay(
      VIDEOS.filter((o) => o.id !== id)
        .sort((a, b) => score(b) - score(a))
        .slice(0, limit),
    );
  }
  search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<VideoManifest>> {
    const needle = q.text.toLowerCase();
    let items = VIDEOS.filter(
      (v) => v.title.toLowerCase().includes(needle) || v.tags.some((t) => t.includes(needle)),
    );
    const f = q.filters;
    if (f) {
      const { author, tags, since, until, minDurationSec, maxDurationSec } = f;
      if (author) items = items.filter((v) => v.author === author);
      if (tags) items = items.filter((v) => v.tags.some((t) => tags.includes(t)));
      if (since !== undefined) items = items.filter((v) => v.publishedAt >= since);
      if (until !== undefined) items = items.filter((v) => v.publishedAt <= until);
      if (minDurationSec !== undefined)
        items = items.filter((v) => (v.durationSec ?? 0) >= minDurationSec);
      if (maxDurationSec !== undefined)
        items = items.filter((v) => (v.durationSec ?? 0) <= maxDurationSec);
    }
    return this.delay(paginate(items, q.cursor, 10));
  }

  // ---- social
  comments(videoId: NostrEventId, sort: 'new' | 'top', cursor?: string): Promise<Page<Comment>> {
    const all = [...fixtureComments(videoId), ...(this.extraComments.get(videoId) ?? [])];
    all.sort(
      sort === 'top' ? (a, b) => b.reactions - a.reactions : (a, b) => b.createdAt - a.createdAt,
    );
    return this.delay(paginate(all, cursor, 20));
  }
  comment(videoId: NostrEventId, content: string, parent?: NostrEventId): Promise<Comment> {
    const id = asEventId(`mine:${videoId}:${String(this.extraComments.get(videoId)?.length ?? 0)}`);
    const createdAt = this.now();
    const video = VIDEOS.find((v) => v.id === videoId);
    const parentAuthor =
      parent === undefined
        ? undefined
        : ([...fixtureComments(videoId), ...(this.extraComments.get(videoId) ?? [])].find(
            (c) => c.id === parent,
          )?.author ?? ME);
    const base = {
      id,
      author: ME,
      content,
      createdAt,
      reactions: 0,
      event: {
        id,
        pubkey: ME,
        kind: NostrKind.Comment,
        created_at: createdAt,
        content,
        tags: commentTags(
          { id: videoId, kind: video?.kind ?? 21, author: video?.author ?? ME },
          parent !== undefined && parentAuthor !== undefined
            ? { id: parent, author: parentAuthor }
            : undefined,
        ),
        sig: '00'.repeat(64),
      },
    };
    const c: Comment = parent ? { ...base, parent } : base;
    const list = this.extraComments.get(videoId) ?? [];
    list.push(c);
    this.extraComments.set(videoId, list);
    return this.delay(c);
  }
  react(videoId: NostrEventId, reaction: string): Promise<void> {
    // NIP-25: the newest reaction per pubkey wins, so a new one replaces the old.
    this.likedIds.delete(videoId);
    this.dislikedIds.delete(videoId);
    if (reaction === '+' || reaction === '') this.likedIds.add(videoId);
    else if (reaction === '-') this.dislikedIds.add(videoId);
    return this.delay(undefined);
  }
  unreact(videoId: NostrEventId): Promise<void> {
    this.likedIds.delete(videoId);
    this.dislikedIds.delete(videoId);
    return this.delay(undefined);
  }
  nutzap(_videoId: NostrEventId, amount: Sats, mint: MintUrl): Promise<void> {
    if (this.wallet instanceof MockWallet)
      this.wallet.credit(mint, -Number(amount), 'out', `nutzap ${amount} sat`);
    return this.delay(undefined);
  }
  subscribe(channel: NostrPubkey): Promise<void> {
    this.subs.add(channel);
    return this.delay(undefined);
  }
  unsubscribe(channel: NostrPubkey): Promise<void> {
    this.subs.delete(channel);
    return this.delay(undefined);
  }
  subscriptions(): Promise<readonly NostrPubkey[]> {
    return this.delay([...this.subs]);
  }
  report(): Promise<void> {
    return this.delay(undefined);
  }

  // ---- library
  library = {
    history: (
      cursor?: string,
    ): Promise<
      Page<{
        readonly video: VideoManifest;
        readonly positionSec: number;
        readonly at: UnixSeconds;
      }>
    > => {
      const items = [...this.progress.entries()]
        .map(([id, p]) => {
          const video = VIDEOS.find((v) => v.id === id);
          return video ? { video, positionSec: p.positionSec, at: p.at } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.at - a.at);
      return this.delay(paginate(items, cursor, 20));
    },
    recordProgress: (videoId: NostrEventId, positionSec: number): Promise<void> => {
      this.progress.set(videoId, { positionSec, at: this.now() });
      return this.delay(undefined);
    },
    watchLater: (): Promise<readonly VideoManifest[]> =>
      this.delay(VIDEOS.filter((v) => this.watchLaterIds.has(v.id))),
    setWatchLater: (videoId: NostrEventId, on: boolean): Promise<void> => {
      if (on) this.watchLaterIds.add(videoId);
      else this.watchLaterIds.delete(videoId);
      return this.delay(undefined);
    },
    playlists: (author?: NostrPubkey): Promise<readonly Playlist[]> =>
      this.delay(this.playlists.filter((p) => !author || p.author === author)),
    savePlaylist: (
      p: Omit<Playlist, 'id' | 'author'> & { readonly id?: string },
    ): Promise<Playlist> => {
      const id = p.id ?? `pl-${String(this.playlists.length + 1)}`;
      const saved: Playlist = { ...p, id, author: ME };
      const i = this.playlists.findIndex((x) => x.id === id);
      if (i >= 0) this.playlists[i] = saved;
      else this.playlists.push(saved);
      return this.delay(saved);
    },
    liked: (): Promise<readonly VideoManifest[]> =>
      this.delay(VIDEOS.filter((v) => this.likedIds.has(v.id))),
  };

  // ---- playback
  async play(videoId: NostrEventId, rendition?: string): Promise<PlaySession> {
    const video = VIDEOS.find((v) => v.id === videoId);
    if (!video) throw new Error('video not found');
    if (this.opts.failWith === 'no-seeders')
      throw new Error('no-seeders: nobody is seeding this video right now');
    const r = video.renditions.find((x) => x.label === rendition) ?? video.renditions[0];
    if (!r) throw new Error('no renditions');
    const bal = await this.wallet.balance(video.price.mints[0] ?? MINTS.a);
    if (bal <= 0) throw new Error(`no-balance: no balance at ${video.price.mints[0] ?? ''}`);
    return this.makeSession(video, r.label);
  }

  private makeSession(video: VideoManifest, label: string): PlaySession {
    const peerKeys = CHANNELS.filter((c) => c.seeds).map((c) => c.pubkey);
    const peers: { pubkey: NostrPubkey; sats: number; blocks: number }[] = peerKeys.map(
      (pubkey) => ({ pubkey, sats: 0, blocks: 0 }),
    );
    const peerCbs = new Set<(p: readonly PeerSpend[]) => void>();
    const spendCbs = new Set<(s: { readonly total: Sats; readonly ratePerMin: Sats }) => void>();
    let paused = false;
    let prefetch = this.settingsState.prefetchSeconds;
    const bps = this.opts.blocksPerSecond ?? 8;
    const mint = video.price.mints[0] ?? MINTS.a;
    const tick = (): void => {
      if (paused) return;
      const per = bps / peers.length;
      for (const p of peers) {
        p.blocks += per;
        p.sats += per * video.price.satsPerBlock;
      }
      const total = peers.reduce((a, p) => a + p.sats, 0);
      if (this.wallet instanceof MockWallet)
        this.wallet.credit(
          mint,
          -bps * video.price.satsPerBlock,
          'out',
          `streamed ${bps} blocks of ${video.title}`,
        );
      const snapshot: PeerSpend[] = peers.map((p) => ({
        pubkey: p.pubkey,
        sats: sats(Math.floor(p.sats)),
        ratePerMin: sats(Math.round(per * 60 * video.price.satsPerBlock)),
        blocks: Math.floor(p.blocks),
        latencyMs: 40,
      }));
      for (const cb of peerCbs) cb(snapshot);
      for (const cb of spendCbs)
        cb({
          total: sats(Math.floor(total)),
          ratePerMin: sats(bps * 60 * video.price.satsPerBlock),
        });
    };
    const stop = (this.opts.setInterval ?? defaultInterval)(tick, 1000);
    const session: PlaySession = {
      videoId: video.id,
      rendition: label,
      source: { kind: 'url', url: `fixture://video/${video.id}/${label}.mp4` },
      policy: video.price,
      onPeers: (cb): Unsubscribe => {
        peerCbs.add(cb);
        return () => peerCbs.delete(cb);
      },
      onSpend: (cb): Unsubscribe => {
        spendCbs.add(cb);
        return () => spendCbs.delete(cb);
      },
      setPrefetchSeconds: (sec): void => {
        prefetch = sec;
      },
      pause: (): void => {
        paused = true;
      },
      resume: (): void => {
        paused = false;
      },
      switchRendition: (next): Promise<PlaySession> => {
        stop();
        const s = this.makeSession(video, next);
        s.setPrefetchSeconds(prefetch);
        return Promise.resolve(s);
      },
      close: (): Promise<void> => {
        stop();
        return Promise.resolve();
      },
    };
    return session;
  }

  image(url: string, _sha256?: Sha256Hex): Promise<string> {
    return this.delay(url);
  }

  // ---- studio
  studio = {
    upload: async (
      input: UploadInput,
      onProgress: (p: UploadProgress) => void,
    ): Promise<VideoManifest> => {
      onProgress({ stage: 'probing' });
      for (const r of ['1080p', '720p', '360p'])
        for (const pct of [25, 50, 75, 100])
          onProgress({ stage: 'transcoding', rendition: r, percent: pct });
      onProgress({
        stage: 'thumbnails',
        candidates: [
          'https://fixture.example/thumbs/new-1.jpg',
          'https://fixture.example/thumbs/new-2.jpg',
          'https://fixture.example/thumbs/new-3.jpg',
        ],
      });
      for (const r of ['1080p', '720p', '360p'])
        onProgress({ stage: 'writing', rendition: r, percent: 100 });
      onProgress({ stage: 'publishing' });
      for (const s of input.mirrorTo ?? []) onProgress({ stage: 'mirroring', server: s, ok: true });
      const base = VIDEOS[0];
      if (!base) throw new Error('no fixture');
      const video: VideoManifest = {
        ...base,
        id: asEventId(`upload:${input.title}`),
        title: input.title,
        description: input.description,
        tags: input.tags,
        kind: input.kind,
        author: ME,
        publishedAt: this.now(),
      };
      onProgress({ stage: 'done', video });
      return this.delay(video);
    },
    myVideos: (cursor?: string): Promise<Page<VideoManifest>> =>
      this.delay(
        paginate(
          VIDEOS.filter((v) => v.author === (CHANNELS[0]?.pubkey ?? ME)).map((v) => ({
            ...v,
            author: ME,
          })),
          cursor,
          10,
        ),
      ),
    analytics: async (
      videoId: NostrEventId,
    ): Promise<VideoStats & { readonly satsByRendition: ReadonlyMap<string, Sats> }> => {
      const s = await this.stats(videoId);
      return {
        ...s,
        satsByRendition: new Map([
          ['1080p', sats(Math.floor(s.satsToCreator * 0.6))],
          ['720p', sats(Math.floor(s.satsToCreator * 0.3))],
          ['360p', sats(Math.floor(s.satsToCreator * 0.1))],
        ]),
      };
    },
  };

  // ---- seeder
  seeder = {
    status: (): Promise<SeederStatus> => this.delay(this.seederStatus()),
    setEnabled: (on: boolean): Promise<void> => {
      this.settingsState = {
        ...this.settingsState,
        seeding: { ...this.settingsState.seeding, enabled: on },
      };
      const s = this.seederStatus();
      for (const cb of this.seederListeners) cb(s);
      return this.delay(undefined);
    },
    melt: (mint: MintUrl, bolt11: string): Promise<{ paid: boolean }> =>
      this.wallet
        .meltQuote(mint, bolt11)
        .then((q) => this.wallet.melt(q))
        .then((r) => ({ paid: r.paid })),
    unban: (pubkey: NostrPubkey): Promise<void> => {
      const i = this.banned.findIndex((b) => b.pubkey === pubkey);
      if (i >= 0) this.banned.splice(i, 1);
      return this.delay(undefined);
    },
    onStatus: (cb: (s: SeederStatus) => void): Unsubscribe => {
      this.seederListeners.add(cb);
      return () => this.seederListeners.delete(cb);
    },
  };

  private seederStatus(): SeederStatus {
    const mine = VIDEOS.filter((v) => v.author === (CHANNELS[0]?.pubkey ?? ME));
    return {
      enabled: this.settingsState.seeding.enabled,
      pubkey: ME,
      videos: mine.length,
      bytesStored: mine.reduce((a, v) => a + v.renditions.reduce((b, r) => b + r.size, 0), 0),
      diskCapBytes: this.settingsState.seeding.diskCapBytes,
      peers: [
        {
          peer: asPubkey('peer-1'),
          uploaded: 812,
          paid: 810,
          outstanding: 2,
          windowBlocks: 4,
          banned: false,
          lastActivity: this.now(),
        },
        {
          peer: asPubkey('peer-2'),
          uploaded: 96,
          paid: 96,
          outstanding: 0,
          windowBlocks: 4,
          banned: false,
          lastActivity: unix(this.now() - 30),
        },
      ],
      earned: {
        total: sats(48_210),
        unswapped: sats(320),
        byMint: new Map([
          [MINTS.a, sats(41_000)],
          [MINTS.b, sats(7_210)],
        ]),
      },
      banned: [...this.banned],
    };
  }

  // ---- settings
  settings(): Promise<Settings> {
    return this.delay(this.settingsState);
  }
  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settingsState = { ...this.settingsState, ...patch };
    return this.delay(this.settingsState);
  }

  // ---- live
  notifications(cb: (n: Notification) => void): Unsubscribe {
    this.notifListeners.add(cb);
    return () => this.notifListeners.delete(cb);
  }

  /** Test/Storybook hook: push a notification to listeners. */
  emitNotification(n: Notification): void {
    for (const cb of this.notifListeners) cb(n);
  }

  private trendScore(v: VideoManifest): number {
    const ageH = Math.max(1, (FIXTURE_NOW - v.publishedAt) / 3600);
    return ((VIDEOS.indexOf(v) + 1) * 1830) / ageH;
  }
}

function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const slice = items.slice(start, start + limit);
  const end = start + slice.length;
  return end < items.length ? { items: slice, next: String(end) } : { items: slice };
}

function defaultInterval(fn: () => void, ms: number): () => void {
  const h = setInterval(fn, ms);
  return () => {
    clearInterval(h);
  };
}
