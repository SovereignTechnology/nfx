/**
 * Search screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers the debounce, stale-response protection, filters → adapter.search args,
 * price-before-play ordering, snippets, the Shorts shelf, channel results, empty/error copy,
 * pagination, cancellation on unmount and the /-to-focus shortcut.
 */
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type { NetworkAdapter, Page, VideoManifest } from '@sovit/core';
import { click, keydown, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import {
  DEFAULT_SEARCH_FILTERS,
  SEARCH_DEBOUNCE_MS,
  Search,
  buildSearchFilters,
  describeSearchError,
  matchesChannelQuery,
  normalizeSearchFilters,
  parseSearchTags,
  type SearchFilterState,
  type SearchProps,
} from '../Search.js';

const { MockNetworkAdapter, VIDEOS, CHANNELS, FIXTURE_NOW } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];
type SearchQuery = Parameters<NetworkAdapter['search']>[0];

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

/** Advances fake timers inside act (debounce windows). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

type Props = Partial<Omit<SearchProps, 'adapter' | 'navigate'>>;

function mount(
  adapter: NetworkAdapter,
  props: Props = {},
): {
  readonly r: Rendered;
  readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>>;
  readonly rerender: (next: Props) => void;
} {
  const navigate = vi.fn<(to: Route) => void>();
  const el = (p: Props): ReactElement =>
    createElement(Search, { adapter, navigate, now: FIXTURE_NOW, ...p });
  const r = render(el(props));
  rendered.push(r);
  return {
    r,
    navigate,
    rerender: (next) => {
      r.rerender(el(next));
    },
  };
}

function adapterWith(opts: Opts = {}): mocks.MockNetworkAdapter {
  return new MockNetworkAdapter(opts);
}

function withSearch(
  base: NetworkAdapter,
  search: (q: SearchQuery) => Promise<Page<VideoManifest>>,
): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'search') return search;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Types into a controlled input (React listens for `input`). */
function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    // The prototype setter (not the instance one React tracks) so React sees a change.
    Reflect.set(HTMLInputElement.prototype, 'value', value, el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(el: HTMLSelectElement, value: string): void {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(r: Rendered, text: string): HTMLElement {
  const b = r.all('button').find((el) => el.textContent.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

function openFilters(r: Rendered): void {
  const toggle = r.get('.nf-search__filters-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') click(toggle);
}

function radio(r: Rendered, label: string): HTMLInputElement {
  const opt = r.all('.nf-search__option').find((l) => l.textContent.trim() === label);
  if (!opt) throw new Error(`no filter option "${label}"`);
  return opt.querySelector('input[type="radio"]')!;
}

/** Every rendered result card (rows + shelf), in DOM order. */
function cards(r: Rendered): HTMLElement[] {
  return r.all('.nf-search__item .nf-card:not(.nf-card--skeleton), .nf-search__short .nf-card');
}

const kiln = CHANNELS[1]!; // "Kilnfire Ceramics" — not subscribed in the mock
const orbital = CHANNELS[0]!; // "Orbital Mechanics" — subscribed in the mock
const lowTide = CHANNELS[2]!; // "Low Tide Sessions" — subscribed in the mock

describe('Search — structure and keyboard', () => {
  it('renders a landmark, a real search box and an idle hint before any query', () => {
    const { r } = mount(adapterWith());
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Search');
    const input = r.get('form[role="search"] input[type="search"]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Search videos');
    expect(input.value).toBe('');
    expect(r.get('[role="status"]').textContent).toContain('Search Nutflix');
    expect(r.all('.nf-card')).toHaveLength(0);
  });

  it('shows the route query in the box and follows a changed `q` prop', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r, rerender } = mount(adapter, { q: 'space' });
    await flush();
    expect((r.get('input[type="search"]') as HTMLInputElement).value).toBe('space');
    expect(cards(r).length).toBeGreaterThan(0);
    rerender({ q: 'ceramics' });
    await flush();
    expect((r.get('input[type="search"]') as HTMLInputElement).value).toBe('ceramics');
    expect(search).toHaveBeenLastCalledWith({ text: 'ceramics' });
    // Re-rendering with the same route is a no-op (no refetch).
    rerender({ q: 'ceramics' });
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('Enter commits immediately (no debounce wait) and announces the search route', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r, navigate } = mount(adapter);
    const input = r.get('input[type="search"]') as HTMLInputElement;
    typeInto(input, '  ceramics ');
    keydown(input, 'Enter');
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenLastCalledWith({ text: 'ceramics' });
    expect(navigate).toHaveBeenCalledWith({ name: 'search', q: 'ceramics' });
    await flush();
    expect(cards(r).length).toBeGreaterThan(0);
  });

  it('/ anywhere focuses the search box (but not while typing in another field)', () => {
    const { r } = mount(adapterWith());
    const input = r.get('input[type="search"]') as HTMLInputElement;
    keydown(document.body, '/');
    expect(document.activeElement).toBe(input);
    openFilters(r);
    const tags = r.get('.nf-search__filters input[type="text"]') as HTMLInputElement;
    act(() => {
      tags.focus();
    });
    keydown(tags, '/');
    expect(document.activeElement).toBe(tags);
  });
});

describe('Search — debounce, staleness and the adapter contract', () => {
  it('debounces typing by ~300 ms into one adapter.search with the trimmed text', async () => {
    vi.useFakeTimers();
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r } = mount(adapter);
    const input = r.get('input[type="search"]') as HTMLInputElement;
    typeInto(input, 'c');
    typeInto(input, 'ce');
    typeInto(input, 'ceramics ');
    expect(search).not.toHaveBeenCalled();
    await advance(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();
    await advance(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ text: 'ceramics' });
    await advance(50);
    expect(cards(r).length).toBeGreaterThan(0);
  });

  it('clearing the box returns to the idle hint without a search', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r } = mount(adapter, { q: 'ceramics' });
    await flush();
    expect(cards(r).length).toBeGreaterThan(0);
    vi.useFakeTimers();
    typeInto(r.get('input[type="search"]') as HTMLInputElement, '');
    await advance(SEARCH_DEBOUNCE_MS + 10);
    expect(r.get('[role="status"]').textContent).toContain('Search Nutflix');
    expect(r.all('.nf-card')).toHaveLength(0);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('a slow answer to an OLDER query never overwrites the newer query’s results', async () => {
    const pending = new Map<string, Deferred<Page<VideoManifest>>>();
    const base = adapterWith();
    const adapter = withSearch(base, (q) => {
      const d = deferred<Page<VideoManifest>>();
      pending.set(q.text, d);
      return d.promise;
    });
    const { r, rerender } = mount(adapter, { q: 'ceramics' });
    rerender({ q: 'space' });
    expect([...pending.keys()]).toEqual(['ceramics', 'space']);
    // The newer query answers first…
    pending.get('space')!.resolve(await base.search({ text: 'space' }));
    await flush();
    // …then the stale one arrives late (and a stale failure must not surface either).
    pending.get('ceramics')!.resolve(await base.search({ text: 'ceramics' }));
    await flush();
    const titles = cards(r).map((c) => c.getAttribute('aria-label'));
    const space = (await base.search({ text: 'space' })).items.map((v) => v.title);
    expect(titles.sort()).toEqual([...space].sort());
    expect(r.get('.nf-search__results').textContent).not.toContain('Raku');
    expect(r.get('.nf-search__count').textContent).toContain('“space”');
  });

  it('a stale failure for an older query does not replace newer results with an error', async () => {
    const pending = new Map<string, Deferred<Page<VideoManifest>>>();
    const base = adapterWith();
    const adapter = withSearch(base, (q) => {
      const d = deferred<Page<VideoManifest>>();
      pending.set(q.text, d);
      return d.promise;
    });
    const { r, rerender } = mount(adapter, { q: 'ceramics' });
    rerender({ q: 'space' });
    pending.get('space')!.resolve(await base.search({ text: 'space' }));
    await flush();
    pending.get('ceramics')!.reject(new Error('relay-down: late'));
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(cards(r).length).toBeGreaterThan(0);
  });

  it('a next page of an older query is dropped, even while the newer query loads its own', async () => {
    const first: Record<string, VideoManifest> = { a: VIDEOS[0]!, b: VIDEOS[2]! };
    const second: Record<string, VideoManifest> = { a: VIDEOS[3]!, b: VIDEOS[6]! };
    const page2 = new Map<string, Deferred<Page<VideoManifest>>>();
    const adapter = withSearch(adapterWith(), (q) => {
      if (q.cursor === undefined) return Promise.resolve({ items: [first[q.text]!], next: 'p2' });
      const d = deferred<Page<VideoManifest>>();
      page2.set(q.text, d);
      return d.promise;
    });
    const { r, rerender } = mount(adapter, { q: 'a' });
    await flush();
    click(button(r, 'Load more')); // page 2 of "a" is now in flight…
    rerender({ q: 'b' }); // …when the viewer searches again
    await flush();
    click(button(r, 'Load more')); // and asks for page 2 of "b"
    page2.get('a')!.resolve({ items: [second['a']!] });
    await flush();
    const titles = (): (string | null)[] => cards(r).map((c) => c.getAttribute('aria-label'));
    expect(titles()).toEqual([first['b']!.title]);
    page2.get('b')!.resolve({ items: [second['b']!] });
    await flush();
    expect(titles()).toEqual([first['b']!.title, second['b']!.title]);
  });

  it('without a `now` prop the clock is read once: a later re-render does not re-search', async () => {
    vi.useFakeTimers();
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const navigate = vi.fn<(to: Route) => void>();
    const el = (): ReactElement =>
      createElement(Search, { adapter, navigate, q: 'space', filters: { uploaded: 'year' } });
    const r = render(el());
    rendered.push(r);
    await advance(50);
    expect(search).toHaveBeenCalledTimes(1);
    await advance(5_000);
    r.rerender(el());
    await advance(50);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('a synchronous throw from adapter.search becomes an ErrorState, never a crash', async () => {
    const adapter = withSearch(adapterWith(), () => {
      throw new Error('boom');
    });
    const { r } = mount(adapter, { q: 'space' });
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Search failed');
  });
});

describe('Search — result rows and price-before-play', () => {
  it('renders a YouTube-style row per hit: hash-checked thumbnail, channel, stats, list layout', async () => {
    const adapter = adapterWith();
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter, { q: 'space' });
    await flush();
    const expected = (await adapter.search({ text: 'space' })).items.filter((v) => v.kind === 21);
    const rows = r.all('.nf-search__item');
    expect(rows).toHaveLength(expected.length);
    const first = expected[0]!;
    expect(rows[0]!.textContent).toContain(first.title);
    const thumb = first.renditions[0]!.image!;
    expect(image).toHaveBeenCalledWith(thumb.url, thumb.sha256);
    expect(rows[0]!.querySelector('.nf-card__img')!.getAttribute('src')).toBe(thumb.url);
    const channel = CHANNELS.find((c) => c.pubkey === first.author)!;
    expect(rows[0]!.querySelector('.nf-card__channel')!.textContent).toContain(
      channel.profile.displayName,
    );
    expect(rows[0]!.querySelector('.nf-card__meta')!.textContent).toContain('paid views');
    expect(rows[0]!.querySelector('.nf-card')!.classList).toContain('nf-card--list');
    expect(rows[0]!.querySelector('.nf-card--grid')).toBeNull();
  });

  it('shows a two-line description snippet rendered through Markdown only', async () => {
    const base = adapterWith();
    const video = VIDEOS.find((v) => v.kind === 21)!;
    const hostile: VideoManifest = {
      ...video,
      description: 'Plain **bold** words.\n\n<img src=x onerror="alert(1)"> <script>x()</script>',
    };
    const adapter = withSearch(base, () => Promise.resolve({ items: [hostile] }));
    const { r } = mount(adapter, { q: 'anything' });
    await flush();
    const snippet = r.get('.nf-search__item .nf-search__snippet');
    expect(snippet.querySelector('.nf-md')).not.toBeNull();
    expect(snippet.querySelector('strong')!.textContent).toBe('bold');
    // Raw HTML is text, never markup.
    expect(snippet.querySelector('img, script')).toBeNull();
    expect(snippet.textContent).toContain('<img src=x onerror="alert(1)">');
    // The snippet sits in the row, after the card (text column under the meta line).
    const card = r.get('.nf-search__item .nf-card');
    expect(card.compareDocumentPosition(snippet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('every card shows its SatsBadge price on the thumbnail, before the title control', async () => {
    const { r } = mount(adapterWith(), { q: 'a' });
    await flush();
    const all = cards(r);
    expect(all.length).toBeGreaterThan(3);
    let sawShort = false;
    for (const card of all) {
      const price = card.querySelector('.nf-sats--price');
      expect(price).not.toBeNull();
      const thumb = card.querySelector('.nf-card__thumb')!;
      const title = card.querySelector('.nf-card__title-button')!;
      expect(thumb.contains(price)).toBe(true);
      expect(price!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(price!.getAttribute('aria-label')).toMatch(/\d.* sats/);
      if (card.classList.contains('nf-card--short')) sawShort = true;
    }
    expect(sawShort).toBe(true);
  });

  it('puts kind-22 hits in a Shorts shelf after the third video row', async () => {
    const adapter = adapterWith();
    const { r } = mount(adapter, { q: 'a' });
    await flush();
    const page = await adapter.search({ text: 'a' });
    const shorts = page.items.filter((v) => v.kind === 22);
    expect(shorts.length).toBeGreaterThan(0);
    expect(r.all('.nf-search__item .nf-card--short')).toHaveLength(0);
    const shelf = r.get('section.nf-search__shorts');
    expect(shelf.querySelector('h2')!.textContent).toContain('Shorts');
    expect(shelf.querySelectorAll('.nf-card--short')).toHaveLength(shorts.length);
    const rows = r.all('.nf-search__item');
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[2]!.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rows[3]!.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('navigates to watch / shorts / channel with the right routes', async () => {
    const adapter = adapterWith();
    const { r, navigate } = mount(adapter, { q: 'a' });
    await flush();
    const page = await adapter.search({ text: 'a' });
    const firstVideo = page.items.find((v) => v.kind === 21)!;
    click(r.get('.nf-search__item .nf-card__thumb'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: firstVideo.id });
    click(r.get('.nf-search__item .nf-card__title-button'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: firstVideo.id });
    click(r.get('.nf-search__item .nf-card__channel'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: firstVideo.author });
    const short = page.items.find((v) => v.kind === 22)!;
    click(r.get('.nf-search__short .nf-card__title-button'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'shorts', videoId: short.id });
  });
});

describe('Search — channel results (derived from the hits)', () => {
  it('a query naming a channel puts that channel on top with Subscribe', async () => {
    const adapter = adapterWith();
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const image = vi.spyOn(adapter, 'image');
    const { r, navigate } = mount(adapter, { q: 'ceramics' });
    await flush();
    const section = r.get('section.nf-search__channels');
    const rows = section.querySelectorAll('.nf-channel');
    expect(rows).toHaveLength(1);
    expect(section.textContent).toContain('Kilnfire Ceramics');
    expect(image).toHaveBeenCalledWith(kiln.profile.picture);
    // The channel comes before the first video row.
    const firstRow = r.get('.nf-search__item');
    expect(
      section.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    click(section.querySelector('.nf-channel__name')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'channel', pubkey: kiln.pubkey });
    const sub = section.querySelector<HTMLButtonElement>('.nf-channel__actions button')!;
    expect(sub.textContent).toBe('Subscribe');
    click(sub);
    await flush();
    expect(subscribe).toHaveBeenCalledWith(kiln.pubkey);
    expect(section.querySelector('.nf-channel__actions button')!.textContent).toBe('Subscribed');
  });

  it('shows an already-followed channel as Subscribed; Unsubscribe calls the adapter', async () => {
    const adapter = adapterWith();
    const unsubscribe = vi.spyOn(adapter, 'unsubscribe');
    const { r } = mount(adapter, { q: 'low tide' });
    await flush();
    const btn = r.get('.nf-search__channels .nf-channel__actions button');
    expect(r.get('.nf-search__channels').textContent).toContain('Low Tide Sessions');
    expect(btn.textContent).toBe('Subscribed');
    click(btn);
    await flush();
    expect(unsubscribe).toHaveBeenCalledWith(lowTide.pubkey);
  });

  it('signed out, Subscribe asks for a signer instead of calling the adapter', async () => {
    const adapter = adapterWith({ signedIn: false });
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r, navigate } = mount(adapter, { q: 'ceramics' });
    await flush();
    click(r.get('.nf-search__channels .nf-channel__actions button'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('no channel card for a one-letter query or a query that names no channel', async () => {
    const { r, rerender } = mount(adapterWith(), { q: 'a' });
    await flush();
    expect(r.all('.nf-search__channels')).toHaveLength(0);
    rerender({ q: 'etcd' });
    await flush();
    expect(cards(r).length).toBeGreaterThan(0);
    expect(r.all('.nf-search__channels')).toHaveLength(0);
  });

  it('matchesChannelQuery: word-start match on name/handle/NIP-05, 2+ characters', () => {
    const p = kiln.profile;
    expect(matchesChannelQuery(p, 'Ceramics')).toBe(true);
    expect(matchesChannelQuery(p, 'kilnfire cer')).toBe(true);
    expect(matchesChannelQuery(p, 'kiln')).toBe(true);
    expect(matchesChannelQuery(p, 'ramics')).toBe(false);
    expect(matchesChannelQuery(p, 'k')).toBe(false);
    expect(matchesChannelQuery(CHANNELS[3]!.profile, 'ops')).toBe(true); // nip05 ops@
  });
});

describe('Search — filters re-run the adapter query', () => {
  it('date / duration radios, debounced tags and the creator select reach adapter.search', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const onFiltersChange = vi.fn<(f: SearchFilterState) => void>();
    const { r, navigate } = mount(adapter, { q: 'a', onFiltersChange });
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a' });
    openFilters(r);
    const since = (FIXTURE_NOW - 604_800) as never;

    click(radio(r, 'Last 7 days'));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a', filters: { since } });
    expect(radio(r, 'Last 7 days').checked).toBe(true);

    click(radio(r, 'Under 4 minutes'));
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      text: 'a',
      filters: { since, maxDurationSec: 239 },
    });

    // Tags are debounced like the query: several keystrokes → one search.
    vi.useFakeTimers();
    const calls = search.mock.calls.length;
    const tags = r.get('.nf-search__filters input[type="text"]') as HTMLInputElement;
    typeInto(tags, 'sp');
    typeInto(tags, 'space, #Ceramics');
    await advance(SEARCH_DEBOUNCE_MS - 1);
    expect(search.mock.calls.length).toBe(calls);
    await advance(10);
    expect(search.mock.calls.length).toBe(calls + 1);
    expect(search).toHaveBeenLastCalledWith({
      text: 'a',
      filters: { since, maxDurationSec: 239, tags: ['space', 'ceramics'] },
    });
    // A trailing separator normalises to the same tags: no extra search.
    typeInto(tags, 'space, #Ceramics, ');
    await advance(SEARCH_DEBOUNCE_MS + 10);
    expect(search.mock.calls.length).toBe(calls + 1);
    vi.useRealTimers();
    await flush();

    // Creator: subscriptions and creators seen in results, grouped.
    const creator = r.get('.nf-search__filters select') as HTMLSelectElement;
    const groups = Array.from(creator.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toContain('Your subscriptions');
    expect(creator.options.length).toBeGreaterThan(2);
    choose(creator, orbital.pubkey);
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      text: 'a',
      filters: { since, maxDurationSec: 239, tags: ['space', 'ceramics'], author: orbital.pubkey },
    });
    for (const card of cards(r)) {
      expect(card.querySelector('.nf-card__channel')?.textContent ?? 'Orbital Mechanics').toContain(
        'Orbital Mechanics',
      );
    }
    // Filters never navigate (the v3 Route has no filter fields) but are reported.
    expect(navigate).not.toHaveBeenCalled();
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      uploaded: 'week',
      duration: 'short',
      tags: ['space', 'ceramics'],
      author: orbital.pubkey,
    });

    // One removable chip per active filter; the toggle counts them.
    const chips = r.all('.nf-search__chip');
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Remove filter: Last 7 days',
      'Remove filter: Under 4 minutes',
      'Remove filter: #space',
      'Remove filter: #ceramics',
      'Remove filter: Orbital Mechanics',
    ]);
    expect(r.get('.nf-search__filters-toggle').textContent).toBe('Filters (5)');
    click(chips[2]!);
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      text: 'a',
      filters: { since, maxDurationSec: 239, tags: ['ceramics'], author: orbital.pubkey },
    });
    expect(tags.value).toBe('ceramics');

    click(button(r, 'Clear filters'));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a' });
    expect(onFiltersChange).toHaveBeenLastCalledWith(DEFAULT_SEARCH_FILTERS);
    expect(r.all('.nf-search__chip')).toHaveLength(0);
    expect(tags.value).toBe('');
  });

  it('a tag suggestion from the results adds that tag', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r } = mount(adapter, { q: 'a' });
    await flush();
    openFilters(r);
    const suggestion = r.all('.nf-search__suggest-tag')[0]!;
    const tag = suggestion.textContent.replace('#', '');
    click(suggestion);
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a', filters: { tags: [tag] } });
    expect(r.all('.nf-search__suggest-tag').map((b) => b.textContent)).not.toContain(`#${tag}`);
  });

  it('the `filters` prop sets the initial filters and is followed by content, not identity', async () => {
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r, rerender } = mount(adapter, { q: 'a', filters: { duration: 'long' } });
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a', filters: { minDurationSec: 1_201 } });
    expect(r.get('.nf-search__filters')).toBeTruthy(); // active filters open the panel
    rerender({ q: 'a', filters: { duration: 'long' } }); // fresh object, same content
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    rerender({ q: 'a', filters: { duration: 'medium', tags: ['#Music'] } });
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith({
      text: 'a',
      filters: { minDurationSec: 240, maxDurationSec: 1_200, tags: ['music'] },
    });
  });

  it('pure helpers map the UI state onto the contract', () => {
    expect(buildSearchFilters(DEFAULT_SEARCH_FILTERS, 1_000)).toBeUndefined();
    expect(
      buildSearchFilters(
        { uploaded: 'day', duration: 'medium', tags: ['a', 'b'], author: '' },
        100_000,
      ),
    ).toEqual({
      since: 100_000 - 86_400,
      minDurationSec: 240,
      maxDurationSec: 1_200,
      tags: ['a', 'b'],
    });
    expect(
      buildSearchFilters(
        { ...DEFAULT_SEARCH_FILTERS, duration: 'long', author: orbital.pubkey },
        0,
      ),
    ).toEqual({ minDurationSec: 1_201, author: orbital.pubkey });
    expect(parseSearchTags(' #Space, space ,, music  ')).toEqual(['space', 'music']);
    expect(parseSearchTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(','))).toHaveLength(
      10,
    );
    expect(
      normalizeSearchFilters({
        uploaded: 'decade' as never,
        duration: 'short',
        tags: ['#A', 'a'],
        author: orbital.pubkey,
      }),
    ).toEqual({ uploaded: 'any', duration: 'short', tags: ['a'], author: orbital.pubkey });
  });
});

