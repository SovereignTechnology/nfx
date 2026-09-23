/**
 * Library screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, price-before-play ordering, navigation routes, optimistic
 * Watch later removal with Undo/rollback, playlist create/open, empty/error copy, tab
 * keyboard operation and cancellation on unmount.
 */
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type {
  NetworkAdapter,
  NostrEventId,
  Page,
  Playlist,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import { click, keydown, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { LIBRARY_TABS, Library, type HistoryEntry, type LibraryProps } from '../Library.js';

const { MockNetworkAdapter, VIDEOS, CHANNELS, FIXTURE_NOW, ME } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];
type Lib = NetworkAdapter['library'];

const HOUR = 3600;
const DAY = 86_400;

function vid(i: number): VideoManifest {
  return VIDEOS[i]!;
}

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const rendered: Rendered[] = [];
function keep(r: Rendered): Rendered {
  rendered.push(r);
  return r;
}
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<LibraryProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = keep(
    render(
      createElement(Library, { adapter, navigate, now: FIXTURE_NOW, timeZone: 'UTC', ...props }),
    ),
  );
  return { r, navigate };
}

/** A mock with a settable clock so history entries land on chosen days (UTC). */
function adapterWith(opts: Opts = {}): {
  readonly adapter: mocks.MockNetworkAdapter;
  readonly setClock: (t: number) => void;
} {
  let clock: number = FIXTURE_NOW;
  const adapter = new MockNetworkAdapter({ now: () => clock as UnixSeconds, ...opts });
  return {
    adapter,
    setClock: (t) => {
      clock = t;
    },
  };
}

/** [video index, positionSec, seconds ago] — Today ×2, Yesterday ×2, Monday, Aug 28, 2024. */
const HISTORY: readonly (readonly [number, number, number])[] = [
  [0, 312, 1 * HOUR],
  [4, 41, 3 * HOUR],
  [1, 2800, 26 * HOUR],
  [2, 2, 30 * HOUR],
  [3, 640, 3 * DAY],
  [6, 1200, 7 * DAY],
  [11, 1900, 400 * DAY],
];

function seeded(opts: Opts = {}): mocks.MockNetworkAdapter {
  const { adapter, setClock } = adapterWith(opts);
  for (const [i, pos, ago] of HISTORY) {
    setClock(FIXTURE_NOW - ago);
    void adapter.library.recordProgress(vid(i).id, pos);
  }
  setClock(FIXTURE_NOW);
  for (const i of [7, 9]) void adapter.library.setWatchLater(vid(i).id, true);
  for (const i of [0, 5]) void adapter.react(vid(i).id, '+');
  void adapter.library.savePlaylist({
    id: 'space',
    title: 'Space deep dives',
    description: 'The **best** explainers. More at https://example.com/space',
    videoIds: [vid(0).id, vid(7).id],
    isPrivate: true,
  });
  void adapter.library.savePlaylist({
    id: 'empty',
    title: 'Empty one',
    videoIds: [],
    isPrivate: false,
  });
  return adapter;
}

