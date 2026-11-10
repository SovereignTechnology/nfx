/**
 * Unit checks for the player's pure parts (`npm run unit`, after `npm run wasm`): the URL
 * sanitisers, the beacon endpoint book behind `watchEndpoints` (rendition availability and
 * what each origin serves included), `open()`'s option checks and the levels it offers
 * (`renditions`, origin sources, the master playlist cut), and the Nostr signaler's
 * bookkeeping (presence, glare, freshness, bounds). The spec's signed beacon vectors
 * (`beacon.json`, `beacon-renditions.json`) run through nfx-wasm into the book, so the shape
 * `verifyBeacon` returns is the shape the book reads, and the hash list vector through
 * nfx-wasm into what `open()` reads of it; the NFX-10 §6 vectors run through nfx-wasm's
 * MeshSession, which builds and reads every signaling event in the browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import initWasm, { MeshRoom, MeshSession, VerifiedHashList, sha256Hex, verifyBeacon } from './out/wasm/nfx_wasm.js';
import type { OriginSource, Signaling } from './src/api';
import {
  EndpointBook,
  MAX_ORIGINS,
  MAX_SEEDERS,
  type VerifiedBeacon,
  beaconStun,
  beaconTracker,
  checkIceServers,
  checkOriginSources,
  checkOrigins,
  checkSignaling,
  checkTrackers,
  originBase,
  checkRelays,
  pageOrigin,
} from './src/endpoints';
import {
  MAX_RENDITIONS,
  checkRenditions,
  contentHash,
  cutMaster,
  hashListLevels,
  mayServe,
  sessionRenditions,
} from './src/levels';
import { MAX_RELAYS, relayUrl } from './src/mesh';
import {
  LIMITS,
  OfferBackoff,
  PresenceBook,
  SeenIds,
  SenderLimiter,
  eventHead,
  eventId,
  offersTo,
  overBytes,
} from './src/signal-book';

const here = dirname(fileURLToPath(import.meta.url));
let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
function throws(what: string, f: () => unknown): void {
  ran += 1;
  try {
    f();
  } catch {
    return;
  }
  bad += 1;
  console.error(`${what}: did not throw`);
}

// ---- URL sanitisers ----------------------------------------------------------------------
const origins: [string, string | null][] = [
  ['https://seed.example/nfx', 'https://seed.example/nfx'],
  ['https://seed.example/nfx/', 'https://seed.example/nfx'],
  ['https://127.0.0.1:38477', 'https://127.0.0.1:38477'],
  ['http://seed.example', null], // beacons name https origins only
  ['https://router.local/admin?x=', null], // a query would steer /<root>/… requests
  ['https://seed.example/#frag', null],
  ['https://user:pw@seed.example', null],
  ['not a url', null],
];
for (const [input, want] of origins) eq(`originBase(${input})`, originBase(input), want);
eq('pageOrigin(http)', pageOrigin('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
eq('pageOrigin(query)', pageOrigin('http://127.0.0.1:9/?a=1'), null);
eq('pageOrigin(ftp)', pageOrigin('ftp://seed.example'), null);

const trackers: [string, string | null][] = [
  ['wss://tracker.example/announce', 'wss://tracker.example/announce'],
  ['wss://tracker.example/', 'wss://tracker.example'],
  ['wss://tracker.example/a?x=1#y', 'wss://tracker.example/a'], // query and fragment dropped
  ['ws://127.0.0.1:8000', null], // a page may use it; a beacon may not point viewers home
  ['ws://tracker.example', null],
  ['https://tracker.example', null],
  ['wss://u:p@tracker.example', null],
  ['', null],
];
for (const [input, want] of trackers) eq(`beaconTracker(${input})`, beaconTracker(input), want);

const stuns: [string, string | null][] = [
  ['203.0.113.10:3478', 'stun:203.0.113.10:3478'],
  ['[2001:db8::1]:3478', 'stun:[2001:db8::1]:3478'],
  ['127.0.0.1:3478', null], // loopback
  ['10.1.2.3:3478', null], // private
  ['172.20.0.1:3478', null],
  ['192.168.1.1:3478', null],
  ['100.64.0.1:3478', null], // shared (CGNAT)
  ['169.254.1.1:3478', null], // link-local
  ['0.0.0.0:3478', null],
  ['224.0.0.1:3478', null], // multicast
  ['255.255.255.255:3478', null],
  ['[::1]:3478', null],
  ['[fe80::1]:3478', null],
  ['[fd00::1]:3478', null], // unique-local
  ['[::ffff:203.0.113.10]:3478', null], // IPv4 inside IPv6
  ['[2001:DB8::1]:3478', null], // not canonical
  ['[2001:db8:0::1]:3478', null],
  ['203.0.113.010:3478', null],
  ['203.0.113.10:03478', null],
  ['203.0.113.256:3478', null],
  ['203.0.113.10:0', null],
  ['203.0.113.10:65536', null],
  ['stun.example:3478', null], // addresses only
  ['203.0.113.10', null],
];
for (const [input, want] of stuns) eq(`beaconStun(${input})`, beaconStun(input), want);

// ---- EndpointBook ------------------------------------------------------------------------
const NOW = 1_800_000_000;
const S = (n: number): string => n.toString(16).padStart(64, '0');
function beacon(seeder: string, createdAt: number, endpoints: unknown, ttl = 120): VerifiedBeacon {
  return { seeder, created_at: createdAt, expiration: createdAt + ttl, a: 'x', content: { endpoints } };
}
const https = (url: string) => ({ t: 'https', url });
const webrtc = (...urls: unknown[]) => ({ t: 'webrtc', tracker_urls: urls, renditions: ['720p'] });
/** Availability when every counted seeder holds every rendition, and when none is counted. */
const allOf = (n: number) => ({ seeders: n, all: n, renditions: [] });

