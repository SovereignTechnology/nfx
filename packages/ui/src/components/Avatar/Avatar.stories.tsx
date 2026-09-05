import type { Meta, StoryObj } from '@storybook/react-vite';
import { CHANNELS, avatar, channelAt } from '../../../.storybook/fixtures.js';
import { Avatar, ProfileAvatar } from './Avatar.js';

const meta = {
  title: 'Components/Avatar',
  component: Avatar,
  parameters: { nf: { width: 420 } },
} satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

const c0 = channelAt(0);

export const Sizes: Story = {
  render: () => (
    <div className="nf-story-row">
      <ProfileAvatar profile={c0.profile} src={avatar(c0.pubkey)} size="sm" />
      <ProfileAvatar profile={c0.profile} src={avatar(c0.pubkey)} size="md" />
      <ProfileAvatar profile={c0.profile} src={avatar(c0.pubkey)} size="lg" />
      <ProfileAvatar profile={c0.profile} src={avatar(c0.pubkey)} size="xl" />
    </div>
  ),
};

export const Fallback: Story = {
  render: () => (
    <div className="nf-story-row">
      {CHANNELS.map((c) => (
        <ProfileAvatar key={c.pubkey} profile={c.profile} size="lg" />
      ))}
      <Avatar seed="anon" size="lg" />
    </div>
  ),
};
