/**
 * Screens/Watch — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule 8).
 * The screenshot script writes these to artifacts/screens/watch/. `MockNetworkAdapter` is
 * allowed here and in tests only, never in the screen source.
 *
 * The screen never autoplays (the money rule). Playback states are reached the way a viewer
 * reaches them: the story's `Driven` wrapper presses the priced Play button after mount (and
 * then Pause, the seeders button, …) — the same DOM clicks a person would make.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NostrEventId, PeerSpend, PlaySession, Sats } from '@sovit/core';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { CHANNELS, NOW, PEERS, avatar, thumbnail } from '../../../.storybook/fixtures.js';
import { Player } from '../../components/index.js';
import type { Route } from '../shared/route.js';
import { Watch, type WatchProps } from './Watch.js';
import type { WatchHandoff } from './model.js';
import './Watch.css';

const { MockNetworkAdapter } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

/**
 * Session ticks for stories: twelve one-second ticks delivered at once, 30 ms after the
 * session starts (after the screen subscribed), then nothing — so spend, peers and "paid to"
 * are populated and stable when the screenshot is taken.
 */
const burstInterval = (fn: () => void): (() => void) => {
  const h = setTimeout(() => {
    for (let i = 0; i < 12; i++) fn();
  }, 30);
  return () => {
    clearTimeout(h);
  };
};

/**
 * A mock whose `image()` answers with inline SVG data URLs, so thumbnails, posters and
 * avatars render offline (the fixture URLs point at fixture.example). Everything else is
 * the stock mock.
 */
function storyAdapter(opts: Options = {}): NetworkAdapter {
  const a = new MockNetworkAdapter({ setInterval: burstInterval, ...opts });
  const byThumb = new Map<string, string>();
  for (const v of mocks.VIDEOS)
    for (const r of v.renditions) if (r.image) byThumb.set(r.image.url, thumbnail(v));
  const byAvatar = new Map<string, string>();
  for (const c of CHANNELS)
    if (c.profile.picture) byAvatar.set(c.profile.picture, avatar(c.pubkey));
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byThumb.get(url) ?? byAvatar.get(url) ?? url, sha256);
  // The mock's `fixture://` URLs cannot play in a browser (the element errors, and the
  // screen then — correctly — stops paying). Stories hand out an MSE-style source instead:
  // the element gets no `src`, shows the verified poster, and the screen's clock runs.
  const play = a.play.bind(a);
  a.play = (id: NostrEventId, rendition?: string): Promise<PlaySession> =>
    play(id, rendition).then((s) => ({
      ...s,
      source: { kind: 'mediasource', mediaSource: { readyState: 'closed' } },
    }));
  return a;
}

/**
 * Same adapter, but every session reports the fixture's four seeders with different rates
 * (the stock mock splits evenly), so the peer panel shows a real ranking.
 */
function rankedPeersAdapter(): NetworkAdapter {
  const base = storyAdapter();
  const play = base.play.bind(base);
  base.play = (id: NostrEventId, rendition?: string): Promise<PlaySession> =>
    play(id, rendition).then((s) => ({
      ...s,
      onPeers: (cb: (p: readonly PeerSpend[]) => void) => {
        const h = setTimeout(() => {
          cb(PEERS);
        }, 40);
        return () => {
          clearTimeout(h);
        };
      },
      onSpend: (cb: (x: { readonly total: Sats; readonly ratePerMin: Sats }) => void) => {
        const h = setTimeout(() => {
          cb({
            total: PEERS.reduce((n, p) => n + p.sats, 0) as Sats,
            ratePerMin: PEERS.reduce((n, p) => n + p.ratePerMin, 0) as Sats,
          });
        }, 40);
        return () => {
          clearTimeout(h);
        };
      },
    }));
  return base;
}