{
  const book = new EndpointBook();
  eq('first beacon taken', book.add(beacon(S(1), NOW, [https('https://a.example/'), webrtc('wss://t1.example')]), NOW), true);
  eq('first snapshot', book.snapshot(NOW), {
    origins: ['https://a.example'],
    originSources: [{ url: 'https://a.example' }],
    trackers: ['wss://t1.example'],
    stunServers: [],
    seeders: 1,
    availability: allOf(1),
  });
  eq('same beacon again (a second relay)', book.add(beacon(S(1), NOW, [https('https://z.example')]), NOW), false);
  eq('older beacon', book.add(beacon(S(1), NOW - 5, [https('https://z.example')]), NOW), false);
  eq('unchanged by the older one', book.snapshot(NOW).origins, ['https://a.example']);
  // The newer beacon replaces what the seeder said: its tracker is withdrawn.
  eq('newer beacon', book.add(beacon(S(1), NOW + 1, [https('https://b.example')]), NOW + 1), true);
  eq('newer replaces', book.snapshot(NOW + 1), {
    origins: ['https://b.example'],
    originSources: [{ url: 'https://b.example' }],
    trackers: [],
    stunServers: [],
    seeders: 1,
    availability: allOf(1),
  });
  // It expires at NOW + 121.
  eq('expired out', book.snapshot(NOW + 121), { origins: [], originSources: [], trackers: [], stunServers: [], seeders: 0, availability: allOf(0) });
  eq('an expired beacon is refused', book.add(beacon(S(2), NOW, [https('https://c.example')]), NOW + 200), false);
}
{
  const book = new EndpointBook();
  book.add(
    beacon(S(1), NOW, [
      https('http://plain.example'),
      https('https://q.example/?x'),
      { t: 'https', url: 7 },
      null,
      'junk',
      { t: 'iroh', node: 'x' },
      { t: 'webrtc', tracker_urls: 'wss://not-a-list.example' },
      webrtc('ws://127.0.0.1:1', 'wss://ok.example', 42, 'wss://u:p@x.example'),
    ]),
    NOW,
  );
  eq('only valid endpoints kept', book.snapshot(NOW), {
    origins: [],
    originSources: [],
    trackers: ['wss://ok.example'],
    stunServers: [],
    seeders: 1,
    availability: allOf(1),
  });
  eq('content without endpoints', book.add(beacon(S(2), NOW, undefined), NOW), true);
  eq('a non-array endpoints', book.add(beacon(S(3), NOW, { t: 'https' }), NOW), true);
  eq('bad seeder', book.add({ ...beacon(S(4), NOW, []), seeder: 5 as unknown as string }, NOW), false);
  eq('bad created_at', book.add({ ...beacon(S(4), NOW, []), created_at: 1.5 }, NOW), false);
}
{
  // Ranked by how many seeders name an entry; ties in first-heard order.
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [webrtc('wss://lonely.example'), https('https://one.example')]), NOW);
  book.add(beacon(S(2), NOW, [webrtc('wss://shared.example'), https('https://two.example')]), NOW);
  book.add(beacon(S(3), NOW, [webrtc('wss://shared.example'), https('https://two.example')]), NOW);
  eq('ranked', book.snapshot(NOW), {
    origins: ['https://two.example', 'https://one.example'],
    originSources: [{ url: 'https://two.example' }, { url: 'https://one.example' }],
    trackers: ['wss://shared.example', 'wss://lonely.example'],
    stunServers: [],
    seeders: 3,
    availability: allOf(3),
  });
}
{
  // STUN servers: global unicast only, ranked like the rest, at most 4 in all.
  const stun = (...addrs: unknown[]) => ({ t: 'stun', addrs });
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [stun('203.0.113.1:3478', '127.0.0.1:3478', '192.168.0.2:3478')]), NOW);
  book.add(beacon(S(2), NOW, [stun('198.51.100.2:3478', '203.0.113.1:3478'), stun(7, null)]), NOW);
  book.add(beacon(S(3), NOW, [{ t: 'stun', addrs: '203.0.113.9:3478' }, stun('[2001:db8::5]:3478')]), NOW);
  eq('stun ranked and filtered', book.snapshot(NOW).stunServers, [
    'stun:203.0.113.1:3478',
    'stun:198.51.100.2:3478',
    'stun:[2001:db8::5]:3478',
  ]);
  for (let i = 4; i < 10; i++) book.add(beacon(S(i), NOW, [stun(`198.51.100.${i}:3478`)]), NOW);
  eq('stun cap', book.snapshot(NOW).stunServers.length, 4);
}
{
  // Caps: per beacon, and overall.
  const book = new EndpointBook();
  const many = Array.from({ length: 10 }, (_, i) => `wss://t${i}.example`);
  book.add(beacon(S(1), NOW, [webrtc(...many), ...many.map((_, i) => https(`https://o${i}.example`))]), NOW);
  eq('per-beacon caps', book.snapshot(NOW), {
    origins: ['https://o0.example', 'https://o1.example', 'https://o2.example', 'https://o3.example'],
    originSources: [0, 1, 2, 3].map((i) => ({ url: `https://o${i}.example` })),
    trackers: ['wss://t0.example', 'wss://t1.example', 'wss://t2.example', 'wss://t3.example'],
    stunServers: [],
    seeders: 1,
    availability: allOf(1),
  });
  for (let i = 2; i <= 12; i++) book.add(beacon(S(i), NOW, [webrtc(`wss://u${i}.example`), https(`https://p${i}.example`)]), NOW);
  const snap = book.snapshot(NOW);
  eq('overall origin cap', snap.origins.length, MAX_ORIGINS);
  eq('overall tracker cap', snap.trackers.length, 4);
}
{
  // At most MAX_SEEDERS held; room again once some expire.
  const book = new EndpointBook();
  for (let i = 0; i < MAX_SEEDERS; i++) book.add(beacon(S(i), NOW, [https(`https://s${i}.example`)], i < 10 ? 30 : 120), NOW);
  eq('one seeder too many', book.add(beacon(S(1000), NOW, [https('https://late.example')]), NOW), false);
  eq('room after expiry', book.add(beacon(S(1000), NOW + 40, [https('https://late.example')]), NOW + 40), true);
  eq('seeders after expiry', book.snapshot(NOW + 40).seeders, MAX_SEEDERS - 10 + 1);
}

