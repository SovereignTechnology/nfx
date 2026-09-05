import type { ReactElement } from 'react';
import type { NostrPubkey, PeerSpend, Profile, Sats } from '@sovit/core';
import { Avatar } from '../Avatar/Avatar.js';
import { EmptyState } from '../EmptyState/EmptyState.js';
import { SatsBadge } from '../SatsBadge/SatsBadge.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { Icon } from '../shared/Icon.js';
import { cx, formatInteger, formatSats, shortPubkey } from '../shared/format.js';

export interface PeerMeterProps {
  /** Live per-seeder spend from `PlaySession.onPeers`. */
  readonly peers: readonly PeerSpend[];
  /** Live totals from `PlaySession.onSpend`. */
  readonly total: Sats;
  readonly ratePerMin: Sats;
  /** Optional profiles for seeders that have one (name/avatar); keyed by pubkey. */
  readonly profiles?: ReadonlyMap<NostrPubkey, Profile> | undefined;
  /** Resolved avatar URLs keyed by pubkey. */
  readonly avatarSrcs?: ReadonlyMap<NostrPubkey, string> | undefined;
  /** Paused = not paying; the meter says so instead of showing a dead rate. */
  readonly paused?: boolean;
  /** Still connecting: shows a skeleton list instead of the empty state. */
  readonly loading?: boolean;
  /** `panel` = standalone card (Watch sidebar / Sheet); `overlay` = on top of the video. */
  readonly variant?: 'panel' | 'overlay';
  readonly onClose?: (() => void) | undefined;
  readonly className?: string;
}

function latencyTone(ms: number | undefined): 'good' | 'ok' | 'slow' | 'unknown' {
  if (ms === undefined) return 'unknown';
  if (ms < 120) return 'good';
  if (ms < 400) return 'ok';
  return 'slow';
}

/**
 * The peer panel (build-plan §6.2): who you are paying and how fast, as a ranked list with
 * proportional bars — not a debug table. Rows are sorted by sats/min; the bar is relative to
 * the fastest peer so the shape reads at a glance.
 */
export function PeerMeter({
  peers,
  total,
  ratePerMin,
  profiles,
  avatarSrcs,
  paused = false,
  loading = false,
  variant = 'panel',
  onClose,
  className,
}: PeerMeterProps): ReactElement {
  const sorted = [...peers].sort((a, b) => b.ratePerMin - a.ratePerMin || b.sats - a.sats);
  const max = sorted.reduce((m, p) => Math.max(m, p.ratePerMin), 0);
  const blocks = sorted.reduce((n, p) => n + p.blocks, 0);

  return (
    <section
      className={cx('nf-peers', `nf-peers--${variant}`, paused && 'nf-peers--paused', className)}
      aria-label="Seeders you are paying"
      aria-busy={loading || undefined}
    >
      <header className="nf-peers__head">
        <div className="nf-peers__title">
          <Icon name="people" size={20} />
          <span>
            {sorted.length === 0
              ? 'Seeders'
              : `${formatInteger(sorted.length)} seeder${sorted.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="nf-peers__totals">
          {paused ? (
            <span className="nf-peers__paused-label">Paused · not paying</span>
          ) : (
            <SatsBadge sats={ratePerMin} variant="rate" size="sm" />
          )}
          <span className="nf-peers__total" title={`${formatInteger(blocks)} blocks so far`}>
            {formatSats(total)} so far
          </span>
        </div>
        {onClose ? (
          <button
            type="button"
            className="nf-peers__close"
            aria-label="Close peer panel"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </header>

      {loading ? (
        <ul className="nf-peers__list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="nf-peers__row">
              <Skeleton variant="circle" width={28} height={28} />
              <div className="nf-peers__main">
                <Skeleton variant="text" width="45%" height={12} />
                <Skeleton variant="text" width="100%" height={6} />
              </div>
              <Skeleton variant="text" width={56} height={12} />
            </li>
          ))}
        </ul>
      ) : sorted.length === 0 ? (
        <EmptyState preset="no-seeders-online" compact />
      ) : (
        <ol className="nf-peers__list">
          {sorted.map((p) => {
            const profile = profiles?.get(p.pubkey);
            const name = profile?.displayName ?? profile?.name ?? shortPubkey(p.pubkey);
            const width = max > 0 ? (p.ratePerMin / max) * 100 : 0;
            const tone = latencyTone(p.latencyMs);
            return (
              <li key={p.pubkey} className="nf-peers__row">
                <Avatar
                  name={profile?.displayName ?? profile?.name}
                  seed={p.pubkey}
                  src={avatarSrcs?.get(p.pubkey)}
                  size="sm"
                />
                <div className="nf-peers__main">
                  <div className="nf-peers__line">
                    <span className="nf-peers__name" title={p.pubkey}>
                      {name}
                    </span>
                    <span
                      className={cx('nf-peers__latency', `nf-peers__latency--${tone}`)}
                      title={p.latencyMs === undefined ? 'latency unknown' : `${p.latencyMs} ms`}
                    >
                      {p.latencyMs === undefined ? '—' : `${p.latencyMs} ms`}
                    </span>
                  </div>
                  <div
                    className="nf-peers__bar"
                    role="meter"
                    aria-label={`${name}: ${formatSats(p.ratePerMin)} per minute`}
                    aria-valuemin={0}
                    aria-valuemax={max}
                    aria-valuenow={p.ratePerMin}
                  >
                    <span className="nf-peers__fill" style={{ width: `${width.toFixed(1)}%` }} />
                  </div>
                </div>
                <div className="nf-peers__figures">
                  <span className="nf-peers__rate">
                    {paused ? '0' : formatInteger(p.ratePerMin)}
                    <span className="nf-peers__unit"> sats/min</span>
                  </span>
                  <span className="nf-peers__paid">
                    {formatInteger(p.sats)} sats · {formatInteger(p.blocks)} blk
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
