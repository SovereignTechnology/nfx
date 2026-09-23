/**
 * Watch — presentational pieces of the stage: the price panel (with the pre-play quality
 * picker), the autoplay-next countdown, the peer panel overlay and the "playing elsewhere"
 * note. Props in, callbacks out; no adapter calls here.
 */
import { useId, useRef, useState, type ReactElement } from 'react';
import type {
  MintUrl,
  NostrPubkey,
  PeerSpend,
  PricePolicy,
  Profile,
  Rendition,
  Sats,
  VideoManifest,
} from '@sovit/core';
import {
  Button,
  Icon,
  MintChip,
  PeerMeter,
  SatsBadge,
  cx,
  formatInteger,
  renditionPriceSats,
  type IconName,
} from '../../components/index.js';
import { safePlaceholder, type RenditionQuote } from './model.js';

function priceLabel(quote: RenditionQuote): string {
  return `${formatInteger(quote.sats)} sats at ${quote.label}`;
}

export interface PricePanelProps {
  /** Price of the rendition that plays (or is playing). */
  readonly quote: RenditionQuote | undefined;
  readonly renditions: readonly Rendition[];
  readonly policy: PricePolicy;
  /** Pre-play only: choose the rendition (and so the price). Omitted = label only. */
  readonly onChoose?: ((label: string) => void) | undefined;
  /** Mint chips, shown pre-play (T8: the mint is part of the purchase decision). */
  readonly mints?: readonly MintUrl[] | undefined;
  /**
   * A session is live: the chip row then shows the price and rendition only — the real
   * spend (`onSpend`) is in the streaming chip, and an estimate beside it would contradict it.
   */
  readonly live?: boolean | undefined;
}

/**
 * The price, always the FIRST thing in the stage's DOM (before any play affordance): the
 * whole-video price at the rendition that will play, that rendition's label (a menu before
 * playback, with every rendition's price and the difference), the per-minute rate and the
 * creator's mints.
 */
export function PricePanel({
  quote,
  renditions,
  policy,
  onChoose,
  mints,
  live = false,
}: PricePanelProps): ReactElement | null {
  if (quote === undefined) return null;
  return (
    <div className="nf-watch__stage-price" role="group" aria-label="Price">
      <SatsBadge sats={quote.sats} variant="price" overlay label={`Price ${priceLabel(quote)}`} />
      {onChoose !== undefined && renditions.length > 1 ? (
        <QualityPicker
          renditions={renditions}
          policy={policy}
          selected={quote.label}
          onChoose={onChoose}
        />
      ) : (
        <span className="nf-watch__quality-label">{quote.label}</span>
      )}
      {!live && quote.ratePerMin > 0 ? (
        <span className="nf-watch__rate-hint">≈ {formatInteger(quote.ratePerMin)} sats/min</span>
      ) : null}
      {mints !== undefined && mints.length > 0 ? (
        <span className="nf-watch__stage-mints">
          {mints.map((m) => (
            <MintChip key={m} mint={m} size="sm" />
          ))}
        </span>
      ) : null}
    </div>
  );
}

interface QualityPickerProps {
  readonly renditions: readonly Rendition[];
  readonly policy: PricePolicy;
  readonly selected: string;
  readonly onChoose: (label: string) => void;
}

