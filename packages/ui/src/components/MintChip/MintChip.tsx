import type { ReactElement } from 'react';
import type { MintUrl, Sats } from '@sovit/core';
import { Icon } from '../shared/Icon.js';
import { cx, formatSats, mintHost } from '../shared/format.js';

export type MintStatus = 'ok' | 'unreachable' | 'unknown';

export interface MintChipProps {
  readonly mint: MintUrl;
  /** Balance the wallet holds at this mint; omitted = not shown. */
  readonly balance?: Sats | undefined;
  readonly status?: MintStatus;
  /** Selected in a chooser (renders `aria-pressed`). */
  readonly selected?: boolean | undefined;
  /** Makes the chip a button. Without it the chip is static. */
  readonly onSelect?: ((mint: MintUrl) => void) | undefined;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

/**
 * A mint as a chip: host name, optional balance, reachability dot. Static `<span>` unless
 * `onSelect` is given, in which case it is a toggle button (Studio mint selection, Wallet).
 */
export function MintChip({
  mint,
  balance,
  status = 'unknown',
  selected,
  onSelect,
  size = 'md',
  className,
}: MintChipProps): ReactElement {
  const host = mintHost(mint);
  const statusText =
    status === 'ok' ? 'reachable' : status === 'unreachable' ? 'unreachable' : 'status unknown';
  const body = (
    <>
      <Icon name="coin" size={size === 'sm' ? 14 : 16} className="nf-mint__icon" />
      <span className="nf-mint__host">{host}</span>
      {balance !== undefined ? (
        <span className="nf-mint__balance">{formatSats(balance)}</span>
      ) : null}
      <span
        className={cx('nf-mint__status', `nf-mint__status--${status}`)}
        role="img"
        aria-label={statusText}
        title={statusText}
      />
    </>
  );
  const cls = cx(
    'nf-mint',
    `nf-mint--${size}`,
    selected && 'nf-mint--selected',
    onSelect && 'nf-mint--button',
    className,
  );
  if (onSelect) {
    return (
      <button
        type="button"
        className={cls}
        title={mint}
        aria-pressed={selected ?? false}
        onClick={() => {
          onSelect(mint);
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={mint}>
      {body}
    </span>
  );
}
