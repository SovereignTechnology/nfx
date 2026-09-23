/**
 * Channel screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers every state, tab switching, the NIP-05 looks, image skeletons (T16), the
 * "Seeding N videos" sources, subscribe flows, price-before-play on playlists, paging,
 * navigation routes, error/not-found copy and cancellation on unmount.
 */
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks } from '@sovit/core';
import type {
  FeedQuery,
  NetworkAdapter,
  NostrPubkey,
  Playlist,
  Profile,
  VideoManifest,
  Page,
} from '@sovit/core';
import { click, keydown, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import {
  CHANNEL_TABS,
  Channel,
  describeChannelError,
  describeNip05,
  nip05State,
  seedingLabel,
  type ChannelProps,
} from '../Channel.js';

const { MockNetworkAdapter, CHANNELS, ME, FIXTURE_NOW } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];

/** Lets every pending mock promise (and the React work it schedules) settle. */
async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<ChannelProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(
    createElement(Channel, {
      adapter,
      navigate,
      now: FIXTURE_NOW,
      ...props,
      pubkey: props.pubkey ?? ORBITAL.pubkey,
    }),
  );
  rendered.push(r);
  return { r, navigate };
}

function adapterWith(opts: Opts = {}): mocks.MockNetworkAdapter {
  return new MockNetworkAdapter(opts);
}

function channelAt(i: number): mocks.FixtureChannel {
  const c = CHANNELS[i];
  if (!c) throw new Error(`fixture channel ${i} missing`);
  return c;
}

/** Overrides one property of an adapter, binding every other method to the mock. */
function withOverride(base: NetworkAdapter, prop: string, impl: unknown): NetworkAdapter {
  return new Proxy(base, {
    get(target, p, receiver): unknown {
      if (p === prop) return impl;
      const v: unknown = Reflect.get(target, p, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** `profile(pk)` answers `override` for exactly one pubkey. */
function withProfile(
  base: mocks.MockNetworkAdapter,
  pubkey: NostrPubkey,
  override: Profile | null,
): NetworkAdapter {
  return withOverride(base, 'profile', (pk: NostrPubkey): Promise<Profile | null> =>
    pk === pubkey ? Promise.resolve(override) : base.profile(pk),
  );
}

/** Author feed rejects (relays answer metadata but not the catalog). */
function withFailingAuthorFeed(base: mocks.MockNetworkAdapter, err: Error): NetworkAdapter {
  return withOverride(base, 'feed', (q: FeedQuery): Promise<Page<VideoManifest>> =>
    q.source === 'author' ? Promise.reject(err) : base.feed(q),
  );
}

/** Gives `author` the supplied NIP-51 video sets. */
function withPlaylists(
  base: NetworkAdapter,
  author: NostrPubkey,
  lists: readonly Playlist[],
): NetworkAdapter {
  return withOverride(base, 'library', {
    ...base.library,
    playlists: (a?: NostrPubkey): Promise<readonly Playlist[]> =>
      Promise.resolve(a === undefined ? lists : lists.filter((x) => x.author === a)),
  });
}

const ORBITAL = channelAt(0);
const KILNFIRE = channelAt(1);
const LOWTIDE = channelAt(2);
const ORBITAL_VIDEOS = mocks.VIDEOS.filter((v) => v.author === ORBITAL.pubkey);
const ORBITAL_LONG = ORBITAL_VIDEOS.filter((v) => v.kind === 21);
const ORBITAL_SHORTS = ORBITAL_VIDEOS.filter((v) => v.kind === 22);
const cards = (r: Rendered): HTMLElement[] => r.all('.nf-card:not(.nf-card--skeleton)');
const button = (r: Rendered, text: string): HTMLElement | undefined =>
  r.all('button').find((b) => b.textContent === text);

describe('Channel — structure and loading', () => {
  it('renders the landmark, banner/avatar/header skeletons and four tabs while loading', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }));
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Channel');
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(CHANNEL_TABS.map((t) => t.label));
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(r.get('[role="tabpanel"]').getAttribute('aria-busy')).toBe('true');
    expect(r.get('.nf-channelpage__banner .nf-skeleton')).toBeTruthy();
    expect(r.get('.nf-channelpage__avatar-skeleton .nf-skeleton--circle')).toBeTruthy();
    expect(r.all('.nf-card--skeleton').length).toBe(8);
    expect(cards(r)).toHaveLength(0);
    expect(r.get('.nf-channelpage__actions .nf-skeleton')).toBeTruthy();
  });

  it('fetches the author feed once, split into Videos and Shorts', async () => {
    const adapter = adapterWith();
    const feed = vi.spyOn(adapter, 'feed');
    const { r, navigate } = mount(adapter);
    await flush();
    expect(feed).toHaveBeenCalledTimes(1);
    expect(feed).toHaveBeenCalledWith({ source: 'author', author: ORBITAL.pubkey, limit: 24 });
    expect(ORBITAL_LONG.length).toBeGreaterThan(0);
    expect(ORBITAL_SHORTS.length).toBeGreaterThan(0);
    expect(cards(r)).toHaveLength(ORBITAL_LONG.length);
    click(r.all('[role="tab"]')[1]!); // Shorts
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'shorts',
    });
    await flush();
    expect(cards(r)).toHaveLength(ORBITAL_SHORTS.length);
    click(r.all('[role="tab"]')[2]!); // Playlists
    click(r.all('[role="tab"]')[0]!); // back to Videos — the feed stays cached
    await flush();
    expect(feed).toHaveBeenCalledTimes(1);
  });
});

