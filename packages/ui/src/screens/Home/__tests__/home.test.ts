/**
 * Home screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, price-before-play ordering, navigation routes, empty/error
 * copy, tab keyboard operation and cancellation on unmount.
 */
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, Page, VideoManifest } from '@sovit/core';
import { click, fire, keydown, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { HOME_TABS, Home, describeError, previewCostSats, type HomeProps } from '../Home.js';

const { MockNetworkAdapter, VIDEOS, CHANNELS, FIXTURE_NOW } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<HomeProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(
    createElement(Home, { adapter, navigate, now: FIXTURE_NOW, hoverPreview: true, ...props }),
  );
  return { r, navigate };
}

function adapterWith(opts: Opts = {}): mocks.MockNetworkAdapter {
  return new MockNetworkAdapter(opts);
}

function withFeed(
  base: NetworkAdapter,
  feed: (q: Parameters<NetworkAdapter['feed']>[0]) => Promise<Page<VideoManifest>>,
): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'feed') return feed;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function pointerEnter(el: Element): void {
  // jsdom has no PointerEvent constructor in every version; React listens for `pointerenter`
  // via `pointerover`/`pointerout` pairs, so a generic Event with the right name suffices.
  fire(el, new Event('pointerover', { bubbles: true }));
}

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

function keep(r: Rendered): Rendered {
  rendered.push(r);
  return r;
}

describe('Home — structure and loading', () => {
  it('renders a landmark, a heading, three keyboard tabs and skeletons while loading', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }));
    keep(r);
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Home');
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(HOME_TABS.map((t) => t.label));
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(r.get('[role="tabpanel"]').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-card--skeleton').length).toBeGreaterThan(0);
    expect(r.all('.nf-card:not(.nf-card--skeleton)')).toHaveLength(0);
  });

  it('uses the route tab and switches to Trending for a signed-out visitor', async () => {
    const a = mount(adapterWith({ signedIn: false }));
    keep(a.r);
    await flush();
    expect(a.r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Trending');
    expect(a.navigate).not.toHaveBeenCalled(); // an automatic fallback is not a navigation
    const b = mount(adapterWith({ signedIn: false }), { tab: 'subscriptions' });
    keep(b.r);
    await flush();
    expect(b.r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Subscriptions');
    expect(b.r.get('[role="status"]').textContent).toContain('Sign in to see your subscriptions');
    click(b.r.get('[role="status"] button'));
    expect(b.navigate).toHaveBeenCalledWith({ name: 'settings' });
  });
});

