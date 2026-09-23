/**
 * Screens/Channel — one story per STATE against `MockNetworkAdapter` (execution plan §0
 * rule 8). The screenshot script writes these to artifacts/screens/channel/.
 * `MockNetworkAdapter` is allowed here and in tests only, never in the screen source.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type {
  FeedQuery,
  NetworkAdapter,
  NostrPubkey,
  Page,
  Playlist,
  Profile,
  VideoManifest,
} from '@sovit/core';
import type { ReactElement } from 'react';
import {
  CHANNELS,
  ME,
  NOW,
  NPUB,
  avatar,
  channelAt,
  thumbnail,
} from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Channel, type ChannelProps } from './Channel.js';
import './Channel.css';

const { MockNetworkAdapter } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

/** Wide banner "image" (inline SVG) keyed by channel slug, so banners render offline. */
function banner(slug: string): string {
  const hue = Math.round((parseInt(mocks.fakeHex64(`ban:${slug}`).slice(0, 4), 16) / 65_536) * 360);
  const hue2 = (hue + 80) % 360;
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1248" height="208" viewBox="0 0 1248 208">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue} 45% 38%)"/><stop offset="1" stop-color="hsl(${hue2} 50% 24%)"/>` +
      `</linearGradient></defs><rect width="1248" height="208" fill="url(#g)"/>` +
      `<circle cx="1060" cy="70" r="110" fill="rgba(255,255,255,0.10)"/>` +
      `<circle cx="200" cy="190" r="150" fill="rgba(255,255,255,0.07)"/>` +
      `</svg>`,
  )}`;
}

/** Binds every method except the overridden ones to the mock (keeps its private state). */
function override(
  base: NetworkAdapter,
  patch: Partial<Record<keyof NetworkAdapter, unknown>>,
): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && prop in patch) return patch[prop as keyof NetworkAdapter];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * A mock whose `image()` answers with inline SVG data URLs, so thumbnails, avatars and the
 * banner render offline (the fixture URLs point at fixture.example). Everything else is the
 * stock mock.
 */
function storyAdapter(opts: Options = {}): NetworkAdapter {
  const a = new MockNetworkAdapter(opts);
  const byUrl = new Map<string, string>();
  for (const v of mocks.VIDEOS)
    for (const r of v.renditions) if (r.image) byUrl.set(r.image.url, thumbnail(v));
  for (const c of CHANNELS) {
    if (c.profile.picture) byUrl.set(c.profile.picture, avatar(c.pubkey));
    if (c.profile.banner) byUrl.set(c.profile.banner, banner(c.profile.name ?? c.pubkey));
  }
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byUrl.get(url) ?? url, sha256);
  return a;
}

/** Overrides `profile(pubkey)` for exactly one pubkey. */
function withProfile(
  base: NetworkAdapter,
  pubkey: NostrPubkey,
  replacement: Profile | null,
): NetworkAdapter {
  return override(base, {
    profile: (pk: NostrPubkey): Promise<Profile | null> =>
      pk === pubkey ? Promise.resolve(replacement) : base.profile(pk),
  });
}

/** A channel that exists (profile) but has published nothing and curates no playlists. */
function emptyChannel(base: NetworkAdapter): NetworkAdapter {
  return override(base, {
    feed: (q: FeedQuery): Promise<Page<VideoManifest>> =>
      q.source === 'author' ? Promise.resolve({ items: [] }) : base.feed(q),
    library: {
      ...base.library,
      playlists: (): Promise<readonly Playlist[]> => Promise.resolve([]),
    },
  });
}