describe('Channel — header', () => {
  it('shows the title, identifier, upload count and hash-verified banner/avatar', async () => {
    const adapter = adapterWith();
    const image = vi.spyOn(adapter, 'image');
    const { r } = mount(adapter);
    await flush();
    const title = r.get('.nf-channelpage__title');
    expect(title.textContent).toContain('Orbital Mechanics');
    expect(title.querySelector('[role="img"][aria-label="NIP-05 verified"]')).toBeTruthy();
    const sub = r.get('.nf-channelpage__sub');
    expect(sub.textContent).toContain('orbital@fixture.example');
    expect(sub.textContent).toContain(`${ORBITAL_VIDEOS.length} videos`);
    // kind-0 URLs carry no `x` hash: resolved hashless, and only the resolved URL is shown
    expect(image).toHaveBeenCalledWith(ORBITAL.profile.banner);
    expect(image).toHaveBeenCalledWith(ORBITAL.profile.picture);
    expect(r.get('.nf-channelpage__banner-img').getAttribute('src')).toBe(ORBITAL.profile.banner);
    expect(r.get('.nf-channelpage__head .nf-avatar__img').getAttribute('src')).toBe(
      ORBITAL.profile.picture,
    );
    expect(r.all('.nf-channelpage__avatar-skeleton')).toHaveLength(0);
  });

  it('keeps banner and avatar as Skeletons until adapter.image resolves, then shows them', async () => {
    const pending = new Map<string, (src: string) => void>();
    const base = adapterWith();
    const adapter = withOverride(
      base,
      'image',
      (url: string): Promise<string> =>
        new Promise((resolve) => {
          pending.set(url, resolve);
        }),
    );
    const { r } = mount(adapter);
    await flush();
    // profile + feed are in; the images are still being verified
    expect(r.get('.nf-channelpage__title').textContent).toContain('Orbital Mechanics');
    expect(r.get('.nf-channelpage__banner .nf-skeleton')).toBeTruthy();
    expect(r.all('.nf-channelpage__banner-img')).toHaveLength(0);
    expect(r.get('.nf-channelpage__avatar-skeleton .nf-skeleton--circle')).toBeTruthy();
    expect(r.all('.nf-channelpage__head .nf-avatar')).toHaveLength(0);
    await act(async () => {
      pending.get(ORBITAL.profile.banner!)?.('blob:banner');
      pending.get(ORBITAL.profile.picture!)?.('blob:avatar');
      await Promise.resolve();
    });
    expect(r.get('.nf-channelpage__banner-img').getAttribute('src')).toBe('blob:banner');
    expect(r.get('.nf-channelpage__head .nf-avatar__img').getAttribute('src')).toBe('blob:avatar');
    expect(r.all('.nf-channelpage__head .nf-skeleton')).toHaveLength(0);
  });

  it('a rejected image (T16) never reaches an <img>: initials + plain banner block', async () => {
    const adapter = withOverride(adapterWith(), 'image', () =>
      Promise.reject(new Error('sha256 mismatch')),
    );
    const { r } = mount(adapter);
    await flush();
    expect(r.all('.nf-channelpage__banner img')).toHaveLength(0);
    expect(r.all('.nf-channelpage__banner .nf-skeleton')).toHaveLength(0);
    expect(r.get('.nf-channelpage__banner')).toBeTruthy();
    expect(r.get('.nf-channelpage__head .nf-avatar--fallback').textContent).toBe('OM');
    expect(r.all('.nf-card__img')).toHaveLength(0); // thumbnails keep their placeholder
  });

  it('a profile without banner renders no banner block at all', async () => {
    const { banner: _dropped, ...noBanner } = ORBITAL.profile;
    const { r } = mount(withProfile(adapterWith(), ORBITAL.pubkey, noBanner));
    await flush();
    expect(r.all('.nf-channelpage__banner')).toHaveLength(0);
    expect(r.get('.nf-channelpage__title').textContent).toContain('Orbital Mechanics');
  });

  it('the header teaser shows the first paragraph via Markdown; "more" opens About', async () => {
    const about =
      'First **line** with https://orbital.example/a\n\nSecond paragraph stays on About.';
    const { r, navigate } = mount(
      withProfile(adapterWith(), ORBITAL.pubkey, { ...ORBITAL.profile, about }),
    );
    await flush();
    const blurb = r.get('.nf-channelpage__blurb');
    expect(blurb.querySelector('strong')!.textContent).toBe('line');
    expect(blurb.querySelector('a')!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(blurb.textContent).not.toContain('Second paragraph');
    click(r.get('.nf-channelpage__blurb-more'));
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'about',
    });
    await flush();
    expect(r.get('[role="tabpanel"]').textContent).toContain('Second paragraph stays on About.');
  });
});

