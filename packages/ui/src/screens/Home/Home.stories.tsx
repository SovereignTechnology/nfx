/**
 * Screens/Home — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule 8).
 * The screenshot script writes these to artifacts/screens/home/. `MockNetworkAdapter` is
 * allowed here and in tests only, never in the screen source.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, Page, VideoManifest } from '@sovit/core';
import type { ReactElement } from 'react';
import { CHANNELS, NOW, avatar, channelAt, thumbnail } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Home, type HomeProps } from './Home.js';
import './Home.css';

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
  for (const c of CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byThumb.get(url) ?? byAvatar.get(url) ?? url, sha256);
  return a;
}

/** Same adapter, but `feed` is replaced (empty trending, stuck second page, …). */
function withFeed(
  base: NetworkAdapter,
  feed: (
    q: Parameters<NetworkAdapter['feed']>[0],
    next: NetworkAdapter['feed'],
  ) => Promise<Page<VideoManifest>>,
): NetworkAdapter {
  const original = base.feed.bind(base);
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'feed') return (q: Parameters<NetworkAdapter['feed']>[0]) => feed(q, original);
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Nobody followed: the viewer's follow set is empty → suggested channels. */
function noSubscriptions(): NetworkAdapter {
  const a = storyAdapter();
  for (const c of CHANNELS) void a.unsubscribe(c.pubkey);
  return a;
}

/** Follows one channel that has never published → "nothing new" (no suggestions). */
function quietSubscriptions(): NetworkAdapter {
  const a = storyAdapter();
  for (const c of CHANNELS) void a.unsubscribe(c.pubkey);
  void a.subscribe(mocks.asPubkey('a-channel-with-no-videos'));
  return a;
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(props: Partial<HomeProps> & { readonly adapter: NetworkAdapter }): ReactElement {
  return <Home navigate={navigate} now={NOW} hoverPreview {...props} />;
}

const meta = {
  title: 'Screens/Home',
  component: Home,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: 'Loading (skeletons)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const Subscriptions: Story = {
  name: 'Subscriptions (populated)',
  render: () => <Screen adapter={storyAdapter()} tab="subscriptions" />,
};

export const Trending: Story = {
  name: 'Trending (populated, sats/hour)',
  render: () => <Screen adapter={storyAdapter()} tab="trending" />,
};

export const Tags: Story = {
  name: 'Tags you follow (populated)',
  render: () => (
    <Screen adapter={storyAdapter()} tab="tags" followedTags={['ceramics', 'space', 'music']} />
  ),
};

export const HoverPreviewOff: Story = {
  name: 'Hover preview off (web default)',
  render: () => <Screen adapter={storyAdapter()} tab="trending" hoverPreview={false} />,
};

export const LoadingMore: Story = {
  name: 'Loading more (infinite scroll)',
  render: () => (
    <Screen
      adapter={withFeed(storyAdapter(), (q, next) =>
        q.cursor === undefined ? next(q) : new Promise<Page<VideoManifest>>(() => undefined),
      )}
      tab="trending"
      pageSize={4}
    />
  ),
};

export const NoSubscriptions: Story = {
  name: 'Empty — no subscriptions yet (suggested channels)',
  render: () => <Screen adapter={noSubscriptions()} tab="subscriptions" />,
};

export const NothingNew: Story = {
  name: 'Empty — subscriptions have no videos',
  render: () => <Screen adapter={quietSubscriptions()} tab="subscriptions" />,
};

export const NoVideosForTags: Story = {
  name: 'Empty — no videos for your tags',
  render: () => (
    <Screen adapter={storyAdapter()} tab="tags" followedTags={['woodworking', 'sailing']} />
  ),
};

export const NoTagsFollowed: Story = {
  name: 'Empty — no tags followed',
  render: () => <Screen adapter={storyAdapter()} tab="tags" followedTags={[]} />,
};

export const NothingTrending: Story = {
  name: 'Empty — nothing trending',
  render: () => (
    <Screen
      adapter={withFeed(storyAdapter(), () => Promise.resolve({ items: [] }))}
      tab="trending"
    />
  ),
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} tab="trending" />,
};

export const LoadMoreFailed: Story = {
  name: 'Error — could not load more',
  render: () => (
    <Screen
      adapter={withFeed(storyAdapter(), (q, next) =>
        q.cursor === undefined
          ? next(q)
          : Promise.reject(new Error('relay-down: no relays reachable')),
      )}
      tab="trending"
      pageSize={4}
    />
  ),
};

export const NoSigner: Story = {
  name: 'Error — no signer (signed-out subscriptions)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} tab="subscriptions" />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders (feed unaffected)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-seeders' })} tab="trending" />,
};

export const NoBalance: Story = {
  name: 'Error — no balance (feed unaffected)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-balance' })} tab="trending" />,
};

export const SignedOut: Story = {
  name: 'Signed out (lands on Trending)',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};

export const SignedOutTags: Story = {
  name: 'Signed out — tags tab',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} tab="tags" />,
};

export const WithMiniPlayer: Story = {
  name: 'With mini-player slot',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="trending"
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