function patched(
  base: NetworkAdapter,
  over: {
    readonly library?: Partial<Lib>;
    readonly video?: NetworkAdapter['video'];
    readonly me?: NetworkAdapter['me'];
    readonly signer?: NetworkAdapter['signer'];
  },
): NetworkAdapter {
  const library: Lib = { ...base.library, ...over.library };
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'library') return library;
      if (prop === 'video' && over.video) return over.video;
      if (prop === 'me' && over.me) return over.me;
      if (prop === 'signer' && over.signer) return over.signer;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
  readonly reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Sets a React-controlled input/textarea the way a user would. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')!;
  act(() => {
    descriptor.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonByText(r: Rendered, text: string): HTMLButtonElement {
  const b = r.all('button').find((x) => x.textContent === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

function titles(r: Rendered, scope: string): string[] {
  return r.all(`${scope} .nf-card__title-button`).map((b) => b.textContent);
}

/** Every price badge precedes every play-shaped control that shares its row. */
function expectPriceBeforePlay(row: Element, play: Element): void {
  const price = row.querySelector('.nf-sats--price');
  expect(price).not.toBeNull();
  expect(price!.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe('Library — structure and identity', () => {
  it('renders a landmark, the Library heading, four keyboard tabs and skeletons while loading', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }).adapter);
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Library');
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(LIBRARY_TABS.map((t) => t.label));
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('History');
    expect(r.get('[role="tabpanel"]').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-card--skeleton').length).toBeGreaterThan(0);
  });

  it('signed out → sign-in state per tab, no library call, Connect signer → settings', async () => {
    const { adapter } = adapterWith({ signedIn: false });
    const history = vi.spyOn(adapter.library, 'history');
    const playlists = vi.spyOn(adapter.library, 'playlists');
    const { r, navigate } = mount(adapter);
    await flush();
    const status = r.get('[role="status"]');
    expect(status.getAttribute('data-preset')).toBe('signer-not-detected');
    expect(status.textContent).toContain('Sign in to see your history');
    expect(status.textContent).toContain('NIP-51');
    click(buttonByText(r, 'Playlists'));
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Sign in to see your playlists');
    click(buttonByText(r, 'Connect signer'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
    expect(history).not.toHaveBeenCalled();
    expect(playlists).not.toHaveBeenCalled();
  });

  it('a locked signer gets "unlock" copy rather than "sign in"', async () => {
    const { adapter } = adapterWith();
    const { r, navigate } = mount(
      patched(adapter, {
        me: () => Promise.resolve(null),
        signer: () =>
          Promise.resolve({ kind: 'local', pubkey: ME, locked: true, supportsSignSecret: true }),
      }),
    );
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Your signer is locked');
    click(buttonByText(r, 'Unlock in Settings'));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings' });
  });

  it('failWith no-signer → the sign-in state', async () => {
    const { r } = mount(adapterWith({ failWith: 'no-signer' }).adapter, { tab: 'liked' });
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Sign in to see the videos you liked');
  });
});

describe('Library — tabs', () => {
  it('tabs are keyboard operable and every change goes through navigate', async () => {
    const { r, navigate } = mount(seeded());
    await flush();
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    act(() => {
      tabs[0]!.focus();
    });
    keydown(r.get('[role="tablist"]'), 'ArrowRight');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'watch-later' });
    expect(document.activeElement).toBe(r.all('[role="tab"]')[1]);
    keydown(r.get('[role="tablist"]'), 'End');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'liked' });
    keydown(r.get('[role="tablist"]'), 'ArrowRight'); // wraps
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'history' });
    keydown(r.get('[role="tablist"]'), 'ArrowLeft'); // wraps back
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'liked' });
    keydown(r.get('[role="tablist"]'), 'Home');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'history' });
    click(r.all('[role="tab"]')[2]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'playlists' });
    await flush();
    expect(r.get('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe(
      r.all('[role="tab"]')[2]!.id,
    );
  });

  it('follows a changed `tab` prop and caches each list for the session', async () => {
    const adapter = seeded();
    const watchLater = vi.spyOn(adapter.library, 'watchLater');
    const navigate = vi.fn<(to: Route) => void>();
    const el = (tab: LibraryProps['tab']): ReactElement =>
      createElement(Library, { adapter, navigate, now: FIXTURE_NOW, timeZone: 'UTC', tab });
    const r = keep(render(el('history')));
    await flush();
    r.rerender(el('watch-later'));
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Watch later');
    expect(r.get('.nf-library__hero-title').textContent).toBe('Watch later');
    r.rerender(el('history'));
    await flush();
    r.rerender(el('watch-later'));
    await flush();
    expect(watchLater).toHaveBeenCalledTimes(1);
  });
});

