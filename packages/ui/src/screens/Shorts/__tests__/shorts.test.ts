/**
 * Shorts screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, price-before-play ordering, "no autoplay / moving is not
 * consent", session lifetime (close on move, on unmount, on a late play()), the price-shown
 * vs price-charged guard, navigation routes, keyboard/wheel/scroll movement, gates and
 * error copy, social actions, nutzap, and cancellation on unmount.
 */
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, NostrEventId, Page, PlaySession, VideoManifest } from '@sovit/core';
import { click, fire, keydown, render, type Rendered } from '../../../components/testing/render.js';
import { renditionPriceSats } from '../../../components/index.js';
import type { Route } from '../../shared/route.js';
import {
  SHORTS_NUTZAP_AMOUNTS,
  Shorts,
  describeShortsError,
  shortPrice,
  shortsPlayErrorKind,
  type ShortsProps,
} from '../Shorts.js';

const { MockNetworkAdapter, VIDEOS, CHANNELS, MINTS } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];

/** Fixture shorts in the order the mock's `feed({ source: 'shorts' })` returns them. */
const SHORTS = VIDEOS.filter((v) => v.kind === 22).sort((a, b) => b.publishedAt - a.publishedAt);
const S0 = SHORTS[0]!;
const S1 = SHORTS[1]!;
const S2 = SHORTS[2]!;

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** A mock whose playback spend never ticks (no timers left behind). */
function adapterWith(opts: Opts = {}): mocks.MockNetworkAdapter {
  return new MockNetworkAdapter({ setInterval: () => () => undefined, ...opts });
}

function withOverrides(base: NetworkAdapter, over: Partial<NetworkAdapter>): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop in over) return (over as Record<string | symbol, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Tracked {
  readonly session: PlaySession;
  readonly close: Mock;
  readonly pause: Mock;
  readonly resume: Mock;
  readonly prefetch: Mock;
}

/** Spies on `play()` and on every session it hands out (before the screen sees it). */
function instrument(adapter: mocks.MockNetworkAdapter): {
  readonly play: Mock;
  readonly sessions: Tracked[];
} {
  const sessions: Tracked[] = [];
  const orig = adapter.play.bind(adapter);
  const play = vi
    .spyOn(adapter, 'play')
    .mockImplementation(async (id: NostrEventId, r?: string): Promise<PlaySession> => {
      const session = await orig(id, r);
      sessions.push({
        session,
        close: vi.spyOn(session, 'close'),
        pause: vi.spyOn(session, 'pause'),
        resume: vi.spyOn(session, 'resume'),
        prefetch: vi.spyOn(session, 'setPrefetchSeconds'),
      });
      return session;
    });
  return { play: play, sessions };
}

const rendered: Rendered[] = [];
function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<ShortsProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: Mock<(to: Route) => void> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(createElement(Shorts, { adapter, navigate, ...props }));
  rendered.push(r);
  return { r, navigate };
}

function unmountTracked(r: Rendered): void {
  const i = rendered.indexOf(r);
  if (i >= 0) rendered.splice(i, 1);
  r.unmount();
}

const active = (r: Rendered): HTMLElement => r.get('article[aria-current="true"]');
const activeId = (r: Rendered): string | null => active(r).getAttribute('data-video-id');
const playButton = (r: Rendered): HTMLButtonElement =>
  active(r).querySelector<HTMLButtonElement>('.nf-shorts__play')!;
const buttonByText = (root: ParentNode, text: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent.includes(text),
  )!;

