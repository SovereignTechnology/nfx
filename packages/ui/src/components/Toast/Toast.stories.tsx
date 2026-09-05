import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastStack } from './Toast.js';

const meta = {
  title: 'Components/Toast',
  component: ToastStack,
  parameters: { nf: { width: 420 } },
} satisfies Meta<typeof ToastStack>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Tones: Story = {
  args: {
    inline: true,
    onDismiss: () => undefined,
    toasts: [
      { id: '1', tone: 'info', title: 'Saved to Watch later', durationMs: 0 },
      { id: '2', tone: 'success', title: 'Subscribed to Orbital Mechanics', durationMs: 0 },
      {
        id: '3',
        tone: 'sats',
        title: '21 sats sent',
        description: 'Nutzap to Kilnfire Ceramics',
        durationMs: 0,
      },
      {
        id: '4',
        tone: 'error',
        title: 'Payment failed',
        description: 'No balance at mint.fixture-b.example',
        action: { label: 'Top up', onClick: () => undefined },
      },
    ],
  },
};

export const WithAction: Story = {
  args: {
    inline: true,
    onDismiss: () => undefined,
    toasts: [
      {
        id: '1',
        tone: 'info',
        title: 'Removed from history',
        action: { label: 'Undo', onClick: () => undefined },
        durationMs: 0,
      },
    ],
  },
};
