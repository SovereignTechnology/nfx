/**
 * Screens/Search — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule
 * 8). The screenshot script writes these to artifacts/screens/search/. `MockNetworkAdapter`
 * is allowed here and in tests only, never in the screen source.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, Page, VideoManifest } from '@sovit/core';
import type { ReactElement } from 'react';
import { avatar, NOW, thumbnail } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Search, type SearchProps } from './Search.js';
import './Search.css';

const { MockNetworkAdapter } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

/**
 * A mock whose `image()` answers with inline SVG data URLs, so thumbnails and avatars render
 * offline (the fixture URLs point at fixture.example). Everything else is the stock mock.
 */
function storyAdapter(opts: Options = {}): NetworkAdapter {
  const a = new MockNetworkAdapter(opts);
  const byThumb = new Map<string, string>();
  for (const v of mocks.VIDEOS)
    for (const r of v.renditions) if (r.image) byThumb.set(r.image.url, thumbnail(v));
  const byAvatar = new Map<string, string>();
  for (const c of mocks.CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byThumb.get(url) ?? byAvatar.get(url) ?? url, sha256);
  return a;
}

/** Same adapter, but `search` is replaced (stuck second page, failing page, …). */
function withSearch(
  base: NetworkAdapter,
  search: (
    q: Parameters<NetworkAdapter['search']>[0],
    next: NetworkAdapter['search'],
  ) => Promise<Page<VideoManifest>>,
): NetworkAdapter {
  const original = base.search.bind(base);
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'search')
        return (q: Parameters<NetworkAdapter['search']>[0]) => search(q, original);
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * Re-pages the mock's search at `size` hits per page (offset cursors, like the mock's own).
 * Used for the long-list stories: VideoCard thumbnails are `loading="lazy"`, and the
 * screenshot script waits for every image — rows more than ~1,250 px below its 900 px
 * viewport never load in headless Chromium, so a 10-row page would hang the capture.
 */
function pagedBy(
  size: number,
  next: NetworkAdapter['search'],
  q: Parameters<NetworkAdapter['search']>[0],
): Promise<Page<VideoManifest>> {
  const start = q.cursor === undefined ? 0 : Number(q.cursor);
  return next({ ...q, cursor: String(start) }).then((page) => {
    const items = page.items.slice(0, size);
    const more = page.items.length > size || page.next !== undefined;
    return more ? { items, next: String(start + items.length) } : { items };
  });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(props: Partial<SearchProps> & { readonly adapter: NetworkAdapter }): ReactElement {
  return <Search navigate={navigate} now={NOW} {...props} />;
}

const meta = {
  title: 'Screens/Search',
  component: Search,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Search>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Initial: Story = {
  name: 'Initial (no query)',
  render: () => <Screen adapter={storyAdapter()} />,
};

export const Loading: Story = {
  name: 'Loading (skeleton rows)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} q="ceramics" />,
};

export const Results: Story = {
  name: 'Results (channel match + Shorts shelf)',
  render: () => <Screen adapter={storyAdapter()} q="ceramics" />,
};

export const ResultsMany: Story = {
  name: 'Results (many, infinite scroll)',
  render: () => (
    <Screen adapter={withSearch(storyAdapter(), (q, next) => pagedBy(6, next, q))} q="a" />
  ),
};

export const ResultsFiltered: Story = {
  name: 'Results filtered (panel open, chips)',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      q="sessions"
      filters={{ uploaded: 'year', duration: 'long', tags: ['music'] }}
    />
  ),
};

// Three rows per page so the infinite-scroll sentinel is inside the capture viewport and the
// next-page request actually fires (it is what these two stories are about).
export const LoadMoreStuck: Story = {
  name: 'Loading more (second page)',
  render: () => (
    <Screen
      adapter={withSearch(storyAdapter(), (q, next) =>
        q.cursor === undefined
          ? pagedBy(3, next, q)
          : new Promise<Page<VideoManifest>>(() => undefined),
      )}
      q="a"
    />
  ),
};

export const LoadMoreFailed: Story = {
  name: 'Error — could not load more',
  render: () => (
    <Screen
      adapter={withSearch(storyAdapter(), (q, next) =>
        q.cursor === undefined
          ? pagedBy(3, next, q)
          : Promise.reject(new Error('relay-down: no relays reachable')),
      )}
      q="a"
    />
  ),
};

export const NoResults: Story = {
  name: 'Empty — no results',
  render: () => <Screen adapter={storyAdapter()} q="woodworking" />,
};

export const NoResultsFiltered: Story = {
  name: 'Empty — filters too strict',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      q="ceramics"
      filters={{ duration: 'short', uploaded: 'hour' }}
    />
  ),
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} q="ceramics" />,
};

export const NoSigner: Story = {
  name: 'Error — no signer (search works; Subscribe asks to sign in)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} q="ceramics" />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders (search unaffected)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-seeders' })} q="space" />,
};

export const NoBalance: Story = {
  name: 'Error — no balance (search unaffected)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-balance' })} q="space" />,
};

export const SignedOut: Story = {
  name: 'Signed out (search still works)',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} q="music" />,
};

export const Narrow: Story = {
  name: 'Narrow column (phone width)',
  parameters: { nf: { width: 390 } },
  render: () => <Screen adapter={storyAdapter()} q="ceramics" />,
};

export const WithMiniPlayer: Story = {
  name: 'With mini-player slot',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      q="space"
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
          mini-player (shell-provided)
        </div>
      }
    />
  ),
};
