/**
 * Screens/Studio — one story per STATE against `MockNetworkAdapter` (execution plan §0 rule 8).
 * The screenshot script writes these to artifacts/screens/studio/. `MockNetworkAdapter` is
 * allowed here and in tests only, never in the screen source.
 *
 * States that need a click (publish, melt-out) are driven by `<Auto>`, a story-only helper
 * that fills inputs / presses buttons right after mount, so the PNGs show the real flow.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { media, mocks } from '@sovit/core';
import type {
  NetworkAdapter,
  NostrPubkey,
  UploadInput,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { CHANNELS, NOW, avatar, thumbnail, videoAt } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import type { StudioFile } from './model.js';
import { Studio, type StudioProps } from './Studio.js';
import './Studio.css';

const { MockNetworkAdapter } = mocks;

type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

const CANDIDATES = [
  'https://fixture.example/thumbs/new-1.jpg',
  'https://fixture.example/thumbs/new-2.jpg',
  'https://fixture.example/thumbs/new-3.jpg',
];

/** A mock whose `image()` answers with inline SVGs (fixture URLs point at fixture.example). */
function storyAdapter(opts: Options = {}): mocks.MockNetworkAdapter {
  const a = new MockNetworkAdapter(opts);
  const byUrl = new Map<string, string>();
  for (const v of mocks.VIDEOS)
    for (const r of v.renditions) if (r.image) byUrl.set(r.image.url, thumbnail(v));
  for (const c of CHANNELS) if (c.profile.picture) byUrl.set(c.profile.picture, avatar(c.pubkey));
  CANDIDATES.forEach((url, i) => {
    byUrl.set(url, thumbnail(videoAt(i + 1)));
  });
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(byUrl.get(url) ?? url, sha256);
  return a;
}

/** Same adapter, seen as another shell (`platform` is capability copy only). */
function asPlatform(base: NetworkAdapter, platform: NetworkAdapter['platform']): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'platform') return platform;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Replaces `studio.upload` with a scripted run (events, then hang or reject). */
function withUpload(
  a: mocks.MockNetworkAdapter,
  script: (input: UploadInput, onProgress: (p: UploadProgress) => void) => Promise<VideoManifest>,
): mocks.MockNetworkAdapter {
  a.studio = { ...a.studio, upload: script };
  return a;
}

const hang = (): Promise<VideoManifest> => new Promise<VideoManifest>(() => undefined);

const FILE: StudioFile = {
  source: '/home/creator/Videos/hohmann-transfers-final.mp4',
  name: 'hohmann-transfers-final.mp4',
  size: 734_003_200,
  type: 'video/mp4',
};

const FFMPEG_OK = { found: true, path: '/usr/bin/ffmpeg', version: '8.1.2' } as const;

const DESCRIPTION =
  'How a **Hohmann transfer** gets you from low orbit to the Moon, explained with a *garden hose*.\n\nNotes and sources: https://example.com/hohmann';

type Step =
  | { readonly fill: string; readonly value: string }
  | { readonly click: string }
  | { readonly press: string }
  /** Waits until the selector matches (e.g. settings have pre-selected a mint). */
  | { readonly wait: string };

/** Story-only: performs `steps` in order as soon as each target exists and is enabled. */
function Auto({
  steps,
  children,
}: {
  readonly steps: readonly Step[];
  readonly children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let i = 0;
    let stopped = false;
    const find = (step: Step): HTMLElement | null => {
      const root = ref.current;
      if (!root) return null;
      if ('press' in step) {
        return (
          Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => b.textContent?.trim() === step.press && !b.disabled,
          ) ?? null
        );
      }
      return root.querySelector<HTMLElement>(
        'fill' in step ? step.fill : 'wait' in step ? step.wait : step.click,
      );
    };
    const tick = (): void => {
      if (stopped) return;
      for (;;) {
        const step = steps[i];
        if (!step) return;
        const el = find(step);
        if (!el || (el instanceof HTMLButtonElement && el.disabled)) break;
        if ('wait' in step) {
          // matched: nothing to do
        } else if ('fill' in step) {
          const proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, step.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.click();
        }
        i++;
      }
      setTimeout(tick, 0);
    };
    tick();
    return () => {
      stopped = true;
    };
  }, [steps]);
  return <div ref={ref}>{children}</div>;
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(
  props: Partial<StudioProps> & { readonly adapter: NetworkAdapter; readonly steps?: Step[] },
): ReactElement {
  const { steps, ...rest } = props;
  const screen = <Studio navigate={navigate} now={NOW} ffmpeg={FFMPEG_OK} {...rest} />;
  return steps ? <Auto steps={steps}>{screen}</Auto> : screen;
}