// ---- Rendition availability (NFX-03 §5) and what each origin serves -----------------------
const bridge = (...ids: unknown[]) => ({ t: 'webrtc', tracker_urls: ['wss://bridge.example'], renditions: ids });
const served = (url: string, ...ids: unknown[]) => ({ t: 'https', url, renditions: ids });
const iroh = (...ids: string[]) => ({ t: 'iroh', node: 'n', tickets: Object.fromEntries(ids.map((id) => [id, `ticket-for-${id}`])) });
const held = (book: EndpointBook, now: number) => book.snapshot(now).availability;
{
  // Mixed holders: each endpoint type by name, a seeder holds the union, counted once per key.
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [iroh('meta', '720p', '360p')]), NOW); // tickets; `meta` is no rendition
  book.add(beacon(S(2), NOW, [bridge('360p')]), NOW);
  book.add(beacon(S(3), NOW, [served('https://o3.example', '360p'), bridge('1080p', '360p')]), NOW);
  book.add(beacon(S(4), NOW, [{ t: 'stun', addrs: ['203.0.113.1:3478'] }]), NOW); // holds nothing
  book.add(beacon(S(5), NOW, [{ t: 'iroh', node: 'n' }, { t: 'hyper', drive: 'd' }]), NOW); // no tickets, hyper: nothing
  eq('mixed holders', held(book, NOW), {
    seeders: 3,
    all: 0,
    renditions: [
      { id: '360p', seeders: 3 },
      { id: '720p', seeders: 1 },
      { id: '1080p', seeders: 1 },
    ],
  });
  eq('every seeder still counts in seeders', book.snapshot(NOW).seeders, 5);
  eq('an origin with the renditions it serves', book.snapshot(NOW).originSources, [{ url: 'https://o3.example', renditions: ['360p'] }]);
  // Absent = all: an https endpoint without `renditions` holds every rendition, and so does a
  // bridge without one; each counts for every id, named or not.
  book.add(beacon(S(6), NOW, [https('https://all.example')]), NOW);
  book.add(beacon(S(7), NOW, [{ t: 'webrtc', tracker_urls: ['wss://b.example'] }, served('https://o7.example', '720p')]), NOW);
  eq('absent = all', held(book, NOW), {
    seeders: 5,
    all: 2,
    renditions: [
      { id: '360p', seeders: 5 },
      { id: '720p', seeders: 3 },
      { id: '1080p', seeders: 3 },
    ],
  });
  eq('origins: absent serves all, a list serves those', book.snapshot(NOW).originSources, [
    { url: 'https://o3.example', renditions: ['360p'] },
    { url: 'https://all.example' },
    { url: 'https://o7.example', renditions: ['720p'] },
  ]);
  // Stale: an older beacon from a key already held changes nothing; a newer one replaces it.
  eq('stale beacon refused', book.add(beacon(S(2), NOW - 5, [bridge('2160p')]), NOW), false);
  eq('stale changes nothing', held(book, NOW).renditions[0], { id: '360p', seeders: 5 });
  eq('newer beacon taken', book.add(beacon(S(2), NOW + 1, [bridge('720p')]), NOW + 1), true);
  // Ties keep first-heard order: S(1)'s tickets named 720p first.
  eq('the seeder now holds 720p, not 360p', held(book, NOW + 1).renditions, [
    { id: '720p', seeders: 4 },
    { id: '360p', seeders: 4 },
    { id: '1080p', seeders: 3 },
  ]);
  // Expired: S(1)…S(7) were sent at NOW with a 120 s TTL; S(2)'s newer one lasts a second more.
  eq('expired beacons do not count', held(book, NOW + 120), { seeders: 1, all: 0, renditions: [{ id: '720p', seeders: 1 }] });
  eq('none left', held(book, NOW + 121), { seeders: 0, all: 0, renditions: [] });
}
{
  // Bounds: ids a beacon may name, at most MAX_RENDITIONS per seeder and in all, ranked first.
  const book = new EndpointBook();
  const junk = Array.from({ length: 40 }, (_, i) => `junk-${i}`);
  book.add(beacon(S(1), NOW, [bridge(...junk, '', 'meta', 'x'.repeat(65), 7)]), NOW);
  eq('a non-string id: the endpoint holds nothing', held(book, NOW), { seeders: 0, all: 0, renditions: [] });
  book.add(beacon(S(1), NOW + 1, [bridge(...junk, '', 'meta', 'x'.repeat(65), 'x'.repeat(64))]), NOW + 1);
  const one = held(book, NOW + 1);
  eq('one seeder: its first 32 valid ids', [one.renditions.length, one.renditions[0]?.id, one.renditions[31]?.id], [32, 'junk-0', 'junk-31']);
  for (let i = 2; i <= 4; i++) book.add(beacon(S(i), NOW + 1, [bridge('720p'), iroh('1080p')]), NOW + 1);
  const many = held(book, NOW + 1);
  eq('ids many seeders hold outrank a flood', many.renditions.slice(0, 3), [
    { id: '720p', seeders: 3 },
    { id: '1080p', seeders: 3 },
    { id: 'junk-0', seeders: 1 },
  ]);
  eq('at most 32 ids in all', many.renditions.length, 32);
  eq('a 65-character id is not counted', many.renditions.some((r) => r.id.length > 64), false);
}
{
  // What an origin serves: several claims leave only what all of them say; a malformed list
  // makes the endpoint serve nothing (nfx-proto refuses such a beacon outright).
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [served('https://x.example', '720p', '360p')]), NOW);
  book.add(beacon(S(2), NOW, [served('https://x.example/', '360p', '1080p')]), NOW);
  book.add(beacon(S(3), NOW, [https('https://x.example')]), NOW);
  eq('claims narrow, never widen', book.snapshot(NOW).originSources, [{ url: 'https://x.example', renditions: ['360p'] }]);
  book.add(beacon(S(4), NOW, [served('https://x.example', '1080p')]), NOW);
  eq('conflicting claims: it serves none', book.snapshot(NOW).originSources, [{ url: 'https://x.example', renditions: [] }]);
  book.add(beacon(S(5), NOW, [served('https://y.example', '720p'), served('https://y.example', '720p', '360p')]), NOW);
  eq('one beacon naming an origin twice', book.snapshot(NOW).originSources[1], { url: 'https://y.example', renditions: ['720p'] });
  const bad = new EndpointBook();
  bad.add(beacon(S(1), NOW, [{ t: 'https', url: 'https://z.example', renditions: '720p' }, { ...bridge(), renditions: null }]), NOW);
  eq('malformed renditions', [bad.snapshot(NOW).originSources, bad.snapshot(NOW).trackers, held(bad, NOW)], [[], ['wss://bridge.example'], { seeders: 0, all: 0, renditions: [] }]);
  const empty = new EndpointBook();
  empty.add(beacon(S(1), NOW, [{ t: 'iroh', node: 'n', tickets: ['720p'] }, { t: 'iroh', node: 'n', tickets: { meta: 'ticket' } }]), NOW);
  eq('iroh: tickets must be an object; meta alone holds nothing', held(empty, NOW), { seeders: 0, all: 0, renditions: [] });
}

