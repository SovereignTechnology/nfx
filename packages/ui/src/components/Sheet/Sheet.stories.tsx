import type { Meta, StoryObj } from '@storybook/react-vite';
import { MINTS, sats } from '../../../.storybook/fixtures.js';
import { Button } from '../Button/Button.js';
import { MintChip } from '../MintChip/MintChip.js';
import { Sheet } from './Sheet.js';

const meta = {
  title: 'Components/Sheet',
  component: Sheet,
  parameters: { nf: { width: 720 } },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = (
  <div className="nf-story-col">
    <p style={{ margin: 0 }}>Pick the mint to pay this video from.</p>
    <MintChip
      mint={MINTS.a}
      balance={sats(12400)}
      status="ok"
      selected
      onSelect={() => undefined}
    />
    <MintChip mint={MINTS.b} balance={sats(310)} status="ok" onSelect={() => undefined} />
  </div>
);

export const Right: Story = {
  args: {
    open: true,
    inline: true,
    title: 'Pay from',
    onClose: () => undefined,
    children: body,
    footer: (
      <>
        <Button variant="ghost">Cancel</Button>
        <Button variant="primary">Use this mint</Button>
      </>
    ),
  },
};

export const Bottom: Story = {
  args: { ...Right.args, side: 'bottom' },
};

export const Untitled: Story = {
  args: { open: true, inline: true, onClose: () => undefined, children: body },
};