describe('Channel — NIP-05 badge: verified, unverified, failed and absent look different', () => {
  async function headFor(profile: Profile): Promise<HTMLElement> {
    const { r } = mount(withProfile(adapterWith(), profile.pubkey, profile), {
      pubkey: profile.pubkey,
    });
    await flush();
    return r.get('.nf-channelpage__head');
  }

  it('verified: check mark by the name, plain identifier, no flag', async () => {
    const head = await headFor(ORBITAL.profile);
    expect(head.getAttribute('data-nip05')).toBe('verified');
    expect(head.querySelector('h1 [aria-label="NIP-05 verified"]')).toBeTruthy();
    expect(head.querySelector('.nf-channelpage__nip05--verified')!.textContent).toBe(
      'orbital@fixture.example',
    );
    expect(head.querySelector('.nf-channelpage__nip05-flag')).toBeNull();
  });

  it('unverified: no check, identifier muted with an "Unverified" flag', async () => {
    const head = await headFor({ ...KILNFIRE.profile, nip05Status: 'unverified' });
    expect(head.getAttribute('data-nip05')).toBe('unverified');
    expect(head.querySelector('[aria-label="NIP-05 verified"]')).toBeNull();
    const nip = head.querySelector('.nf-channelpage__nip05--unverified')!;
    expect(nip.querySelector('.nf-channelpage__nip05-id')!.textContent).toBe(
      'kiln@fixture.example',
    );
    expect(nip.querySelector('.nf-channelpage__nip05-flag')!.textContent).toBe('Unverified');
    expect(nip.querySelector('s')).toBeNull();
  });

  it('failed: no check, identifier struck through, warning flag', async () => {
    const head = await headFor({ ...KILNFIRE.profile, nip05Status: 'failed' });
    expect(head.getAttribute('data-nip05')).toBe('failed');
    expect(head.querySelector('[aria-label="NIP-05 verified"]')).toBeNull();
    const nip = head.querySelector('.nf-channelpage__nip05--failed')!;
    expect(nip.querySelector('s')!.textContent).toBe('kiln@fixture.example');
    expect(nip.querySelector('.nf-channelpage__nip05-flag--failed')!.textContent).toBe(
      'Verification failed',
    );
  });

  it('absent: no identifier, no flag — the short pubkey instead', async () => {
    const head = await headFor(LOWTIDE.profile);
    expect(head.getAttribute('data-nip05')).toBe('none');
    expect(head.querySelector('.nf-channelpage__nip05')).toBeNull();
    const code = head.querySelector('code.nf-channelpage__pubkey')!;
    expect(code.textContent).toContain('…');
    expect(code.textContent).not.toBe(LOWTIDE.pubkey);
  });

  it('nip05State / describeNip05 cover every status', () => {
    const base = { ...ORBITAL.profile };
    expect(nip05State(base)).toBe('verified');
    expect(nip05State({ ...base, nip05Status: 'unverified' })).toBe('unverified');
    expect(nip05State({ ...base, nip05Status: 'none' })).toBe('unverified'); // claimed, unchecked
    expect(nip05State({ ...base, nip05Status: 'failed' })).toBe('failed');
    expect(nip05State({ ...base, nip05: '  ' })).toBe('none');
    const { nip05: _dropped, ...withoutNip05 } = base;
    expect(nip05State(withoutNip05)).toBe('none');
    expect(describeNip05(base)).toBe('orbital@fixture.example — verified');
    expect(describeNip05({ ...base, nip05Status: 'unverified' })).toContain('not verified');
    expect(describeNip05({ ...base, nip05Status: 'failed' })).toContain('verification failed');
    expect(describeNip05(withoutNip05)).toBe('Not set');
  });
});