// ---- open()'s option checks --------------------------------------------------------------
eq('trackers normalised and deduplicated', checkTrackers(['wss://t.example/', 'wss://t.example', 'ws://127.0.0.1:9']), [
  'wss://t.example',
  'ws://127.0.0.1:9',
]);
throws('a ws tracker off loopback', () => checkTrackers(['ws://t.example']));
eq('no signaling, no mesh', checkSignaling(undefined), null);
eq('tracker signaling normalised', checkSignaling({ kind: 'trackers', urls: ['wss://t.example/'] }), {
  kind: 'trackers',
  urls: ['wss://t.example'],
});
throws('tracker signaling with no tracker', () => checkSignaling({ kind: 'trackers', urls: [] }));
throws('a signaling kind this build lacks', () => checkSignaling({ kind: 'carrier-pigeon', urls: [] } as unknown as Signaling));
throws('signaling that is not an object', () => checkSignaling(null as unknown as Signaling));
throws('five trackers', () => checkTrackers(['wss://a.x', 'wss://b.x', 'wss://c.x', 'wss://d.x', 'wss://e.x']));
eq('STUN servers, credentials dropped', checkIceServers([{ urls: 'stun:stun.example:3478', username: 'u', credential: 'c' }]), [
  { urls: ['stun:stun.example:3478'] },
]);
eq('stuns and an IPv6 literal', checkIceServers([{ urls: ['stuns:[2001:db8::1]:5349', 'stun:192.0.2.1'] }]), [
  { urls: ['stuns:[2001:db8::1]:5349', 'stun:192.0.2.1'] },
]);
throws('a TURN server', () => checkIceServers([{ urls: 'turn:turn.example' }]));
throws('a STUN URL with a query', () => checkIceServers([{ urls: 'stun:stun.example?transport=tcp' }]));
throws('an empty urls', () => checkIceServers([{ urls: [] }]));
throws('five ICE servers', () => checkIceServers(Array.from({ length: 5 }, () => ({ urls: 'stun:s.example' }))));
eq('origins normalised', checkOrigins(['https://o.example/nfx/', 'http://127.0.0.1:1']), ['https://o.example/nfx', 'http://127.0.0.1:1']);
throws('no origin', () => checkOrigins([]));
throws('an origin with a query', () => checkOrigins(['https://o.example/?x']));

// ---- open()'s levels: `renditions`, what each origin serves, the master playlist cut --------
/** `f` must throw a `type` whose message matches `re`. */
function refuses(what: string, f: () => unknown, type: ErrorConstructor, re: RegExp): void {
  ran += 1;
  try {
    f();
  } catch (e) {
    if (e instanceof type && re.test((e as Error).message)) return;
    bad += 1;
    console.error(`${what}: threw ${String(e)}, want a ${type.name} matching ${re}`);
    return;
  }
  bad += 1;
  console.error(`${what}: did not throw`);
}
eq('renditions absent: every one', checkRenditions(undefined), null);
eq('renditions in the caller order', checkRenditions(['360p', '1080p']), ['360p', '1080p']);
refuses('renditions empty', () => checkRenditions([]), TypeError, /at least one rendition/);
refuses('renditions not a list', () => checkRenditions('720p'), TypeError, /must be a list/);
refuses('renditions null', () => checkRenditions(null), TypeError, /must be a list/);
refuses('an empty id', () => checkRenditions(['720p', '']), TypeError, /"" is not a rendition id/);
refuses('meta', () => checkRenditions(['meta']), TypeError, /"meta" is not a rendition id/);
refuses('a number', () => checkRenditions([720]), TypeError, /720 is not a rendition id/);
refuses('an id twice', () => checkRenditions(['720p', '720p']), TypeError, /"720p" is named twice/);
refuses('33 ids', () => checkRenditions(Array.from({ length: MAX_RENDITIONS + 1 }, (_, i) => `r${i}`)), TypeError, /at most 32/);
eq('32 ids', checkRenditions(Array.from({ length: MAX_RENDITIONS }, (_, i) => `r${i}`))?.length, 32);
refuses('a long id is cut short in the message', () => checkRenditions(['x'.repeat(5000), 'x'.repeat(5000)]), TypeError, /^nfx: renditions: "x{64}…" is named twice$/);