const PUBLISH: Step[] = [
  { wait: '.nf-studio__mints button[aria-pressed="true"]' },
  { click: 'button[type="submit"]' },
];

const meta = {
  title: 'Screens/Studio',
  component: Studio,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Studio>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- loading / identity -----------------------------------------------------------

export const Loading: Story = {
  name: 'Loading',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const SignedOut: Story = {
  name: 'Signed out',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};

export const NoSigner: Story = {
  name: 'Error — no signer',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-signer' })} />,
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} />,
};

// ---- upload -------------------------------------------------------------------------

export const UploadChooseFile: Story = {
  name: 'Upload — choose a file',
  render: () => <Screen adapter={storyAdapter()} tab="upload" />,
};

export const UploadDetails: Story = {
  name: 'Upload — details and preview',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="upload"
      pendingFile={FILE}
      steps={[
        { fill: 'textarea[name="description"]', value: DESCRIPTION },
        { fill: 'input[name="tags"]', value: 'space, #Physics, orbital mechanics' },
      ]}
    />
  ),
};

export const UploadValidation: Story = {
  name: 'Upload — validation errors',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="upload"
      pendingFile={FILE}
      steps={[
        { fill: 'input[name="title"]', value: '' },
        { fill: 'input[name="price"]', value: '0' },
        { fill: 'input[name="seeder"]', value: '120' },
        ...PUBLISH,
      ]}
    />
  ),
};

export const UploadWeb: Story = {
  name: 'Upload — web platform notice',
  render: () => (
    <Screen adapter={asPlatform(storyAdapter(), 'web')} tab="upload" ffmpeg={undefined} />
  ),
};

export const FfmpegNotFound: Story = {
  name: 'Upload — ffmpeg not found',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="upload"
      ffmpeg={{ found: false, path: '/usr/local/bin/ffmpeg', os: 'linux' }}
      onRecheckFfmpeg={() => undefined}
    />
  ),
};

export const FfmpegNotFoundDuringUpload: Story = {
  name: 'Upload — ffmpeg not found during upload',
  render: () => (
    <Screen
      adapter={withUpload(storyAdapter(), (_input, onProgress) => {
        onProgress({ stage: 'probing' });
        const err = new media.MediaError(
          'ffmpeg-not-found',
          'ffprobe: could not spawn ffprobe (ENOENT)',
        );
        onProgress({ stage: 'error', message: err.message });
        return Promise.reject(err);
      })}
      tab="upload"
      ffmpeg={undefined}
      pendingFile={FILE}
      steps={PUBLISH}
    />
  ),
};

export const UploadTranscoding: Story = {
  name: 'Upload — in progress (transcoding)',
  render: () => (
    <Screen
      adapter={withUpload(storyAdapter(), (_input, onProgress) => {
        onProgress({ stage: 'probing' });
        for (const pct of [20, 60, 100])
          onProgress({ stage: 'transcoding', rendition: '1080p', percent: pct });
        onProgress({ stage: 'transcoding', rendition: '720p', percent: 62 });
        return hang();
      })}
      tab="upload"
      pendingFile={FILE}
      steps={PUBLISH}
    />
  ),
};

export const UploadWriting: Story = {
  name: 'Upload — thumbnails ready, writing',
  render: () => (
    <Screen
      adapter={withUpload(storyAdapter(), (_input, onProgress) => {
        onProgress({ stage: 'probing' });
        for (const r of ['1080p', '720p', '360p'])
          onProgress({ stage: 'transcoding', rendition: r, percent: 100 });
        onProgress({ stage: 'thumbnails', candidates: CANDIDATES });
        onProgress({ stage: 'writing', rendition: '1080p', percent: 100 });
        onProgress({ stage: 'writing', rendition: '720p', percent: 35 });
        return hang();
      })}
      tab="upload"
      pendingFile={FILE}
      steps={PUBLISH}
    />
  ),
};

export const UploadPublished: Story = {
  name: 'Upload — published',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="upload"
      pendingFile={FILE}
      mirrorServers={['https://blossom.fixture.example', 'https://gateway.fixture.example']}
      steps={PUBLISH}
    />
  ),
};

