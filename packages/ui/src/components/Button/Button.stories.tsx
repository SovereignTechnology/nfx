import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, IconButton } from './Button.js';

const meta = {
  title: 'Components/Button',
  component: Button,
  parameters: { nf: { width: 560 } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="nf-story-row">
      <Button variant="primary">Subscribe</Button>
      <Button variant="secondary">Share</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="accent" icon="bolt">
        Nutzap
      </Button>
      <Button variant="danger">Report</Button>
      <Button variant="secondary" size="sm" icon="check">
        Small
      </Button>
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="nf-story-row">
      <Button variant="primary" pressed>
        Subscribed
      </Button>
      <Button variant="primary" loading>
        Subscribing
      </Button>
      <Button disabled>Disabled</Button>
      <Button icon="refresh" aria-label="Refresh" />
    </div>
  ),
};

export const Icons: Story = {
  render: () => (
    <div className="nf-story-row">
      <IconButton icon="search" label="Search" />
      <IconButton icon="moreVert" label="More" />
      <IconButton icon="captions" label="Captions" pressed />
      <IconButton icon="close" label="Close" size="sm" />
      <span
        style={{ background: '#000', padding: 8, borderRadius: 8, display: 'inline-flex', gap: 4 }}
      >
        <IconButton icon="play" label="Play" tone="overlay" size="lg" />
        <IconButton icon="settings" label="Settings" tone="overlay" size="lg" />
        <IconButton icon="fullscreen" label="Full screen" tone="overlay" size="lg" pressed />
      </span>
    </div>
  ),
};