eq('origin sources: strings and objects', checkOriginSources(['https://a.example/', { url: 'https://b.example' }, { url: 'http://127.0.0.1:9/', renditions: ['360p', '360p', '720p'] }]), [
  { url: 'https://a.example', renditions: null },
  { url: 'https://b.example', renditions: null },
  { url: 'http://127.0.0.1:9', renditions: ['360p', '720p'] },
]);
eq('an origin serving none', checkOriginSources([{ url: 'https://a.example', renditions: [] }]), [{ url: 'https://a.example', renditions: [] }]);
eq('an origin given twice: first wins', checkOriginSources([{ url: 'https://a.example', renditions: ['720p'] }, 'https://a.example/']), [
  { url: 'https://a.example', renditions: ['720p'] },
]);
refuses('origin renditions not a list', () => checkOriginSources([{ url: 'https://a.example', renditions: '720p' as never }]), TypeError, /renditions of https:\/\/a.example/);
refuses('origin renditions null', () => checkOriginSources([{ url: 'https://a.example', renditions: null as never }]), TypeError, /renditions of/);
refuses('origin renditions with an empty id', () => checkOriginSources([{ url: 'https://a.example', renditions: [''] }]), TypeError, /renditions of/);
refuses('origin renditions, 33', () => checkOriginSources([{ url: 'https://a.example', renditions: Array.from({ length: 33 }, (_, i) => `r${i}`) }]), TypeError, /at most 32/);
refuses('an origin object without a url', () => checkOriginSources([{ renditions: ['720p'] } as never]), TypeError, /not an origin base/);
refuses('a null origin', () => checkOriginSources([null as never]), TypeError, /not an origin base/);
refuses('origins not a list', () => checkOriginSources('https://a.example' as never), TypeError, /must be a list/);
refuses('too many origins', () => checkOriginSources(Array.from({ length: 17 }, (_, i) => `https://o${i}.example`)), TypeError, /at most 16/);

eq('mayServe: an origin serving all', mayServe(['720p'], null), true);
eq('mayServe: overlap', mayServe(['720p', '360p'], ['360p']), true);
eq('mayServe: disjoint', mayServe(['720p'], ['360p']), false);
eq('mayServe: serves none', mayServe(null, []), false);
eq('mayServe: some, every rendition asked for', mayServe(null, ['360p']), true);

const ladder = ['1080p', '720p', '360p'];
eq('every rendition, every one served', sessionRenditions(ladder, null, null), ladder);
eq('the caller order', sessionRenditions(ladder, ['360p', '1080p'], null), ['360p', '1080p']);
eq('cut to what the origin serves', sessionRenditions(ladder, ['360p', '1080p'], ['1080p', '720p']), ['1080p']);
eq('an origin naming ids the list lacks', sessionRenditions(ladder, null, ['720p', '4320p']), ['720p']);
eq('none of the allowed served', sessionRenditions(ladder, ['720p'], ['360p']), []);
refuses('an id the hash list lacks', () => sessionRenditions(ladder, ['360p', '2160p'], null), RangeError, /"2160p" is not a rendition of this video \(it has "1080p", "720p", "360p"\)/);
refuses('checked even when the origin serves none', () => sessionRenditions(ladder, ['2160p'], []), RangeError, /"2160p"/);

const H = (n: number): string => n.toString(16).padStart(64, `${n % 10}`);
eq('content hash', contentHash(`https://o.example/nfx/${'a'.repeat(64)}/${H(1)}.m3u8`), H(1));
eq('content hash, relative', contentHash(`${H(2)}.m3u8`, `https://o.example/${'a'.repeat(64)}/master.m3u8`), H(2));
eq('content hash: no extension', contentHash(`https://o.example/${H(1)}`), null);
eq('content hash: empty extension', contentHash(`https://o.example/${H(1)}.`), null);
eq('content hash: upper case', contentHash(`https://o.example/${H(10).toUpperCase()}.m3u8`), null);
eq('content hash: a trailing slash', contentHash(`https://o.example/${H(1)}.m3u8/`), H(1));
eq('content hash: not a URL', contentHash('http://[::1'), null);