export const UploadFailed: Story = {
  name: 'Upload — error (transcoding failed)',
  render: () => (
    <Screen
      adapter={withUpload(storyAdapter(), (_input, onProgress) => {
        onProgress({ stage: 'probing' });
        onProgress({ stage: 'transcoding', rendition: '1080p', percent: 41 });
        const err = new media.MediaError('process-failed', 'transcode 1080p: exit 1');
        onProgress({ stage: 'error', message: err.message });
        return Promise.reject(err);
      })}
      tab="upload"
      pendingFile={FILE}
      steps={PUBLISH}
    />
  ),
};

// ---- videos / analytics ----------------------------------------------------------------

export const Videos: Story = {
  name: 'Videos (populated)',
  render: () => <Screen adapter={storyAdapter()} tab="videos" />,
};

function noVideos(): mocks.MockNetworkAdapter {
  const a = storyAdapter();
  a.studio = { ...a.studio, myVideos: () => Promise.resolve({ items: [] }) };
  return a;
}

export const VideosEmpty: Story = {
  name: 'Videos — empty',
  render: () => <Screen adapter={noVideos()} tab="videos" />,
};

export const Analytics: Story = {
  name: 'Analytics (populated)',
  render: () => <Screen adapter={storyAdapter()} tab="analytics" />,
};

export const AnalyticsNoSeeders: Story = {
  name: 'Analytics — no seeders online',
  render: () => <Screen adapter={storyAdapter({ failWith: 'no-seeders' })} tab="analytics" />,
};

export const AnalyticsEmpty: Story = {
  name: 'Analytics — no videos yet',
  render: () => <Screen adapter={noVideos()} tab="analytics" />,
};

// ---- seeder ------------------------------------------------------------------------------

/** Adds two more bans to the mock's one, so the list shows the reason copy. */
function moreBans(opts: Options = {}): mocks.MockNetworkAdapter {
  const a = storyAdapter(opts);
  const base = a.seeder;
  const extra = [
    {
      pubkey: mocks.asPubkey('double-spender') as NostrPubkey,
      reason: 'double-spend',
      at: mocks.unix(NOW - 86_400 * 3),
    },
    {
      pubkey: mocks.asPubkey('replayer') as NostrPubkey,
      reason: 'range-already-paid',
      at: mocks.unix(NOW - 600),
    },
  ];
  a.seeder = {
    ...base,
    status: () => base.status().then((s) => ({ ...s, banned: [...extra, ...s.banned] })),
  };
  return a;
}

export const Seeder: Story = {
  name: 'Seeder (banned peers)',
  render: () => <Screen adapter={moreBans({ now: () => NOW })} tab="seeder" />,
};

export const SeederOff: Story = {
  name: 'Seeder — seeding off',
  render: () => <Screen adapter={storyAdapter({ seeding: false, now: () => NOW })} tab="seeder" />,
};

const INVOICE = `lnbc1500n1p${'q'.repeat(40)}sp5${'x'.repeat(30)}`;
const MELT: Step[] = [
  { fill: 'textarea.nf-studio__mono', value: INVOICE },
  { press: 'Review melt-out' },
];

export const SeederMeltConfirm: Story = {
  name: 'Seeder — melt-out confirm',
  parameters: { nf: { width: 1280 } },
  render: () => <Screen adapter={storyAdapter({ now: () => NOW })} tab="seeder" steps={MELT} />,
};

export const SeederMeltPaid: Story = {
  name: 'Seeder — melt-out paid',
  parameters: { nf: { width: 1280 } },
  render: () => (
    <Screen
      adapter={storyAdapter({ now: () => NOW })}
      tab="seeder"
      steps={[...MELT, { press: 'Melt out 1,500 sats' }]}
    />
  ),
};

export const SeederMeltNoBalance: Story = {
  name: 'Error — no balance (melt-out not paid)',
  parameters: { nf: { width: 1280 } },
  render: () => (
    <Screen
      adapter={storyAdapter({ failWith: 'no-balance', now: () => NOW })}
      tab="seeder"
      steps={[...MELT, { press: 'Melt out 1,500 sats' }]}
    />
  ),
};

// ---- shell slot --------------------------------------------------------------------------

export const WithMiniPlayer: Story = {
  name: 'With mini-player slot',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      tab="videos"
      miniPlayer={
        <div
          style={{
            width: 320,
            height: 180,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            background: '#0f0f0f',
          }}
        >
          mini-player
        </div>
      }
    />
  ),
};
