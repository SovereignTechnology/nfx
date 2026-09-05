import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { Sats } from '@sovit/core';
import { Player, type PlayerState } from '../Player/Player.js';
import type { PlayerAction } from '../Player/keyboard.js';
import { click, keydown, render } from '../testing/render.js';

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('fixture missing');
  return v;
}
const video = must(mocks.VIDEOS[1]);

const base: PlayerState = {
  status: 'playing',
  currentTimeSec: 100,
  durationSec: 600,
  buffered: [{ start: 0, end: 200 }],
  paidThroughSec: 150,
  volume: 0.5,
  muted: false,
  playbackRate: 1,
  rendition: '720p',
  captions: 'off',
  pip: false,
  theater: false,
  fullscreen: false,
  mini: false,
  spend: { total: 40 as Sats, ratePerMin: 4 as Sats },
};

function mount(state: PlayerState = base, extra: Record<string, unknown> = {}) {
  const onAction = vi.fn<(a: PlayerAction) => void>();
  const r = render(
    createElement(Player, {
      media: createElement('div', { 'data-testid': 'media' }),
      state,
      renditions: video.renditions,
      policy: video.price,
      title: video.title,
      onAction,
      autoHideMs: 0,
      ...extra,
    }),
  );
  return { r, onAction };
}

describe('Player chrome', () => {
  it('renders the media slot and a control for every documented function, each with a name', () => {
    const { r } = mount();
    expect(r.get('[data-testid="media"]')).toBeTruthy();
    const labels = r.all('button[aria-label]').map((b) => b.getAttribute('aria-label') ?? '');
    for (const needle of [
      'Pause',
      'Mute',
      'Settings',
      'Captions',
      'Mini-player',
      'Picture-in-picture',
      'Theater',
      'Full screen',
      'seeders',
    ]) {
      expect(
        labels.some((l) => l.includes(needle)),
        needle,
      ).toBe(true);
    }
    // every button in the chrome has an accessible name
    for (const b of r.all('button')) {
      expect(
        (b.getAttribute('aria-label') ?? b.textContent).trim().length,
        b.outerHTML,
      ).toBeGreaterThan(0);
    }
    expect(r.get('input[aria-label="Seek"]').getAttribute('aria-valuetext')).toBe('1:40 of 10:00');
    expect(r.get('input[aria-label="Volume"]').getAttribute('aria-valuetext')).toBe('50%');
    r.unmount();
  });

  it('dispatches keyboard actions from the documented map', () => {
    const { r, onAction } = mount();
    const region = r.get('[role="region"]');
    keydown(region, 'k');
    keydown(region, 'l');
    keydown(region, 'f');
    keydown(region, '5');
    keydown(region, '>');
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      { type: 'toggle-play' },
      { type: 'seek', toSec: 110 },
      { type: 'toggle-fullscreen' },
      { type: 'seek', toSec: 300 },
      { type: 'set-rate', rate: 1.25 },
    ]);
    r.unmount();
  });

  it('ignores keys typed into a text field inside the region', () => {
    const { r, onAction } = mount(base, {
      media: createElement('input', { type: 'text', 'data-testid': 'field' }),
    });
    keydown(r.get('[data-testid="field"]'), 'k');
    expect(onAction).not.toHaveBeenCalled();
    r.unmount();
  });

  it('buttons dispatch the matching actions', () => {
    const { r, onAction } = mount();
    click(r.get('button[aria-label="Pause (k)"]'));
    click(r.get('button[aria-label="Mute (m)"]'));
    click(r.get('button[aria-label="Theater mode (t)"]'));
    click(r.get('button[aria-label="Mini-player (i)"]'));
    click(r.get('button[aria-label="Show seeders"]'));
    expect(onAction.mock.calls.map((c) => c[0].type)).toEqual([
      'toggle-play',
      'toggle-mute',
      'toggle-theater',
      'toggle-mini',
      'toggle-peers',
    ]);
    r.unmount();
  });

  it('shows buffered and paid-so-far on the seek bar', () => {
    const { r } = mount();
    const w = (sel: string): number => Number.parseFloat(r.get(sel).style.width);
    expect(w('.nf-player__buffered')).toBeCloseTo(33.3, 0);
    expect(w('.nf-player__paid')).toBeCloseTo(25, 0);
    expect(w('.nf-player__played')).toBeCloseTo(16.7, 0);
    expect(r.container.textContent).toContain('paid to 2:30');
    r.unmount();
  });

  it('rendition menu lists every rendition with its price and the difference vs the current one', () => {
    const { r, onAction } = mount();
    click(r.get('button[aria-haspopup="menu"]'));
    const items = r
      .all('[role="menuitemradio"]')
      .filter((el) => el.classList.contains('nf-player__menu-item'));
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    const text = items.map((i) => i.textContent);
    expect(text[1]).toContain('720p');
    expect(text[0]).toMatch(/\+[\d,]+/); // 1080p costs more
    expect(text[2]).toMatch(/−[\d,]+/); // 360p costs less
    click(items[0]!);
    expect(onAction).toHaveBeenCalledWith({ type: 'set-rendition', label: '1080p' });
    expect(r.container.querySelector('[role="menu"]')).toBeNull();
    r.unmount();
  });

  it('speed menu dispatches set-rate', () => {
    const { r, onAction } = mount();
    click(r.get('button[aria-haspopup="menu"]'));
    const two = r.all('.nf-player__menu-rate').find((b) => b.textContent === '2×');
    click(two!);
    expect(onAction).toHaveBeenCalledWith({ type: 'set-rate', rate: 2 });
    r.unmount();
  });

  it('mini mode renders the compact chrome with expand and close', () => {
    const { r, onAction } = mount({ ...base, mini: true });
    expect(r.get('.nf-player').classList.contains('nf-player--mini')).toBe(true);
    click(r.get('button[aria-label="Expand player"]'));
    click(r.get('button[aria-label="Close player"]'));
    expect(onAction.mock.calls.map((c) => c[0].type)).toEqual(['toggle-mini', 'close']);
    expect(r.container.querySelector('button[aria-label="Theater mode (t)"]')).toBeNull();
    r.unmount();
  });

  it('error state shows the message and a retry that dispatches play', () => {
    const { r, onAction } = mount({ ...base, status: 'error', errorMessage: 'no seeders' });
    expect(r.get('[role="alert"]').textContent).toContain('no seeders');
    click(r.get('.nf-player__retry'));
    expect(onAction).toHaveBeenCalledWith({ type: 'play' });
    r.unmount();
  });

  it('captions control disappears when captions are unavailable; pressed states mirror state', () => {
    const { r } = mount({ ...base, captions: 'unavailable', theater: true, muted: true });
    expect(r.container.querySelector('button[aria-label^="Captions"]')).toBeNull();
    expect(r.get('button[aria-label="Default view (t)"]').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(r.get('button[aria-label="Unmute (m)"]').getAttribute('aria-pressed')).toBe('true');
    r.unmount();
  });

  it('peer panel overlay renders when showPeers with peers', () => {
    const peers = [{ pubkey: mocks.ME, sats: 10 as Sats, ratePerMin: 2 as Sats, blocks: 5 }];
    const { r, onAction } = mount(base, { peers, showPeers: true });
    expect(r.get('.nf-player__peers .nf-peers')).toBeTruthy();
    click(r.get('button[aria-label="Close peer panel"]'));
    expect(onAction).toHaveBeenCalledWith({ type: 'toggle-peers' });
    r.unmount();
  });
});
