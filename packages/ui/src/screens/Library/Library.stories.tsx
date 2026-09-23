/**
 * Screens/Library — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule
 * 8). The screenshot script writes these to artifacts/screens/library/. `MockNetworkAdapter`
 * is allowed here and in tests only, never in the screen source. Timestamps are pinned
 * (`now` = fixture NOW, days cut in UTC) so the PNGs are diffable.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NostrEventId, Page, UnixSeconds, VideoManifest } from '@sovit/core';
import type { ReactElement } from 'react';
import { CHANNELS, NOW, ME, avatar, channelAt, thumbnail } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Library, type HistoryEntry, type LibraryProps } from './Library.js';
import './Library.css';

const { MockNetworkAdapter, VIDEOS } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];
type Lib = NetworkAdapter['library'];

const HOUR = 3600;
const DAY = 86_400;

function vid(i: number): VideoManifest {
  const v = VIDEOS[i];
  if (!v) throw new Error(`fixture VIDEOS[${i}] missing`);
  return v;
}

/**
 * A mock whose `image()` answers with inline SVG data URLs (the fixture URLs point at
 * fixture.example) and whose clock is settable, so history entries land on chosen days.
 */
function storyAdapter(opts: Options = {}): {
  readonly adapter: mocks.MockNetworkAdapter;
  readonly setClock: (t: number) => void;
} {
  let clock: number = NOW;
  const a = new MockNetworkAdapter({ now: () => clock as UnixSeconds, ...opts });
  const byThumb = new Map<string, string>();
  for (const v of VIDEOS)
    for (const r of v.renditions) if (r.image) byThumb.set(r.image.url, thumbnail(v));
  const byAvatar = new Map<string, string>();
  for (const c of CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byThumb.get(url) ?? byAvatar.get(url) ?? url, sha256);
  return {
    adapter: a,
    setClock: (t) => {
      clock = t;
    },
  };
}

/** History across Today / Yesterday / a weekday / "Aug 28" / last year; synchronous seeding. */
function seedHistory(a: mocks.MockNetworkAdapter, setClock: (t: number) => void): void {
  const entries: readonly [index: number, positionSec: number, ago: number][] = [
    [0, 312, 1 * HOUR], // Hohmann — resume at 5:12
    [4, 41, 3 * HOUR], // a short, watched
    [1, 2800, 26 * HOUR], // Raku — watched to the end
    [2, 2, 30 * HOUR], // Low Tide #01 — barely started
    [3, 640, 3 * DAY], // pod eviction — resume
    [6, 1200, 7 * DAY], // Green Room — resume
    [11, 1900, 400 * DAY], // etcd — last year
  ];
  for (const [i, pos, ago] of entries) {
    setClock(NOW - ago);
    void a.library.recordProgress(vid(i).id, pos);
  }
  setClock(NOW);
}

/** Watch later, likes and three extra playlists (one private with a description, one empty). */
function seedLists(a: mocks.MockNetworkAdapter): void {
  for (const i of [7, 9, 11]) void a.library.setWatchLater(vid(i).id, true);
  for (const i of [0, 2, 5, 8, 10]) void a.react(vid(i).id, '+');
  void a.library.savePlaylist({
    id: 'space-deep-dives',
    title: 'Space deep dives',
    description:
      'The **best** orbital mechanics explainers on the network, in watching order. More at https://example.com/space',
    videoIds: [vid(0).id, vid(7).id, vid(5).id],
    isPrivate: true,
  });
  void a.library.savePlaylist({
    id: 'late-night-sets',
    title: 'Late-night sets',
    videoIds: [vid(2).id, vid(9).id, vid(6).id],
    isPrivate: false,
  });
  void a.library.savePlaylist({
    id: 'empty-draft',
    title: 'Road trip (draft)',
    videoIds: [],
    isPrivate: true,
  });
}

function populated(opts: Options = {}): mocks.MockNetworkAdapter {
  const { adapter, setClock } = storyAdapter(opts);
  seedHistory(adapter, setClock);
  seedLists(adapter);
  return adapter;
}