describe('Channel — "Seeding N videos"', () => {
  it('is not inferred from swarm counts: other channels show it only when the shell says so', async () => {
    // Every orbital video has seeders online in the mock — that alone must not claim that
    // the channel runs a seeder.
    const a = mount(adapterWith());
    await flush();
    expect(a.r.all('.nf-channelpage__seeding')).toHaveLength(0);

    const b = mount(adapterWith(), { seedingVideos: 3 });
    await flush();
    expect(b.r.get('.nf-channelpage__seeding').textContent).toBe('Seeding 3 videos');
    click(b.r.all('[role="tab"]')[3]!);
    await flush();
    expect(b.r.get('.nf-channelpage__details').textContent).toContain(
      'Runs a seeder · seeding 3 videos',
    );

    const c = mount(adapterWith(), { seedingVideos: 0 });
    await flush();
    expect(c.r.all('.nf-channelpage__seeding')).toHaveLength(0);
    expect(seedingLabel(1)).toBe('Seeding 1 video');
    expect(seedingLabel(1200)).toBe('Seeding 1,200 videos');
  });

  it('your own channel reads the local seeder, live', async () => {
    const adapter = adapterWith();
    const status = vi.spyOn(adapter.seeder, 'status');
    const { r } = mount(adapter, { pubkey: ME, seedingVideos: 99 });
    await flush();
    expect(status).toHaveBeenCalledTimes(1);
    const expected = (await adapter.seeder.status()).videos;
    expect(r.get('.nf-channelpage__seeding').textContent).toBe(seedingLabel(expected));
    await act(async () => {
      await adapter.seeder.setEnabled(false); // pushes through onStatus
    });
    expect(r.all('.nf-channelpage__seeding')).toHaveLength(0);
    click(r.all('[role="tab"]')[3]!);
    await flush();
    expect(r.get('.nf-channelpage__details').textContent).toContain('Seeding is off');
  });

  it('never asks the local seeder about somebody else’s channel', async () => {
    const adapter = adapterWith();
    const status = vi.spyOn(adapter.seeder, 'status');
    const onStatus = vi.spyOn(adapter.seeder, 'onStatus');
    mount(adapter);
    await flush();
    expect(status).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('About shows swarm availability from VideoStats.seedersOnline', async () => {
    const a = mount(adapterWith(), { tab: 'about' });
    await flush();
    expect(a.r.get('.nf-channelpage__details').textContent).toContain(
      `Seeders online for ${ORBITAL_VIDEOS.length} of ${ORBITAL_VIDEOS.length} videos`,
    );
    const b = mount(adapterWith({ failWith: 'no-seeders' }), { tab: 'about' });
    await flush();
    expect(b.r.get('.nf-channelpage__details').textContent).toContain(
      'No seeders online for these videos right now',
    );
  });
});

describe('Channel — cards, price and navigation', () => {
  it('thumbnails via adapter.image(url, sha256), paid views, price badge, → watch', async () => {
    const adapter = adapterWith();
    const image = vi.spyOn(adapter, 'image');
    const { r, navigate } = mount(adapter);
    await flush();
    const first = ORBITAL_LONG[0]!;
    const thumb = first.renditions[0]!.image!;
    expect(image).toHaveBeenCalledWith(thumb.url, thumb.sha256);
    const card = r.get('.nf-card');
    expect(card.querySelector('.nf-card__img')!.getAttribute('src')).toBe(thumb.url);
    expect(card.querySelector('.nf-card__meta')!.textContent).toContain('paid views');
    // Channel cards hide the channel row: we are already on the channel.
    expect(card.querySelector('.nf-card__channel')).toBeNull();
    for (const c of cards(r)) expect(c.querySelector('.nf-sats--price')).toBeTruthy();
    click(card.querySelector('.nf-card__thumb')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
    click(r.all('.nf-card__title-button')[1]!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: ORBITAL_LONG[1]!.id });
  });

  it('shorts are 9:16 cards with a price and open the shorts route', async () => {
    const { r, navigate } = mount(adapterWith(), { tab: 'shorts' });
    await flush();
    const card = r.get('.nf-channelpage__shorts-grid .nf-card');
    expect(card.className).toContain('nf-card--short');
    expect(card.querySelector('.nf-sats--price')).toBeTruthy();
    click(card.querySelector('.nf-card__thumb')!);
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'shorts',
      videoId: ORBITAL_SHORTS[0]!.id,
    });
  });
});