describe('Home — populated feeds', () => {
  it('shows the subscriptions feed with hash-checked thumbnails and channel rows', async () => {
    const adapter = adapterWith();
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter, { tab: 'subscriptions' });
    keep(r);
    await flush();
    const expected = await adapter.feed({ source: 'subscriptions', limit: 12 });
    const cards = r.all('.nf-card:not(.nf-card--skeleton)');
    expect(cards).toHaveLength(expected.items.length);
    expect(cards.length).toBeGreaterThan(0);
    const first = expected.items[0]!;
    const thumb = first.renditions[0]!.image!;
    expect(image).toHaveBeenCalledWith(thumb.url, thumb.sha256);
    expect(r.get('.nf-card__img').getAttribute('src')).toBe(thumb.url);
    const channel = CHANNELS.find((c) => c.pubkey === first.author)!;
    expect(cards[0]!.querySelector('.nf-card__channel-name')!.textContent).toBe(
      channel.profile.displayName,
    );
    expect(cards[0]!.querySelector('.nf-card__meta')!.textContent).toContain('paid views');
  });

  it('shows the price badge on every card before any play affordance', async () => {
    const { r } = mount(adapterWith(), { tab: 'trending' });
    keep(r);
    await flush();
    const items = r.all('.nf-home__item');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const price = item.querySelector('.nf-sats--price');
      expect(price).not.toBeNull();
      pointerEnter(item);
      const preview = item.querySelector('.nf-home__preview');
      expect(preview).not.toBeNull();
      expect(preview!.getAttribute('aria-hidden')).toBe('true');
      // DOCUMENT_POSITION_FOLLOWING: the preview affordance comes after the price badge.
      expect(price!.compareDocumentPosition(preview!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(preview!.querySelector('.nf-sats')!.getAttribute('aria-label')).toMatch(
        /^Preview costs about \d+ sats$/,
      );
      fire(item, new Event('pointerout', { bubbles: true }));
      expect(item.querySelector('.nf-home__preview')).toBeNull();
    }
  });

  it('renders no preview affordance when hoverPreview is off', async () => {
    const { r } = mount(adapterWith(), { tab: 'trending', hoverPreview: false });
    keep(r);
    await flush();
    const item = r.get('.nf-home__item');
    pointerEnter(item);
    expect(r.all('.nf-home__preview')).toHaveLength(0);
    fire(item.querySelector('.nf-card__thumb')!, new FocusEvent('focusin', { bubbles: true }));
    expect(r.all('.nf-home__preview')).toHaveLength(0);
  });

  it('shows the preview affordance on keyboard focus too', async () => {
    const { r } = mount(adapterWith(), { tab: 'trending' });
    keep(r);
    await flush();
    const item = r.get('.nf-home__item');
    const thumb = item.querySelector<HTMLElement>('.nf-card__thumb')!;
    act(() => {
      thumb.focus();
    });
    expect(item.querySelector('.nf-home__preview')).not.toBeNull();
  });

  it('navigates to watch / channel with the right routes', async () => {
    const { r, navigate } = mount(adapterWith(), { tab: 'trending' });
    keep(r);
    await flush();
    const trending = await adapterWith().feed({ source: 'trending', limit: 12 });
    const first = trending.items[0]!;
    click(r.get('.nf-card__thumb'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
    click(r.get('.nf-card__channel'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: first.author });
    click(r.get('.nf-card__title-button'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
  });

  it('passes followed tags to the adapter and shelves shorts separately (→ shorts route)', async () => {
    const adapter = adapterWith();
    const feed = vi.spyOn(adapter, 'feed');
    const { r, navigate } = mount(adapter, { tab: 'tags', followedTags: ['ceramics', 'space'] });
    keep(r);
    await flush();
    expect(feed).toHaveBeenCalledWith({ source: 'tags', limit: 12, tags: ['ceramics', 'space'] });
    const page = await adapter.feed({ source: 'tags', limit: 12, tags: ['ceramics', 'space'] });
    const longs = page.items.filter((v) => v.kind === 21);
    const shorts = page.items.filter((v) => v.kind === 22);
    expect(shorts.length).toBeGreaterThan(0);
    expect(r.all('.nf-home__grid .nf-card')).toHaveLength(longs.length);
    expect(r.all('.nf-home__shorts .nf-card--short')).toHaveLength(shorts.length);
    expect(r.get('.nf-home__shorts h2').textContent).toBe('Shorts');
    click(r.get('.nf-home__shorts .nf-card__thumb'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: shorts[0]!.id });
  });

  it('tabs are keyboard operable and announce the tab route', async () => {
    const { r, navigate } = mount(adapterWith(), { tab: 'subscriptions' });
    keep(r);
    await flush();
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    act(() => {
      tabs[0]!.focus();
    });
    keydown(r.get('[role="tablist"]'), 'ArrowRight');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'trending' });
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Trending');
    expect(document.activeElement).toBe(r.all('[role="tab"]')[1]);
    keydown(r.get('[role="tablist"]'), 'End');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'tags' });
    keydown(r.get('[role="tablist"]'), 'ArrowRight'); // wraps
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'subscriptions' });
    keydown(r.get('[role="tablist"]'), 'ArrowLeft'); // wraps back
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'tags' });
    click(r.all('[role="tab"]')[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'trending' });
    await flush();
    const panel = r.get('[role="tabpanel"]');
    expect(panel.getAttribute('aria-labelledby')).toBe(r.all('[role="tab"]')[1]!.id);
  });

  it('follows a changed `tab` prop', async () => {
    const adapter = adapterWith();
    const navigate = vi.fn<(to: Route) => void>();
    const el = (tab: HomeProps['tab']): ReactElement =>
      createElement(Home, { adapter, navigate, now: FIXTURE_NOW, tab });
    const r = keep(render(el('trending')));
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Trending');
    r.rerender(el('tags'));
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Your tags');
  });
});