describe('Search — pagination', () => {
  it('Load more appends the next page (button fallback without IntersectionObserver)', async () => {
    expect(typeof IntersectionObserver).toBe('undefined');
    const adapter = adapterWith();
    const search = vi.spyOn(adapter, 'search');
    const { r } = mount(adapter, { q: 'a' });
    await flush();
    const firstPage = await adapter.search({ text: 'a' });
    expect(cards(r)).toHaveLength(10);
    expect(firstPage.next).toBe('10');
    expect(r.get('.nf-search__count').textContent).toBe('10+ results for “a”');
    click(button(r, 'Load more'));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ text: 'a', cursor: '10' });
    expect(cards(r).length).toBeGreaterThan(10);
    const labels = cards(r).map((el) => el.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(labels.length);
    expect(r.all('button').some((b) => b.textContent === 'Load more')).toBe(false);
  });

  it('pages reuse the first page’s request (same `since`) even after `now` moves', async () => {
    const base = adapterWith();
    const video = VIDEOS.find((v) => v.kind === 21)!;
    const search = vi.fn((q: SearchQuery): Promise<Page<VideoManifest>> =>
      Promise.resolve(q.cursor === undefined ? { items: [video], next: 'p2' } : { items: [] }),
    );
    const adapter = withSearch(base, search);
    const { r, rerender } = mount(adapter, { q: 'a', filters: { uploaded: 'year' } });
    await flush();
    const first = search.mock.calls[0]![0];
    expect(first.filters?.since).toBe(FIXTURE_NOW - 31_536_000);
    rerender({ q: 'a', filters: { uploaded: 'year' }, now: FIXTURE_NOW + 3_600 });
    await flush();
    expect(search).toHaveBeenCalledTimes(1); // a new clock alone never re-searches
    click(button(r, 'Load more'));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ ...first, cursor: 'p2' });
  });

  it('with IntersectionObserver the sentinel loads the next page', async () => {
    const observed: Element[] = [];
    let callback: IntersectionObserverCallback = () => undefined;
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(el: Element): void {
        observed.push(el);
      }
      disconnect(): void {
        disconnect();
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);
    try {
      const adapter = adapterWith();
      const search = vi.spyOn(adapter, 'search');
      const { r } = mount(adapter, { q: 'a' });
      await flush();
      expect(observed).toHaveLength(1);
      expect(observed[0]!.classList).toContain('nf-search__sentinel');
      expect(r.all('button').some((b) => b.textContent === 'Load more')).toBe(false);
      act(() => {
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
      await flush();
      expect(search).toHaveBeenLastCalledWith({ text: 'a', cursor: '10' });
      expect(cards(r).length).toBeGreaterThan(10);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a failed next page shows an inline error and Retry recovers', async () => {
    const base = adapterWith();
    let fail = true;
    const adapter = withSearch(base, (q) =>
      q.cursor !== undefined && fail
        ? Promise.reject(new Error('relay-down: no relays reachable'))
        : base.search(q),
    );
    const { r } = mount(adapter, { q: 'a' });
    await flush();
    click(button(r, 'Load more'));
    await flush();
    expect(cards(r)).toHaveLength(10);
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Could not load more');
    fail = false;
    click(alert.querySelector('button')!);
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(cards(r).length).toBeGreaterThan(10);
  });
});

describe('Search — loading / empty / error / signed-out', () => {
  it('shows skeleton rows (list layout) with aria-busy while loading', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }), { q: 'ceramics' });
    expect(r.get('.nf-search__results').getAttribute('aria-busy')).toBe('true');
    expect(r.get('[role="status"]').textContent).toContain('Searching for “ceramics”');
    const skeletons = r.all('.nf-card--skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
    expect(skeletons[0]!.classList).toContain('nf-card--list');
    expect(r.all('.nf-card:not(.nf-card--skeleton)')).toHaveLength(0);
  });

  it('no results → designed empty state echoing the query back', async () => {
    const { r } = mount(adapterWith(), { q: 'zqxw-no-such-video' });
    await flush();
    const status = r.get('[role="status"]');
    expect(status.getAttribute('data-preset')).toBe('no-results');
    expect(status.textContent).toContain('No results');
    expect(status.textContent).toContain('“zqxw-no-such-video”');
    expect(status.textContent).toContain('Try different words');
    expect(status.querySelector('button')).toBeNull(); // no filters → nothing to clear
  });

  it('no results with active filters → offers Clear filters which restores results', async () => {
    const { r } = mount(adapterWith(), {
      q: 'ceramics',
      filters: { duration: 'long', uploaded: 'hour' },
    });
    await flush();
    const status = r.get('[role="status"]');
    expect(status.textContent).toContain('No results');
    expect(status.textContent).toContain('with these filters');
    click(status.querySelector('button')!);
    await flush();
    expect(cards(r).length).toBeGreaterThan(0);
  });

  it('relay down → ErrorState with retry that refetches; nothing thrown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ failWith: 'relay-down' });
    const search = vi.spyOn(adapter, 'search');
    const { r } = mount(adapter, { q: 'ceramics' });
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    click(alert.querySelector('button')!);
    await flush();
    expect(search).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('search works signed out and with no seeders / no balance (none of them gate search)', async () => {
    for (const opts of [
      { signedIn: false },
      { failWith: 'no-signer' },
      { failWith: 'no-seeders' },
      { failWith: 'no-balance' },
    ] as const) {
      const { r } = mount(adapterWith(opts), { q: 'music' });
      await flush();
      expect(cards(r).length).toBeGreaterThan(0);
      expect(r.all('[role="alert"]')).toHaveLength(0);
    }
  });

  it('describeSearchError maps relay failures and unknown values', () => {
    expect(describeSearchError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeSearchError('relay timed out').detail).toBe('relay timed out');
    expect(describeSearchError(new Error('boom')).title).toBe('Search failed');
    expect(describeSearchError(undefined).detail).toBeUndefined();
    expect(describeSearchError(new Error('relay-down: x'), 'more').description).toContain(
      'the next page could not load',
    );
  });
});

describe('Search — cancellation', () => {
  it('unmounting mid-load cancels: no state updates, no follow-up calls, no errors', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ latencyMs: 1000 });
    const search = vi.spyOn(adapter, 'search');
    const image = vi.spyOn(adapter, 'image');
    const profile = vi.spyOn(adapter, 'profile');
    const stats = vi.spyOn(adapter, 'stats');
    const subscriptions = vi.spyOn(adapter, 'subscriptions');
    const { r } = mount(adapter, { q: 'ceramics' });
    expect(search).toHaveBeenCalledTimes(1);
    await advance(500);
    rendered.splice(rendered.indexOf(r), 1);
    r.unmount();
    await advance(5_000);
    expect(image).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(subscriptions).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});