let mediaPlay: Mock = vi.fn();
beforeEach(() => {
  vi.useRealTimers();
  mediaPlay = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Shorts — structure and loading', () => {
  it('renders a landmark, a hidden h1 and a busy skeleton while loading; nothing plays', () => {
    const adapter = adapterWith({ latencyMs: 5000 });
    const play = vi.spyOn(adapter, 'play');
    const { r } = mount(adapter);
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Shorts');
    expect(r.get('.nf-shorts__feed').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-skeleton').length).toBeGreaterThan(0);
    expect(r.all('article')).toHaveLength(0);
    expect(r.all('video')).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('Shorts — populated feed', () => {
  it('one article per short in a role=feed; the first is active, the others inert', async () => {
    const adapter = adapterWith();
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter);
    await flush();
    expect(feed).toHaveBeenCalledWith({ source: 'shorts', limit: 10 });
    expect(r.get('[role="feed"]')).toBeTruthy();
    const articles = r.all('article[data-video-id]');
    expect(articles.map((a) => a.getAttribute('data-video-id'))).toEqual(SHORTS.map((v) => v.id));
    expect(activeId(r)).toBe(S0.id);
    expect(articles[0]!.hasAttribute('inert')).toBe(false);
    expect(articles[1]!.hasAttribute('inert')).toBe(true);
    expect(articles[2]!.hasAttribute('inert')).toBe(true);
    expect(articles[0]!.getAttribute('aria-posinset')).toBe('1');
    expect(articles[0]!.getAttribute('aria-setsize')).toBe(String(SHORTS.length));
    // Title is a heading rendered through the Markdown subset; the article is labelled by it.
    const heading = articles[0]!.querySelector('[role="heading"][aria-level="2"]')!;
    expect(heading.querySelector('.nf-md')).not.toBeNull();
    expect(heading.textContent).toBe(S0.title);
    expect(articles[0]!.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(articles[0]!.querySelector('.nf-shorts__desc .nf-md')).not.toBeNull();
  });

  it('posters are hash-checked through adapter.image before display (T16)', async () => {
    const adapter = adapterWith();
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter);
    await flush();
    for (const v of SHORTS) {
      const thumb = v.renditions[0]!.image!;
      expect(image).toHaveBeenCalledWith(thumb.url, thumb.sha256);
    }
    const poster = active(r).querySelector('img.nf-shorts__poster')!;
    expect(poster.getAttribute('src')).toBe(S0.renditions[0]!.image!.url);
  });

  it('a rejected poster hash leaves no image (and no endless skeleton)', async () => {
    const base = adapterWith();
    const adapter = withOverrides(base, {
      image: (url: string) =>
        url.includes('/thumbs/') ? Promise.reject(new Error('hash mismatch')) : base.image(url),
    });
    const { r } = mount(adapter);
    await flush();
    expect(active(r).querySelector('img.nf-shorts__poster')).toBeNull();
    expect(active(r).querySelector('.nf-shorts__poster-skeleton')).toBeNull();
  });

  it('shows every price via SatsBadge BEFORE the play affordance; nothing autoplays', async () => {
    const adapter = adapterWith();
    const { play } = instrument(adapter);
    const { r } = mount(adapter);
    await flush();
    const articles = r.all('article[data-video-id]');
    for (const [i, article] of articles.entries()) {
      const price = article.querySelector('.nf-sats--price')!;
      const playBtn = article.querySelector('.nf-shorts__play')!;
      expect(price).not.toBeNull();
      expect(playBtn).not.toBeNull();
      expect(price.compareDocumentPosition(playBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const v = SHORTS[i]!;
      const sats = renditionPriceSats(v.renditions[0]!, v.price);
      expect(price.getAttribute('aria-label')).toContain(`${sats.toLocaleString('en-US')} sats`);
      expect(playBtn.getAttribute('aria-label')).toContain('sats');
    }
    expect(play).not.toHaveBeenCalled();
    expect(r.all('video')).toHaveLength(0);
  });
});

describe('Shorts — playback and payment', () => {
  it('play → a session for the shown rendition; prefetch from Settings; pause stops paying', async () => {
    const adapter = adapterWith();
    await adapter.updateSettings({ prefetchSeconds: 12 });
    const { play, sessions } = instrument(adapter);
    const started = vi.fn();
    const { r } = mount(adapter, { onPlaybackStart: started });
    await flush();
    click(playButton(r));
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith(S0.id, shortPrice(S0)!.rendition.label);
    expect(sessions[0]!.prefetch).toHaveBeenCalledWith(12);
    expect(started).toHaveBeenCalledWith(S0.id);
    const video = active(r).querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toBe(
      sessions[0]!.session.source.kind === 'url' ? sessions[0]!.session.source.url : null,
    );
    expect(mediaPlay).toHaveBeenCalled();
    // Only the active short ever has a media element.
    expect(r.all('video')).toHaveLength(1);
    // Price stays visible while playing, ahead of the controls.
    const price = active(r).querySelector('.nf-shorts__top .nf-sats--price')!;
    const pauseBtn = active(r).querySelector<HTMLButtonElement>('.nf-shorts__controls button')!;
    expect(price.compareDocumentPosition(pauseBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pauseBtn.getAttribute('aria-label')).toBe('Pause (space)');
    click(pauseBtn);
    expect(sessions[0]!.pause).toHaveBeenCalledTimes(1);
    expect(active(r).textContent).toContain('Paused — not paying');
    click(active(r).querySelector<HTMLButtonElement>('.nf-shorts__play')!); // Resume
    expect(sessions[0]!.resume).toHaveBeenCalledTimes(1);
    expect(active(r).textContent).not.toContain('Paused — not paying');
  });

  it('shows live spend from PlaySession.onSpend while playing', async () => {
    let tick: (() => void) | undefined;
    const adapter = adapterWith({
      setInterval: (fn) => {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
    });
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    act(() => {
      tick!();
    });
    const rate = active(r).querySelector('.nf-sats--rate')!;
    expect(rate.getAttribute('aria-label')).toMatch(
      /^Streaming \d+ sats per minute — \d+ sats so far$/,
    );
  });

  it('moving on closes the session and leaves the next short idle behind its price', async () => {
    const adapter = adapterWith();
    const { play, sessions } = instrument(adapter);
    const { r, navigate } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    expect(sessions).toHaveLength(1);
    click(r.get('button[aria-label="Next short (j)"]'));
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S1.id });
    await flush();
    expect(activeId(r)).toBe(S1.id);
    expect(r.all('video')).toHaveLength(0);
    expect(play).toHaveBeenCalledTimes(1); // no autoplay of the next short
    expect(active(r).querySelector('.nf-sats--price')).not.toBeNull();
    expect(playButton(r)).not.toBeNull();
  });

  it('closes the session on unmount', async () => {
    const adapter = adapterWith();
    const { sessions } = instrument(adapter);
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    unmountTracked(r);
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('a play() that resolves after the viewer moved on is closed, never bound', async () => {
    const base = adapterWith();
    let resolve: ((s: PlaySession) => void) | undefined;
    const adapter = withOverrides(base, {
      play: () =>
        new Promise<PlaySession>((res) => {
          resolve = res;
        }),
    });
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    expect(active(r).querySelector('.nf-shorts__hint')!.textContent).toBe('Starting…');
    click(r.get('button[aria-label="Next short (j)"]'));
    await flush();
    const late = await base.play(S0.id);
    const close = vi.spyOn(late, 'close');
    resolve!(late);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(r.all('video')).toHaveLength(0);
  });

  it('a play() that resolves after unmount is closed on arrival', async () => {
    const base = adapterWith();
    let resolve: ((s: PlaySession) => void) | undefined;
    const adapter = withOverrides(base, {
      play: () =>
        new Promise<PlaySession>((res) => {
          resolve = res;
        }),
    });
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    unmountTracked(r);
    const late = await base.play(S0.id);
    const close = vi.spyOn(late, 'close');
    resolve!(late);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('price shown vs charged: a dearer session is refused and the new price shown first', async () => {
    const base = adapterWith();
    const closes: Mock[] = [];
    const adapter = withOverrides(base, {
      play: (id: NostrEventId, r?: string) =>
        base.play(id, r).then((s) => {
          const session: PlaySession = {
            ...s,
            policy: { ...s.policy, satsPerBlock: mocks.sats(s.policy.satsPerBlock * 2) },
          };
          closes.push(vi.spyOn(session, 'close'));
          return session;
        }),
    });
    const { r } = mount(adapter);
    await flush();
    const shown = shortPrice(S0)!.sats;
    click(playButton(r));
    await flush();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(r.all('video')).toHaveLength(0);
    expect(active(r).textContent).toContain('The price changed');
    const price = active(r).querySelector('.nf-sats--price')!;
    expect(price.getAttribute('aria-label')).toContain(
      `${(shown * 2).toLocaleString('en-US')} sats`,
    );
    // Fresh consent at the new (shown) price → accepted.
    click(playButton(r));
    await flush();
    expect(closes[1]).not.toHaveBeenCalled();
    expect(r.all('video')).toHaveLength(1);
  });

  it('the end of a short pauses the session (never pay past the end) and offers Replay', async () => {
    const adapter = adapterWith();
    const { sessions } = instrument(adapter);
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    fire(active(r).querySelector('video')!, new Event('ended'));
    expect(sessions[0]!.pause).toHaveBeenCalledTimes(1);
    const replay = active(r).querySelector<HTMLButtonElement>('.nf-shorts__play')!;
    expect(replay.getAttribute('aria-label')).toBe('Replay');
    click(replay);
    expect(sessions[0]!.resume).toHaveBeenCalledTimes(1);
  });

  it('a media error closes the session and offers Retry', async () => {
    const adapter = adapterWith();
    const { play, sessions } = instrument(adapter);
    const { r } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    fire(active(r).querySelector('video')!, new Event('error'));
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    const alert = active(r).querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('This short could not be played');
    click(alert.querySelector('button')!);
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
  });
});

describe('Shorts — moving between shorts', () => {
  it('keyboard: ArrowDown/j next, ArrowUp/k previous, ignored while typing; Space plays', async () => {
    const adapter = adapterWith();
    const { play } = instrument(adapter);
    const { navigate } = mount(adapter);
    await flush();
    keydown(document, 'ArrowDown');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S1.id });
    keydown(document, 'j');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S2.id });
    keydown(document, 'k');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S1.id });
    keydown(document, 'ArrowUp');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S0.id });
    keydown(document, 'ArrowUp'); // already first: nothing
    expect(navigate).toHaveBeenCalledTimes(4);
    const input = document.createElement('input');
    document.body.appendChild(input);
    keydown(input, 'j');
    expect(navigate).toHaveBeenCalledTimes(4);
    keydown(document, 'j', { ctrlKey: true });
    expect(navigate).toHaveBeenCalledTimes(4);
    expect(play).not.toHaveBeenCalled();
    keydown(document.body, ' ');
    await flush();
    expect(play).toHaveBeenCalledWith(S0.id, '720p');
  });

  it('wheel: one short per gesture, and the page does not scroll', async () => {
    const { r, navigate } = mount(adapterWith());
    await flush();
    const feed = r.get('.nf-shorts__feed');
    const first = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    fire(feed, first);
    expect(first.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S1.id });
    fire(feed, new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledTimes(1); // same gesture
    await sleep(300);
    fire(feed, new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S0.id });
  });

  it('scroll-snap / swipe: the snapped short becomes active once scrolling settles', async () => {
    const adapter = adapterWith();
    const { sessions } = instrument(adapter);
    const { r, navigate } = mount(adapter);
    await flush();
    click(playButton(r));
    await flush();
    const feed = r.get('.nf-shorts__feed');
    Object.defineProperty(feed, 'clientHeight', { configurable: true, value: 800 });
    feed.scrollTop = 1600;
    fire(feed, new Event('scroll'));
    expect(navigate).not.toHaveBeenCalled(); // not before it settles
    await sleep(200);
    expect(activeId(r)).toBe(S2.id);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S2.id });
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('up/down buttons respect the bounds; the tail says all caught up and can go back', async () => {
    const adapter = adapterWith();
    const { sessions } = instrument(adapter);
    const { r, navigate } = mount(adapter);
    await flush();
    const prev = r.get('button[aria-label="Previous short (k)"]');
    const next = r.get('button[aria-label="Next short (j)"]');
    expect(prev.hasAttribute('disabled')).toBe(true);
    click(next);
    click(next);
    await flush();
    click(playButton(r));
    await flush();
    click(next); // onto the end-cap
    await flush();
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    expect(r.all('video')).toHaveLength(0);
    expect(r.all('article[aria-current="true"]')).toHaveLength(0);
    const tail = r.get('.nf-shorts__slide--tail');
    expect(tail.hasAttribute('inert')).toBe(false);
    expect(tail.textContent).toContain("You're all caught up");
    expect(r.get('button[aria-label="Next short (j)"]').hasAttribute('disabled')).toBe(true);
    click(buttonByText(tail, 'Back to the first short'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S0.id });
    await flush();
    expect(activeId(r)).toBe(S0.id);
  });

  it('loads the next page near the end with the cursor; a failed page shows Retry in the tail', async () => {
    const base = adapterWith();
    let fail = true;
    const feed = vi.fn((q: Parameters<NetworkAdapter['feed']>[0]): Promise<Page<VideoManifest>> =>
      q.cursor !== undefined && fail
        ? Promise.reject(new Error('relay-down: no relays reachable'))
        : base.feed(q),
    );
    const { r } = mount(withOverrides(base, { feed }), { pageSize: 1 });
    await flush();
    expect(feed).toHaveBeenCalledWith({ source: 'shorts', limit: 1, cursor: '1' });
    expect(r.all('article[data-video-id]')).toHaveLength(1);
    keydown(document, 'j');
    await flush();
    const tail = r.get('.nf-shorts__slide--tail');
    expect(tail.querySelector('[role="alert"]')!.textContent).toContain(
      'Could not load more shorts',
    );
    fail = false;
    click(buttonByText(tail, 'Retry'));
    await flush();
    expect(r.all('article[data-video-id]').length).toBeGreaterThan(1);
    // The viewer was on the tail; the new short took its place, idle behind its price.
    expect(activeId(r)).toBe(S1.id);
    expect(r.all('video')).toHaveLength(0);
  });
});

describe('Shorts — route', () => {
  it('starts at the route videoId without navigating, and follows later route changes', async () => {
    const adapter = adapterWith();
    const navigate = vi.fn<(to: Route) => void>();
    const el = (videoId: NostrEventId): ReturnType<typeof createElement> =>
      createElement(Shorts, { adapter, navigate, videoId });
    const r = render(el(S1.id));
    rendered.push(r);
    await flush();
    expect(activeId(r)).toBe(S1.id);
    expect(navigate).not.toHaveBeenCalled();
    r.rerender(el(S2.id));
    await flush();
    expect(activeId(r)).toBe(S2.id);
    expect(navigate).not.toHaveBeenCalled();
    // Our own navigation echoed back by the shell is a no-op (no reload, no jump).
    const feed = vi.spyOn(adapter, 'feed');
    keydown(document, 'k');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: S1.id });
    r.rerender(el(S1.id));
    await flush();
    expect(activeId(r)).toBe(S1.id);
    expect(feed).not.toHaveBeenCalled();
  });

  it('a short outside the first page is fetched and put first; a missing one gets a notice', async () => {
    const a = adapterWith();
    const video = vi.spyOn(a, 'video');
    const one = mount(a, { videoId: S2.id, pageSize: 1 });
    await flush();
    expect(video).toHaveBeenCalledWith(S2.id);
    expect(activeId(one.r)).toBe(S2.id);
    // [linked short, first page…] — then the next page is appended (deduped) as usual.
    const ids = one.r.all('article[data-video-id]').map((x) => x.getAttribute('data-video-id'));
    expect(ids.slice(0, 2)).toEqual([S2.id, S0.id]);
    expect(new Set(ids).size).toBe(ids.length);
    const two = mount(adapterWith(), { videoId: mocks.asEventId('deleted-short') });
    await flush();
    expect(two.r.get('.nf-shorts__notice[role="status"]').textContent).toContain(
      'That short is not available any more',
    );
    expect(activeId(two.r)).toBe(S0.id);
    click(two.r.get('.nf-shorts__notice button'));
    expect(two.r.all('.nf-shorts__notice')).toHaveLength(0);
  });
});