{
  const list = {
    v: 1,
    video: 'nfx:testnet:1:x',
    files: [
      { name: 'master.m3u8', role: 'playlist-master', sha256: H(9), size: 1 },
      { name: 'r1080.m3u8', role: 'playlist', sha256: H(1), size: 1 },
      { name: 'r720.m3u8', role: 'playlist', sha256: H(2), size: 1 },
      { name: 'r360.m3u8', role: 'playlist', sha256: H(3), size: 1 },
      { name: 'seg', role: 'segment', sha256: H(4), size: 1 },
    ],
    renditions: [
      { id: '1080p', playlist: 'r1080.m3u8', bandwidth: 5 },
      { id: '720p', playlist: 'r720.m3u8', bandwidth: 3 },
      { id: '360p', playlist: 'r360.m3u8', bandwidth: 1 },
      { id: 'ghost', playlist: 'seg', bandwidth: 1 },
    ],
  };
  eq('hash list levels', hashListLevels(JSON.stringify(list)), {
    renditions: [
      { id: '1080p', playlist: H(1) },
      { id: '720p', playlist: H(2) },
      { id: '360p', playlist: H(3) },
    ],
    master: H(9),
  });
}
{
  const base = `https://o.example/nfx/${'a'.repeat(64)}/master.m3u8`;
  const variant = (bw: number, h: number): string => `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${h * 2}x${h},CODECS="avc1.64001f,mp4a.40.2"\n${H(bw)}.m3u8\n`;
  const head = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
  const master = head + variant(1, 1080) + variant(2, 720) + variant(3, 360);
  eq('every variant kept: the text unchanged', cutMaster(master, base, new Set([H(1), H(2), H(3)])), { text: master, kept: 3 });
  eq('one variant kept', cutMaster(master, base, new Set([H(3)])), { text: `${head}\n\n${variant(3, 360)}`, kept: 1 });
  eq('two kept', cutMaster(master, base, new Set([H(1), H(3)])).text, `${head}${variant(1, 1080)}\n${variant(3, 360)}`);
  eq('none kept', cutMaster(master, base, new Set()).kept, 0);
  eq('none kept: no variant left', cutMaster(master, base, new Set()).text.includes('STREAM-INF'), false);
  const crlf = master.replace(/\n/g, '\r\n');
  const c = cutMaster(crlf, base, new Set([H(2)]));
  eq('CRLF', [c.kept, c.text.includes(H(1)), c.text.includes(H(3)), c.text.includes(`${H(2)}.m3u8`)], [1, false, false, true]);
  // As hls.js reads it, tag and blank lines between a STREAM-INF and its URI belong to it,
  // even another STREAM-INF: the variant is one, and goes as one.
  const odd = `${head}#EXT-X-STREAM-INF:BANDWIDTH=1\n\n#EXT-X-STREAM-INF:BANDWIDTH=9\n# a comment\n${H(1)}.m3u8\n${variant(2, 720)}`;
  eq('a STREAM-INF block with tag lines', cutMaster(odd, base, new Set([H(2)])), { text: `${head}\n${variant(2, 720)}`, kept: 1 });
  eq('the block kept whole', cutMaster(odd, base, new Set([H(1), H(2)])), { text: odd, kept: 2 });
  // hls.js matches a STREAM-INF anywhere on a line; so does the cut.
  const midLine = `${head}#EXT-X-UNKNOWN:#EXT-X-STREAM-INF:BANDWIDTH=1\n${H(1)}.m3u8\n${variant(2, 720)}`;
  eq('a STREAM-INF inside another line', cutMaster(midLine, base, new Set([H(2)])), { text: `${head}#EXT-X-UNKNOWN:\n${variant(2, 720)}`, kept: 1 });
  // A URI that is not a content name maps to no rendition: cut whatever `keep` holds.
  const notNamed = `${head}#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://elsewhere.example/${H(1)}.m3u8?x\n#EXT-X-STREAM-INF:BANDWIDTH=2\nplain.m3u8\n${variant(2, 720)}`;
  eq('a URI maps by its last path element, as a level does', cutMaster(notNamed, base, new Set([H(1), H(2)])).kept, 2);
  eq('a URI that is no content name is cut', cutMaster(notNamed, base, new Set([H(2)])).text.includes('plain.m3u8'), false);
  // I-frame playlists are not levels hls.js plays; they are left as they are.
  const iframes = `${master}#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="${H(7)}.m3u8"\n`;
  eq('I-frame variants untouched', cutMaster(iframes, base, new Set([H(2)])).text.endsWith(`URI="${H(7)}.m3u8"\n`), true);
}

