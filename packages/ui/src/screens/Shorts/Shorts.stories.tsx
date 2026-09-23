/**
 * Screens/Shorts — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule 8).
 * The screenshot script writes these to artifacts/screens/shorts/. `MockNetworkAdapter` is
 * allowed here and in tests only, never in the screen source.
 *
 * States that need a viewer action (playing, paused, nutzap sheet, end of feed, a failed
 * start) are reached with a story `play` function that clicks/keys exactly like a viewer —
 * the screen itself never starts playback on its own.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NostrEventId, Page, PlaySession, VideoManifest } from '@sovit/core';
import type { ReactElement } from 'react';
import { CHANNELS, avatar, thumbnail } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Shorts, type ShortsProps } from './Shorts.js';
import './Shorts.css';

const { MockNetworkAdapter, VIDEOS } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

const SHORTS = VIDEOS.filter((v) => v.kind === 22);

function shortAt(i: number): VideoManifest {
  const v = SHORTS[i];
  if (v === undefined) throw new Error(`fixture short ${String(i)} missing`);
  return v;
}

/**
 * The stock mock, except `image()` answers with inline SVG data URLs (9:16 for shorts) so
 * posters and avatars render offline, and spend ticks exactly once (deterministic PNGs).
 */
function storyAdapter(opts: Options = {}): NetworkAdapter {
  const a = new MockNetworkAdapter({
    setInterval: (fn) => {
      const t = setTimeout(fn, 40);
      return () => {
        clearTimeout(t);
      };
    },
    ...opts,
  });
  const byThumb = new Map<string, string>();
  for (const v of VIDEOS)
    for (const r of v.renditions)
      if (r.image) byThumb.set(r.image.url, v.kind === 22 ? thumbnail(v, 360, 640) : thumbnail(v));
  const byAvatar = new Map<string, string>();
  for (const c of CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byThumb.get(url) ?? byAvatar.get(url) ?? url, sha256);
  return a;
}

/** Same adapter with some methods replaced (methods stay bound to the mock). */
function withOverrides(base: NetworkAdapter, over: Partial<NetworkAdapter>): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in over) return (over as Record<string | symbol, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * A session whose source is `mediasource` (the web shell wires MSE), so the `<video>` has no
 * `src` to fail on in Storybook and the playing chrome can be shown over the poster.
 */
function mseSessions(base: NetworkAdapter): NetworkAdapter {
  return withOverrides(base, {
    play: (videoId: NostrEventId, rendition?: string): Promise<PlaySession> =>
      base.play(videoId, rendition).then((s): PlaySession => ({
        ...s,
        source: { kind: 'mediasource', mediaSource: { readyState: 'closed' } },
      })),
  });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

/** The shell gives the screen a fixed height (viewport minus header); stories use 820 px. */
function Screen({
  height = 820,
  ...props
}: Partial<ShortsProps> & {
  readonly adapter: NetworkAdapter;
  readonly height?: number;
}): ReactElement {
  return (
    <div style={{ height }}>
      <Shorts navigate={navigate} {...props} />
    </div>
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function clickPlay(canvasElement: HTMLElement): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const btn = canvasElement.querySelector<HTMLButtonElement>(
      '.nf-shorts__slide--active .nf-shorts__play:not([disabled])',
    );
    if (btn) {
      btn.click();
      await wait(120);
      return;
    }
    await wait(25);
  }
}

async function waitFor(canvasElement: HTMLElement, selector: string): Promise<HTMLElement | null> {
  for (let i = 0; i < 40; i++) {
    const el = canvasElement.querySelector<HTMLElement>(selector);
    if (el) return el;
    await wait(25);
  }
  return null;
}

const meta = {
  title: 'Screens/Shorts',
  component: Shorts,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Shorts>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: 'Loading (skeleton)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const Populated: Story = {
  name: 'Populated (price before play, nothing playing)',
  render: () => <Screen adapter={storyAdapter()} />,
};

export const DeepLink: Story = {
  name: 'Deep link (route videoId, second short)',
  render: () => <Screen adapter={storyAdapter()} videoId={shortAt(1).id} />,
};

export const Playing: Story = {
  name: 'Playing (after an explicit tap)',
  render: () => <Screen adapter={mseSessions(storyAdapter())} />,
  play: async ({ canvasElement }) => {
    await clickPlay(canvasElement);
  },
};

export const Paused: Story = {
  name: 'Paused (not paying)',
  render: () => <Screen adapter={mseSessions(storyAdapter())} />,
  play: async ({ canvasElement }) => {
    await clickPlay(canvasElement);
    const pause = await waitFor(canvasElement, '.nf-shorts__controls button');
    pause?.click();
    await wait(60);
  },
};

export const NutzapSheet: Story = {
  name: 'Nutzap sheet',
  // The sheet is fixed to the viewport (1280 × 900): make the story frame the viewport.
  parameters: { nf: { width: 1280 } },
  render: () => <Screen adapter={storyAdapter()} height={868} />,
  play: async ({ canvasElement }) => {
    const btn = await waitFor(canvasElement, '.nf-shorts__slide--active .nf-button--accent');
    btn?.click();
    await wait(80);
  },
};

export const EndOfFeed: Story = {
  name: 'End of feed (all caught up)',
  render: () => <Screen adapter={storyAdapter()} videoId={shortAt(SHORTS.length - 1).id} />,
  play: async ({ canvasElement }) => {
    await waitFor(canvasElement, '.nf-shorts__slide--active .nf-shorts__play');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await wait(120);
  },
};

export const Empty: Story = {
  name: 'Empty — no shorts yet',
  render: () => (
    <Screen
      adapter={withOverrides(storyAdapter(), {
        feed: (): Promise<Page<VideoManifest>> => Promise.resolve({ items: [] }),
      })}
    />
  ),
};

export const MissingShort: Story = {
  name: 'Deep link to a missing short (notice)',
  render: () => <Screen adapter={storyAdapter()} videoId={mocks.asEventId('deleted-short')} />,
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders online',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-seeders' })} />,
};