/** Same adapter with some members replaced (Proxy binds the rest so private state works). */
function patched(
  base: NetworkAdapter,
  over: {
    readonly library?: Partial<Lib>;
    readonly video?: NetworkAdapter['video'];
    readonly me?: NetworkAdapter['me'];
    readonly signer?: NetworkAdapter['signer'];
  },
): NetworkAdapter {
  const library: Lib = { ...base.library, ...over.library };
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'library') return library;
      if (prop === 'video' && over.video) return over.video;
      if (prop === 'me' && over.me) return over.me;
      if (prop === 'signer' && over.signer) return over.signer;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** History paged 4 at a time; `second` decides what the next page does. */
function pagedHistory(base: mocks.MockNetworkAdapter, second: 'stuck' | 'fail'): NetworkAdapter {
  const all = base.library.history.bind(base.library);
  return patched(base, {
    library: {
      history: async (cursor?: string): Promise<Page<HistoryEntry>> => {
        if (cursor !== undefined) {
          if (second === 'fail') throw new Error('relay-down: no relays reachable');
          return new Promise<Page<HistoryEntry>>(() => undefined);
        }
        const page = await all();
        return { items: page.items.slice(0, 4), next: '4' };
      },
    },
  });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(props: Partial<LibraryProps> & { readonly adapter: NetworkAdapter }): ReactElement {
  return <Library navigate={navigate} now={NOW} timeZone="UTC" {...props} />;
}

/** Polls the story DOM (play functions run before the mock's promises settle). */
async function waitFor<T>(find: () => T | null | undefined, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const found = find();
    if (found !== null && found !== undefined) return found;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text);
}

const meta = {
  title: 'Screens/Library',
  component: Library,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Library>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- loading --------------------------------------------------------------------------
export const Loading: Story = {
  name: 'Loading — History',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 }).adapter} tab="history" />,
};

export const LoadingWatchLater: Story = {
  name: 'Loading — Watch later',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 }).adapter} tab="watch-later" />,
};

export const LoadingPlaylists: Story = {
  name: 'Loading — Playlists',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 }).adapter} tab="playlists" />,
};

export const LoadingLiked: Story = {
  name: 'Loading — Liked',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 }).adapter} tab="liked" />,
};

// ---- populated ------------------------------------------------------------------------
export const HistoryPopulated: Story = {
  name: 'History (populated, grouped by day)',
  render: () => <Screen adapter={populated()} tab="history" />,
};

export const HistoryLoadingMore: Story = {
  name: 'History — loading more',
  render: () => <Screen adapter={pagedHistory(populated(), 'stuck')} tab="history" />,
};

export const HistoryLoadMoreFailed: Story = {
  name: 'Error — history could not load more',
  render: () => <Screen adapter={pagedHistory(populated(), 'fail')} tab="history" />,
};

export const WatchLater: Story = {
  name: 'Watch later (populated)',
  render: () => <Screen adapter={populated()} tab="watch-later" />,
};

export const WatchLaterRemoved: Story = {
  name: 'Watch later — removed (Undo)',
  render: () => <Screen adapter={populated()} tab="watch-later" />,
  play: async ({ canvasElement }) => {
    const remove = await waitFor(() =>
      canvasElement.querySelector<HTMLButtonElement>('.nf-library__remove'),
    );
    remove.click();
    await waitFor(() => canvasElement.querySelector('.nf-toast'));
  },
};

export const WatchLaterRemoveFailed: Story = {
  name: 'Error — Watch later remove failed (rolled back)',
  render: () => {
    const base = populated();
    return (
      <Screen
        adapter={patched(base, {
          library: {
            setWatchLater: () => Promise.reject(new Error('relay-down: no relays reachable')),
          },
        })}
        tab="watch-later"
      />
    );
  },
  play: async ({ canvasElement }) => {
    const remove = await waitFor(() =>
      canvasElement.querySelector<HTMLButtonElement>('.nf-library__remove'),
    );
    remove.click();
    await waitFor(() => canvasElement.querySelector('.nf-toast--error'));
  },
};

export const Playlists: Story = {
  name: 'Playlists (populated, private + public)',
  render: () => <Screen adapter={populated()} tab="playlists" />,
};