describe('Shorts — gates and errors', () => {
  it('no signer: signer card instead of a play button, Connect signer → settings', async () => {
    for (const opts of [{ failWith: 'no-signer' as const }, { signedIn: false }]) {
      const adapter = adapterWith(opts);
      const { play } = instrument(adapter);
      const { r, navigate } = mount(adapter);
      await flush();
      const card = active(r).querySelector('[data-preset="signer-not-detected"]')!;
      expect(card).not.toBeNull();
      expect(active(r).querySelector('.nf-shorts__play')).toBeNull();
      const price = active(r).querySelector('.nf-sats--price')!;
      expect(price.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      click(card.querySelector('button')!);
      expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
      keydown(document.body, ' ');
      await flush();
      expect(play).not.toHaveBeenCalled();
      // Social actions ask to sign in instead of failing.
      click(buttonByText(active(r), 'Like'));
      expect(r.get('.nf-toast').textContent).toContain('Sign in to do that');
      click(buttonByText(r.get('.nf-toast'), 'Connect signer'));
      expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
      unmountTracked(r);
    }
  });

  it('no seeders: designed card; Retry re-checks the seeders; play() is never attempted', async () => {
    const adapter = adapterWith({ failWith: 'no-seeders' });
    const { play } = instrument(adapter);
    const stats = vi.spyOn(adapter, 'stats');
    const { r } = mount(adapter);
    await flush();
    const card = active(r).querySelector('[data-preset="no-seeders-online"]')!;
    expect(card.textContent).toContain('No seeders online');
    const before = stats.mock.calls.filter((c) => c[0] === S0.id).length;
    click(card.querySelector('button')!);
    await flush();
    expect(stats.mock.calls.filter((c) => c[0] === S0.id).length).toBe(before + 1);
    expect(play).not.toHaveBeenCalled();
  });

  it('no balance at the mint: designed card; Top up → wallet', async () => {
    const { r, navigate } = mount(adapterWith({ failWith: 'no-balance' }));
    await flush();
    const card = active(r).querySelector('[data-preset="no-balance-at-mint"]')!;
    expect(card.textContent).toContain('mint.fixture-a.example');
    click(card.querySelector('button')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'wallet' });
  });

  it('play() rejections map to the designed states; nothing was paid', async () => {
    const cases: readonly [string, string][] = [
      ['no-seeders: nobody is seeding', 'No seeders online'],
      ['no-balance: no balance at x', 'No balance at this mint'],
      ['relay-down: no relays reachable', 'Relay down'],
      ['stream refused', 'Could not start this short'],
    ];
    for (const [message, copy] of cases) {
      const adapter = withOverrides(adapterWith(), {
        play: () => Promise.reject(new Error(message)),
      });
      const { r } = mount(adapter);
      await flush();
      click(playButton(r));
      await flush();
      expect(active(r).textContent).toContain(copy);
      expect(r.all('video')).toHaveLength(0);
      unmountTracked(r);
    }
    expect(shortsPlayErrorKind(new Error('no-seeders: x'))).toBe('no-seeders');
    expect(shortsPlayErrorKind(new Error('no-balance: x'))).toBe('no-balance');
    expect(shortsPlayErrorKind('signer locked')).toBe('no-signer');
    expect(shortsPlayErrorKind(new Error('relay timed out'))).toBe('relay-down');
    expect(shortsPlayErrorKind(undefined)).toBe('unknown');
  });

  it('relay down → ErrorState with the designed copy, never thrown; Retry refetches', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ failWith: 'relay-down' });
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.textContent).toContain('None of your relays answered');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    click(alert.querySelector('button')!);
    await flush();
    expect(feed).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
    expect(describeShortsError(new Error('boom')).title).toBe('Something went wrong');
    expect(describeShortsError(undefined).detail).toBeUndefined();
  });

  it('empty feed → "No shorts yet", Browse Home → home', async () => {
    const adapter = withOverrides(adapterWith(), {
      feed: () => Promise.resolve({ items: [] }),
    });
    const { r, navigate } = mount(adapter);
    await flush();
    const status = r.get('[role="status"]');
    expect(status.textContent).toContain('No shorts yet');
    expect(r.all('[role="feed"]')).toHaveLength(0);
    click(status.querySelector('button')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home' });
  });
});

