/**
 * Watch screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, price-before-play DOM ordering, the PlaySession lifecycle
 * (prefetch / peers / spend / pause / resume / switchRendition / close), the mini-player
 * handshake, library resume + progress every ~5 s, report/nutzap, comments, and
 * cancellation on unmount.
 */
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NostrEventId, PlaySession, VideoManifest } from '@sovit/core';
import { click, fire, keydown, render, type Rendered } from '../../../components/testing/render.js';
import { formatInteger, renditionPriceSats } from '../../../components/index.js';
import type { Route } from '../../shared/route.js';
import { Watch, type WatchProps } from '../Watch.js';
import {
  buildCommentThreads as buildThreads,
  describeWatchError as describeError,
  playErrorKind,
  resumePositionSec,
  safePlaceholder,
} from '../model.js';

const { MockNetworkAdapter, VIDEOS, CHANNELS, fixtureComments } = mocks;

/** VIDEOS[1]: 'Raku firing at night' — two mints, not subscribed, already liked. */
const VIDEO = VIDEOS[1]!;
const NEXT_AFTER = ((): NostrEventId => {
  // Deterministic stand-in so autoplay-next tests know the next kind-21 in the rail.
  const v = VIDEOS[8]!; // 'Centering 5 kg on the wheel' — same channel, same tags.
  return v.id;
})();

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** Same settle pass for suites running on fake timers. */
async function flushFake(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(1);
  });
}

interface MountResult {
  readonly r: Rendered;
  readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>>;
}

function mount(
  adapter: mocks.MockNetworkAdapter,
  props: Partial<Omit<WatchProps, 'adapter' | 'navigate'>> = {},
): MountResult {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(
    createElement(Watch, {
      adapter,
      navigate,
      now: mocks.FIXTURE_NOW,
      videoId: VIDEO.id,
      ...props,
    }),
  );
  return { r, navigate };
}

/** Sets a controlled input's value the way React likes (native setter + input event). */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  // Native prototype setter applied to the element — `el.value = …` is valueTracker-visible.
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value);
  fire(el, new Event('input', { bubbles: true }));
}

interface SpiedSession {
  readonly session: PlaySession;
  readonly close: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
  readonly switchRendition: ReturnType<typeof vi.fn>;
}

/**
 * Intercepts `adapter.play`: every PlaySession the screen gets carries spied lifecycle
 * methods, so tests can assert pause/close without touching the mock's internals.
 */
