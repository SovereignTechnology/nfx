import type { Meta, StoryObj } from '@storybook/react-vite';
import { MINTS, sats } from '../../../.storybook/fixtures.js';
import { MintChip } from './MintChip.js';

const meta = {
  title: 'Components/MintChip',
  component: MintChip,
  parameters: { nf: { width: 560 } },
} satisfies Meta<typeof MintChip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {
  render: () => (
    <div className="nf-story-row">
      <MintChip mint={MINTS.a} status="ok" />
      <MintChip mint={MINTS.b} status="unreachable" balance={sats(0)} />
      <MintChip mint={MINTS.a} balance={sats(12400)} status="ok" size="sm" />
    </div>
  ),
};

export const Selectable: Story = {
  render: () => (
    <div className="nf-story-row">
      <MintChip
        mint={MINTS.a}
        status="ok"
        balance={sats(12400)}
        selected
        onSelect={() => undefined}
      />
      <MintChip mint={MINTS.b} status="ok" balance={sats(310)} onSelect={() => undefined} />
    </div>
  ),
};