describe('Channel — paging the author feed', () => {
  it('"Show more" loads the next page with the cursor and appends without duplicates', async () => {
    const adapter = adapterWith();
    const feed = vi.spyOn(adapter, 'feed');
    const { r } = mount(adapter, { pageSize: 2 });
    await flush();
    // page 1 = the 2 newest uploads: 1 video + 1 short
    expect(cards(r)).toHaveLength(1);
    click(button(r, 'Show more')!);
    expect(r.get('[role="tabpanel"]').getAttribute('aria-busy')).toBe('true');
    await flush();
    expect(feed).toHaveBeenLastCalledWith({
      source: 'author',
      author: ORBITAL.pubkey,
      limit: 2,
      cursor: '2',
    });
    expect(cards(r)).toHaveLength(ORBITAL_LONG.length);
    expect(button(r, 'Show more')).toBeUndefined(); // no next page left
    const ids = cards(r).map((c) => c.getAttribute('aria-label'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a failed page keeps the loaded cards and offers Retry', async () => {
    const base = adapterWith();
    let fail = true;
    const adapter = withOverride(base, 'feed', (q: FeedQuery): Promise<Page<VideoManifest>> =>
      q.cursor !== undefined && fail
        ? Promise.reject(new Error('relay-down: no relays reachable'))
        : base.feed(q),
    );
    const { r } = mount(adapter, { pageSize: 2 });
    await flush();
    click(button(r, 'Show more')!);
    await flush();
    const alert = r.get('[role="tabpanel"] [role="alert"]');
    expect(alert.textContent).toContain('Could not load more');
    expect(cards(r)).toHaveLength(1);
    fail = false;
    click(alert.querySelector('button')!);
    await flush();
    expect(cards(r)).toHaveLength(ORBITAL_LONG.length);
    expect(r.all('[role="alert"]')).toHaveLength(0);
  });

  it('a tab with nothing on the loaded page but more pages offers "Load older uploads"', async () => {
    // Orbital's newest upload is a video, so page 1 (size 1) has no shorts yet.
    const { r } = mount(adapterWith(), { pageSize: 1, tab: 'shorts' });
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('No shorts in the latest uploads');
    click(button(r, 'Load older uploads')!);
    await flush();
    expect(cards(r)).toHaveLength(1);
    expect(cards(r)[0]!.className).toContain('nf-card--short');
  });
});

describe('Channel — subscribe', () => {
  it('renders the subscribed state and unsubscribes', async () => {
    const adapter = adapterWith();
    const unsubscribe = vi.spyOn(adapter, 'unsubscribe');
    const { r } = mount(adapter);
    await flush();
    const btn = button(r, 'Subscribed')!;
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Unsubscribe from Orbital Mechanics');
    click(btn);
    expect(unsubscribe).toHaveBeenCalledWith(ORBITAL.pubkey);
    await flush();
    expect(button(r, 'Subscribe')).toBeTruthy();
  });

  it('subscribes to an unfollowed channel', async () => {
    const adapter = adapterWith();
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r } = mount(adapter, { pubkey: KILNFIRE.pubkey });
    await flush();
    const btn = button(r, 'Subscribe')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    click(btn);
    expect(subscribe).toHaveBeenCalledWith(KILNFIRE.pubkey);
    await flush();
    expect(button(r, 'Subscribed')).toBeTruthy();
  });

  it('reverts when the subscribe call fails (nothing thrown, no console noise)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = withOverride(adapterWith(), 'subscribe', () =>
      Promise.reject(new Error('relay-down: no relays reachable')),
    );
    const { r } = mount(adapter, { pubkey: KILNFIRE.pubkey });
    await flush();
    click(button(r, 'Subscribe')!);
    await flush();
    expect(button(r, 'Subscribe')).toBeTruthy();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('routes a signed-out visitor to Settings instead of subscribing', async () => {
    const adapter = adapterWith({ signedIn: false });
    const subscribe = vi.spyOn(adapter, 'subscribe');
    const { r, navigate } = mount(adapter);
    await flush();
    const btn = button(r, 'Subscribe')!;
    expect(btn.getAttribute('aria-label')).toBe(
      'Connect a signer to subscribe to Orbital Mechanics',
    );
    click(btn);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'settings' });
    expect(subscribe).not.toHaveBeenCalled();
    // Public content still renders without a signer.
    expect(cards(r).length).toBeGreaterThan(0);
  });

  it('no-signer behaves like signed out; no-balance leaves the channel untouched', async () => {
    const a = mount(adapterWith({ failWith: 'no-signer' }));
    await flush();
    expect(button(a.r, 'Subscribe')!.getAttribute('aria-label')).toContain('Connect a signer');
    const b = mount(adapterWith({ failWith: 'no-balance' }));
    await flush();
    expect(b.r.all('[role="alert"]')).toHaveLength(0);
    expect(cards(b.r)).toHaveLength(ORBITAL_LONG.length);
    expect(button(b.r, 'Subscribed')).toBeTruthy();
  });

  it('your own channel: "Manage videos" instead of Subscribe, and upload prompts', async () => {
    const { r, navigate } = mount(adapterWith(), { pubkey: ME });
    await flush();
    expect(r.get('.nf-channelpage__title').textContent).toContain('Fixture Viewer');
    expect(button(r, 'Subscribe')).toBeUndefined();
    click(button(r, 'Manage videos')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'videos' });
    expect(r.get('[role="status"]').textContent).toContain('You have not published any videos');
    click(button(r, 'Upload a video')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'upload' });
  });
});