function historyAdapter(): NetworkAdapter {
  const a = storyAdapter();
  void a.library.recordProgress(VIDEO_ID, 1260);
  return a;
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

/** The main fixture: 'Raku firing at night' — two mints, three renditions, not subscribed. */
const VIDEO_ID = (() => {
  const v = mocks.VIDEOS[1] ?? mocks.VIDEOS[0];
  if (!v) throw new Error('fixture videos empty');
  return v.id;
})();

type Step =
  | { readonly click: string }
  | { readonly wait: string }
  | { readonly key: string }
  | { readonly event: string; readonly on: string };

/** Performs viewer steps (click / wait / key / media event) in order once the screen is up. */
function Driven({
  steps,
  children,
}: {
  readonly steps: readonly Step[];
  readonly children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let stopped = false;
    const find = async (selector: string): Promise<HTMLElement | null> => {
      for (let i = 0; i < 200 && !stopped; i++) {
        const el = ref.current?.querySelector<HTMLElement>(selector) ?? null;
        if (el !== null) return el;
        await new Promise((r) => setTimeout(r, 5));
      }
      return null;
    };
    void (async () => {
      for (const step of steps) {
        if (stopped) return;
        if ('click' in step) (await find(step.click))?.click();
        else if ('wait' in step) await find(step.wait);
        else if ('key' in step)
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: step.key, bubbles: true, cancelable: true }),
          );
        else (await find(step.on))?.dispatchEvent(new Event(step.event));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [steps]);
  return <div ref={ref}>{children}</div>;
}

const PRESS_PLAY: readonly Step[] = [
  { click: 'button[aria-label^="Play — costs"]' },
  { wait: '.nf-player[data-status="playing"]' },
];

function Screen(props: Partial<WatchProps> & { readonly adapter: NetworkAdapter }): ReactElement {
  return <Watch navigate={navigate} now={NOW} videoId={VIDEO_ID} {...props} />;
}

/** A tiny stand-in shell: takes the handed-off session and floats its own mini-player. */
function MiniPlayerShell({ adapter }: { readonly adapter: NetworkAdapter }): ReactElement {
  const [handoff, setHandoff] = useState<WatchHandoff | null>(null);
  const video = mocks.VIDEOS.find((v) => v.id === VIDEO_ID);
  const mini =
    handoff === null || video === undefined ? null : (
      <Player
        media={<img src={thumbnail(video)} alt="" />}
        state={{
          status: handoff.paused ? 'paused' : 'playing',
          currentTimeSec: handoff.positionSec,
          durationSec: video.durationSec ?? 0,
          buffered: [],
          paidThroughSec: handoff.positionSec + 30,
          volume: handoff.volume,
          muted: handoff.muted,
          playbackRate: handoff.playbackRate,
          rendition: handoff.session.rendition,
          captions: 'unavailable',
          pip: false,
          theater: false,
          fullscreen: false,
          mini: true,
          spend: { total: 1152 as Sats, ratePerMin: 960 as Sats },
        }}
        renditions={video.renditions}
        policy={video.price}
        title={handoff.title}
        onAction={() => undefined}
      />
    );
  return (
    <Screen
      adapter={adapter}
      onMiniPlayer={(_session, _id, h) => {
        setHandoff(h);
      }}
      miniPlayer={mini}
    />
  );
}

const meta = {
  title: 'Screens/Watch',
  component: Watch,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Watch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: 'Loading (skeletons)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const Populated: Story = {
  name: 'Populated (price before play)',
  render: () => <Screen adapter={storyAdapter()} />,
};

export const Resume: Story = {
  name: 'Resume from history (poster)',
  render: () => <Screen adapter={historyAdapter()} />,
};

export const QualityPicker: Story = {
  name: 'Quality picker before play (price per rendition)',
  render: () => (
    <Driven steps={[{ click: '.nf-watch__quality-button' }]}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const Playing: Story = {
  name: 'Playing (viewer pressed play) — streaming sats/min',
  render: () => (
    <Driven steps={PRESS_PLAY}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const Paused: Story = {
  name: 'Paused — not paying',
  render: () => (
    <Driven steps={[...PRESS_PLAY, { click: 'button[aria-label="Pause (k)"]' }]}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const PeerPanel: Story = {
  name: 'Peer panel (seeders you are paying)',
  render: () => (
    <Driven steps={[...PRESS_PLAY, { click: 'button[aria-label="Show seeders"]' }]}>
      <Screen adapter={rankedPeersAdapter()} />
    </Driven>
  ),
};

export const UpNext: Story = {
  name: 'Ended — up next countdown with price',
  render: () => (
    <Driven steps={[...PRESS_PLAY, { event: 'ended', on: 'video' }]}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const Theater: Story = {
  name: 'Theater mode',
  render: () => (
    <Driven steps={[...PRESS_PLAY, { key: 't' }]}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const MiniPlayerHandoff: Story = {
  name: 'Mini-player (session handed to the shell)',
  render: () => (
    <Driven steps={[...PRESS_PLAY, { click: 'button[aria-label="Mini-player (i)"]' }]}>
      <MiniPlayerShell adapter={storyAdapter()} />
    </Driven>
  ),
};

export const Playlist: Story = {
  name: 'Playlist panel (autoplay follows it)',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      playlist={{
        title: 'Ceramics binge',
        videoIds: mocks.VIDEOS.filter((v) => v.tags.includes('ceramics')).map((v) => v.id),
      }}
    />
  ),
};

export const Nutzap: Story = {
  name: 'Nutzap sheet (mint chooser)',
  // The sheet is fixed to the viewport's right edge: frame = viewport width so it is whole.
  parameters: { nf: { width: 1280 } },
  render: () => (
    <Driven steps={[{ click: '.nf-watch__actions .nf-button--accent' }]}>
      <Screen adapter={storyAdapter()} />
    </Driven>
  ),
};

export const NotFound: Story = {
  name: 'Empty — video not found',
  render: () => <Screen adapter={storyAdapter()} videoId={mocks.asEventId('missing')} />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders online',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-seeders' })} />,
};

export const NoBalance: Story = {
  name: 'Error — no balance at the mint',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-balance' })} />,
};

export const NoSigner: Story = {
  name: 'Error — no signer detected',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} />,
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} />,
};

export const SignedOut: Story = {
  name: 'Signed out (read-only page, signer gate on the stage)',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};