/** Gives `author` the supplied NIP-51 video sets. */
function withPlaylists(
  base: NetworkAdapter,
  author: NostrPubkey,
  lists: readonly Playlist[],
): NetworkAdapter {
  return override(base, {
    library: {
      ...base.library,
      playlists: (a?: NostrPubkey): Promise<readonly Playlist[]> =>
        Promise.resolve(a === undefined ? lists : lists.filter((p) => p.author === a)),
    },
  });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

const orbital = channelAt(0);
const kilnfire = channelAt(1);
const lowtide = channelAt(2);
const orbitalVideos = mocks.VIDEOS.filter((v) => v.author === orbital.pubkey);
const orbitalPlaylists: readonly Playlist[] = [
  {
    id: 'starter-pack',
    author: orbital.pubkey,
    title: 'Orbital mechanics — start here',
    description:
      'The **essential** path through the channel, in order. Background reading lives at https://orbital.example/start.',
    videoIds: orbitalVideos.map((v) => v.id),
    isPrivate: false,
  },
  {
    id: 'launch-day',
    author: orbital.pubkey,
    title: 'Launch day, raw',
    description: 'Press-site clips, unedited.',
    videoIds: orbitalVideos.filter((v) => v.kind === 22).map((v) => v.id),
    isPrivate: false,
  },
  {
    id: 'draft-set',
    author: orbital.pubkey,
    title: 'Next season (draft)',
    description: 'Nothing filed here yet — an empty set renders without a play affordance.',
    videoIds: [],
    isPrivate: true,
  },
  {
    id: 'gone',
    author: orbital.pubkey,
    title: 'Archived livestreams',
    videoIds: [mocks.asEventId('a-deleted-video')],
    isPrivate: false,
  },
];

const RICH_ABOUT = [
  'We make **orbital mechanics** intuitive — one mission at a time. New long-form video every week, shorts in between.',
  'Reading list and episode notes: https://orbital.example/notes — questions welcome, or say hi to the producer nostr:' +
    NPUB,
].join('\n\n');

/**
 * What a shell with a kind-10019 lookup would pass as `seedingVideos`: the fixture says
 * which channels run a seeder (`FixtureChannel.seeds`); such a channel seeds its own catalog.
 */
function seedingFor(pubkey: NostrPubkey): number | undefined {
  const c = CHANNELS.find((x) => x.pubkey === pubkey);
  return c?.seeds ? mocks.VIDEOS.filter((v) => v.author === pubkey).length : undefined;
}

function Screen(
  props: Partial<Omit<ChannelProps, 'adapter' | 'pubkey'>> & {
    readonly adapter: NetworkAdapter;
    readonly pubkey?: NostrPubkey;
  },
): ReactElement {
  const pubkey = props.pubkey ?? orbital.pubkey;
  return (
    <Channel
      navigate={navigate}
      now={NOW}
      seedingVideos={seedingFor(pubkey)}
      {...props}
      pubkey={pubkey}
    />
  );
}

const meta = {
  title: 'Screens/Channel',
  component: Channel,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Channel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: 'Loading (skeletons)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const ImagesPending: Story = {
  name: 'Loading — images still verifying (T16)',
  render: () => (
    <Screen
      adapter={override(storyAdapter(), {
        image: (): Promise<string> => new Promise(() => undefined),
      })}
    />
  ),
};

export const Populated: Story = {
  name: 'Videos (populated, seeding, NIP-05 verified)',
  render: () => <Screen adapter={storyAdapter()} />,
};

export const ShortsTab: Story = {
  name: 'Shorts (populated)',
  render: () => <Screen adapter={storyAdapter()} tab="shorts" />,
};

export const PlaylistsTab: Story = {
  name: 'Playlists (price before Play all)',
  render: () => (
    <Screen
      adapter={withPlaylists(storyAdapter(), orbital.pubkey, orbitalPlaylists)}
      tab="playlists"
    />
  ),
};

export const AboutTab: Story = {
  name: 'About (populated)',
  render: () => (
    <Screen
      adapter={withProfile(storyAdapter(), orbital.pubkey, {
        ...orbital.profile,
        about: RICH_ABOUT,
        lud16: 'orbital@wallet.fixture.example',
      })}
      tab="about"
    />
  ),
};

export const Nip05Unverified: Story = {
  name: 'NIP-05 unverified (not seeding)',
  render: () => (
    <Screen
      adapter={withProfile(storyAdapter(), kilnfire.pubkey, {
        ...kilnfire.profile,
        nip05Status: 'unverified',
      })}
      pubkey={kilnfire.pubkey}
    />
  ),
};

export const Nip05Failed: Story = {
  name: 'NIP-05 verification failed',
  render: () => (
    <Screen
      adapter={withProfile(storyAdapter(), kilnfire.pubkey, {
        ...kilnfire.profile,
        nip05Status: 'failed',
      })}
      pubkey={kilnfire.pubkey}
    />
  ),
};

export const Nip05Absent: Story = {
  name: 'NIP-05 absent (pubkey shown)',
  render: () => <Screen adapter={storyAdapter()} pubkey={lowtide.pubkey} />,
};

export const OwnChannel: Story = {
  name: 'Your channel (local seeder, nothing published)',
  render: () => <Screen adapter={storyAdapter()} pubkey={ME} />,
};

export const MorePages: Story = {
  name: 'More pages (Show more)',
  render: () => <Screen adapter={storyAdapter()} pageSize={2} />,
};

export const NoProfile: Story = {
  name: 'No kind-0 profile (videos only)',
  render: () => (
    <Screen adapter={withProfile(storyAdapter(), orbital.pubkey, null)} seedingVideos={undefined} />
  ),
};

export const EmptyChannel: Story = {
  name: 'Empty channel (nothing published)',
  render: () => <Screen adapter={emptyChannel(storyAdapter())} pubkey={channelAt(4).pubkey} />,
};

export const ShortsEmpty: Story = {
  name: 'Empty — no shorts',
  render: () => <Screen adapter={storyAdapter()} pubkey={lowtide.pubkey} tab="shorts" />,
};

export const PlaylistsEmpty: Story = {
  name: 'Empty — no playlists',
  render: () => <Screen adapter={storyAdapter()} tab="playlists" />,
};

export const AboutEmpty: Story = {
  name: 'Empty — no description',
  render: () => {
    const { about: _dropped, ...noAbout } = kilnfire.profile;
    return (
      <Screen
        adapter={withProfile(storyAdapter(), kilnfire.pubkey, noAbout)}
        pubkey={kilnfire.pubkey}
        tab="about"
      />
    );
  },
};

export const ChannelNotFound: Story = {
  name: 'Channel not found',
  render: () => (
    <Screen adapter={storyAdapter()} pubkey={mocks.asPubkey('there-is-no-such-channel')} />
  ),
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders online (About availability)',
  render: () => (
    <Screen
      adapter={storyAdapter({ failWith: 'no-seeders' })}
      seedingVideos={undefined}
      tab="about"
    />
  ),
};

export const NoSigner: Story = {
  name: 'Error — no signer (Subscribe → settings)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} />,
};

export const NoBalance: Story = {
  name: 'Error — no balance (channel unaffected)',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-balance' })} />,
};

export const SignedOut: Story = {
  name: 'Signed out (Subscribe → settings)',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};

export const WithMiniPlayer: Story = {
  name: 'With mini-player slot',
  render: () => (
    <Screen
      adapter={storyAdapter()}
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