// ---- Nostr signaling: the option, and the signaler's bookkeeping --------------------------
const relayCases: [string, string | null][] = [
  ['wss://relay.example', 'wss://relay.example'],
  ['wss://relay.example/', 'wss://relay.example'],
  ['wss://relay.example/nostr?x=1#y', 'wss://relay.example/nostr'], // query and fragment dropped
  ['ws://127.0.0.1:7777', 'ws://127.0.0.1:7777'], // loopback, for tests
  ['ws://[::1]:7777', 'ws://[::1]:7777'],
  ['ws://relay.example', null], // plain ws off loopback
  ['https://relay.example', null],
  ['wss://u:p@relay.example', null],
  ['not a url', null],
];
for (const [input, want] of relayCases) eq(`relayUrl(${input})`, relayUrl(input), want);
eq('nostr signaling normalised', checkSignaling({ kind: 'nostr', relays: ['wss://r.example/', 'wss://r.example', 'ws://127.0.0.1:1'] }), {
  kind: 'nostr',
  relays: ['wss://r.example', 'ws://127.0.0.1:1'],
});
throws('nostr signaling with no relay', () => checkSignaling({ kind: 'nostr', relays: [] }));
throws('nostr signaling with relays missing', () => checkSignaling({ kind: 'nostr' } as unknown as Signaling));
throws('nostr signaling with a plain ws relay', () => checkSignaling({ kind: 'nostr', relays: ['ws://r.example'] }));
throws('nostr signaling with a non-string relay', () => checkSignaling({ kind: 'nostr', relays: [7 as unknown as string] }));
eq('eight relays', checkRelays(Array.from({ length: 8 }, (_, i) => `wss://r${i}.example`)).length, MAX_RELAYS);
throws('nine relays', () => checkRelays(Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`)));
{
  // Glare: exactly one side of a pair offers, the lower lowercase-hex key.
  const lo = '0'.repeat(63) + 'a';
  const hi = '0'.repeat(63) + 'b';
  eq('the lower key offers', [offersTo(lo, hi), offersTo(hi, lo)], [true, false]);
  eq('not to itself', offersTo(lo, lo), false);
}
{
  // Presence: newest by created_at wins; a disconnect wins a same-second tie; expiry; bound.
  const p = new PresenceBook(2);
  eq('connect taken', p.add('a', 100, 190, 100), true);
  eq('present', p.present('a', 150), true);
  eq('expired', p.present('a', 190), false);
  eq('the same connect again', p.add('a', 100, 190, 100), false);
  eq('an older connect', p.add('a', 99, 189, 100), false);
  eq('a disconnect of the same second wins', p.add('a', 100, null, 100), true);
  eq('gone after it', p.present('a', 101), false);
  eq('a connect of that second does not undo it', p.add('a', 100, 190, 100), false);
  eq('a newer connect does', p.add('a', 101, 191, 101), true);
  eq('present again', p.present('a', 150), true);
  eq('a second peer', p.add('b', 100, 190, 100), true);
  eq('a third is refused while both are present', p.add('c', 100, 190, 100), false);
  eq('room once one expires', p.add('c', 200, 290, 200), true);
  eq('held, after the prune', p.size, 1);
}
{
  // A disconnect is kept 60 s, so a replayed older connect cannot bring its peer back.
  const p = new PresenceBook(4);
  p.add('a', 100, 190, 100);
  p.add('a', 110, null, 110);
  p.prune(150);
  eq('a replayed connect after the prune', p.add('a', 105, 195, 150), false);
  p.prune(171);
  eq('the tombstone goes once nothing older is fresh', p.size, 0);
}
{
  const seen = new SeenIds(3);
  eq('unseen', seen.has('a'), false);
  seen.add('a');
  seen.add('a');
  seen.add('b');
  seen.add('c');
  eq('seen', [seen.has('a'), seen.has('b'), seen.has('c')], [true, true, true]);
  seen.add('d');
  eq('the oldest is forgotten past the bound', [seen.has('a'), seen.has('d')], [false, true]);
}
{
  const b = new OfferBackoff(1000, 4000, 2);
  eq('a fresh peer may be offered to', b.allowed('x', 0), true);
  b.failed('x', 0);
  eq('not within the backoff', [b.allowed('x', 999), b.allowed('x', 1000)], [false, true]);
  b.failed('x', 1000);
  eq('doubling', [b.allowed('x', 2999), b.allowed('x', 3000)], [false, true]);
  b.failed('x', 3000);
  b.failed('x', 3000);
  eq('capped', [b.allowed('x', 6999), b.allowed('x', 7000)], [false, true]);
  b.connected('x');
  eq('forgotten once connected', b.allowed('x', 0), true);
  b.failed('y', 0);
  b.failed('z', 0);
  b.failed('w', 0);
  eq('bounded: the oldest goes', [b.allowed('y', 1), b.allowed('w', 1)], [true, false]);
  eq('reference timings', [LIMITS.answerTimeoutMs, LIMITS.pendingOffersPerRoom, LIMITS.negotiationsPerRoom], [15_000, 4, 16]);
}
{
  const h = '0'.repeat(64);
  eq('eventHead', [eventHead(`{"id":"${h}","pubkey":"${h}"}`), eventHead(`{"id":"${h}"}`), eventHead('[')], [{ id: h, pubkey: h }, null, null]);
  eq('overBytes', [overBytes('aaaa', 4), overBytes('aaaaa', 4), overBytes('éé', 4), overBytes('ééé', 4)], [false, true, false, true]);
}
{
  const lim = new SenderLimiter(2, 1000, 2);
  eq('two per window', [lim.take('x', 0), lim.take('x', 10), lim.take('x', 20)], [true, true, false]);
  eq('a new window', lim.take('x', 1000), true);
  eq('another sender', lim.take('y', 1000), true);
  eq('senders bounded', lim.take('z', 1000), false);
  eq('room once a window ends', lim.take('z', 2500), true);
  eq('reference limits', [LIMITS.directedPerSender, LIMITS.directedWindowMs, LIMITS.peersPerRoom], [8, 30_000, 256]);
}
eq('eventId', [eventId('{"id":"' + 'a'.repeat(64) + '"}'), eventId('{"id":"A"}'), eventId('nope'), eventId('{"id":7}')], [
  'a'.repeat(64),
  null,
  null,
  null,
]);

// ---- the signed beacon vector, through nfx-wasm ------------------------------------------
await initWasm({ module_or_path: readFileSync(join(here, 'out/wasm/nfx_wasm_bg.wasm')) });
const vector = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/beacon.json'), 'utf8')) as {
  now: number;
  event: unknown;
};
const verified = JSON.parse(verifyBeacon(JSON.stringify(vector.event), vector.now)) as VerifiedBeacon;
{
  const book = new EndpointBook();
  eq('vector beacon taken', book.add(verified, vector.now), true);
  eq('vector endpoints', book.snapshot(vector.now), {
    origins: ['https://seed.example/nfx'],
    originSources: [{ url: 'https://seed.example/nfx' }],
    trackers: ['wss://tracker.example/announce'],
    stunServers: [],
    seeders: 1,
    availability: allOf(1),
  });
}
throws('vector beacon past its expiration', () => verifyBeacon(JSON.stringify(vector.event), verified.expiration + 1));
{
  // NFX-03 §4's `renditions` vectors, as nfx-wasm returns them, into the book.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/beacon-renditions.json'), 'utf8')) as {
    now: number;
    valid: { name: string; event: unknown }[];
    invalid: { name: string; event: unknown }[];
  };
  const want: Record<string, [OriginSource[], unknown]> = {
    'https-names-one-rendition': [[{ url: 'https://seed.example/nfx', renditions: ['720p'] }], { seeders: 1, all: 0, renditions: [{ id: '720p', seeders: 1 }] }],
    'iroh-https-and-webrtc-name-the-same-rendition': [[{ url: 'https://seed.example/nfx', renditions: ['720p'] }], { seeders: 1, all: 0, renditions: [{ id: '720p', seeders: 1 }] }],
    'https-names-two-of-several': [
      [{ url: 'https://seed.example/nfx', renditions: ['1080p', '360p'] }],
      { seeders: 1, all: 0, renditions: [{ id: '1080p', seeders: 1 }, { id: '360p', seeders: 1 }] },
    ],
    'https-without-renditions-serves-every-rendition': [[{ url: 'https://seed.example/nfx' }], { seeders: 1, all: 1, renditions: [] }],
  };
  eq('renditions vectors covered', v.valid.map((c) => c.name).sort(), Object.keys(want).sort());
  for (const c of v.valid) {
    const book = new EndpointBook();
    book.add(JSON.parse(verifyBeacon(JSON.stringify(c.event), v.now)) as VerifiedBeacon, v.now);
    const snap = book.snapshot(v.now);
    eq(`vector ${c.name}`, [snap.originSources, snap.availability], want[c.name]);
  }
  for (const c of v.invalid) throws(`invalid vector ${c.name}`, () => verifyBeacon(JSON.stringify(c.event), v.now));
}
{
  // The hash list vector through nfx-wasm: what open() reads of it, and its master cut.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/hashlist.json'), 'utf8')) as {
    rendered_bytes_sha256: string;
    hashlist: { files: { name: string; sha256: string }[] };
    playlists: Record<string, string>;
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(v.hashlist, null, 2)}\n`);
  eq('hash list vector bytes', sha256Hex(bytes), v.rendered_bytes_sha256);
  const list = VerifiedHashList.fromRoot(bytes, v.rendered_bytes_sha256);
  const levels = hashListLevels(list.toJSON());
  const sha = (name: string): string | undefined => v.hashlist.files.find((f) => f.name === name)?.sha256;
  eq('hash list vector levels', levels, { renditions: [{ id: '720p', playlist: sha('r720.m3u8') }], master: sha('master.m3u8') });
  const master = v.playlists['master.m3u8'] ?? '';
  const base = `https://seed.example/nfx/${v.rendered_bytes_sha256}/master.m3u8`;
  eq('vector master, its rendition kept', cutMaster(master, base, new Set(levels.renditions.map((r) => r.playlist))), { text: master, kept: 1 });
  eq('vector master, none kept', cutMaster(master, base, new Set()).kept, 0);
  list.free();
}

