import type { Meta, StoryObj } from '@storybook/react-vite';
import { PEERS, PEER_AVATARS, PEER_PROFILES, sats } from '../../../.storybook/fixtures.js';
import { PeerMeter } from './PeerMeter.js';

const meta = {
  title: 'Components/PeerMeter',
  component: PeerMeter,
  parameters: { nf: { width: 420 } },
} satisfies Meta<typeof PeerMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Streaming: Story = {
  args: {
    peers: PEERS,
    total: sats(751),
    ratePerMin: sats(28),
    profiles: PEER_PROFILES,
    avatarSrcs: PEER_AVATARS,
  },
};

export const Paused: Story = {
  args: { ...Streaming.args, paused: true },
};

export const NoSeeders: Story = {
  name: 'Empty (no seeders online)',
  args: { peers: [], total: sats(0), ratePerMin: sats(0) },
};

export const Loading: Story = {
  args: { peers: [], total: sats(0), ratePerMin: sats(0), loading: true },
};

export const Overlay: Story = {
  render: (args) => (
    <div className="nf-story-video" style={{ padding: 16, borderRadius: 12 }}>
      <PeerMeter {...args} />
    </div>
  ),
  args: { ...Streaming.args, variant: 'overlay', onClose: () => undefined },
};
