/**
 * Player keyboard map (build-plan §6.2): space/k play-pause, j/l ±10 s, f fullscreen,
 * m mute, t theater, i mini-player, < > speed, 0-9 seek to N×10 %. Extras in the YouTube
 * idiom: ←/→ ±5 s, ↑/↓ volume ±5 %, c captions, p picture-in-picture, Home/End.
 *
 * Pure: `keyboardAction` maps a key + the current state to a resolved `PlayerAction`, so
 * the shell can also wire it to a document-level listener.
 */

export const PLAYBACK_RATES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const SEEK_STEP_SEC = 10;
export const ARROW_SEEK_STEP_SEC = 5;
export const VOLUME_STEP = 0.05;

export type PlayerAction =
  | { readonly type: 'toggle-play' }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  /** Absolute seek target in seconds (already clamped to `[0, duration]`). */
  | { readonly type: 'seek'; readonly toSec: number }
  /** Volume 0–1 (already clamped). */
  | { readonly type: 'set-volume'; readonly volume: number }
  | { readonly type: 'toggle-mute' }
  | { readonly type: 'set-rate'; readonly rate: number }
  | { readonly type: 'set-rendition'; readonly label: string }
  | { readonly type: 'toggle-captions' }
  | { readonly type: 'toggle-pip' }
  | { readonly type: 'toggle-theater' }
  | { readonly type: 'toggle-fullscreen' }
  | { readonly type: 'toggle-mini' }
  | { readonly type: 'toggle-peers' }
  /** Mini-player "close" (stop playback and dismiss). */
  | { readonly type: 'close' };

/** The slice of player state the keyboard map needs. */
export interface KeyboardState {
  readonly currentTimeSec: number;
  readonly durationSec: number;
  readonly volume: number;
  readonly playbackRate: number;
}

export interface KeyLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

function clampTime(sec: number, duration: number): number {
  const max = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(0, sec));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Next rate in `PLAYBACK_RATES` (or the nearest step when the current rate is off-list). */
export function stepRate(current: number, direction: 1 | -1): number {
  const idx = PLAYBACK_RATES.findIndex((r) => r >= current);
  const cur = idx === -1 ? PLAYBACK_RATES.length - 1 : idx;
  const next = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, cur + direction));
  return PLAYBACK_RATES[next] ?? 1;
}

/**
 * Maps a key event to an action, or `null` when the key is not bound. Any Ctrl/Alt/Meta
 * chord is left to the browser. Shift is only meaningful for `<`/`>` (already reflected in
 * `key`) — plain `k` and `K` are the same binding.
 */
export function keyboardAction(ev: KeyLike, state: KeyboardState): PlayerAction | null {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  const key = ev.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if (key === ' ' || key === 'Spacebar' || lower === 'k') return { type: 'toggle-play' };
  if (lower === 'j')
    return {
      type: 'seek',
      toSec: clampTime(state.currentTimeSec - SEEK_STEP_SEC, state.durationSec),
    };
  if (lower === 'l')
    return {
      type: 'seek',
      toSec: clampTime(state.currentTimeSec + SEEK_STEP_SEC, state.durationSec),
    };
  if (key === 'ArrowLeft')
    return {
      type: 'seek',
      toSec: clampTime(state.currentTimeSec - ARROW_SEEK_STEP_SEC, state.durationSec),
    };
  if (key === 'ArrowRight')
    return {
      type: 'seek',
      toSec: clampTime(state.currentTimeSec + ARROW_SEEK_STEP_SEC, state.durationSec),
    };
  if (key === 'Home') return { type: 'seek', toSec: 0 };
  if (key === 'End')
    return { type: 'seek', toSec: clampTime(state.durationSec, state.durationSec) };
  if (key === 'ArrowUp') return { type: 'set-volume', volume: clamp01(state.volume + VOLUME_STEP) };
  if (key === 'ArrowDown')
    return { type: 'set-volume', volume: clamp01(state.volume - VOLUME_STEP) };
  if (lower === 'f') return { type: 'toggle-fullscreen' };
  if (lower === 'm') return { type: 'toggle-mute' };
  if (lower === 't') return { type: 'toggle-theater' };
  if (lower === 'i') return { type: 'toggle-mini' };
  if (lower === 'c') return { type: 'toggle-captions' };
  if (lower === 'p') return { type: 'toggle-pip' };
  if (key === '<' || key === ',')
    return { type: 'set-rate', rate: stepRate(state.playbackRate, -1) };
  if (key === '>' || key === '.')
    return { type: 'set-rate', rate: stepRate(state.playbackRate, 1) };
  if (/^[0-9]$/.test(key)) {
    const pct = Number(key) / 10;
    if (!Number.isFinite(state.durationSec) || state.durationSec <= 0) return null;
    return { type: 'seek', toSec: clampTime(state.durationSec * pct, state.durationSec) };
  }
  return null;
}

/** Whether a keydown target is a text-entry element (the player should ignore those). */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(type);
  }
  // jsdom has no `isContentEditable`; the attribute check covers it there.
  const editable =
    (target as { isContentEditable?: boolean }).isContentEditable === true ||
    target.getAttribute('contenteditable') === 'true';
  return tag === 'TEXTAREA' || tag === 'SELECT' || editable;
}

/** Human-readable map for the "keyboard shortcuts" sheet / docs. */
export const KEYBOARD_MAP: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: 'Space / k', action: 'Play / pause' },
  { keys: 'j / l', action: 'Back / forward 10 seconds' },
  { keys: '← / →', action: 'Back / forward 5 seconds' },
  { keys: '↑ / ↓', action: 'Volume up / down' },
  { keys: '0–9', action: 'Seek to 0 %–90 %' },
  { keys: 'Home / End', action: 'Start / end' },
  { keys: 'm', action: 'Mute' },
  { keys: 'f', action: 'Fullscreen' },
  { keys: 't', action: 'Theater mode' },
  { keys: 'i', action: 'Mini-player' },
  { keys: 'c', action: 'Captions' },
  { keys: 'p', action: 'Picture-in-picture' },
  { keys: '< / >', action: 'Slower / faster' },
];
