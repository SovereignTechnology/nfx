import { describe, expect, it } from 'vitest';
import {
  KEYBOARD_MAP,
  PLAYBACK_RATES,
  isTextEntryTarget,
  keyboardAction,
  stepRate,
  type KeyboardState,
  type PlayerAction,
} from '../Player/keyboard.js';

const state: KeyboardState = {
  currentTimeSec: 100,
  durationSec: 600,
  volume: 0.5,
  playbackRate: 1,
};

const act = (key: string, extra: Partial<KeyboardState> = {}, init = {}): PlayerAction | null =>
  keyboardAction({ key, ...init }, { ...state, ...extra });

describe('player keyboard map (build-plan §6.2)', () => {
  it('space and k toggle play', () => {
    expect(act(' ')).toEqual({ type: 'toggle-play' });
    expect(act('k')).toEqual({ type: 'toggle-play' });
    expect(act('K')).toEqual({ type: 'toggle-play' });
  });

  it('j / l seek ±10 s, clamped to the media', () => {
    expect(act('j')).toEqual({ type: 'seek', toSec: 90 });
    expect(act('l')).toEqual({ type: 'seek', toSec: 110 });
    expect(act('j', { currentTimeSec: 4 })).toEqual({ type: 'seek', toSec: 0 });
    expect(act('l', { currentTimeSec: 595 })).toEqual({ type: 'seek', toSec: 600 });
  });

  it('f / m / t / i toggle fullscreen, mute, theater, mini-player', () => {
    expect(act('f')).toEqual({ type: 'toggle-fullscreen' });
    expect(act('m')).toEqual({ type: 'toggle-mute' });
    expect(act('t')).toEqual({ type: 'toggle-theater' });
    expect(act('i')).toEqual({ type: 'toggle-mini' });
  });

  it('< and > step the playback rate through the documented list', () => {
    expect(act('>')).toEqual({ type: 'set-rate', rate: 1.25 });
    expect(act('<')).toEqual({ type: 'set-rate', rate: 0.75 });
    expect(act('>', { playbackRate: 2 })).toEqual({ type: 'set-rate', rate: 2 });
    expect(act('<', { playbackRate: 0.25 })).toEqual({ type: 'set-rate', rate: 0.25 });
    // off-list rates snap to the nearest step
    expect(stepRate(1.1, 1)).toBe(1.5);
    expect(stepRate(1.1, -1)).toBe(1);
    expect(PLAYBACK_RATES).toContain(1);
  });

  it('0–9 seek to N × 10 % of the duration', () => {
    for (let n = 0; n <= 9; n++) {
      expect(act(String(n))).toEqual({ type: 'seek', toSec: 60 * n });
    }
    expect(act('5', { durationSec: 0 })).toBeNull();
    expect(act('5', { durationSec: Number.NaN })).toBeNull();
  });

  it('arrows: ±5 s and volume ±5 % (clamped); Home/End', () => {
    expect(act('ArrowLeft')).toEqual({ type: 'seek', toSec: 95 });
    expect(act('ArrowRight')).toEqual({ type: 'seek', toSec: 105 });
    expect(act('ArrowUp')).toEqual({ type: 'set-volume', volume: 0.55 });
    expect(act('ArrowDown')).toEqual({ type: 'set-volume', volume: 0.45 });
    expect(act('ArrowUp', { volume: 0.98 })).toEqual({ type: 'set-volume', volume: 1 });
    expect(act('ArrowDown', { volume: 0.02 })).toEqual({ type: 'set-volume', volume: 0 });
    expect(act('Home')).toEqual({ type: 'seek', toSec: 0 });
    expect(act('End')).toEqual({ type: 'seek', toSec: 600 });
  });

  it('c and p toggle captions and picture-in-picture', () => {
    expect(act('c')).toEqual({ type: 'toggle-captions' });
    expect(act('p')).toEqual({ type: 'toggle-pip' });
  });

  it('leaves modifier chords and unbound keys alone', () => {
    expect(act('k', {}, { ctrlKey: true })).toBeNull();
    expect(act('f', {}, { metaKey: true })).toBeNull();
    expect(act('m', {}, { altKey: true })).toBeNull();
    expect(act('x')).toBeNull();
    expect(act('Enter')).toBeNull();
    expect(act('Escape')).toBeNull();
  });

  it('the documented map covers every binding the brief names', () => {
    const text = KEYBOARD_MAP.map((k) => k.keys).join(' ');
    for (const k of ['Space', 'k', 'j', 'l', 'f', 'm', 't', 'i', '<', '>', '0–9']) {
      expect(text).toContain(k);
    }
  });

  it('isTextEntryTarget spots inputs the player must not hijack', () => {
    const text = document.createElement('input');
    const range = document.createElement('input');
    range.type = 'range';
    const ta = document.createElement('textarea');
    const div = document.createElement('div');
    expect(isTextEntryTarget(text)).toBe(true);
    expect(isTextEntryTarget(range)).toBe(false);
    expect(isTextEntryTarget(ta)).toBe(true);
    expect(isTextEntryTarget(div)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