describe('Channel — tabs', () => {
  it('tabs switch content and are keyboard operable with roving tabindex', async () => {
    const { r, navigate } = mount(adapterWith());
    await flush();
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    act(() => {
      tabs[0]!.focus();
    });
    keydown(r.get('[role="tablist"]'), 'ArrowRight');
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'shorts',
    });
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Shorts');
    expect(document.activeElement).toBe(r.all('[role="tab"]')[1]);
    keydown(r.get('[role="tablist"]'), 'End');
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'about',
    });
    keydown(r.get('[role="tablist"]'), 'ArrowRight'); // wraps to Videos
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'videos',
    });
    keydown(r.get('[role="tablist"]'), 'ArrowLeft'); // wraps back to About
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'about',
    });
    keydown(r.get('[role="tablist"]'), 'Home');
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'channel',
      pubkey: ORBITAL.pubkey,
      tab: 'videos',
    });
    await flush();
    const panel = r.get('[role="tabpanel"]');
    expect(panel.getAttribute('aria-labelledby')).toBe(r.all('[role="tab"]')[0]!.id);
    expect(r.all('[role="tab"]')[0]!.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('follows a changed `tab` prop', async () => {
    const adapter = adapterWith();
    const navigate = vi.fn<(to: Route) => void>();
    const el = (tab: ChannelProps['tab']): ReactElement =>
      createElement(Channel, { adapter, navigate, now: FIXTURE_NOW, pubkey: ORBITAL.pubkey, tab });
    const r = render(el('videos'));
    rendered.push(r);
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Videos');
    r.rerender(el('playlists'));
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Playlists');
  });

  it('a changed pubkey refetches the profile and feed', async () => {
    const adapter = adapterWith();
    const navigate = vi.fn<(to: Route) => void>();
    const el = (pubkey: NostrPubkey): ReactElement =>
      createElement(Channel, { adapter, navigate, now: FIXTURE_NOW, pubkey });
    const r = render(el(ORBITAL.pubkey));
    rendered.push(r);
    await flush();
    expect(r.get('.nf-channelpage__title').textContent).toContain('Orbital Mechanics');
    r.rerender(el(KILNFIRE.pubkey));
    await flush();
    expect(r.get('.nf-channelpage__title').textContent).toContain('Kilnfire Ceramics');
    const kiln = mocks.VIDEOS.filter((v) => v.author === KILNFIRE.pubkey && v.kind === 21);
    expect(cards(r)).toHaveLength(kiln.length);
  });
});

