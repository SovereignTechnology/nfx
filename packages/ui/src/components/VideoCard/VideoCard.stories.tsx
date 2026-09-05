import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  NOW,
  VIDEOS,
  avatar,
  channelFor,
  durationOf,
  thumbnail,
  videoAt,
  withPlaceholder,
} from '../../../.storybook/fixtures.js';
import { VideoCard, VideoCardSkeleton } from './VideoCard.js';

const meta = {
  title: 'Components/VideoCard',
  component: VideoCard,
  parameters: { nf: { width: 360 } },
} satisfies Meta<typeof VideoCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const v0 = videoAt(0);
const v1 = videoAt(1);
const short = videoAt(4);

export const Default: Story = {
  args: {
    video: v0,
    channel: channelFor(v0),
    thumbnailSrc: thumbnail(v0),
    avatarSrc: avatar(v0.author),
    stats: { paidViews: 1284 },
    now: NOW,
  },
};

export const MultiplePrices: Story = {
  name: 'Multiple renditions (from price)',
  args: {
    video: v1,
    channel: channelFor(v1),
    thumbnailSrc: thumbnail(v1),
    avatarSrc: avatar(v1.author),
    stats: { paidViews: 96 },
    now: NOW,
  },
};

export const BlurUp: Story = {
  name: 'Blur-up placeholder (image loading)',
  args: {
    video: withPlaceholder(v0),
    channel: channelFor(v0),
    avatarSrc: avatar(v0.author),
    now: NOW,
  },
};

export const WatchedProgress: Story = {
  args: {
    ...Default.args,
    progress: 0.62,
  },
};

export const NoChannelRow: Story = {
  name: 'Channel page (no channel row)',
  args: {
    ...Default.args,
    hideChannel: true,
  },
};

export const Short: Story = {
  parameters: { nf: { width: 220 } },
  args: {
    video: short,
    channel: channelFor(short),
    thumbnailSrc: thumbnail(short, 360, 640),
    avatarSrc: avatar(short.author),
    stats: { paidViews: 4021 },
    now: NOW,
  },
};

export const ListLayout: Story = {
  parameters: { nf: { width: 420 } },
  args: {
    ...Default.args,
    layout: 'list',
  },
};

export const Skeleton: Story = {
  render: () => <VideoCardSkeleton />,
};

export const Grid: Story = {
  parameters: { nf: { width: 760 } },
  render: () => (
    <div className="nf-story-grid">
      {VIDEOS.slice(0, 4).map((v) => (
        <VideoCard
          key={v.id}
          video={v}
          channel={channelFor(v)}
          thumbnailSrc={thumbnail(v)}
          avatarSrc={avatar(v.author)}
          stats={{ paidViews: 7 + durationOf(v) }}
          now={NOW}
        />
      ))}
    </div>
  ),
};
