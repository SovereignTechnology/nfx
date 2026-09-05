import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import type { PeerSpend, PricePolicy, Rendition, Sats } from '@sovit/core';
import { IconButton } from '../Button/Button.js';
import { PeerMeter } from '../PeerMeter/PeerMeter.js';
import { SatsBadge } from '../SatsBadge/SatsBadge.js';
import { Icon } from '../shared/Icon.js';
import { cx, formatDuration, formatInteger, renditionPriceSats } from '../shared/format.js';
import {
  PLAYBACK_RATES,
  isTextEntryTarget,
  keyboardAction,
  type PlayerAction,
} from './keyboard.js';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/** Everything the chrome shows. Owned by the screen/shell; the player never mutates it. */
export interface PlayerState {
  readonly status: PlayerStatus;
  readonly currentTimeSec: number;
  readonly durationSec: number;
  /** `<video>.buffered` as ranges. */
  readonly buffered: readonly TimeRange[];
  /** Seconds of media already paid for ("paid so far", build-plan §6.2 buffer = money). */
  readonly paidThroughSec: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly playbackRate: number;
  /** Current rendition label (matches `Rendition.label`). */
  readonly rendition: string;
  readonly captions: 'unavailable' | 'off' | 'on';
  readonly pip: boolean;
  readonly theater: boolean;
  readonly fullscreen: boolean;
  readonly mini: boolean;
  /** Live spend for the in-player chip (`PlaySession.onSpend`). */
  readonly spend?: { readonly total: Sats; readonly ratePerMin: Sats } | undefined;
  readonly errorMessage?: string | undefined;
}

export interface PlayerProps {
  /**
   * The media element slot — the shell's `<video>` (desktop: blob-server URL; web:
   * service-worker URL or MSE). The player renders chrome around it and never touches
   * playback or networking itself.
   */
  readonly media: ReactNode;
  readonly state: PlayerState;
  /** Renditions of the manifest, for the quality menu (with per-rendition price). */
  readonly renditions: readonly Rendition[];
  readonly policy: PricePolicy;
  /** Shown in mini mode and as the region label. */
  readonly title?: string | undefined;
  /** Peer panel overlay data (`PlaySession.onPeers`); shown when `showPeers`. */
  readonly peers?: readonly PeerSpend[] | undefined;
  readonly showPeers?: boolean;
  readonly onAction: (action: PlayerAction) => void;
  /** Hide controls after this idle time while playing; `0` keeps them visible. Default 3000. */
  readonly autoHideMs?: number;
  /** Ref to the outer element — the shell calls `requestFullscreen()` on it. */
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly className?: string;
}

function pct(sec: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (sec / duration) * 100));
}

function volumeIcon(volume: number, muted: boolean): 'volumeOff' | 'volumeDown' | 'volumeUp' {
  if (muted || volume <= 0) return 'volumeOff';
  return volume < 0.5 ? 'volumeDown' : 'volumeUp';
}

/**
 * Player chrome (build-plan §6.2). Controls: play/pause, seek (buffered + paid-so-far),
 * volume, quality menu with price difference per rendition, speed, captions, PiP, theater,
 * fullscreen, mini-player, peer panel. Every control has an accessible name; the keyboard
 * map lives in `keyboard.ts`.
 */