describe('Home — infinite scroll', () => {
  it('falls back to a Load more button without IntersectionObserver and appends the next page', async () => {
    expect(typeof IntersectionObserver).toBe('undefined');
    const adapter = adapterWith();
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter, { tab: 'trending', pageSize: 4 });
    keep(r);
    await flush();
    expect(r.all('.nf-home__grid .nf-card')).toHaveLength(4);
    const more = r.all('button').find((b) => b.textContent === 'Load more')!;
    expect(more).toBeTruthy();
    click(more);
    expect(r.all('.nf-card--skeleton').length).toBeGreaterThan(0);
    await flush();
    expect(feed).toHaveBeenLastCalledWith({ source: 'trending', limit: 4, cursor: '4' });
    expect(r.all('.nf-home__grid .nf-card:not(.nf-card--skeleton)')).toHaveLength(8);
    const ids = r.all('.nf-card').map((c) => c.getAttribute('aria-label'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('observes a sentinel when IntersectionObserver exists and loads when it intersects', async () => {
    let callback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = (): IntersectionObserverEntry[] => [];
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    try {
      const adapter = adapterWith();
      const feed = vi.spyOn(adapter, 'feed');
      const { r } = mount(adapter, { tab: 'trending', pageSize: 4 });
      keep(r);
      await flush();
      expect(r.all('button').find((b) => b.textContent === 'Load more')).toBeUndefined();
      expect(observe).toHaveBeenCalledWith(r.get('.nf-home__sentinel'));
      act(() => {
        callback!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      await flush();
      expect(feed).toHaveBeenCalledWith({ source: 'trending', limit: 4, cursor: '4' });
      expect(r.all('.nf-home__grid .nf-card:not(.nf-card--skeleton)')).toHaveLength(8);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a failed next page inline with Retry and keeps the loaded cards', async () => {
    const base = adapterWith();
    let fail = true;
    const adapter = withFeed(base, (q) =>
      q.cursor !== undefined && fail
        ? Promise.reject(new Error('relay-down: no relays reachable'))
        : base.feed(q),
    );
    const { r } = mount(adapter, { tab: 'trending', pageSize: 4 });
    keep(r);
    await flush();
    click(r.all('button').find((b) => b.textContent === 'Load more')!);
    await flush();
    expect(r.all('.nf-home__grid .nf-card')).toHaveLength(4);
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Could not load more');
    fail = false;
    click(alert.querySelector('button')!);
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(r.all('.nf-home__grid .nf-card')).toHaveLength(8);
  });
});

describe('Home — empty states', () => {
  it('no subscriptions → designed empty + suggested channels, Subscribe reloads the feed', async () => {
    const adapter = adapterWith();
    for (const c of CHANNELS) await adapter.unsubscribe(c.pubkey);
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r, navigate } = mount(adapter, { tab: 'subscriptions' });
    keep(r);
    await flush();
    const status = r.get('[role="status"]');
    expect(status.getAttribute('data-preset')).toBe('no-subscriptions');
    expect(status.textContent).toContain('No subscriptions yet');
    expect(r.get('.nf-home__suggest h2').textContent).toBe('Suggested channels');
    const rows = r.all('.nf-home__suggest .nf-channel');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.length).toBeLessThanOrEqual(5);
    // "Explore trending" switches tab locally and announces the route.
    click(status.querySelector('button')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'trending' });
    await flush();
    expect(r.all('.nf-home__grid .nf-card').length).toBeGreaterThan(0);
    // Back to subscriptions, subscribe to the first suggestion → feed reloads with videos.
    click(r.all('[role="tab"]')[0]!);
    await flush();
    const firstRow = r.get('.nf-home__suggest .nf-channel');
    const name = firstRow.querySelector('.nf-channel__name')!.textContent;
    click(firstRow.querySelector('.nf-button')!);
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const subscribedTo = subscribe.mock.calls[0]![0];
    expect(CHANNELS.find((c) => c.pubkey === subscribedTo)!.profile.displayName).toBe(name);
    expect(r.all('[role="status"]')).toHaveLength(0);
    const cards = r.all('.nf-home__grid .nf-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(
      cards.every((c) => c.querySelector('.nf-card__channel-name')!.textContent === name),
    ).toBe(true);
  });

  it('subscriptions with no videos → "Nothing new" (no suggestions)', async () => {
    const adapter = adapterWith();
    for (const c of CHANNELS) await adapter.unsubscribe(c.pubkey);
    await adapter.subscribe(mocks.asPubkey('silent-channel'));
    const { r } = mount(adapter, { tab: 'subscriptions' });
    keep(r);
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Nothing new from your subscriptions');
    expect(r.all('.nf-home__suggest')).toHaveLength(0);
  });

  it('tags: "No videos for your tags" names the tags; no tags followed has its own copy', async () => {
    const a = mount(adapterWith(), { tab: 'tags', followedTags: ['woodworking', 'sailing'] });
    keep(a.r);
    await flush();
    const s = a.r.get('[role="status"]');
    expect(s.textContent).toContain('No videos for your tags');
    expect(s.textContent).toContain('#woodworking, #sailing');
    const b = mount(adapterWith(), { tab: 'tags', followedTags: [] });
    keep(b.r);
    await flush();
    expect(b.r.get('[role="status"]').textContent).toContain('not following any tags yet');
    click(b.r.get('[role="status"] button'));
    expect(b.navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'trending' });
  });

  it('trending empty → "Nothing trending yet"', async () => {
    const adapter = withFeed(adapterWith(), () => Promise.resolve({ items: [] }));
    const { r } = mount(adapter, { tab: 'trending' });
    keep(r);
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Nothing trending yet');
  });
});

describe('Home — errors', () => {
  it('relay down → ErrorState with the designed copy, never thrown; Retry refetches', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ failWith: 'relay-down' });
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter, { tab: 'trending' });
    keep(r);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.textContent).toContain('None of your relays answered');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    expect(feed).toHaveBeenCalledTimes(1);
    click(alert.querySelector('button')!);
    await flush();
    expect(feed).toHaveBeenCalledTimes(2);
    expect(r.get('[role="alert"]').textContent).toContain('Relay down');
    expect(errors).not.toHaveBeenCalled();
  });

  it('relay down on the identity call → same error on subscriptions', async () => {
    const { r } = mount(adapterWith({ failWith: 'relay-down' }), { tab: 'subscriptions' });
    keep(r);
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Relay down');
  });

  it('no-signer → signed-out copy; no-seeders / no-balance leave the feed intact', async () => {
    const a = mount(adapterWith({ failWith: 'no-signer' }), { tab: 'subscriptions' });
    keep(a.r);
    await flush();
    expect(a.r.get('[role="status"]').getAttribute('data-preset')).toBe('signer-not-detected');
    for (const failWith of ['no-seeders', 'no-balance'] as const) {
      const b = mount(adapterWith({ failWith }), { tab: 'trending' });
      keep(b.r);
      await flush();
      expect(b.r.all('.nf-home__grid .nf-card').length).toBeGreaterThan(0);
      expect(b.r.all('[role="alert"]')).toHaveLength(0);
    }
  });

  it('describeError maps relay failures and unknown values', () => {
    expect(describeError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeError('relay timed out').detail).toBe('relay timed out');
    expect(describeError(new Error('boom')).title).toBe('Something went wrong');
    expect(describeError(undefined).detail).toBeUndefined();
  });
});

