import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton, SkeletonLines } from './Skeleton.js';

const meta = {
  title: 'Components/Skeleton',
  component: Skeleton,
  parameters: { nf: { width: 420 } },
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Shapes: Story = {
  render: () => (
    <div className="nf-story-col">
      <Skeleton variant="block" aspectRatio="16 / 9" />
      <div className="nf-story-row">
        <Skeleton variant="circle" />
        <div style={{ flex: 1 }}>
          <SkeletonLines lines={3} />
        </div>
      </div>
    </div>
  ),
};
