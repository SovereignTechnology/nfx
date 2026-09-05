import type { ReactElement } from 'react';
import type { Sats } from '@sovit/core';
import { Icon } from '../shared/Icon.js';
import { cx, formatSats, formatSatsCompact } from '../shared/format.js';

export type SatsBadgeVariant =
  /** Price shown before playback ("from 1,240 sats"). */
  | 'price'
  /** Live streaming rate ("12 sats/min"). */
  | 'rate'
  /** Money that reached someone ("4,200 sats to creator"). */
  | 'earned'
  /** Plain figure, no colour. */
  | 'neutral';

export interface SatsBadgeProps {
  readonly sats: Sats | number;
  readonly variant?: SatsBadgeVariant;
  readonly size?: 'sm' | 'md';
  /** Prefix copy, e.g. "from". */
  readonly prefix?: string;
  /** Suffix copy, e.g. "to creator". `rate` adds "/min" by itself. */
  readonly suffix?: string;
  /** Compact number ("1.2k") for tight chips. */
  readonly compact?: boolean;
  /** Renders on top of video (thumbnail corner / player overlay). */
  readonly overlay?: boolean;
  readonly className?: string;
  /** Overrides the accessible text; default is the full "N sats …" string. */
  readonly label?: string;
}

/**
 * The one place a sats figure is rendered. Ordinary chip styling on purpose: the brief says
 * price is content in a mainstream layout, not a separate "crypto" visual language.
 */
export function SatsBadge({
  sats,
  variant = 'price',
  size = 'md',
  prefix,
  suffix,
  compact = false,
  overlay = false,
  className,
  label,
}: SatsBadgeProps): ReactElement {
  const number = compact ? formatSatsCompact(sats) : formatSats(sats);
  const unit = compact ? ' sats' : '';
  const rate = variant === 'rate' ? '/min' : '';
  const text = `${prefix ? `${prefix} ` : ''}${number}${unit}${rate}${suffix ? ` ${suffix}` : ''}`;
  return (
    <span
      className={cx(
        'nf-sats',
        `nf-sats--${variant}`,
        `nf-sats--${size}`,
        overlay && 'nf-sats--overlay',
        className,
      )}
      aria-label={label ?? text}
      title={label ?? text}
    >
      <Icon name="bolt" size={size === 'sm' ? 12 : 14} className="nf-sats__icon" />
      <span className="nf-sats__text" aria-hidden="true">
        {prefix ? <span className="nf-sats__prefix">{prefix} </span> : null}
        <span className="nf-sats__number">{number}</span>
        {unit ? <span className="nf-sats__unit">{unit}</span> : null}
        {rate ? <span className="nf-sats__unit">{rate}</span> : null}
        {suffix ? <span className="nf-sats__suffix"> {suffix}</span> : null}
      </span>
    </span>
  );
}