// ---- the NFX-10 §6 vectors, through nfx-wasm's MeshSession --------------------------------
{
  const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  type Ev = { id: string; created_at: number; [k: string]: unknown };
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/mesh-signal.json'), 'utf8')) as {
    now: number;
    secret_keys_DO_NOT_USE: Record<string, string>;
    room: { stream_swarm_id: string; pubkey: string };
    sessions: Record<'offerer' | 'answerer', { pubkey: string; session_id: string }>;
    nip44: { offer_nonce: string; answer_nonce: string };
    sdp: { offer: string; answer: string };
    events: Record<'connect' | 'disconnect' | 'offer' | 'answer', Ev>;
  };
  const room = new MeshRoom(v.room.stream_swarm_id);
  eq('room key', room.pubkey, v.room.pubkey);
  const session = (role: 'offerer' | 'answerer') =>
    new MeshSession(hex(v.secret_keys_DO_NOT_USE[role]!), hex(v.sessions[role].session_id));
  const off = session('offerer');
  const ans = session('answerer');
  eq('session keys', [off.pubkey, ans.pubkey], [v.sessions.offerer.pubkey, v.sessions.answerer.pubkey]);
  eq('the vector offerer is the lower key', offersTo(off.pubkey, ans.pubkey), true);
  const at = v.events.connect.created_at;
  const same = (what: string, json: string, want: Ev) => eq(what, JSON.parse(json), want);
  same('connect reproduced', off.connect(room, at), v.events.connect);
  same('disconnect reproduced', off.disconnect(room, at), v.events.disconnect);
  same('offer reproduced', off.offer(room, ans.pubkey, v.sdp.offer, hex(v.nip44.offer_nonce), at), v.events.offer);
  same('answer reproduced', ans.answer(room, off.pubkey, v.events.offer.id, v.sdp.answer, hex(v.nip44.answer_nonce), at), v.events.answer);
  const read = (s: MeshSession, ev: Ev, now = v.now) => JSON.parse(s.read(room, JSON.stringify(ev), now)) as Record<string, unknown>;
  eq('connect read', read(ans, v.events.connect).expiration, at + 90);
  const offer = read(ans, v.events.offer);
  eq('offer read', [offer.type, offer.sender], ['offer', off.pubkey]);
  eq('offer opened', ans.open(String(offer.sender), String(offer.content)), v.sdp.offer);
  eq('an offer to another session is ignored', typeof read(off, v.events.offer).ignored, 'string');
  const answer = read(off, v.events.answer);
  eq('answer names its offer', answer.offer, v.events.offer.id);
  eq('answer opened', off.open(String(answer.sender), String(answer.content)), v.sdp.answer);
  throws('the answer opened by the wrong session', () => ans.open(String(answer.sender), String(answer.content)));
  // Freshness: 60 s back, 30 s ahead, and presence until its expiration.
  eq('60 s after', read(ans, v.events.offer, at + 60).type, 'offer');
  throws('61 s after', () => read(ans, v.events.offer, at + 61));
  eq('30 s before', read(ans, v.events.offer, at - 30).type, 'offer');
  throws('31 s before', () => read(ans, v.events.offer, at - 31));
  throws('presence at its expiration', () => read(ans, v.events.connect, at + 90));
  throws('a connect from another room', () => new MeshSession(hex(v.secret_keys_DO_NOT_USE.answerer!), hex(v.sessions.answerer.session_id)).read(new MeshRoom('nfx/1/web/other'), JSON.stringify(v.events.connect), v.now));
  throws('a zero key', () => new MeshSession(new Uint8Array(32), new Uint8Array(16)));
  throws('a short nonce', () => off.offer(room, ans.pubkey, v.sdp.offer, new Uint8Array(31), at));

  const bad = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/mesh-signal-invalid.json'), 'utf8')) as {
    now: number;
    rejected: { name: string; event: Ev }[];
    ignored: { name: string; event: Ev }[];
  };
  for (const c of bad.rejected) {
    const reader = c.name.startsWith('answer-') ? off : ans;
    let outcome = 'accepted';
    try {
      const r = JSON.parse(reader.read(room, JSON.stringify(c.event), bad.now)) as Record<string, unknown>;
      if (r.ignored !== undefined) outcome = 'ignored';
      else if (r.type === 'offer' || r.type === 'answer') reader.open(String(r.sender), String(r.content));
    } catch {
      outcome = 'rejected';
    }
    eq(`rejected vector ${c.name}`, outcome, 'rejected');
  }
  for (const c of bad.ignored) {
    let r: Record<string, unknown> = {};
    try {
      r = JSON.parse(ans.read(room, JSON.stringify(c.event), bad.now)) as Record<string, unknown>;
    } catch (e) {
      r = { error: String(e) };
    }
    eq(`ignored vector ${c.name}`, typeof r.ignored, 'string');
  }
  eq('vector counts', [bad.rejected.length, bad.ignored.length], [36, 7]);
}

console.log(`unit: ${ran - bad}/${ran} ok`);
process.exit(bad === 0 ? 0 : 1);