/** Pre-play rendition menu: label, size, price and "+N / −N" against the selected one. */
function QualityPicker({
  renditions,
  policy,
  selected,
  onChoose,
}: QualityPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLSpanElement | null>(null);
  const current = renditions.find((r) => r.label === selected);
  const currentPrice = current === undefined ? undefined : renditionPriceSats(current, policy);
  return (
    <span
      className="nf-watch__quality"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      onBlur={(e) => {
        const next: EventTarget | null = e.relatedTarget;
        if (!(next instanceof Node) || wrap.current?.contains(next) !== true) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="nf-watch__quality-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Quality ${selected} — change quality and price`}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        {selected}
        <Icon name="chevronRight" size={16} className="nf-watch__quality-caret" />
      </button>
      {open ? (
        <div className="nf-watch__quality-menu" role="menu" id={menuId} aria-label="Quality">
          {renditions.map((r) => {
            const price = renditionPriceSats(r, policy);
            const delta = currentPrice === undefined ? 0 : price - currentPrice;
            const active = r.label === selected;
            return (
              <button
                key={r.label}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={cx('nf-watch__quality-item', active && 'nf-watch__quality-item--active')}
                onClick={() => {
                  setOpen(false);
                  onChoose(r.label);
                }}
              >
                <span className="nf-watch__quality-check">
                  {active ? <Icon name="check" size={16} /> : null}
                </span>
                <span className="nf-watch__quality-name">
                  {r.label}
                  {r.width !== undefined && r.height !== undefined ? (
                    <span className="nf-watch__quality-sub">
                      {r.width}×{r.height}
                    </span>
                  ) : null}
                </span>
                <span className="nf-watch__quality-price">
                  {formatInteger(price)} sats
                  {!active && delta !== 0 ? (
                    <span
                      className={cx(
                        'nf-watch__quality-delta',
                        delta > 0 ? 'nf-watch__quality-delta--up' : 'nf-watch__quality-delta--down',
                      )}
                    >
                      {delta > 0 ? '+' : '−'}
                      {formatInteger(Math.abs(delta))}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

export interface UpNextOverlayProps {
  readonly video: VideoManifest;
  readonly quote: RenditionQuote;
  readonly channelName: string;
  readonly thumbSrc: string | undefined;
  readonly secondsLeft: number;
  readonly totalSeconds: number;
  readonly from: 'playlist' | 'related';
  readonly onCancel: () => void;
  readonly onPlayNow: () => void;
}

/**
 * Autoplay-next (build-plan §6.2): the next video, ITS price at the rendition that will play
 * (DOM order: price before "Play now"), a countdown, Cancel.
 */
export function UpNextOverlay({
  video,
  quote,
  channelName,
  thumbSrc,
  secondsLeft,
  totalSeconds,
  from,
  onCancel,
  onPlayNow,
}: UpNextOverlayProps): ReactElement {
  const placeholder = safePlaceholder(video);
  const pct = totalSeconds > 0 ? Math.max(0, Math.min(100, (secondsLeft / totalSeconds) * 100)) : 0;
  return (
    <div className="nf-watch__upnext" role="alertdialog" aria-modal="false" aria-label="Up next">
      <div className="nf-watch__upnext-card">
        <p className="nf-watch__upnext-kicker">
          {from === 'playlist' ? 'Next in playlist' : 'Up next'} in{' '}
          <span className="nf-watch__upnext-count">{secondsLeft}</span> s
        </p>
        <div className="nf-watch__upnext-video">
          <span className="nf-watch__upnext-thumb">
            {thumbSrc !== undefined ? (
              <img src={thumbSrc} alt="" />
            ) : placeholder !== undefined ? (
              <img src={placeholder} alt="" />
            ) : null}
          </span>
          <span className="nf-watch__upnext-meta">
            <span className="nf-watch__upnext-title">{video.title}</span>
            <span className="nf-watch__upnext-channel">{channelName}</span>
          </span>
        </div>
        <div className="nf-watch__upnext-price">
          <SatsBadge
            sats={quote.sats}
            variant="price"
            overlay
            label={`Next video costs ${priceLabel(quote)}`}
          />
          <span className="nf-watch__quality-label">{quote.label}</span>
          {quote.ratePerMin > 0 ? (
            <span className="nf-watch__rate-hint">
              ≈ {formatInteger(quote.ratePerMin)} sats/min
            </span>
          ) : null}
        </div>
        <div className="nf-watch__upnext-bar" aria-hidden="true">
          <span className="nf-watch__upnext-fill" style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
        <div className="nf-watch__upnext-actions">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" icon="play" onClick={onPlayNow}>
            Play now
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface PeerOverlayProps {
  readonly peers: readonly PeerSpend[];
  readonly spend: { readonly total: Sats; readonly ratePerMin: Sats } | undefined;
  readonly paused: boolean;
  /** Session live but no `onPeers` report yet. */
  readonly loading: boolean;
  readonly profiles: ReadonlyMap<NostrPubkey, Profile>;
  readonly avatars: ReadonlyMap<NostrPubkey, string>;
  readonly policy: PricePolicy;
  readonly rendition: string;
  readonly onClose: () => void;
}

function blockSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0)
    return `${String(bytes / 1024 / 1024)} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${String(bytes / 1024)} KiB`;
  return `${formatInteger(bytes)} B`;
}

/**
 * The peer panel (build-plan §6.2 "your differentiator; make it pretty, not a debug view"):
 * L4's `PeerMeter` ranked bars with the seeders' names and avatars resolved, plus one line
 * that explains the tariff in words.
 */
export function PeerOverlay({
  peers,
  spend,
  paused,
  loading,
  profiles,
  avatars,
  policy,
  rendition,
  onClose,
}: PeerOverlayProps): ReactElement {
  return (
    <div className="nf-watch__peers">
      <PeerMeter
        peers={peers}
        total={spend?.total ?? (0 as Sats)}
        ratePerMin={paused ? (0 as Sats) : (spend?.ratePerMin ?? (0 as Sats))}
        profiles={profiles}
        avatarSrcs={avatars}
        paused={paused}
        loading={loading}
        variant="overlay"
        onClose={onClose}
        className="nf-watch__peers-meter"
      />
      <p className="nf-watch__peers-foot">
        <Icon name="bolt" size={14} />
        <span>
          {formatInteger(policy.satsPerBlock)} {policy.satsPerBlock === 1 ? 'sat' : 'sats'} per{' '}
          {blockSizeLabel(policy.blockSize)} block at {rendition} · {policy.split.seeder}% to
          seeders, {policy.split.creator}% to the creator
        </span>
      </p>
    </div>
  );
}

export interface StageNoteProps {
  readonly icon: IconName;
  readonly title: string;
  readonly children?: string | undefined;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}

/** A calm centred note on the black stage ("Playing in the mini-player"). */
export function StageNote({ icon, title, children, action }: StageNoteProps): ReactElement {
  return (
    <div className="nf-watch__stage-note" role="status">
      <Icon name={icon} size={32} />
      <p className="nf-watch__stage-note-title">{title}</p>
      {children !== undefined ? <p className="nf-watch__stage-note-sub">{children}</p> : null}
      {action !== undefined ? (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