export const NoBalance: Story = {
  name: 'Error — no balance at this mint',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-balance' })} />,
};

export const NoSigner: Story = {
  name: 'Error — no signer',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} />,
};

export const SignedOut: Story = {
  name: 'Signed out',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};

export const StartFailed: Story = {
  name: 'Error — could not start',
  render: () => (
    <Screen
      adapter={withOverrides(storyAdapter(), {
        play: (): Promise<PlaySession> =>
          Promise.reject(new Error('transport: stream refused by every peer')),
      })}
    />
  ),
  play: async ({ canvasElement }) => {
    await clickPlay(canvasElement);
  },
};

export const PriceChanged: Story = {
  name: 'Price changed at start (re-consent)',
  render: () => {
    const base = storyAdapter();
    return (
      <Screen
        adapter={withOverrides(base, {
          play: (videoId: NostrEventId, rendition?: string): Promise<PlaySession> =>
            base.play(videoId, rendition).then((s): PlaySession => ({
              ...s,
              policy: { ...s.policy, satsPerBlock: mocks.sats(s.policy.satsPerBlock * 2) },
            })),
        })}
      />
    );
  },
  play: async ({ canvasElement }) => {
    await clickPlay(canvasElement);
  },
};

export const LoadMoreFailed: Story = {
  name: 'Error — could not load more',
  render: () => {
    const base = storyAdapter();
    return (
      <Screen
        pageSize={1}
        adapter={withOverrides(base, {
          feed: (q): Promise<Page<VideoManifest>> =>
            q.cursor === undefined
              ? base.feed(q)
              : Promise.reject(new Error('relay-down: no relays reachable')),
        })}
      />
    );
  },
  play: async ({ canvasElement }) => {
    await waitFor(canvasElement, '.nf-shorts__slide--active .nf-shorts__play');
    await wait(60);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    await wait(120);
  },
};

export const Phone: Story = {
  name: 'Phone width (full-bleed frame)',
  parameters: { nf: { width: 390 } },
  render: () => <Screen adapter={storyAdapter()} />,
};
