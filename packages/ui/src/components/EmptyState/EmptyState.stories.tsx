import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  EMPTY_STATE_PRESETS,
  EmptyState,
  ErrorState,
  type EmptyStatePreset,
} from './EmptyState.js';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  parameters: { nf: { width: 480 } },
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

const preset = (p: EmptyStatePreset): Story => ({
  args: { preset: p, onAction: 'action' in EMPTY_STATE_PRESETS[p] ? () => undefined : undefined },
});

export const NoBalanceAtMint = preset('no-balance-at-mint');
export const NoSeedersOnline = preset('no-seeders-online');
export const SignerNotDetected = preset('signer-not-detected');
export const NoVideos = preset('no-videos');
export const NoResults = preset('no-results');
export const NoSubscriptions = preset('no-subscriptions');
export const NoHistory = preset('no-history');
export const NoComments = preset('no-comments');

export const Compact: Story = {
  args: { preset: 'no-seeders-online', compact: true },
};

export const Error: Story = {
  render: () => (
    <ErrorState onRetry={() => undefined} detail="relay timed out (wss://relay.fixture.example)" />
  ),
};

export const ErrorCompact: Story = {
  render: () => (
    <ErrorState
      compact
      title="Could not load comments"
      description="The relay did not answer."
      onRetry={() => undefined}
    />
  ),
};