export const NewPlaylist: Story = {
  name: 'Playlists — new playlist form',
  // The Sheet is fixed to the viewport: frame the whole 1280 × 900 viewport so it is not cut.
  parameters: { nf: { width: 1280 } },
  render: () => (
    <div style={{ minHeight: 868 }}>
      <Screen adapter={populated()} tab="playlists" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const open = await waitFor(() => buttonByText(canvasElement, 'New playlist'));
    open.click();
    const title = await waitFor(() =>
      document.querySelector<HTMLInputElement>('.nf-library__form input[type="text"]'),
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(title, 'Kiln builds');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  },
};

export const PlaylistOpen: Story = {
  name: 'Playlist opened (private, with description)',
  render: () => <Screen adapter={populated()} playlistId="space-deep-dives" />,
};

export const PlaylistUnavailable: Story = {
  name: 'Playlist — unavailable videos',
  render: () => {
    const base = populated();
    const broken = mocks.asEventId('relay-timeout');
    void base.library.savePlaylist({
      id: 'mixed',
      title: 'Saved from friends',
      videoIds: [vid(3).id, mocks.asEventId('deleted-video'), broken, vid(8).id],
      isPrivate: false,
    });
    const video = base.video.bind(base);
    return (
      <Screen
        adapter={patched(base, {
          video: (id: NostrEventId) =>
            id === broken ? Promise.reject(new Error('relay timed out')) : video(id),
        })}
        playlistId="mixed"
      />
    );
  },
};

export const Liked: Story = {
  name: 'Liked (populated)',
  render: () => <Screen adapter={populated()} tab="liked" />,
};

// ---- empty ----------------------------------------------------------------------------
export const EmptyHistory: Story = {
  name: 'Empty — history',
  render: () => <Screen adapter={storyAdapter().adapter} tab="history" />,
};

export const EmptyWatchLater: Story = {
  name: 'Empty — watch later',
  render: () => {
    const { adapter } = storyAdapter();
    void adapter.library.setWatchLater(vid(3).id, false);
    return <Screen adapter={adapter} tab="watch-later" />;
  },
};

export const EmptyPlaylists: Story = {
  name: 'Empty — playlists',
  render: () => (
    <Screen
      adapter={patched(storyAdapter().adapter, {
        library: { playlists: () => Promise.resolve([]) },
      })}
      tab="playlists"
    />
  ),
};

export const EmptyPlaylist: Story = {
  name: 'Empty — playlist has no videos',
  render: () => <Screen adapter={populated()} playlistId="empty-draft" />,
};

export const EmptyLiked: Story = {
  name: 'Empty — liked',
  render: () => {
    const { adapter } = storyAdapter();
    void adapter.react(vid(1).id, '-');
    return <Screen adapter={adapter} tab="liked" />;
  },
};

// ---- errors (every failWith that applies) ----------------------------------------------
export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' }).adapter} tab="history" />,
};

export const PlaylistsFailed: Story = {
  name: 'Error — playlists failed to load',
  render: () => (
    <Screen
      adapter={patched(populated(), {
        library: {
          playlists: () => Promise.reject(new Error('decrypt failed: signer did not answer')),
        },
      })}
      tab="playlists"
    />
  ),
};

export const NoSigner: Story = {
  name: 'Error — no signer (sign-in state)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' }).adapter} tab="history" />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders (library unaffected)',
  render: () => <Screen adapter={populated({ failWith: 'no-seeders' })} tab="watch-later" />,
};

export const NoBalance: Story = {
  name: 'Error — no balance (library unaffected)',
  render: () => <Screen adapter={populated({ failWith: 'no-balance' })} tab="liked" />,
};

// ---- signed out -----------------------------------------------------------------------
export const SignedOut: Story = {
  name: 'Signed out — playlists tab',
  render: () => <Screen adapter={storyAdapter({ signedIn: false }).adapter} tab="playlists" />,
};

export const SignerLocked: Story = {
  name: 'Signed out — signer locked',
  render: () => (
    <Screen
      adapter={patched(storyAdapter().adapter, {
        me: () => Promise.resolve(null),
        signer: () =>
          Promise.resolve({ kind: 'local', pubkey: ME, locked: true, supportsSignSecret: true }),
      })}
      tab="history"
    />
  ),
};

export const WithMiniPlayer: Story = {
  name: 'With mini-player slot',
  render: () => (
    <Screen
      adapter={populated()}
      tab="history"
      miniPlayer={
        <div
          style={{
            width: 400,
            aspectRatio: '16 / 9',
            background: 'var(--nf-color-bg-inverse)',
            color: 'var(--nf-color-text-inverse)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          mini-player (shell-provided) — {channelAt(0).profile.displayName}
        </div>
      }
    />
  ),
};
