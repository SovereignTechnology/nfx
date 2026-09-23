/**
 * `WalletChip` — the persistent header chip (build-plan §6.1 row "Wallet"): balance, plus
 * "streaming X sats/min" while a video plays. Presentational only: the SHELL owns the header
 * and feeds it (total of `adapter.wallet.balances()`, kept live with `wallet.onChange`
 * `balance` events; `satsPerMin` from `PlaySession.onSpend`'s `ratePerMin` while playing).
 * Built from L4 pieces only (`SatsBadge`, `Icon`, `Skeleton`); styles in Wallet.css.
 */
import type { ReactElement } from 'react';
import type { Sats } from '@sovit/core';
import { Icon, SatsBadge, Skeleton, cx, formatSats } from '../../components/index.js';

export interface WalletChipProps {
  /** Total balance across mints; `undefined` while it loads (renders a skeleton). */
  readonly balance: Sats | number | undefined;
  /** Current spend rate while playing; omitted/0 = not streaming (the rate is hidden). */
  readonly satsPerMin?: Sats | number | undefined;
  /** Usually `navigate({ name: 'wallet' })`. Without it the chip is static. */
  readonly onClick?: (() => void) | undefined;
  readonly className?: string | undefined;
}

/** Full figures up to 9,999; compact ("12k") above, so the header never jumps in width. */
const COMPACT_FROM = 10_000;

export function walletChipLabel(
  balance: Sats | number | undefined,
  satsPerMin?: Sats | number,
): string {
  const parts = [
    balance === undefined ? 'Wallet: loading balance' : `Wallet: ${formatSats(balance)}`,
  ];
  if (satsPerMin !== undefined && satsPerMin > 0)
    parts.push(`streaming ${formatSats(satsPerMin)}/min`);
  return parts.join(', ');
}

export function WalletChip({
  balance,
  satsPerMin,
  onClick,
  className,
}: WalletChipProps): ReactElement {
  const streaming = satsPerMin !== undefined && satsPerMin > 0;
  const label = walletChipLabel(balance, satsPerMin);
  const body = (
    <>
      <Icon name="wallet" size={20} className="nf-walletchip__icon" />
      {balance === undefined ? (
        <Skeleton variant="text" width={64} className="nf-walletchip__skeleton" />
      ) : (
        <SatsBadge
          sats={balance}
          variant="neutral"
          compact={balance >= COMPACT_FROM}
          className="nf-walletchip__balance"
        />
      )}
      {streaming ? (
        <SatsBadge
          sats={satsPerMin}
          variant="rate"
          size="sm"
          prefix="streaming"
          className="nf-walletchip__rate"
        />
      ) : null}
    </>
  );
  const cls = cx(
    'nf-walletchip',
    streaming && 'nf-walletchip--streaming',
    onClick && 'nf-walletchip--button',
    className,
  );
  if (onClick) {
    return (
      <button type="button" className={cls} aria-label={label} title={label} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <span className={cls} role="group" aria-label={label} title={label}>
      {body}
    </span>
  );
}