function wrapPlay(adapter: mocks.MockNetworkAdapter): {
  readonly adapter: mocks.MockNetworkAdapter;
  readonly sessions: SpiedSession[];
} {
  const sessions: SpiedSession[] = [];
  const proxied = new Proxy(adapter, {
    get(target, prop, receiver): unknown {
      if (prop === 'play') {
        return (id: NostrEventId, rendition?: string): Promise<PlaySession> =>
          target.play(id, rendition).then((session) => {
            const spied: SpiedSession = {
              session,
              close: vi.fn(() => session.close()),
              pause: vi.fn(() => {
                session.pause();
              }),
              resume: vi.fn(() => {
                session.resume();
              }),
              switchRendition: vi.fn((label: string) => session.switchRendition(label)),
            };
            sessions.push(spied);
            return {
              ...session,
              close: spied.close as () => Promise<void>,
              pause: spied.pause as () => void,
              resume: spied.resume as () => void,
              switchRendition: spied.switchRendition as (label: string) => Promise<PlaySession>,
            };
          });
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { adapter: proxied, sessions };
}

let mediaPlaySpy: MockInstance<() => Promise<void>>;
let mediaPauseSpy: MockInstance<() => void>;

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
  // jsdom has no media pipeline: its play()/pause() only log "not implemented".
  mediaPlaySpy = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(() => Promise.resolve());
  mediaPauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

function keep(r: Rendered): Rendered {
  rendered.push(r);
  return r;
}

function playButton(r: Rendered): HTMLElement {
  const b = r
    .all('button[aria-label]')
    .find((el) => el.getAttribute('aria-label')?.startsWith('Play'));
  if (!b) throw new Error('no play affordance');
  return b;
}

async function pressPlay(r: Rendered): Promise<void> {
  click(playButton(r));
  await flush();
}

describe('Watch — structure and loading', () => {
  it('renders landmark, hidden h1, skeletons and aria-busy while loading', () => {
    const { r } = mount(new MockNetworkAdapter({ latencyMs: 5000 }));
    keep(r);
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.all('h1')).toHaveLength(1);
    expect(r.get('.nf-watch__stage-skeleton')).toBeTruthy();
    expect(r.all('.nf-card--skeleton').length).toBeGreaterThan(0);
    expect(r.get('.nf-watch').getAttribute('aria-busy')).toBe('true');
  });

  it('loads the populated page: title, channel row, actions, description, comments, related', async () => {
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    expect(r.get('h1.nf-watch__title').textContent).toBe(VIDEO.title);
    // Channel row: Kilnfire Ceramics, NIP-05 shown, not subscribed yet, earnings badge.
    expect(r.get('.nf-channel').textContent).toContain(CHANNELS[1]!.profile.displayName);
    expect(r.get('.nf-channel__actions').textContent).toContain('to creator');
    expect(r.get('.nf-channel__actions button').textContent).toBe('Subscribe');
    // Description through Markdown (bold parsed, never raw HTML).
    const strong = r.get('.nf-watch__desc .nf-md strong');
    expect(strong.textContent).toBeTruthy();
    // Comments: fixture count for this video, threaded; count named in the heading.
    expect(r.get('.nf-watch__comments-title').textContent).toContain('comments');
    expect(r.all('.nf-watch__comment').length).toBeGreaterThan(0);
    // Sidebar: up to RELATED_COUNT related cards, each with its own price.
    const cards = r.all('.nf-watch__related-list .nf-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(8);
    expect(cards[0]!.querySelector('.nf-sats--price')).toBeTruthy();
  });

  it('the description box expands on demand and never renders raw HTML', async () => {
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    const toggle = r.get('.nf-watch__desc-toggle');
    expect(toggle.textContent).toBe('…more');
    click(toggle);
    expect(r.get('.nf-watch__desc-toggle').textContent).toBe('Show less');
    expect(r.get('.nf-watch__desc').classList.contains('nf-watch__desc--open')).toBe(true);
    expect(r.get('.nf-watch__desc .nf-md a').getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('Watch — price before play', () => {
  it('renders the price badge before the play affordance (DOM order)', async () => {
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    const price = r.get('.nf-watch__stage-price .nf-sats--price');
    const play = playButton(r);
    expect(price.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('keeps the price before the player chrome once a session is live', async () => {
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    await pressPlay(r);
    const price = r.get('.nf-watch__stage-price .nf-sats--price');
    const pause = r.get('button[aria-label="Pause (k)"]');
    expect(price.compareDocumentPosition(pause) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows the price on every gate; no play affordance exists behind a gate', async () => {
    for (const failWith of ['no-signer', 'no-seeders', 'no-balance'] as const) {
      const { r } = mount(new MockNetworkAdapter({ failWith }));
      keep(r);
      await flush();
      expect(r.get('.nf-watch__stage-price .nf-sats--price')).toBeTruthy();
      expect(
        r.all('button[aria-label]').some((b) => b.getAttribute('aria-label')?.startsWith('Play —')),
      ).toBe(false);
    }
  });
});

describe('Watch — playback lifecycle (PlaySession)', () => {
  it('starts a session: prefetch set, peers + spend wired, progress recorded every ~5 s', async () => {
    vi.useFakeTimers();
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const record = vi.spyOn(wrapped.adapter.library, 'recordProgress');
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    expect(wrapped.sessions).toHaveLength(1);
    expect(r.get('.nf-player[data-status="playing"]')).toBeTruthy();
    // The session ticks at 1 Hz; after ~11 s we need recordProgress at ~5 s and ~10 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_200);
    });
    expect(record.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of record.mock.calls) expect(call[0]).toBe(VIDEO.id);
    expect(record.mock.calls[0]![1]).toBe(5);
    expect(record.mock.calls[1]![1]).toBe(10);
    // Spend chip in the actions row: the mock pays 8 blocks/s at 2 sats/block ⇒ 960 sats/min.
    const rate = r.get('.nf-watch__actions .nf-sats--rate');
    expect(rate.getAttribute('aria-label')).toContain('960 sats per minute');
    // Peer panel wiring: onPeers data reaches the PeerMeter.
    click(r.get('button[aria-label="Show seeders"]'));
    expect(r.all('.nf-peers__row')).toHaveLength(2);
  });

  it('pause() stops paying and the UI says so; resume() restarts it', async () => {
    vi.useFakeTimers();
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(wrapped.sessions).toHaveLength(1);
    click(r.get('button[aria-label="Pause (k)"]'));
    await flushFake();
    expect(wrapped.sessions[0]!.pause).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-watch__paystate').textContent).toContain('Paused — not paying');
    expect(r.get('.nf-watch__paystate').textContent).toContain('sats so far');
    // While paused the in-player spend chip reads 0 sats/min — visibly not paying.
    expect(r.get('.nf-player .nf-sats--rate').getAttribute('aria-label')).toContain(
      '0 sats per minute',
    );
    click(r.get('button[aria-label="Play (k)"]'));
    await flushFake();
    expect(wrapped.sessions[0]!.resume).toHaveBeenCalledTimes(1);
    expect(r.all('.nf-watch__paystate')).toHaveLength(0);
  });

  it('switchRendition changes quality with the price shown; the old session is closed', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    expect(wrapped.sessions).toHaveLength(1);
    // Open the settings menu and pick 720p — the menu shows the price delta per rendition.
    click(r.get('button[aria-label="Settings: quality and speed"]'));
    const item = r.all('[role="menuitemradio"]').find((b) => b.textContent.includes('720p'))!;
    expect(item.textContent).toContain('sats');
    click(item);
    await flush();
    expect(wrapped.sessions[0]!.switchRendition).toHaveBeenCalledWith('720p');
    expect(wrapped.sessions[0]!.close).toHaveBeenCalledTimes(1);
    // The player's quality menu now has 720p checked.
    click(r.get('button[aria-label="Settings: quality and speed"]'));
    expect(r.get('[role="menuitemradio"][aria-checked="true"]').textContent).toContain('720p');
  });

  it('closes the session on unmount', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    await flush();
    await pressPlay(r);
    expect(wrapped.sessions).toHaveLength(1);
    r.unmount();
    await flush();
    expect(wrapped.sessions[0]!.close).toHaveBeenCalledTimes(1);
  });
});

describe('Watch — mini-player handshake', () => {
  it('with onMiniPlayer the shell takes the session; unmount must NOT close it', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const onMiniPlayer = vi.fn();
    const { r } = mount(wrapped.adapter, { onMiniPlayer });
    await flush();
    await pressPlay(r);
    expect(wrapped.sessions).toHaveLength(1);
    click(r.get('button[aria-label="Mini-player (i)"]'));
    await flush();
    expect(onMiniPlayer).toHaveBeenCalledTimes(1);
    const [handedSession, handedId] = onMiniPlayer.mock.calls[0] as [PlaySession, NostrEventId];
    expect(handedId).toBe(VIDEO.id);
    expect(handedSession.videoId).toBe(VIDEO.id);
    expect(handedSession.rendition).toBe('1080p');
    expect(r.get('.nf-watch__stage').textContent).toContain('Playing in the mini-player');
    r.unmount();
    await flush();
    expect(wrapped.sessions[0]!.close).not.toHaveBeenCalled();
  });

  it('without onMiniPlayer the mini chrome renders in place; close stops playback', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    click(r.get('button[aria-label="Mini-player (i)"]'));
    await flush();
    expect(r.get('.nf-watch__mini .nf-player--mini')).toBeTruthy();
    click(r.get('.nf-watch__mini button[aria-label="Close player"]'));
    await flush();
    expect(wrapped.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(r.all('.nf-watch__mini')).toHaveLength(0);
    expect(playButton(r)).toBeTruthy();
  });
});

describe('Watch — autoplay next', () => {
  it('counts down with the next video’s price; Cancel stops it', async () => {
    vi.useFakeTimers();
    const { r, navigate } = mount(new MockNetworkAdapter());
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    fire(r.get('video'), new Event('ended'));
    await flushFake();
    const overlay = r.get('.nf-watch__upnext');
    expect(overlay.textContent).toContain('Up next in');
    expect(overlay.querySelector('.nf-sats--price')).toBeTruthy();
    expect(overlay.textContent).toContain('Play now');
    click([...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
    await flushFake();
    expect(r.all('.nf-watch__upnext')).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('when the countdown finishes it navigates and starts the next video (price was shown)', async () => {
    vi.useFakeTimers();
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const playSpy = vi.spyOn(wrapped.adapter, 'play');
    const { r, navigate } = mount(wrapped.adapter);
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    fire(r.get('video'), new Event('ended'));
    await flushFake();
    expect(r.get('.nf-watch__upnext')).toBeTruthy();
    // The countdown chain re-arms per tick: step it one second at a time.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await flushFake();
    expect(navigate).toHaveBeenCalledWith({ name: 'watch', videoId: NEXT_AFTER });
    expect(playSpy.mock.calls.map((c) => c[0])).toEqual([VIDEO.id, NEXT_AFTER]);
  });
});

describe('Watch — empty and error states', () => {
  it('not-found: designed empty state with a way back to Home', async () => {
    const { r, navigate } = mount(new MockNetworkAdapter(), {
      videoId: mocks.asEventId('nope'),
    });
    keep(r);
    await flush();
    const status = r.get('[role="status"]');
    expect(status.textContent).toContain('Video not found');
    click(status.querySelector('button')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home' });
  });

  it('relay-down: ErrorState with detail, Retry refetches, nothing thrown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new MockNetworkAdapter({ failWith: 'relay-down' });
    const video = vi.spyOn(adapter, 'video');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    expect(video).toHaveBeenCalledTimes(1);
    click(alert.querySelector('button')!);
    await flush();
    expect(video).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('no-signer: the stage gates playback behind the signer preset; the page stays readable', async () => {
    const { r, navigate } = mount(new MockNetworkAdapter({ failWith: 'no-signer' }));
    keep(r);
    await flush();
    expect(r.get('.nf-watch__stage--gate [role="status"]').getAttribute('data-preset')).toBe(
      'signer-not-detected',
    );
    expect(r.get('h1.nf-watch__title').textContent).toBe(VIDEO.title);
    const cta = r.all('button').find((b) => b.textContent === 'Connect signer')!;
    click(cta);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
  });

  it('no-seeders: the stage gate names the state and offers Retry', async () => {
    const { r } = mount(new MockNetworkAdapter({ failWith: 'no-seeders' }));
    keep(r);
    await flush();
    expect(r.get('.nf-watch__stage--gate [role="status"]').getAttribute('data-preset')).toBe(
      'no-seeders-online',
    );
  });

  it('no-balance: the stage gate offers the wallet route', async () => {
    const { r, navigate } = mount(new MockNetworkAdapter({ failWith: 'no-balance' }));
    keep(r);
    await flush();
    expect(r.get('.nf-watch__stage--gate [role="status"]').getAttribute('data-preset')).toBe(
      'no-balance-at-mint',
    );
    click(r.all('.nf-watch__stage--gate button').find((b) => b.textContent === 'Top up')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'wallet' });
  });
});

describe('Watch — navigation and actions', () => {
  it('related cards navigate to watch/shorts; the channel row navigates to the channel', async () => {
    const { r, navigate } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    const card = r.get('.nf-watch__related .nf-card');
    const title = card.getAttribute('aria-label');
    const target = VIDEOS.find((v) => v.title === title)!;
    click(card.querySelector('.nf-card__thumb')!);
    expect(navigate).toHaveBeenLastCalledWith(
      target.kind === 22
        ? { name: 'shorts', videoId: target.id }
        : { name: 'watch', videoId: target.id },
    );
    click(r.get('.nf-channel__name'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: VIDEO.author });
  });

  it('like toggles through adapter.react; subscribe through adapter.subscribe', async () => {
    const adapter = new MockNetworkAdapter();
    const react = vi.spyOn(adapter, 'react');
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    click(r.get('button[aria-label="Remove your like"]')); // VIDEO is pre-liked
    await flush();
    expect(react).toHaveBeenCalledWith(VIDEO.id, '-');
    click(r.get('.nf-channel__actions button'));
    await flush();
    expect(subscribe).toHaveBeenCalledWith(VIDEO.author);
    expect(r.get('.nf-channel__actions button').textContent).toBe('Subscribed');
  });

  it('nutzap: MintChips with balances, price badge before the send button, adapter called', async () => {
    const adapter = new MockNetworkAdapter();
    const nutzap = vi.spyOn(adapter, 'nutzap');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    click(r.all('button').find((b) => b.textContent === 'Nutzap')!);
    await flush();
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('Nutzap');
    const chips = dialog.querySelectorAll('.nf-mint');
    expect(chips).toHaveLength(2);
    expect(dialog.querySelector('.nf-mint--selected')).toBeTruthy();
    const badge = dialog.querySelector('.nf-sats--price')!;
    const send = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send nutzap',
    )!;
    expect(badge.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    click(send);
    await flush();
    expect(nutzap).toHaveBeenCalledWith(VIDEO.id, 21, mocks.MINTS.a);
    expect(r.get('.nf-toast').textContent).toContain('Nutzap sent');
  });

  it('nutzap sheet: a custom amount overrides the presets and reaches the adapter', async () => {
    const adapter = new MockNetworkAdapter();
    const nutzap = vi.spyOn(adapter, 'nutzap');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    click(r.all('button').find((b) => b.textContent === 'Nutzap')!);
    await flush();
    setValue(r.get('[role="dialog"] input[type="number"]') as HTMLInputElement, '250');
    await flush();
    click(
      [...r.get('[role="dialog"]').querySelectorAll('button')].find(
        (b) => b.textContent === 'Send nutzap',
      )!,
    );
    await flush();
    expect(nutzap).toHaveBeenCalledWith(VIDEO.id, 250, mocks.MINTS.a);
  });

  it('no-balance: the send button is disabled and the sheet offers the wallet route', async () => {
    const adapter = new MockNetworkAdapter({ failWith: 'no-balance' });
    const nutzap = vi.spyOn(adapter, 'nutzap');
    const { r, navigate } = mount(adapter);
    keep(r);
    await flush();
    // No balance gate guards the poster; nutzap still opens (the wallet has 0 everywhere).
    click(r.all('button').find((b) => b.textContent === 'Nutzap')!);
    await flush();
    const dialog = r.get('[role="dialog"]');
    const send = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Send nutzap',
    )!;
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(dialog.querySelector('[data-preset="no-balance-at-mint"]')).toBeTruthy();
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Top up')!);
    await flush();
    expect(navigate).toHaveBeenLastCalledWith({ name: 'wallet' });
    expect(nutzap).not.toHaveBeenCalled();
  });

  it('report flows from the overflow menu and calls adapter.report', async () => {
    const adapter = new MockNetworkAdapter();
    const report = vi.spyOn(adapter, 'report');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    click(r.get('button[aria-label="More actions"]'));
    click(r.all('[role="menuitem"]').find((b) => b.textContent === 'Report video')!);
    await flush();
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('Report video');
    click(
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Spam or misleading')!,
    );
    await flush();
    expect(report).toHaveBeenCalledWith(VIDEO.id, 'spam');
    expect(r.get('.nf-toast').textContent).toContain('Report sent');
  });
});

describe('Watch — comments', () => {
  it('sorts new/top and posts a comment that lands in the thread', async () => {
    const adapter = new MockNetworkAdapter();
    const comments = vi.spyOn(adapter, 'comments');
    const comment = vi.spyOn(adapter, 'comment');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    expect(comments).toHaveBeenCalledWith(VIDEO.id, 'new');
    click(r.all('button').find((b) => b.textContent === 'Top')!);
    await flush();
    expect(comments).toHaveBeenCalledWith(VIDEO.id, 'top');
    setValue(r.get('textarea[id*="comment"]') as HTMLTextAreaElement, 'A **fine** pot.');
    click(
      r.all('button').find((b) => b.textContent === 'Comment' && b.closest('.nf-watch__composer'))!,
    );
    await flush();
    expect(comment).toHaveBeenCalledWith(VIDEO.id, 'A **fine** pot.', undefined);
    const list = r.get('.nf-watch__comment-list');
    expect(list.textContent).toContain('A ');
    expect([...list.querySelectorAll('strong')].some((s) => s.textContent === 'fine')).toBe(true);
  });

  it('one reply level: reply composer posts with the root comment as parent', async () => {
    const adapter = new MockNetworkAdapter();
    const comment = vi.spyOn(adapter, 'comment');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    const thread = r.get('.nf-watch__thread');
    click(
      [...thread.querySelectorAll('button')]
        .filter((b) => b.closest('.nf-watch__comment--reply') === null)
        .find((b) => b.textContent === 'Reply')!,
    );
    setValue(thread.querySelector('textarea')!, 'reply text');
    click(
      [...thread.querySelectorAll('.nf-watch__composer--reply button')].find(
        (b) => b.textContent === 'Reply',
      )!,
    );
    await flush();
    const rootId = buildThreads(fixtureComments(VIDEO.id))[0]!.root.id;
    expect(comment).toHaveBeenCalledWith(VIDEO.id, 'reply text', rootId);
  });

  it('signed-out: the composer becomes a sign-in call to action', async () => {
    const { r, navigate } = mount(new MockNetworkAdapter({ signedIn: false }));
    keep(r);
    await flush();
    expect(r.all('textarea')).toHaveLength(0);
    click(r.all('.nf-watch__comments button').find((b) => b.textContent === 'Connect signer')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
  });
});

describe('Watch — resume and cancellation', () => {
  it('resumes from library history and says so on the poster', async () => {
    const adapter = new MockNetworkAdapter();
    await adapter.library.recordProgress(VIDEO.id, 100);
    const { r } = mount(adapter);
    keep(r);
    await flush();
    expect(r.get('.nf-watch__resume').textContent).toBe('Resume from 1:40');
  });

  it('a route `t` deep link beats history', async () => {
    const adapter = new MockNetworkAdapter();
    await adapter.library.recordProgress(VIDEO.id, 100);
    const { r } = mount(adapter, { startAtSec: 42 });
    keep(r);
    await flush();
    expect(r.get('.nf-watch__resume').textContent).toBe('Resume from 0:42');
  });

  it('unmounting mid-load cancels everything without state updates or console errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    const adapter = new MockNetworkAdapter({ latencyMs: 1000 });
    const image = vi.spyOn(adapter, 'image');
    const balances = vi.spyOn(adapter.wallet, 'balances');
    const { r } = mount(adapter);
    // Unmount before any mock call resolves (latency is 1000 ms): every follow-up —
    // the bootstrapping fetches, thumbnails, stats — must silently die with the screen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    r.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(image).not.toHaveBeenCalled();
    expect(balances).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('Watch — pure helpers', () => {
  it('buildThreads keeps one reply level and drops nothing', () => {
    const items = fixtureComments(VIDEO.id);
    const threads = buildThreads(items);
    const replies = threads.reduce((n, t) => n + t.replies.length, 0);
    expect(threads.length + replies).toBe(items.length);
    expect(replies).toBe(items.filter((c) => c.parent !== undefined).length);
    for (const t of threads) {
      for (let i = 1; i < t.replies.length; i++) {
        expect(t.replies[i]!.createdAt).toBeGreaterThanOrEqual(t.replies[i - 1]!.createdAt);
      }
    }
  });

  it('resumePositionSec follows the YouTube convention', () => {
    expect(resumePositionSec(VIDEO, 3)).toBe(0);
    expect(resumePositionSec(VIDEO, 100)).toBe(100);
    expect(resumePositionSec(VIDEO, VIDEO.durationSec! - 5)).toBe(0);
    const { durationSec: _dropped, ...noDuration } = VIDEO;
    expect(resumePositionSec(noDuration, 100)).toBe(100);
  });

  it('safePlaceholder accepts only inline images (T16: no unverified remote fetch)', () => {
    const withP = (placeholder: string): VideoManifest => ({
      ...VIDEO,
      renditions: VIDEO.renditions.map((r) => ({ ...r, placeholder })),
    });
    expect(safePlaceholder(withP('data:image/webp;base64,AAAA'))).toBe(
      'data:image/webp;base64,AAAA',
    );
    expect(safePlaceholder(withP('https://evil.example/pixel.png'))).toBeUndefined();
    expect(safePlaceholder(withP('javascript:alert(1)'))).toBeUndefined();
    expect(safePlaceholder(withP('data:text/html,<b>x</b>'))).toBeUndefined();
  });

  it('playErrorKind maps the mock failure prefixes', () => {
    expect(playErrorKind(new Error('no-seeders: nobody is seeding'))).toBe('no-seeders');
    expect(playErrorKind(new Error('no-balance: none'))).toBe('no-balance');
    expect(playErrorKind(new Error('relay-down: no relays'))).toBe('relay-down');
    expect(playErrorKind(new Error('boom'))).toBe('unknown');
    expect(playErrorKind('relay timed out')).toBe('relay-down');
  });

  it('describeError maps relay failures and unknown values', () => {
    expect(describeError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeError('relay timed out').detail).toBe('relay timed out');
    expect(describeError(new Error('boom')).title).toBe('Something went wrong');
    expect(describeError(undefined).detail).toBeUndefined();
  });
});

/** Price of `video` at `label`, as the screen must show it. */
function priceOf(video: VideoManifest, label: string): number {
  const r = video.renditions.find((x) => x.label === label)!;
  return renditionPriceSats(r, video.price);
}

/** Proxy that overrides a few adapter methods and binds the rest (mock state stays intact). */
function override<T extends NetworkAdapter>(base: T, patch: Partial<NetworkAdapter>): T {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in patch) return (patch as Record<string | symbol, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe('Watch — price shown is price charged', () => {
  it('never autoplays on mount: no play() and no <video> until the viewer presses play', async () => {
    const adapter = new MockNetworkAdapter();
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(r.all('video')).toHaveLength(0);
    expect(r.get('.nf-watch__stage').classList.contains('nf-watch__stage--poster')).toBe(true);
  });

  it('the poster price is the rendition play() receives; the quality picker changes both', async () => {
    const adapter = new MockNetworkAdapter();
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    const badge = r.get('.nf-watch__stage-price .nf-sats--price');
    expect(badge.getAttribute('aria-label')).toBe(
      `Price ${formatInteger(priceOf(VIDEO, '1080p'))} sats at 1080p`,
    );
    expect(playButton(r).getAttribute('aria-label')).toContain(
      `${formatInteger(priceOf(VIDEO, '1080p'))} sats (1080p)`,
    );
    // Pre-play picker: every rendition with its price and the difference.
    click(r.get('.nf-watch__quality-button'));
    const items = r.all('.nf-watch__quality-menu [role="menuitemradio"]');
    expect(items).toHaveLength(VIDEO.renditions.length);
    const cheap = items.find((b) => b.textContent.includes('360p'))!;
    expect(cheap.textContent).toContain(formatInteger(priceOf(VIDEO, '360p')));
    expect(cheap.querySelector('.nf-watch__quality-delta--down')).toBeTruthy();
    click(cheap);
    expect(r.get('.nf-watch__stage-price .nf-sats--price').getAttribute('aria-label')).toBe(
      `Price ${formatInteger(priceOf(VIDEO, '360p'))} sats at 360p`,
    );
    await pressPlay(r);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(VIDEO.id, '360p');
  });

  it('refuses a session at a different rendition than the one priced (closed, nothing played)', async () => {
    const base = new MockNetworkAdapter();
    const closes: ReturnType<typeof vi.fn>[] = [];
    const adapter = override(base, {
      play: (id: NostrEventId) =>
        base.play(id, '360p').then((s) => {
          const close = vi.fn(() => s.close());
          closes.push(close);
          return { ...s, close };
        }),
    });
    const { r } = mount(adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(r.all('video')).toHaveLength(0);
    expect(r.get('.nf-watch__stage--gate [role="alert"]').textContent).toContain(
      'nothing was played',
    );
  });

  it('never prefetches related videos: one play() for the video on screen only', async () => {
    const adapter = new MockNetworkAdapter();
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    expect(r.all('.nf-watch__related .nf-card').length).toBeGreaterThan(0);
    await pressPlay(r);
    await flush();
    expect(play.mock.calls).toEqual([[VIDEO.id, '1080p']]);
  });

  it('never records progress for a video that was not played (resume point survives)', async () => {
    const adapter = new MockNetworkAdapter();
    await adapter.library.recordProgress(VIDEO.id, 100);
    const record = vi.spyOn(adapter.library, 'recordProgress');
    const { r } = mount(adapter);
    await flush();
    r.unmount();
    await flush();
    expect(record).not.toHaveBeenCalled();
  });

  it('switching quality mid-play toasts the new price and the difference', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    click(r.get('button[aria-label="Settings: quality and speed"]'));
    click(r.all('[role="menuitemradio"]').find((b) => b.textContent.includes('360p'))!);
    await flush();
    const delta = priceOf(VIDEO, '1080p') - priceOf(VIDEO, '360p');
    const toast = r
      .all('.nf-toast')
      .map((t) => t.textContent)
      .join(' ');
    expect(toast).toContain(`Quality 360p — ${formatInteger(priceOf(VIDEO, '360p'))} sats`);
    expect(toast).toContain(`−${formatInteger(delta)} sats for the whole video vs 1080p`);
    expect(r.get('.nf-watch__stage-price .nf-sats--price').getAttribute('aria-label')).toContain(
      'at 360p',
    );
  });
});

describe('Watch — media element and pause = stop paying', () => {
  it('drives the element: play() while playing, pause() when paused', async () => {
    const play = mediaPlaySpy;
    const pause = mediaPauseSpy;
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    await pressPlay(r);
    expect(play).toHaveBeenCalled();
    click(r.get('button[aria-label="Pause (k)"]'));
    await flush();
    expect(pause).toHaveBeenCalled();
  });

  it('an element pause from outside the page (PiP window, media keys) pauses the session', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    fire(r.get('video'), new Event('pause'));
    await flush();
    expect(wrapped.sessions[0]!.pause).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-watch__paystate').textContent).toContain('Paused — not paying');
  });
});

describe('Watch — media errors', () => {
  it('an element that cannot play stops paying, says so, and Retry resumes', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    fire(r.get('video'), new Event('error'));
    await flush();
    expect(wrapped.sessions[0]!.pause).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-player').getAttribute('data-status')).toBe('error');
    expect(r.get('.nf-player [role="alert"]').textContent).toContain('Payment is paused');
    expect(r.get('.nf-watch__paystate').textContent).toContain('Stopped — not paying');
    click(r.get('.nf-player__retry'));
    await flush();
    expect(wrapped.sessions[0]!.resume).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-player').getAttribute('data-status')).toBe('playing');
  });
});

describe('Watch — keyboard', () => {
  it('page-wide keys drive the live player: k, l, number keys, >, t', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const { r } = mount(wrapped.adapter);
    keep(r);
    await flush();
    await pressPlay(r);
    keydown(document.body, 'l');
    expect(r.get('[data-testid="current-time"]').textContent).toBe('0:10');
    keydown(document.body, '5');
    expect(r.get('[data-testid="current-time"]').textContent).toBe('23:25');
    keydown(document.body, '>');
    click(r.get('button[aria-label="Settings: quality and speed"]'));
    expect(r.all('.nf-player__menu-rate[aria-checked="true"]').map((b) => b.textContent)).toEqual([
      '1.25×',
    ]);
    keydown(document.body, 't');
    expect(r.get('.nf-watch').classList.contains('nf-watch--theater')).toBe(true);
    keydown(document.body, 'k');
    await flush();
    expect(wrapped.sessions[0]!.pause).toHaveBeenCalledTimes(1);
  });

  it('ignores keys while typing, and a stray key never starts paying', async () => {
    const adapter = new MockNetworkAdapter();
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    keydown(document.body, 'k');
    keydown(document.body, ' ');
    await flush();
    expect(play).not.toHaveBeenCalled();
    // `t` works before playback (it costs nothing).
    keydown(document.body, 't');
    expect(r.get('.nf-watch').classList.contains('nf-watch--theater')).toBe(true);
    await pressPlay(r);
    keydown(r.get('textarea[id*="comment"]'), 'k');
    expect(r.get('.nf-player').getAttribute('data-status')).toBe('playing');
  });
});

describe('Watch — peer panel', () => {
  it('shows the seeders being paid, by name, with sats/min; paused says not paying', async () => {
    vi.useFakeTimers();
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    click(r.get('button[aria-label="Show seeders"]'));
    expect(r.get('.nf-watch__peers [aria-busy="true"]')).toBeTruthy(); // before the first report
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    await flushFake();
    const panel = r.get('.nf-watch__peers');
    const seeders = CHANNELS.filter((c) => c.seeds);
    expect(r.all('.nf-watch__peers .nf-peers__row')).toHaveLength(seeders.length);
    for (const c of seeders) expect(panel.textContent).toContain(c.profile.displayName);
    expect(panel.textContent).toContain('sats/min');
    expect(panel.querySelector('.nf-watch__peers-foot')!.textContent).toContain('% to seeders');
    click(r.get('button[aria-label="Pause (k)"]'));
    await flushFake();
    expect(r.get('.nf-watch__peers').textContent).toContain('Paused · not paying');
  });
});

describe('Watch — mini-player on navigate', () => {
  it('navigating to a channel while playing hands the session to the shell first', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const onMiniPlayer = vi.fn();
    const { r, navigate } = mount(wrapped.adapter, { onMiniPlayer });
    keep(r);
    await flush();
    await pressPlay(r);
    keydown(document.body, 'l');
    click(r.get('.nf-channel__name'));
    expect(onMiniPlayer).toHaveBeenCalledTimes(1);
    const handoff = onMiniPlayer.mock.calls[0]![2] as { positionSec: number; paused: boolean };
    expect(handoff.positionSec).toBe(10);
    expect(handoff.paused).toBe(false);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: VIDEO.author });
    expect(wrapped.sessions[0]!.close).not.toHaveBeenCalled();
  });

  it('unmounting while playing (shell navigation) hands off instead of closing', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const onMiniPlayer = vi.fn();
    const { r } = mount(wrapped.adapter, { onMiniPlayer });
    await flush();
    await pressPlay(r);
    r.unmount();
    await flush();
    expect(onMiniPlayer).toHaveBeenCalledTimes(1);
    expect(wrapped.sessions[0]!.close).not.toHaveBeenCalled();
  });

  it('opening another video closes the session — it is not handed off', async () => {
    const wrapped = wrapPlay(new MockNetworkAdapter());
    const onMiniPlayer = vi.fn();
    const { r, navigate } = mount(wrapped.adapter, { onMiniPlayer });
    keep(r);
    await flush();
    await pressPlay(r);
    const card = r.all('.nf-watch__related-list .nf-card')[0]!;
    click(card.querySelector('.nf-card__thumb')!);
    await flush();
    expect(onMiniPlayer).not.toHaveBeenCalled();
    expect(wrapped.sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'watch' }));
  });

  it('adopts a handed-back session without a new play(); owns (closes) it again', async () => {
    const adapter = new MockNetworkAdapter();
    const session = await adapter.play(VIDEO.id, '720p');
    const close = vi.fn(() => session.close());
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter, {
      resumeSession: {
        session: { ...session, close },
        videoId: VIDEO.id,
        title: VIDEO.title,
        positionSec: 100,
        paused: true,
        volume: 0.5,
        muted: false,
        playbackRate: 1.5,
      },
    });
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(r.get('.nf-player').getAttribute('data-status')).toBe('paused');
    expect(r.get('[data-testid="current-time"]').textContent).toBe('1:40');
    expect(r.get('.nf-watch__stage-price .nf-sats--price').getAttribute('aria-label')).toContain(
      'at 720p',
    );
    r.unmount();
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('Watch — hand-back guard', () => {
  it('never re-adopts a session it already closed, even from a fresh hand-off object', async () => {
    const adapter = new MockNetworkAdapter();
    const session = await adapter.play(VIDEO.id, '720p');
    const close = vi.fn(() => session.close());
    const handoff = {
      session: { ...session, close },
      videoId: VIDEO.id,
      title: VIDEO.title,
      positionSec: 30,
      paused: false,
      volume: 1,
      muted: false,
      playbackRate: 1,
    };
    const navigate = vi.fn<(to: Route) => void>();
    const props = { adapter, navigate, now: mocks.FIXTURE_NOW, videoId: VIDEO.id };
    const r = keep(render(createElement(Watch, { ...props, resumeSession: handoff })));
    await flush();
    expect(r.get('.nf-player').getAttribute('data-status')).toBe('playing');
    // Opening another video closes the adopted session.
    click(r.get('.nf-watch__related-list .nf-card .nf-card__thumb'));
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    r.rerender(createElement(Watch, { ...props, resumeSession: { ...handoff } }));
    await flush();
    expect(r.all('.nf-player')).toHaveLength(0);
    expect(playButton(r)).toBeTruthy();
  });
});

describe('Watch — autoplay next: playlist, price guard, switch', () => {
  const others = VIDEOS.filter((v) => v.kind === 21 && v.id !== VIDEO.id).slice(0, 2);
  const playlist = { title: 'Ceramics binge', videoIds: [VIDEO.id, ...others.map((v) => v.id)] };

  it('a playlist renders as a panel and autoplay-next follows it', async () => {
    const { r } = mount(new MockNetworkAdapter(), { playlist });
    keep(r);
    await flush();
    const panel = r.get('.nf-watch__playlist');
    expect(panel.textContent).toContain('Ceramics binge');
    expect(panel.textContent).toContain('1 / 3');
    expect(panel.querySelector('[aria-current="true"]')).toBeTruthy();
    await pressPlay(r);
    fire(r.get('video'), new Event('ended'));
    await flush();
    const overlay = r.get('.nf-watch__upnext');
    expect(overlay.textContent).toContain('Next in playlist');
    expect(overlay.textContent).toContain(others[0]!.title);
    expect(overlay.querySelector('.nf-sats--price')!.getAttribute('aria-label')).toBe(
      `Next video costs ${formatInteger(priceOf(others[0]!, '1080p'))} sats at 1080p`,
    );
  });

  it('the countdown price is the charged price: play(next, same rendition)', async () => {
    vi.useFakeTimers();
    const adapter = new MockNetworkAdapter();
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    fire(r.get('video'), new Event('ended'));
    await flushFake();
    const next = VIDEOS.find((v) => v.id === NEXT_AFTER)!;
    expect(r.get('.nf-watch__upnext .nf-sats--price').getAttribute('aria-label')).toBe(
      `Next video costs ${formatInteger(priceOf(next, '1080p'))} sats at 1080p`,
    );
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await flushFake();
    expect(play.mock.calls[1]).toEqual([NEXT_AFTER, '1080p']);
  });

  it('refuses to autoplay when the loaded manifest prices the next video higher', async () => {
    vi.useFakeTimers();
    const base = new MockNetworkAdapter();
    const adapter = override(base, {
      video: (id: NostrEventId) =>
        base
          .video(id)
          .then((v) =>
            v !== null && id === NEXT_AFTER
              ? { ...v, price: { ...v.price, satsPerBlock: (v.price.satsPerBlock * 2) as never } }
              : v,
          ),
    });
    const play = vi.spyOn(base, 'play');
    const { r, navigate } = mount(adapter);
    keep(r);
    await flushFake();
    click(playButton(r));
    await flushFake();
    fire(r.get('video'), new Event('ended'));
    await flushFake();
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await flushFake();
    expect(navigate).toHaveBeenCalledWith({ name: 'watch', videoId: NEXT_AFTER });
    expect(play.mock.calls.map((c) => c[0])).toEqual([VIDEO.id]);
    expect(
      r
        .all('.nf-toast')
        .map((t) => t.textContent)
        .join(' '),
    ).toContain('Autoplay stopped');
    expect(playButton(r)).toBeTruthy();
  });

  it('the Autoplay switch turns the countdown off', async () => {
    const { r } = mount(new MockNetworkAdapter());
    keep(r);
    await flush();
    const toggle = r.all('.nf-watch__related-head button')[0]!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await pressPlay(r);
    fire(r.get('video'), new Event('ended'));
    await flush();
    expect(r.all('.nf-watch__upnext')).toHaveLength(0);
    expect(r.get('.nf-watch__paystate').textContent).toContain('not paying');
  });
});

describe('Watch — overflow menu', () => {
  it('saves to Watch later and opens the keyboard-shortcut sheet', async () => {
    const adapter = new MockNetworkAdapter();
    const setWatchLater = vi.spyOn(adapter.library, 'setWatchLater');
    const { r } = mount(adapter);
    keep(r);
    await flush();
    click(r.get('button[aria-label="More actions"]'));
    click(r.all('[role="menuitem"]').find((b) => b.textContent === 'Save to Watch later')!);
    await flush();
    expect(setWatchLater).toHaveBeenCalledWith(VIDEO.id, true);
    expect(r.get('.nf-toast').textContent).toContain('Saved to Watch later');
    click(r.get('button[aria-label="More actions"]'));
    click(r.all('[role="menuitem"]').find((b) => b.textContent === 'Keyboard shortcuts')!);
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('Mini-player');
    expect(dialog.querySelectorAll('.nf-watch__keys-row').length).toBeGreaterThan(10);
  });
});