describe('Home — cancellation', () => {
  it('unmounting mid-load cancels: the chain stops, no state updates, no errors', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ latencyMs: 1000 });
    for (const c of CHANNELS) void adapter.unsubscribe(c.pubkey);
    const feed = vi.spyOn(adapter, 'feed');
    const subscriptions = vi.spyOn(adapter, 'subscriptions');
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter, { tab: 'subscriptions' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500); // me() resolves → feed starts
    });
    expect(feed).toHaveBeenCalledTimes(1);
    r.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // The feed promise resolved after unmount; the cancelled effect must not continue into
    // `subscriptions()` (the empty-feed follow-up) nor resolve any images — i.e. no setState.
    expect(subscriptions).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('switching tabs mid-load abandons the old request and reloads it on return', async () => {
    vi.useFakeTimers();
    const adapter = adapterWith({ latencyMs: 1000 });
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter, { tab: 'trending' });
    keep(r);
    expect(feed).toHaveBeenCalledTimes(1);
    click(r.all('[role="tab"]')[2]!); // tags (needs identity → waits on me())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(feed).toHaveBeenCalledTimes(2);
    click(r.all('[role="tab"]')[1]!); // back to trending: it was interrupted → fetched again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(feed).toHaveBeenCalledTimes(3);
    expect(r.all('.nf-home__grid .nf-card').length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

describe('previewCostSats', () => {
  it('charges whole blocks of ~3 s at the cheapest rendition, at least one block', () => {
    const v = VIDEOS[0]!;
    const cheapest = [...v.renditions].sort((a, b) => a.size - b.size)[0]!;
    const bytes = cheapest.bitrateKbps! * 125 * 3;
    const blocks = Math.max(1, Math.ceil(bytes / v.price.blockSize));
    expect(previewCostSats(v)).toBe(blocks * v.price.satsPerBlock);
    expect(previewCostSats({ ...v, renditions: [] })).toBeUndefined();
    const tiny: VideoManifest = {
      ...v,
      renditions: [{ ...cheapest, bitrateKbps: 1, size: 10 }],
    };
    expect(previewCostSats(tiny)).toBe(v.price.satsPerBlock);
  });
});