describe('Shorts — actions', () => {
  it('like toggles through react(+/-) and the count follows', async () => {
    const adapter = adapterWith();
    const react = vi.spyOn(adapter, 'react');
    const { r } = mount(adapter);
    await flush();
    const stats = await adapter.stats(S0.id);
    const like = (): HTMLButtonElement => buttonByText(active(r), 'Like');
    expect(like().textContent).toBe(`Like · ${String(stats.reactions)}`);
    expect(like().getAttribute('aria-pressed')).toBe('false');
    click(like());
    await flush();
    expect(react).toHaveBeenLastCalledWith(S0.id, '+');
    expect(like().getAttribute('aria-pressed')).toBe('true');
    expect(like().textContent).toBe(`Like · ${String(stats.reactions + 1)}`);
    click(like());
    await flush();
    expect(react).toHaveBeenLastCalledWith(S0.id, '-');
    expect(like().textContent).toBe(`Like · ${String(stats.reactions)}`);
  });

  it('subscribe, channel → channel route, comments → watch route', async () => {
    const adapter = adapterWith();
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r, navigate } = mount(adapter);
    await flush();
    const subscribed = (await adapter.subscriptions()).includes(S0.author);
    const btn = (): HTMLButtonElement =>
      active(r).querySelector<HTMLButtonElement>('.nf-shorts__subscribe')!;
    expect(btn().textContent).toBe(subscribed ? 'Subscribed' : 'Subscribe');
    if (!subscribed) {
      click(btn());
      await flush();
      expect(subscribe).toHaveBeenCalledWith(S0.author);
      expect(btn().textContent).toBe('Subscribed');
    }
    click(active(r).querySelector('.nf-shorts__channel-link')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: S0.author });
    const name = CHANNELS.find((c) => c.pubkey === S0.author)!.profile.displayName!;
    expect(active(r).querySelector('.nf-shorts__channel-name')!.textContent).toBe(name);
    click(buttonByText(active(r), 'Comments'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: S0.id });
  });

  it('nutzap: the amount is shown before Send; sends at the chosen mint; keys stay in the sheet', async () => {
    const adapter = adapterWith();
    const nutzap = vi.spyOn(adapter, 'nutzap');
    const { r, navigate } = mount(adapter);
    await flush();
    click(buttonByText(active(r), 'Nutzap'));
    await flush();
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('Nutzap');
    expect(SHORTS_NUTZAP_AMOUNTS.length).toBeGreaterThan(1);
    click(buttonByText(dialog, '100'));
    const badge = dialog.querySelector('.nf-shorts__zap-foot .nf-sats')!;
    const send = buttonByText(dialog, 'Send nutzap');
    expect(badge.getAttribute('aria-label')).toBe('You send 100 sats');
    expect(badge.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    keydown(document, 'j'); // the sheet is modal: no movement behind it
    expect(navigate).not.toHaveBeenCalled();
    const input = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input).not.toBeNull();
    click(send);
    await flush();
    expect(nutzap).toHaveBeenCalledWith(S0.id, 100, MINTS.a);
    expect(r.all('[role="dialog"]')).toHaveLength(0);
    expect(r.get('.nf-toast').textContent).toContain('Nutzap sent');
  });

  it('nutzap with no balance at the creator mints: designed card, Send disabled', async () => {
    const { r } = mount(adapterWith({ failWith: 'no-balance' }));
    await flush();
    click(buttonByText(active(r), 'Nutzap'));
    await flush();
    const dialog = r.get('[role="dialog"]');
    expect(dialog.querySelector('[data-preset="no-balance-at-mint"]')).not.toBeNull();
    expect(buttonByText(dialog, 'Send nutzap').hasAttribute('disabled')).toBe(true);
  });

  it('hostile titles and descriptions render as text only', async () => {
    const evil: VideoManifest = {
      ...S0,
      title: '<img src=x onerror="alert(1)"> **bold**',
      description: '<script>alert(1)</script> [x](javascript:alert(1))',
    };
    const adapter = withOverrides(adapterWith(), {
      feed: () => Promise.resolve({ items: [evil] }),
    });
    const { r } = mount(adapter);
    await flush();
    const heading = active(r).querySelector('[role="heading"]')!;
    expect(heading.querySelector('img')).toBeNull();
    expect(heading.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(heading.querySelector('strong')!.textContent).toBe('bold');
    expect(active(r).querySelector('script')).toBeNull();
    expect(active(r).querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe('Shorts — cancellation', () => {
  it('unmounting mid-load cancels: no follow-up calls, no state updates, no errors', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ latencyMs: 1000 });
    const image = vi.spyOn(adapter, 'image');
    const profile = vi.spyOn(adapter, 'profile');
    const stats = vi.spyOn(adapter, 'stats');
    const video = vi.spyOn(adapter, 'video');
    const { r } = mount(adapter, { videoId: mocks.asEventId('not-in-page') });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    unmountTracked(r);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // The feed resolved after unmount: the cancelled load must not continue into video()
    // nor resolve any posters/profiles/stats — i.e. no setState after unmount.
    expect(video).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
