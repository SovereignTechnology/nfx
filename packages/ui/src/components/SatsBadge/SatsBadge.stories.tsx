import type { Meta, StoryObj } from '@storybook/react-vite';
import { SatsBadge } from './SatsBadge.js';

const meta = {
  title: 'Components/SatsBadge',
  component: SatsBadge,
  parameters: { nf: { width: 520 } },
} satisfies Meta<typeof SatsBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Price: Story = {
  render: () => (
    <div className="nf-story-row">
      <SatsBadge sats={1} />
      <SatsBadge sats={1240} prefix="from" />
      <SatsBadge sats={1240} compact size="sm" />
      <SatsBadge sats={125000} compact />
    </div>
  ),
};

export const Rate: Story = {
  render: () => (
    <div className="nf-story-row">
      <SatsBadge sats={12} variant="rate" />
      <SatsBadge sats={12} variant="rate" size="sm" />
      <SatsBadge sats={0} variant="rate" />
    </div>
  ),
};

export const Earned: Story = {
  render: () => (
    <div className="nf-story-row">
      <SatsBadge sats={4200} variant="earned" suffix="to creator" />
      <SatsBadge sats={91} variant="neutral" />
    </div>
  ),
};

export const Overlay: Story = {
  render: () => (
    <div className="nf-story-row" style={{ background: '#333', padding: 12, borderRadius: 8 }}>
      <SatsBadge sats={1240} overlay compact size="sm" prefix="from" />
      <SatsBadge sats={12} variant="rate" overlay size="sm" />
    </div>
  ),
};
