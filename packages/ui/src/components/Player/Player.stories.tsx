import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { PEERS, durationOf, sats, videoAt } from '../../../.storybook/fixtures.js';
import { Player, type PlayerState } from './Player.js';
import type { PlayerAction } from './keyboard.js';

const video = videoAt(1); // 3 renditions, 2 sats/block
const media = <div className="nf-story-video" aria-hidden="true" />;

const base: PlayerState = {
  status: 'playing',
  currentTimeSec: 754,
  durationSec: durationOf(video),
  buffered: [
    { start: 0, end: 900 },
    { start: 1500, end: 1600 },
  ],
  paidThroughSec: 840,
  volume: 0.8,
  muted: false,
  playbackRate: 1,
  rendition: '720p',
  captions: 'off',
  pip: false,
  theater: false,
  fullscreen: false,
  mini: false,
  spend: { total: sats(412), ratePerMin: sats(12) },
};

const meta = {
  title: 'Components/Player',
  component: Player,
  parameters: { nf: { width: 800 } },
  args: {
    media,
    renditions: video.renditions,
    policy: video.price,
    title: video.title,
    peers: PEERS,
    autoHideMs: 0,
    onAction: () => undefined,
  },
} satisfies Meta<typeof Player>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playing: Story = { args: { state: base } };

export const Paused: Story = {
  args: { state: { ...base, status: 'paused' } },
};

export const Loading: Story = {
  args: {
    state: { ...base, status: 'loading', currentTimeSec: 0, paidThroughSec: 0, buffered: [] },
  },
};

export const Ended: Story = {
  args: { state: { ...base, status: 'ended', currentTimeSec: base.durationSec } },
};

export const Error: Story = {
  args: {
    state: {
      ...base,
      status: 'error',
      errorMessage: 'No seeders online for 720p — try another rendition.',
    },
  },
};

export const Muted: Story = {
  args: { state: { ...base, muted: true } },
};

export const CaptionsOn: Story = {
  args: { state: { ...base, captions: 'on' } },
};

export const Theater: Story = {
  parameters: { nf: { width: 960 } },
  args: { state: { ...base, theater: true } },
};

export const Fullscreen: Story = {
  args: { state: { ...base, fullscreen: true, pip: false } },
};

export const PictureInPicture: Story = {
  args: { state: { ...base, pip: true } },
};

export const Speed: Story = {
  name: 'Speed 1.5×',
  args: { state: { ...base, playbackRate: 1.5 } },
};

export const PeerPanel: Story = {
  name: 'Peer panel overlay',
  args: { state: base, showPeers: true },
};

export const MiniPlayer: Story = {
  parameters: { nf: { width: 440 } },
  args: { state: { ...base, mini: true } },
};

/** Opens the quality/speed menu by clicking the settings control after mount. */
export const RenditionMenu: Story = {
  name: 'Rendition menu (price difference)',
  args: { state: base },
  render: (args) => {
    const [state, setState] = useState<PlayerState>(args.state);
    const onAction = (a: PlayerAction): void => {
      if (a.type === 'set-rendition') setState({ ...state, rendition: a.label });
      if (a.type === 'set-rate') setState({ ...state, playbackRate: a.rate });
    };
    return (
      <div
        ref={(el) => {
          const btn = el?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
          if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
        }}
      >
        <Player {...args} state={state} onAction={onAction} />
      </div>
    );
  },
};

/** Live: every control dispatches into local state so the chrome can be exercised. */
export const Interactive: Story = {
  args: { state: { ...base, status: 'paused' } },
  render: (args) => {
    const [state, setState] = useState<PlayerState>(args.state);
    const [showPeers, setShowPeers] = useState(false);
    const onAction = (a: PlayerAction): void => {
      setState((s) => {
        switch (a.type) {
          case 'toggle-play':
            return { ...s, status: s.status === 'playing' ? 'paused' : 'playing' };
          case 'play':
            return { ...s, status: 'playing' };
          case 'pause':
            return { ...s, status: 'paused' };
          case 'seek':
            return { ...s, currentTimeSec: a.toSec };
          case 'set-volume':
            return { ...s, volume: a.volume, muted: false };
          case 'toggle-mute':
            return { ...s, muted: !s.muted };
          case 'set-rate':
            return { ...s, playbackRate: a.rate };
          case 'set-rendition':
            return { ...s, rendition: a.label };
          case 'toggle-captions':
            return { ...s, captions: s.captions === 'on' ? 'off' : 'on' };
          case 'toggle-pip':
            return { ...s, pip: !s.pip };
          case 'toggle-theater':
            return { ...s, theater: !s.theater };
          case 'toggle-fullscreen':
            return { ...s, fullscreen: !s.fullscreen };
          case 'toggle-mini':
            return { ...s, mini: !s.mini };
          case 'toggle-peers':
            setShowPeers((v) => !v);
            return s;
          case 'close':
            return { ...s, mini: false, status: 'paused' };
        }
      });
    };
    return <Player {...args} state={state} showPeers={showPeers} onAction={onAction} />;
  },
};