describe('Library — History', () => {
  it('groups by day (Today / Yesterday / weekday / date), with progress and hash-checked thumbs', async () => {
    const adapter = seeded();
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter, { tab: 'history' });
    await flush();
    expect(r.all('.nf-library__day-title').map((h) => h.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Monday',
      'Aug 28',
      'Jul 31, 2024',
    ]);
    const rows = r.all('.nf-library__row');
    expect(rows).toHaveLength(HISTORY.length);
    const thumb = vid(0).renditions[0]!.image!;
    expect(image).toHaveBeenCalledWith(thumb.url, thumb.sha256);
    expect(rows[0]!.querySelector('.nf-card__img')!.getAttribute('src')).toBe(thumb.url);
    // 312 s of 754 s → 41.4 %; the watched Raku session is a full bar.
    expect(rows[0]!.querySelector<HTMLElement>('.nf-card__progress-bar')!.style.width).toBe(
      '41.4%',
    );
    expect(rows[2]!.querySelector<HTMLElement>('.nf-card__progress-bar')!.style.width).toBe('100%');
    expect(r.all('.nf-library__resume').map((b) => b.textContent)).toEqual([
      'Resume at 5:12',
      'Watch again', // a short
      'Watch again', // watched to the end
      'Watch', // 2 s in: starts over
      'Resume at 10:40',
      'Resume at 20:00',
      'Resume at 31:40',
    ]);
    expect(r.get('.nf-library__hint').textContent).toContain('encrypted to your key');
  });

  it('shows the price on every row before its resume control', async () => {
    const { r } = mount(seeded(), { tab: 'history' });
    await flush();
    const rows = r.all('.nf-library__row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expectPriceBeforePlay(row, row.querySelector('.nf-library__resume')!);
  });

  it('resumes at the recorded position; watched/barely-started start over; shorts → shorts', async () => {
    const { r, navigate } = mount(seeded(), { tab: 'history' });
    await flush();
    const resume = r.all('.nf-library__resume');
    click(resume[0]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(0).id, t: 312 });
    click(r.all('.nf-library__row .nf-card__thumb')[0]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(0).id, t: 312 });
    click(resume[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: vid(4).id });
    click(resume[2]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(1).id });
    click(resume[3]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(2).id });
    click(r.all('.nf-library__row .nf-card__channel')[0]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: vid(0).author });
  });

  it('paginates with a Load more fallback and reports a failed page inline with Retry', async () => {
    expect(typeof IntersectionObserver).toBe('undefined');
    const base = seeded();
    const all = base.library.history.bind(base.library);
    let fail = true;
    const history = vi.fn(async (cursor?: string): Promise<Page<HistoryEntry>> => {
      const page = await all();
      if (cursor === undefined) return { items: page.items.slice(0, 4), next: '4' };
      if (fail) throw new Error('relay-down: no relays reachable');
      return { items: page.items.slice(4) };
    });
    const { r } = mount(patched(base, { library: { history } }), { tab: 'history' });
    await flush();
    expect(r.all('.nf-library__row')).toHaveLength(4);
    click(buttonByText(r, 'Load more'));
    await flush();
    expect(history).toHaveBeenLastCalledWith('4');
    expect(r.all('.nf-library__row')).toHaveLength(4);
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Could not load more');
    fail = false;
    click(alert.querySelector('button')!);
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(r.all('.nf-library__row')).toHaveLength(HISTORY.length);
    expect(r.all('button').find((b) => b.textContent === 'Load more')).toBeUndefined();
  });

  it('observes a sentinel when IntersectionObserver exists', async () => {
    let callback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe = observe;
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = (): IntersectionObserverEntry[] => [];
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    try {
      const base = seeded();
      const all = base.library.history.bind(base.library);
      const history = vi.fn(async (cursor?: string): Promise<Page<HistoryEntry>> => {
        const page = await all();
        return cursor === undefined
          ? { items: page.items.slice(0, 4), next: '4' }
          : { items: page.items.slice(4) };
      });
      const { r } = mount(patched(base, { library: { history } }), { tab: 'history' });
      await flush();
      expect(observe).toHaveBeenCalledWith(r.get('.nf-library__sentinel'));
      act(() => {
        callback!(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      await flush();
      expect(history).toHaveBeenLastCalledWith('4');
      expect(r.all('.nf-library__row')).toHaveLength(HISTORY.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Library — Watch later', () => {
  it('lists the saved videos under a hero, each with its price; opening → watch', async () => {
    const { r, navigate } = mount(seeded(), { tab: 'watch-later' });
    await flush();
    expect(r.get('.nf-library__hero-title').textContent).toBe('Watch later');
    expect(r.get('.nf-library__hero-meta').textContent).toBe('3 videos');
    expect(titles(r, '.nf-library__list')).toEqual([vid(3).title, vid(7).title, vid(9).title]);
    for (const item of r.all('.nf-library__item')) {
      expect(item.querySelector('.nf-sats--price')).not.toBeNull();
    }
    click(r.all('.nf-library__item .nf-card__title-button')[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(7).id });
  });

  it('removes optimistically, then offers Undo, which puts it back where it was', async () => {
    const base = seeded();
    const pending = deferred<undefined>();
    const setWatchLater = vi.fn((_id: NostrEventId, on: boolean) =>
      on ? Promise.resolve() : pending.promise.then(() => undefined),
    );
    const { r } = mount(patched(base, { library: { setWatchLater } }), { tab: 'watch-later' });
    await flush();
    click(r.all('.nf-library__remove')[1]!);
    // Gone before the adapter answered.
    expect(titles(r, '.nf-library__list')).toEqual([vid(3).title, vid(9).title]);
    expect(setWatchLater).toHaveBeenLastCalledWith(vid(7).id, false);
    expect(r.all('.nf-toast')).toHaveLength(0);
    pending.resolve(undefined);
    await flush();
    const toast = r.get('.nf-toast');
    expect(toast.textContent).toContain('Removed from Watch later');
    expect(toast.textContent).toContain(vid(7).title);
    click(toast.querySelector('.nf-toast__action')!);
    expect(titles(r, '.nf-library__list')).toEqual([vid(3).title, vid(7).title, vid(9).title]);
    expect(setWatchLater).toHaveBeenLastCalledWith(vid(7).id, true);
    expect(r.all('.nf-toast')).toHaveLength(0);
  });

  it('rolls back on error, says so, and Retry tries again', async () => {
    const base = seeded();
    let fail = true;
    const setWatchLater = vi.fn(() =>
      fail ? Promise.reject(new Error('relay-down: no relays reachable')) : Promise.resolve(),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { r } = mount(patched(base, { library: { setWatchLater } }), { tab: 'watch-later' });
    await flush();
    click(r.all('.nf-library__remove')[0]!);
    expect(titles(r, '.nf-library__list')).toEqual([vid(7).title, vid(9).title]);
    await flush();
    expect(titles(r, '.nf-library__list')).toEqual([vid(3).title, vid(7).title, vid(9).title]);
    const toast = r.get('.nf-toast--error');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.textContent).toContain('Could not remove from Watch later');
    expect(toast.textContent).toContain('is back in your list');
    fail = false;
    click(toast.querySelector('.nf-toast__action')!);
    await flush();
    expect(setWatchLater).toHaveBeenCalledTimes(2);
    expect(titles(r, '.nf-library__list')).toEqual([vid(7).title, vid(9).title]);
    expect(r.get('.nf-toast').textContent).toContain('Removed from Watch later');
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('Library — Playlists', () => {
  it('shows a grid of playlists with private/public indicators and verified covers', async () => {
    const adapter = seeded();
    const video = vi.spyOn(adapter, 'video');
    const { r } = mount(adapter, { tab: 'playlists' });
    await flush();
    const tiles = r.all('.nf-library__tile');
    expect(tiles.map((t) => t.querySelector('.nf-library__tile-open')!.textContent)).toEqual([
      'Ceramics binge',
      'Space deep dives',
      'Empty one',
    ]);
    expect(tiles.map((t) => t.querySelector('.nf-library__visibility')!.textContent)).toEqual([
      'Public',
      'Private',
      'Public',
    ]);
    expect(tiles[1]!.querySelector('.nf-library__visibility--private')).not.toBeNull();
    expect(tiles.map((t) => t.querySelector('.nf-library__tile-count')!.textContent)).toEqual([
      '3 videos',
      '2 videos',
      'No videos',
    ]);
    expect(video).toHaveBeenCalledWith(vid(0).id); // cover of "Space deep dives"
    expect(tiles[1]!.querySelector('.nf-library__cover-img')!.getAttribute('src')).toBe(
      vid(0).renditions[0]!.image!.url,
    );
    expect(tiles[2]!.querySelector('.nf-library__cover-empty')).not.toBeNull();
    expect(r.get('.nf-library__count').textContent).toBe('3 playlists');
  });

  it('opens a playlist (videos resolved by id, description through Markdown) and goes back', async () => {
    const adapter = seeded();
    const video = vi.spyOn(adapter, 'video');
    const { r, navigate } = mount(adapter, { tab: 'playlists' });
    await flush();
    const open = r.all('.nf-library__tile-open')[1]!;
    click(open);
    await flush();
    expect(video).toHaveBeenCalledWith(vid(7).id);
    const heading = r.get('.nf-library__hero-title');
    expect(heading.textContent).toBe('Space deep dives');
    expect(document.activeElement).toBe(heading);
    expect(r.get('.nf-library__hero-meta').textContent).toContain('Private');
    expect(r.get('.nf-library__hero-desc strong').textContent).toBe('best');
    const link = r.get('.nf-library__hero-desc a');
    expect(link.getAttribute('href')).toBe('https://example.com/space');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(titles(r, '.nf-library__list')).toEqual([vid(0).title, vid(7).title]);
    for (const item of r.all('.nf-library__item')) {
      expect(item.querySelector('.nf-sats--price')).not.toBeNull();
    }
    click(r.all('.nf-library__item .nf-card__thumb')[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(7).id });
    click(buttonByText(r, 'All playlists'));
    await flush();
    expect(r.all('.nf-library__tile')).toHaveLength(3);
    expect(document.activeElement).toBe(r.all('.nf-library__tile-open')[1]);
  });

  it('shows unavailable and failed entries, and retries the failed one', async () => {
    const base = seeded();
    const gone = mocks.asEventId('gone');
    const flaky = mocks.asEventId('flaky');
    void base.library.savePlaylist({
      id: 'mixed',
      title: 'Mixed',
      videoIds: [vid(3).id, gone, flaky],
      isPrivate: false,
    });
    let failing = true;
    const real = base.video.bind(base);
    const video = vi.fn((id: NostrEventId) =>
      id === flaky
        ? failing
          ? Promise.reject(new Error('relay timed out'))
          : Promise.resolve(vid(8))
        : real(id),
    );
    const { r } = mount(patched(base, { video }), { playlistId: 'mixed' });
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Playlists');
    const items = r.all('.nf-library__item');
    expect(items).toHaveLength(3);
    expect(items[1]!.textContent).toContain('Video unavailable');
    expect(items[2]!.textContent).toContain('Could not load this video');
    failing = false;
    click(items[2]!.querySelector('button')!);
    await flush();
    expect(titles(r, '.nf-library__list')).toEqual([vid(3).title, vid(8).title]);
  });

  it('an unknown playlist id → "Playlist not found" with a way back', async () => {
    const { r } = mount(seeded(), { playlistId: 'nope' });
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Playlist not found');
    click(buttonByText(r, 'All playlists'));
    await flush();
    expect(r.all('.nf-library__tile').length).toBeGreaterThan(0);
  });

  it('creates a playlist (title, description, private toggle) and shows it first', async () => {
    const adapter = seeded();
    const save = vi.spyOn(adapter.library, 'savePlaylist');
    const { r } = mount(adapter, { tab: 'playlists' });
    await flush();
    click(buttonByText(r, 'New playlist'));
    await flush();
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('New playlist');
    const create = buttonByText(r, 'Create');
    expect(create.disabled).toBe(true);
    const title = dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(document.activeElement).toBe(title);
    typeInto(title, '  Kiln builds  ');
    typeInto(dialog.querySelector('textarea')!, 'Wood-fired, *mostly*.');
    const priv = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(priv.checked).toBe(true); // private by default
    click(priv);
    expect(dialog.textContent).toContain('anyone can see it');
    expect(create.disabled).toBe(false);
    click(create);
    await flush();
    expect(save).toHaveBeenCalledWith({
      title: 'Kiln builds',
      description: 'Wood-fired, *mostly*.',
      videoIds: [],
      isPrivate: false,
    });
    expect(r.all('[role="dialog"]')).toHaveLength(0);
    const first = r.get('.nf-library__tile');
    expect(first.querySelector('.nf-library__tile-open')!.textContent).toBe('Kiln builds');
    expect(first.querySelector('.nf-library__visibility')!.textContent).toBe('Public');
    expect(r.get('.nf-toast').textContent).toContain('Playlist created');
  });

  it('a failed create keeps the dialog and what was typed, with the error inside', async () => {
    const base = seeded();
    const savePlaylist = vi.fn((): Promise<Playlist> =>
      Promise.reject(new Error('relay-down: no relays reachable')),
    );
    const { r } = mount(patched(base, { library: { savePlaylist } }), { tab: 'playlists' });
    await flush();
    click(buttonByText(r, 'New playlist'));
    await flush();
    const dialog = r.get('[role="dialog"]');
    typeInto(dialog.querySelector<HTMLInputElement>('input[type="text"]')!, 'Draft');
    click(buttonByText(r, 'Create'));
    await flush();
    expect(savePlaylist).toHaveBeenCalledWith({ title: 'Draft', videoIds: [], isPrivate: true });
    expect(r.get('[role="dialog"] [role="alert"]').textContent).toContain(
      'Could not create the playlist',
    );
    expect((r.get('[role="dialog"] input[type="text"]') as HTMLInputElement).value).toBe('Draft');
  });
});

describe('Library — Liked', () => {
  it('shows liked videos in a grid (shorts shelved) with prices; opening routes by kind', async () => {
    const { r, navigate } = mount(seeded(), { tab: 'liked' });
    await flush();
    expect(r.get('.nf-library__count').textContent).toBe('3 liked videos');
    expect(titles(r, '.nf-library__grid')).toEqual([vid(0).title, vid(1).title]);
    expect(titles(r, '.nf-library__shorts')).toEqual([vid(5).title]);
    for (const cell of r.all('.nf-library__cell')) {
      expect(cell.querySelector('.nf-sats--price')).not.toBeNull();
    }
    expect(r.get('.nf-library__hint').textContent).toContain('public');
    click(r.get('.nf-library__grid .nf-card__thumb'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: vid(0).id });
    click(r.get('.nf-library__shorts .nf-card__thumb'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: vid(5).id });
  });
});

describe('Library — empty states', () => {
  it('history empty → "Nothing watched yet" → Explore trending', async () => {
    const { r, navigate } = mount(adapterWith().adapter, { tab: 'history' });
    await flush();
    const status = r.get('[role="status"]');
    expect(status.getAttribute('data-preset')).toBe('no-history');
    expect(status.textContent).toContain('Nothing watched yet');
    click(status.querySelector('button')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'home', tab: 'trending' });
  });

  it('watch later, liked and playlists each have their own empty copy', async () => {
    const a = adapterWith().adapter;
    await a.library.setWatchLater(vid(3).id, false);
    await a.react(vid(1).id, '-');
    const wl = mount(a, { tab: 'watch-later' });
    await flush();
    expect(wl.r.get('[role="status"]').textContent).toContain('Nothing saved for later');
    const liked = mount(a, { tab: 'liked' });
    await flush();
    expect(liked.r.get('[role="status"]').textContent).toContain('No liked videos yet');
    const pl = mount(patched(a, { library: { playlists: () => Promise.resolve([]) } }), {
      tab: 'playlists',
    });
    await flush();
    expect(pl.r.get('[role="status"]').textContent).toContain('No playlists yet');
    click(pl.r.get('[role="status"] button'));
    await flush();
    expect(pl.r.get('[role="dialog"]').textContent).toContain('New playlist');
  });

  it('an empty playlist says so under its hero', async () => {
    const { r } = mount(seeded(), { playlistId: 'empty' });
    await flush();
    expect(r.get('.nf-library__hero-title').textContent).toBe('Empty one');
    expect(r.get('[role="status"]').textContent).toContain('This playlist is empty');
  });
});

describe('Library — errors', () => {
  it('relay down → ErrorState with the designed copy, never thrown; Retry asks again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { adapter } = adapterWith({ failWith: 'relay-down' });
    const me = vi.spyOn(adapter, 'me');
    const { r } = mount(adapter);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    expect(me).toHaveBeenCalledTimes(1);
    click(alert.querySelector('button')!);
    await flush();
    expect(me).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('one list failing → its own error; Retry recovers it', async () => {
    const base = seeded();
    let fail = true;
    const real = base.library.playlists.bind(base.library);
    const playlists = vi.fn(() =>
      fail ? Promise.reject(new Error('decrypt failed: signer did not answer')) : real(),
    );
    const { r } = mount(patched(base, { library: { playlists } }), { tab: 'playlists' });
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Could not unlock your library');
    fail = false;
    click(r.get('[role="alert"] button'));
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(r.all('.nf-library__tile').length).toBeGreaterThan(0);
  });

  it('no-seeders / no-balance leave the library intact (they matter on Watch)', async () => {
    for (const failWith of ['no-seeders', 'no-balance'] as const) {
      const { r } = mount(seeded({ failWith }), { tab: 'watch-later' });
      await flush();
      expect(r.all('.nf-library__item').length).toBeGreaterThan(0);
      expect(r.all('[role="alert"]')).toHaveLength(0);
    }
  });
});

describe('Library — cancellation', () => {
  it('unmounting mid-load cancels: no follow-up calls, no state updates, no errors', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = seeded({ latencyMs: 1000 });
    const history = vi.spyOn(adapter.library, 'history');
    const image = vi.spyOn(adapter, 'image');
    const profile = vi.spyOn(adapter, 'profile');
    const navigate = vi.fn<(to: Route) => void>();
    const r = render(
      createElement(Library, { adapter, navigate, now: FIXTURE_NOW, timeZone: 'UTC' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500); // me() resolves → history() starts
    });
    expect(history).toHaveBeenCalledTimes(1);
    r.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // history() resolved after unmount; the cancelled load must not go on to resolve media.
    expect(image).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('switching tabs mid-load abandons the request and reloads it on return', async () => {
    vi.useFakeTimers();
    const adapter = seeded({ latencyMs: 1000 });
    const history = vi.spyOn(adapter.library, 'history');
    const watchLater = vi.spyOn(adapter.library, 'watchLater');
    const r = keep(
      render(
        createElement(Library, {
          adapter,
          navigate: vi.fn(),
          now: FIXTURE_NOW,
          timeZone: 'UTC',
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(history).toHaveBeenCalledTimes(1);
    click(r.all('[role="tab"]')[1]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(watchLater).toHaveBeenCalledTimes(1);
    expect(r.all('.nf-library__item').length).toBeGreaterThan(0);
    click(r.all('[role="tab"]')[0]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(history).toHaveBeenCalledTimes(2);
    expect(r.all('.nf-library__row')).toHaveLength(HISTORY.length);
    vi.useRealTimers();
  });
});

describe('Library — profiles', () => {
  it('resolves each channel once and shows its name', async () => {
    const adapter = seeded();
    const profile = vi.spyOn(adapter, 'profile');
    const { r } = mount(adapter, { tab: 'history' });
    await flush();
    const authors = new Set(HISTORY.map(([i]) => vid(i).author));
    expect(profile).toHaveBeenCalledTimes(authors.size);
    const channel = CHANNELS.find((c) => c.pubkey === vid(0).author)!;
    expect(r.get('.nf-library__row .nf-card__channel-name').textContent).toBe(
      channel.profile.displayName,
    );
  });
});