describe('Channel — playlists (NIP-51 video sets)', () => {
  const lists: Playlist[] = [
    {
      id: 'starter-pack',
      author: ORBITAL.pubkey,
      title: 'Orbital mechanics — start here',
      description: 'The **essential** path through the channel.',
      videoIds: ORBITAL_VIDEOS.map((v) => v.id),
      isPrivate: false,
    },
    {
      id: 'empty-draft',
      author: ORBITAL.pubkey,
      title: 'Empty draft',
      videoIds: [],
      isPrivate: true,
    },
    {
      id: 'gone',
      author: ORBITAL.pubkey,
      title: 'Deleted first video',
      videoIds: [mocks.asEventId('deleted-video')],
      isPrivate: false,
    },
  ];

  it('loads lazily: not queried until the Playlists tab is opened', async () => {
    const adapter = adapterWith();
    const playlists = vi.spyOn(adapter.library, 'playlists');
    const { r } = mount(adapter);
    await flush();
    expect(playlists).not.toHaveBeenCalled();
    click(r.all('[role="tab"]')[2]!);
    await flush();
    expect(playlists).toHaveBeenCalledWith(ORBITAL.pubkey);
  });

  it('empty → designed empty state (and a Library prompt on your own channel)', async () => {
    const a = mount(adapterWith(), { tab: 'playlists', pubkey: KILNFIRE.pubkey });
    await flush();
    expect(a.r.get('[role="status"]').textContent).toContain('No playlists yet');
    const own = withPlaylists(adapterWith(), ME, []);
    const b = mount(own, { tab: 'playlists', pubkey: ME });
    await flush();
    expect(b.r.get('[role="status"]').textContent).toContain('You have no playlists yet');
    click(button(b.r, 'Open Library')!);
    expect(b.navigate).toHaveBeenLastCalledWith({ name: 'library', tab: 'playlists' });
  });

  it('shows the first video’s price BEFORE the "Play all" affordance, then plays it', async () => {
    const { r, navigate } = mount(withPlaylists(adapterWith(), ORBITAL.pubkey, lists), {
      tab: 'playlists',
    });
    await flush();
    const rows = r.all('.nf-channelpage__playlists > .nf-channelpage__playlist');
    expect(rows).toHaveLength(3);
    const first = ORBITAL_VIDEOS[0]!;
    const row = rows[0]!;
    expect(row.textContent).toContain('Orbital mechanics — start here');
    expect(row.textContent).toContain(`${ORBITAL_VIDEOS.length} videos`);
    expect(row.querySelector('.nf-md strong')!.textContent).toBe('essential');
    const thumb = row.querySelector<HTMLButtonElement>('button.nf-channelpage__playlist-thumb')!;
    expect(thumb.querySelector('img')!.getAttribute('src')).toBe(first.renditions[0]!.image!.url);
    const price = thumb.querySelector('.nf-sats--price')!;
    const play = thumb.querySelector('.nf-channelpage__playlist-play')!;
    expect(price.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(play.getAttribute('aria-hidden')).toBe('true');
    expect(thumb.getAttribute('aria-label')).toMatch(
      /^Play all: Orbital mechanics — start here\. First video (from )?[\d,]+ sats?$/,
    );
    click(thumb);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
    click(row.querySelector('.nf-channelpage__playlist-open')!);
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
  });

  it('an empty set or a missing first video has no play affordance at all', async () => {
    const { r } = mount(withPlaylists(adapterWith(), ORBITAL.pubkey, lists), {
      tab: 'playlists',
    });
    await flush();
    const rows = r.all('.nf-channelpage__playlists > .nf-channelpage__playlist');
    for (const row of [rows[1]!, rows[2]!]) {
      expect(row.querySelector('button')).toBeNull();
      expect(row.querySelector('.nf-channelpage__playlist-play')).toBeNull();
      expect(row.querySelector('.nf-sats')).toBeNull();
    }
    expect(rows[1]!.textContent).toContain('0 videos');
    expect(rows[1]!.textContent).toContain('Private');
    expect(rows[2]!.textContent).toContain('no longer available');
  });

  it('while the first video resolves there is no play affordance yet', async () => {
    const base = withPlaylists(adapterWith(), ORBITAL.pubkey, lists);
    const adapter = withOverride(base, 'video', () => new Promise(() => undefined));
    const { r } = mount(adapter, { tab: 'playlists' });
    await flush();
    const row = r.all('.nf-channelpage__playlists > .nf-channelpage__playlist')[0]!;
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('.nf-skeleton')).toBeTruthy();
    expect(row.textContent).toContain(`${ORBITAL_VIDEOS.length} videos`);
  });

  it('a playlist fetch failure lands in ErrorState with Retry', async () => {
    const base = adapterWith();
    let fail = true;
    const adapter = withOverride(base, 'library', {
      ...base.library,
      playlists: (a?: NostrPubkey): Promise<readonly Playlist[]> =>
        fail
          ? Promise.reject(new Error('relay-down: no relays reachable'))
          : Promise.resolve(lists.filter((x) => x.author === a)),
    });
    const { r } = mount(adapter, { tab: 'playlists' });
    await flush();
    const alert = r.get('[role="tabpanel"] [role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    fail = false;
    click(alert.querySelector('button')!);
    await flush();
    expect(r.all('.nf-channelpage__playlists > .nf-channelpage__playlist')).toHaveLength(3);
  });
});

describe('Channel — about', () => {
  it('renders the description through Markdown and lists details', async () => {
    const { r } = mount(adapterWith(), { tab: 'about' });
    await flush();
    const desc = r.get('.nf-channelpage__about .nf-md');
    expect(desc.textContent).toContain('Fixture channel "Orbital Mechanics"');
    const details = r.get('.nf-channelpage__details');
    expect(details.textContent).toContain('orbital@fixture.example — verified');
    expect(details.textContent).toContain('…'); // pubkey is shortened
    expect(details.textContent).not.toContain(ORBITAL.pubkey); // never the whole key
  });

  it('hostile description text stays text', async () => {
    const about = '<img src=x onerror=alert(1)> [x](javascript:alert(1)) **ok**';
    const { r } = mount(withProfile(adapterWith(), ORBITAL.pubkey, { ...ORBITAL.profile, about }), {
      tab: 'about',
    });
    await flush();
    const desc = r.get('.nf-channelpage__about .nf-md');
    expect(desc.querySelector('img')).toBeNull();
    expect(desc.querySelector('a')).toBeNull();
    expect(desc.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('empty description → designed empty state', async () => {
    const { about: _dropped, ...stripped } = KILNFIRE.profile;
    const { r } = mount(withProfile(adapterWith(), KILNFIRE.pubkey, stripped), {
      pubkey: KILNFIRE.pubkey,
      tab: 'about',
    });
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('No description yet');
    expect(r.all('.nf-channelpage__blurb')).toHaveLength(0);
  });
});

describe('Channel — errors and missing channel', () => {
  it('relay down → ErrorState with the designed copy; Retry refetches', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ failWith: 'relay-down' });
    const profile = vi.spyOn(adapter, 'profile');
    const { r } = mount(adapter);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.textContent).toContain('None of your relays answered');
    expect(alert.querySelector('.nf-state__detail')!.textContent).toBe(
      'relay-down: no relays reachable',
    );
    expect(profile).toHaveBeenCalledTimes(1);
    click(alert.querySelector('button')!);
    await flush();
    expect(profile).toHaveBeenCalledTimes(2);
    expect(r.get('[role="alert"]')).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it('a feed failure keeps the header and reports in the panel', async () => {
    const adapter = withFailingAuthorFeed(
      adapterWith(),
      new Error('relay-down: no relays reachable'),
    );
    const { r } = mount(adapter);
    await flush();
    expect(r.get('.nf-channelpage__title').textContent).toContain('Orbital Mechanics');
    const alert = r.get('[role="tabpanel"] [role="alert"]');
    expect(alert.textContent).toContain('Relay down');
  });

  it('channel not found (no profile, no videos) → ErrorState, no tabs, Retry refetches', async () => {
    const pk = mocks.asPubkey('there-is-no-such-channel');
    const adapter = adapterWith();
    const profile = vi.spyOn(adapter, 'profile');
    const { r } = mount(adapter, { pubkey: pk });
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Channel not found');
    expect(r.get('h1').textContent).toBe('Channel not found');
    expect(r.all('[role="tab"]')).toHaveLength(0);
    expect(profile).toHaveBeenCalledTimes(1);
    click(r.get('[role="alert"] button'));
    await flush();
    expect(profile).toHaveBeenCalledTimes(2);
  });

  it('a pubkey with videos but no kind 0 is still a channel, named by its short pubkey', async () => {
    const { r } = mount(withProfile(adapterWith(), ORBITAL.pubkey, null));
    await flush();
    expect(r.all('[role="alert"]')).toHaveLength(0);
    const title = r.get('.nf-channelpage__title').textContent;
    expect(title).toContain('…');
    expect(title).not.toContain(ORBITAL.pubkey);
    expect(r.get('.nf-channelpage__head').getAttribute('data-nip05')).toBe('none');
    expect(r.get('.nf-channelpage__sub').textContent).toContain('No profile published');
    expect(r.all('.nf-channelpage__banner')).toHaveLength(0);
    expect(cards(r)).toHaveLength(ORBITAL_LONG.length);
  });

  it('describeChannelError maps relay failures and unknown values', () => {
    expect(describeChannelError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeChannelError('relay timed out').detail).toBe('relay timed out');
    expect(describeChannelError(new Error('boom')).title).toBe('Something went wrong');
    expect(describeChannelError(undefined).detail).toBeUndefined();
  });
});

describe('Channel — cancellation', () => {
  it('unmounting mid-load cancels: no follow-up calls, no setState, no errors', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = adapterWith({ latencyMs: 1000 });
    const image = vi.spyOn(adapter, 'image');
    const stats = vi.spyOn(adapter, 'stats');
    const subscriptions = vi.spyOn(adapter, 'subscriptions');
    const r = render(
      createElement(Channel, {
        adapter,
        navigate: vi.fn<(to: Route) => void>(),
        now: FIXTURE_NOW,
        pubkey: ORBITAL.pubkey,
      }),
    );
    r.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // profile/feed resolved after unmount; the cancelled chains must not continue into
    // subscriptions(), stats() or image() — i.e. no setState after unmount.
    expect(subscriptions).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(r.container.childElementCount).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('unmounting your own channel drops the live seeder subscription', async () => {
    const adapter = adapterWith();
    const off = vi.fn();
    vi.spyOn(adapter.seeder, 'onStatus').mockImplementation(() => off);
    const { r } = mount(adapter, { pubkey: ME });
    await flush();
    expect(off).not.toHaveBeenCalled();
    rendered.splice(rendered.indexOf(r), 1);
    r.unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
