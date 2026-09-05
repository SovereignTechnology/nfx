import type { Meta, StoryObj } from '@storybook/react-vite';
import { NPUB, videoAt } from '../../../.storybook/fixtures.js';
import { Markdown } from './Markdown.js';

const meta = {
  title: 'Components/Markdown',
  component: Markdown,
  parameters: { nf: { width: 560 } },
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Description: Story = {
  args: {
    source:
      `${videoAt(0).description}\n\n` +
      `Chapters:\n0:00 intro\n2:14 the hose\n9:30 delta-v\n\n` +
      `Thanks to [Kilnfire](https://kilnfire.example) and nostr:${NPUB} for the footage. ` +
      `*Not* financial advice — __seriously__.`,
  },
};

export const NostrChipSlot: Story = {
  name: 'nostr: refs via renderNostr slot',
  args: {
    source: `Shout-out to nostr:${NPUB} and [Alice](nostr:${NPUB}).`,
    renderNostr: (ref) => (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 8px 0 2px',
          borderRadius: 999,
          background: 'var(--nf-color-bg-subtle)',
          fontWeight: 500,
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 999,
            background: 'hsl(210 50% 45%)',
            display: 'inline-block',
          }}
        />
        {ref.label ?? '@orbital'}
      </span>
    ),
  },
};

export const HostileInput: Story = {
  name: 'Hostile input stays text',
  args: {
    source:
      '<script>alert(1)</script> <img src=x onerror="alert(1)"> [click](javascript:alert(1)) ' +
      '&lt;b&gt;entities&lt;/b&gt; **bold stays bold** and https://example.com autolinks.',
  },
};
