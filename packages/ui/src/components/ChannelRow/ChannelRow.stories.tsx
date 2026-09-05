import type { Meta, StoryObj } from '@storybook/react-vite';
import { avatar, channelAt, sats } from '../../../.storybook/fixtures.js';
import { ChannelRow, ChannelRowSkeleton } from './ChannelRow.js';

const meta = {
  title: 'Components/ChannelRow',
  component: ChannelRow,
  parameters: { nf: { width: 640 } },
} satisfies Meta<typeof ChannelRow>;
export default meta;
type Story = StoryObj<typeof meta>;

const verifiedSeeder = channelAt(0);
const plain = channelAt(2);

export const Default: Story = {
  args: {
    profile: verifiedSeeder.profile,
    avatarSrc: avatar(verifiedSeeder.pubkey),
    subscribed: false,
    subscribers: 12800,
    satsToCreator: sats(48210),
    seedingVideos: 3,
  },
};

export const Subscribed: Story = {
  args: { ...Default.args, subscribed: true },
};

export const Busy: Story = {
  name: 'Subscribing (busy)',
  args: { ...Default.args, busy: true },
};

export const Unverified: Story = {
  name: 'No NIP-05, no seeder, no avatar',
  args: {
    profile: plain.profile,
    subscribed: false,
    subscribers: 41,
  },
};

export const ChannelHeader: Story = {
  name: 'Channel page header (lg)',
  parameters: { nf: { width: 760 } },
  args: { ...Default.args, size: 'lg' },
};

export const Skeleton: Story = {
  render: () => <ChannelRowSkeleton />,
};