export function Player({
  media,
  state,
  renditions,
  policy,
  title,
  peers,
  showPeers = false,
  onAction,
  autoHideMs = 3000,
  ref,
  className,
}: PlayerProps): ReactElement {
  const [menu, setMenu] = useState<'none' | 'settings'>('none');
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const playing = state.status === 'playing';

  const poke = useCallback((): void => {
    setIdle(false);
    if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    if (autoHideMs > 0 && playing) {
      idleTimer.current = setTimeout(() => {
        setIdle(true);
      }, autoHideMs);
    }
  }, [autoHideMs, playing]);

  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current !== undefined) clearTimeout(idleTimer.current);
    };
  }, [poke]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextEntryTarget(e.target)) return;
    const onRange = e.target instanceof HTMLInputElement && e.target.type === 'range';
    if (onRange && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) return;
    if (e.key === 'Escape' && menu !== 'none') {
      setMenu('none');
      e.preventDefault();
      return;
    }
    const action = keyboardAction(e, state);
    if (!action) return;
    e.preventDefault();
    poke();
    onAction(action);
  };

  const current = renditions.find((r) => r.label === state.rendition);
  const currentPrice = current ? renditionPriceSats(current, policy) : undefined;
  const duration = state.durationSec;
  const hideControls = idle && playing && menu === 'none';
  const chromeHidden = state.mini ? false : hideControls;

  const seekChange = (e: ChangeEvent<HTMLInputElement>): void => {
    onAction({ type: 'seek', toSec: Number(e.target.value) });
  };
  const volumeChange = (e: ChangeEvent<HTMLInputElement>): void => {
    onAction({ type: 'set-volume', volume: Number(e.target.value) });
  };

  const statusLabel =
    state.status === 'error'
      ? 'Playback error'
      : state.status === 'loading'
        ? 'Loading'
        : state.status === 'ended'
          ? 'Ended'
          : playing
            ? 'Playing'
            : 'Paused';

  return (
    <div
      ref={ref}
      className={cx(
        'nf-player',
        `nf-player--${state.status}`,
        state.mini && 'nf-player--mini',
        state.theater && 'nf-player--theater',
        state.fullscreen && 'nf-player--fullscreen',
        chromeHidden && 'nf-player--idle',
        className,
      )}
      role="region"
      aria-label={title ? `Video player: ${title}` : 'Video player'}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={poke}
      onMouseLeave={() => {
        if (playing && autoHideMs > 0) setIdle(true);
      }}
      data-status={state.status}
    >
      <div className="nf-player__media">{media}</div>

      {/* Big centre affordance: play when paused/idle/ended, spinner when loading, error card. */}
      {state.status === 'loading' ? (
        <div className="nf-player__center" aria-live="polite">
          <span className="nf-player__spinner" role="img" aria-label="Loading" />
        </div>
      ) : state.status === 'error' ? (
        <div className="nf-player__center nf-player__center--error" role="alert">
          <Icon name="error" size={32} />
          <div className="nf-player__error-title">Playback stopped</div>
          {state.errorMessage ? (
            <div className="nf-player__error-desc">{state.errorMessage}</div>
          ) : null}
          <button
            type="button"
            className="nf-player__retry"
            onClick={() => {
              onAction({ type: 'play' });
            }}
          >
            <Icon name="refresh" size={18} /> Retry
          </button>
        </div>
      ) : !playing && !state.mini ? (
        <button
          type="button"
          className="nf-player__center nf-player__big-play"
          aria-label={state.status === 'ended' ? 'Replay' : 'Play'}
          onClick={() => {
            onAction({ type: 'toggle-play' });
          }}
        >
          <Icon name={state.status === 'ended' ? 'replay' : 'play'} size={40} />
        </button>
      ) : null}

      {state.mini ? (
        <div className="nf-player__mini-bar">
          <span className="nf-player__mini-title" title={title}>
            {title ?? ''}
          </span>
          <IconButton
            icon="expand"
            label="Expand player"
            tone="overlay"
            size="sm"
            onClick={() => {
              onAction({ type: 'toggle-mini' });
            }}
          />
          <IconButton
            icon="close"
            label="Close player"
            tone="overlay"
            size="sm"
            onClick={() => {
              onAction({ type: 'close' });
            }}
          />
        </div>
      ) : null}

      {showPeers && peers && !state.mini ? (
        <div className="nf-player__peers">
          <PeerMeter
            peers={peers}
            total={state.spend?.total ?? (0 as Sats)}
            ratePerMin={state.spend?.ratePerMin ?? (0 as Sats)}
            paused={!playing}
            variant="overlay"
            onClose={() => {
              onAction({ type: 'toggle-peers' });
            }}
          />
        </div>
      ) : null}

      <div className="nf-player__chrome" data-testid="player-chrome">
        <div className="nf-player__gradient" aria-hidden="true" />

        {/* Seek bar: buffered ranges, paid-so-far, played, plus the accessible range input. */}
        <div className="nf-player__seek" data-testid="seek">
          <div className="nf-player__track" aria-hidden="true">
            {state.buffered.map((r, i) => (
              <span
                key={i}
                className="nf-player__buffered"
                style={{
                  left: `${pct(r.start, duration)}%`,
                  width: `${pct(r.end - r.start, duration)}%`,
                }}
              />
            ))}
            <span
              className="nf-player__paid"
              style={{ width: `${pct(state.paidThroughSec, duration)}%` }}
              title={`Paid through ${formatDuration(state.paidThroughSec)}`}
            />
            <span
              className="nf-player__played"
              style={{ width: `${pct(state.currentTimeSec, duration)}%` }}
            />
            <span
              className="nf-player__thumb"
              style={{ left: `${pct(state.currentTimeSec, duration)}%` }}
            />
          </div>
          <input
            className="nf-player__seek-input"
            type="range"
            min={0}
            max={Number.isFinite(duration) && duration > 0 ? duration : 0}
            step={0.1}
            value={Math.min(state.currentTimeSec, duration > 0 ? duration : 0)}
            onChange={seekChange}
            aria-label="Seek"
            aria-valuetext={`${formatDuration(state.currentTimeSec)} of ${formatDuration(duration)}`}
          />
        </div>

        {state.mini ? (
          <div className="nf-player__bar nf-player__bar--mini">
            <IconButton
              icon={playing ? 'pause' : 'play'}
              label={playing ? 'Pause' : 'Play'}
              tone="overlay"
              onClick={() => {
                onAction({ type: 'toggle-play' });
              }}
            />
            <span className="nf-player__time">
              {formatDuration(state.currentTimeSec)} / {formatDuration(duration)}
            </span>
            {state.spend ? (
              <SatsBadge sats={state.spend.ratePerMin} variant="rate" size="sm" overlay />
            ) : null}
          </div>
        ) : (
          <div className="nf-player__bar">
            <div className="nf-player__group">
              <IconButton
                icon={state.status === 'ended' ? 'replay' : playing ? 'pause' : 'play'}
                label={state.status === 'ended' ? 'Replay' : playing ? 'Pause (k)' : 'Play (k)'}
                tone="overlay"
                size="lg"
                onClick={() => {
                  onAction({ type: 'toggle-play' });
                }}
              />
              <div className="nf-player__volume">
                <IconButton
                  icon={volumeIcon(state.volume, state.muted)}
                  label={state.muted ? 'Unmute (m)' : 'Mute (m)'}
                  tone="overlay"
                  size="lg"
                  pressed={state.muted}
                  onClick={() => {
                    onAction({ type: 'toggle-mute' });
                  }}
                />
                <input
                  className="nf-player__volume-input"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={state.muted ? 0 : state.volume}
                  onChange={volumeChange}
                  aria-label="Volume"
                  aria-valuetext={`${Math.round((state.muted ? 0 : state.volume) * 100)}%`}
                />
              </div>
              <span className="nf-player__time" aria-live="off">
                <span data-testid="current-time">{formatDuration(state.currentTimeSec)}</span>
                <span className="nf-player__time-sep"> / </span>
                <span>{formatDuration(duration)}</span>
              </span>
              <span className="nf-player__paid-label" title="Seconds of video already paid for">
                paid to {formatDuration(state.paidThroughSec)}
              </span>
            </div>

            <div className="nf-player__group nf-player__group--right">
              {state.spend ? (
                <span
                  className="nf-player__spend"
                  title={`${formatInteger(state.spend.total)} sats this session`}
                >
                  <SatsBadge
                    sats={state.spend.ratePerMin}
                    variant="rate"
                    size="sm"
                    overlay
                    label={`streaming ${formatInteger(state.spend.ratePerMin)} sats per minute, ${formatInteger(state.spend.total)} sats so far`}
                  />
                </span>
              ) : null}
              <IconButton
                icon="people"
                label={showPeers ? 'Hide seeders' : 'Show seeders'}
                tone="overlay"
                size="lg"
                pressed={showPeers}
                onClick={() => {
                  onAction({ type: 'toggle-peers' });
                }}
              />
              {state.captions !== 'unavailable' ? (
                <IconButton
                  icon="captions"
                  label={state.captions === 'on' ? 'Captions on (c)' : 'Captions off (c)'}
                  tone="overlay"
                  size="lg"
                  pressed={state.captions === 'on'}
                  onClick={() => {
                    onAction({ type: 'toggle-captions' });
                  }}
                />
              ) : null}
              <div className="nf-player__settings">
                <IconButton
                  icon="settings"
                  label="Settings: quality and speed"
                  tone="overlay"
                  size="lg"
                  aria-haspopup="menu"
                  aria-expanded={menu === 'settings'}
                  aria-controls={menuId}
                  onClick={() => {
                    setMenu(menu === 'settings' ? 'none' : 'settings');
                  }}
                />
                {menu === 'settings' ? (
                  <div
                    className="nf-player__menu"
                    role="menu"
                    id={menuId}
                    aria-label="Quality and speed"
                  >
                    <div className="nf-player__menu-title">
                      Quality
                      {currentPrice !== undefined ? (
                        <span className="nf-player__menu-hint">
                          current {formatInteger(currentPrice)} sats
                        </span>
                      ) : null}
                    </div>
                    {renditions.map((r) => {
                      const price = renditionPriceSats(r, policy);
                      const delta = currentPrice === undefined ? 0 : price - currentPrice;
                      const active = r.label === state.rendition;
                      return (
                        <button
                          key={r.label}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={cx(
                            'nf-player__menu-item',
                            active && 'nf-player__menu-item--active',
                          )}
                          onClick={() => {
                            setMenu('none');
                            if (!active) onAction({ type: 'set-rendition', label: r.label });
                          }}
                        >
                          <span className="nf-player__menu-check">
                            {active ? <Icon name="check" size={16} /> : null}
                          </span>
                          <span className="nf-player__menu-label">
                            {r.label}
                            {r.width !== undefined && r.height !== undefined ? (
                              <span className="nf-player__menu-sub">
                                {r.width}×{r.height}
                              </span>
                            ) : null}
                          </span>
                          <span className="nf-player__menu-price">
                            {formatInteger(price)} sats
                            {!active && delta !== 0 ? (
                              <span
                                className={cx(
                                  'nf-player__menu-delta',
                                  delta > 0
                                    ? 'nf-player__menu-delta--up'
                                    : 'nf-player__menu-delta--down',
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
                    <div className="nf-player__menu-title">Speed</div>
                    <div className="nf-player__menu-rates">
                      {PLAYBACK_RATES.map((rate) => (
                        <button
                          key={rate}
                          type="button"
                          role="menuitemradio"
                          aria-checked={rate === state.playbackRate}
                          className={cx(
                            'nf-player__menu-rate',
                            rate === state.playbackRate && 'nf-player__menu-rate--active',
                          )}
                          onClick={() => {
                            setMenu('none');
                            onAction({ type: 'set-rate', rate });
                          }}
                        >
                          {rate === 1 ? 'Normal' : `${rate}×`}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <IconButton
                icon="miniPlayer"
                label="Mini-player (i)"
                tone="overlay"
                size="lg"
                onClick={() => {
                  onAction({ type: 'toggle-mini' });
                }}
              />
              <IconButton
                icon="pip"
                label={state.pip ? 'Exit picture-in-picture (p)' : 'Picture-in-picture (p)'}
                tone="overlay"
                size="lg"
                pressed={state.pip}
                onClick={() => {
                  onAction({ type: 'toggle-pip' });
                }}
              />
              <IconButton
                icon={state.theater ? 'theaterExit' : 'theater'}
                label={state.theater ? 'Default view (t)' : 'Theater mode (t)'}
                tone="overlay"
                size="lg"
                pressed={state.theater}
                onClick={() => {
                  onAction({ type: 'toggle-theater' });
                }}
              />
              <IconButton
                icon={state.fullscreen ? 'fullscreenExit' : 'fullscreen'}
                label={state.fullscreen ? 'Exit full screen (f)' : 'Full screen (f)'}
                tone="overlay"
                size="lg"
                pressed={state.fullscreen}
                onClick={() => {
                  onAction({ type: 'toggle-fullscreen' });
                }}
              />
            </div>
          </div>
        )}
      </div>
      <span className="nf-player__sr" aria-live="polite">
        {statusLabel}
      </span>
    </div>
  );
}
