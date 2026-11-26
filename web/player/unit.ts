/**
 * Unit checks for the player's pure parts (`npm run unit`, after `npm run wasm`): the URL
 * sanitisers, the beacon endpoint book behind `watchEndpoints` (rendition availability and
 * what beacons claim each origin serves included), `open()`'s option checks and the levels it
 * offers (`renditions`, origin hints, asking the origin what it holds: the probe runner, its
 * bounds, timeouts and aborts, the byte-capped GET, a hostile hint ignored; the master
 * playlist cut), the Nostr signaler's
 * bookkeeping (presence, glare, freshness, bounds), and the remote candidate filter
 * (`remoteCandidates: 'global'`, its vectors in test-vectors/remote-sdp.json). The spec's signed beacon vectors
 * (`beacon.json`, `beacon-renditions.json`) run through nfx-wasm into the book, so the shape
 * `verifyBeacon` returns is the shape the book reads, and the hash list vector through
 * nfx-wasm into what `open()` reads of it; the NFX-10 §6 vectors run through nfx-wasm's
 * MeshSession, which builds and reads every signaling event in the browser; and the stats
 * panel's per-peer book and candidate-pair reader (nfx #99). The NFX-10 §1 STUN vectors run
 * through nfx-wasm (announcements, which the player never uses on its own) and the selection
 * rules (`stun-select.json`: the creator's servers, and the fallback), the verdicts nfx-proto
 * and the generator give; and STUN at the relays a session signals through (`relay-stun.json`,
 * the generator's verdicts), with the NIP-11 reader behind it (a stand-in fetch: no network)
 * and the per-connection order and session-wide cap.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import initWasm, {
  MeshRoom,
  MeshSession,
  VerifiedHashList,
  sha256Hex,
  verifyBeacon,
  verifyStunAnnouncement,
} from './out/wasm/nfx_wasm.js';
import type { MeshStats, OriginSource, RemoteCandidates, Signaling } from './src/api';
import * as fc from './src/file-channel';
import {
  EndpointBook,
  MAX_ICE_SERVERS,
  MAX_ORIGINS,
  MAX_SEEDERS,
  type VerifiedBeacon,
  beaconStun,
  beaconTracker,
  checkIceServers,
  checkOriginSources,
  checkOrigins,
  checkSignaling,
  checkStunFallbackServers,
  checkTrackers,
  globalUnicast,
  ipFamily,
  originBase,
  checkRelays,
  pageOrigin,
  relayStunHost,
  relayStunServers,
  relayStunUrl,
  selectStun,
  selectStunFallback,
  stunHost,
} from './src/endpoints';
import { RESUBSCRIBE_MAX_MS, RESUBSCRIBE_MIN_MS, keepSubscribed } from './src/nostr';
import { RELAY_INFO_MAX_BYTES, RelayInfoCache, fetchRelayInfo, parseRelayInfo, relayInfoUrl } from './src/relay-info';
import { RelayStunBook } from './src/relay-stun';
import { StunFallbackBook } from './src/stun-fallback';
import {
  MAX_RENDITIONS,
  checkRenditions,
  contentHash,
  cutMaster,
  hashListLevels,
  mayServe,
  originOrder,
  probeOrder,
  sessionRenditions,
} from './src/levels';
import {
  MAX_PEERS_LISTED,
  MAX_PEER_WAIT_MS,
  MAX_RELAYS,
  PEER_AHEAD_SECONDS,
  PEER_STORAGE_MIB,
  PEER_WAIT_MS,
  PeerBook,
  PlayIntent,
  type ProbeConnection,
  checkSegmentSource,
  meshConfig,
  printable,
  probeWebRtc,
  relayUrl,
  segmentWindows,
  selectedPair,
} from './src/mesh';
import { addressText, formatBytes, nerdView, pathText, shortId, typingInto } from './src/nerd';
import {
  PROBE_CONCURRENCY,
  PROBE_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  type Probe,
  describe as describeProbes,
  initUrl,
  probeAll,
  probeStatus,
  selectRenditions,
} from './src/probe';
import { MAX_REMOTE_CANDIDATES, filterRemoteSdp, filterRemoteSdpCounted } from './src/remote-sdp';
import {
  LIMITS,
  OfferBackoff,
  PresenceBook,
  SeenIds,
  SenderLimiter,
  eventHead,
  eventId,
  isServerReflexive,
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
  ['1.1.1.1:3478', 'stun:1.1.1.1:3478'],
  ['[2606:4700::1111]:3478', 'stun:[2606:4700::1111]:3478'],
  ['203.0.113.10:3478', null], // documentation (RFC 5737): routes nowhere
  ['198.51.100.7:3478', null],
  ['192.0.2.1:3478', null],
  ['[2001:db8::1]:3478', null], // documentation (RFC 3849)
  ['[2001:db9::1]:3478', 'stun:[2001:db9::1]:3478'], // just past it
  ['[3fff::1]:3478', null], // documentation (RFC 9637)
  ['[3fff:fff:ffff::1]:3478', null],
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
/** The video's creator in these beacons: `beacon(CREATOR, …)` is the creator's own. */
const CREATOR = S(0xc0ffee);
function beacon(seeder: string, createdAt: number, endpoints: unknown, ttl = 120): VerifiedBeacon {
  return { seeder, creator: CREATOR, created_at: createdAt, expiration: createdAt + ttl, a: 'x', content: { endpoints } };
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
    originSources: [{ url: 'https://a.example', tier: 3 }],
    trackers: ['wss://t1.example'],
    stunServers: [],
    stunCreator: [],
    stunSeeders: [],
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
    originSources: [{ url: 'https://b.example', tier: 3 }],
    trackers: [],
    stunServers: [],
    stunCreator: [],
    stunSeeders: [],
    seeders: 1,
    availability: allOf(1),
  });
  // It expires at NOW + 121.
  eq('expired out', book.snapshot(NOW + 121), { origins: [], originSources: [], trackers: [], stunServers: [], stunCreator: [], stunSeeders: [], seeders: 0, availability: allOf(0) });
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
    stunCreator: [],
    stunSeeders: [],
    seeders: 1,
    availability: allOf(1),
  });
  eq('content without endpoints', book.add(beacon(S(2), NOW, undefined), NOW), true);
  eq('a non-array endpoints', book.add(beacon(S(3), NOW, { t: 'https' }), NOW), true);
  eq('bad seeder', book.add({ ...beacon(S(4), NOW, []), seeder: 5 as unknown as string }, NOW), false);
  eq('bad created_at', book.add({ ...beacon(S(4), NOW, []), created_at: 1.5 }, NOW), false);
}
{
  // Trackers ranked by how many seeders name them, ties in first-heard order; origins in
  // NFX-17 §4.2's tiers, never by how many keys name them (book-unit.ts has the tiers).
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [webrtc('wss://lonely.example'), https('https://one.example')]), NOW);
  book.add(beacon(S(2), NOW, [webrtc('wss://shared.example'), https('https://two.example')]), NOW);
  book.add(beacon(S(3), NOW, [webrtc('wss://shared.example'), https('https://two.example')]), NOW);
  const snap = book.snapshot(NOW);
  eq('trackers ranked', snap.trackers, ['wss://shared.example', 'wss://lonely.example']);
  eq('origins: both open', [...snap.originSources].sort((x, y) => x.url.localeCompare(y.url)), [
    { url: 'https://one.example', tier: 3 },
    { url: 'https://two.example', tier: 3 },
  ]);
  eq('ranked: the rest', { ...snap, origins: [], originSources: [], trackers: [] }, {
    origins: [],
    originSources: [],
    trackers: [],
    stunServers: [],
    stunCreator: [],
    stunSeeders: [],
    seeders: 3,
    availability: allOf(3),
  });
}
{
  // STUN servers (NFX-10 §1): only the creator's own beacon names those used routinely;
  // strangers' keys add none, however many name a server. Every seeder's go to the fallback.
  const stun = (...addrs: unknown[]) => ({ t: 'stun', addrs });
  const book = new EndpointBook();
  book.add(beacon(S(1), NOW, [stun('1.1.1.1:3478', '127.0.0.1:3478', '192.168.0.2:3478')]), NOW);
  book.add(beacon(S(2), NOW, [stun('1.0.0.2:3478', '1.1.1.1:3478'), stun(7, null)]), NOW);
  eq('a stranger alone: nothing', book.snapshot(NOW).stunServers, []);
  book.add(beacon(S(3), NOW, [stun('1.1.1.1:3478')]), NOW);
  const { stunServers, stunCreator } = book.snapshot(NOW);
  eq('strangers, three keys: still nothing', { stunServers, stunCreator }, { stunServers: [], stunCreator: [] });
  eq('every seeder for the fallback, filtered', book.snapshot(NOW).stunSeeders, [
    { seeder: S(1), urls: ['stun:1.1.1.1:3478'], expiration: NOW + 120 },
    { seeder: S(2), urls: ['stun:1.0.0.2:3478', 'stun:1.1.1.1:3478'], expiration: NOW + 120 },
    { seeder: S(3), urls: ['stun:1.1.1.1:3478'], expiration: NOW + 120 },
  ]);
  book.add(beacon(CREATOR, NOW, [{ t: 'stun', addrs: '1.1.1.9:3478' }, stun('[2606:4700::5]:3478', '1.0.0.3:53', '10.0.0.1:3478')]), NOW);
  eq('the creator names them', book.snapshot(NOW).stunCreator, ['stun:[2606:4700::5]:3478', 'stun:1.0.0.3:53']);
  eq('global unicast, port 1024 or above', book.snapshot(NOW).stunServers, ['stun:[2606:4700::5]:3478']);
  eq('the creator is a seeder too', book.snapshot(NOW).stunSeeders.length, 4);
  // A newer beacon of the creator replaces what it named; one that expires withdraws it.
  book.add(beacon(CREATOR, NOW + 1, [stun('1.0.0.4:3478', '1.0.0.5:3478', '1.0.0.6:3478', '1.0.0.7:3478', '1.0.0.8:3478')], 60), NOW + 1);
  eq('at most 4 per beacon', book.snapshot(NOW + 1).stunServers, ['stun:1.0.0.4:3478', 'stun:1.0.0.5:3478', 'stun:1.0.0.6:3478', 'stun:1.0.0.7:3478']);
  eq('the creator expires first', book.nextExpiration(NOW + 1), NOW + 61);
  eq('then nothing routine', book.snapshot(NOW + 61).stunServers, []);
}
{
  // Strangers cannot crowd the creator out: its beacon is taken past MAX_SEEDERS.
  const book = new EndpointBook();
  for (let i = 1; i <= MAX_SEEDERS; i++) book.add(beacon(S(i), NOW, [{ t: 'stun', addrs: ['1.1.1.1:3478'] }]), NOW);
  eq('a stranger past the cap', book.add(beacon(S(MAX_SEEDERS + 1), NOW, []), NOW), false);
  eq('the creator past the cap', book.add(beacon(CREATOR, NOW, [{ t: 'stun', addrs: ['1.1.1.2:3478'] }]), NOW), true);
  eq('and its server is used', book.snapshot(NOW).stunServers, ['stun:1.1.1.2:3478']);
}
{
  // selectStun: the page's own first, then its relays', then the creator's by the same rules.
  const creator = ['stun:1.1.1.1:3478', 'stun:1.1.1.2:3478'];
  eq('own first, then the creator s', selectStun(['stun:stun.example:3478'], [], creator), [
    'stun:stun.example:3478',
    'stun:1.1.1.1:3478',
    'stun:1.1.1.2:3478',
  ]);
  eq('own counts once', selectStun(['stun:1.1.1.2:3478', 'stun:1.1.1.2:3478'], [], creator), ['stun:1.1.1.2:3478', 'stun:1.1.1.1:3478']);
  eq('own on any port', selectStun(['stun:9.9.9.9:53'], [], []), ['stun:9.9.9.9:53']);
  eq('the creator s below 1024: refused', selectStun([], [], ['stun:1.1.1.1:1023', 'stun:1.1.1.1:1024']), ['stun:1.1.1.1:1024']);
  eq('the creator s not global unicast: refused', selectStun([], [], ['stun:10.0.0.1:3478', 'stun:203.0.113.1:3478', 'stun:x.example:3478']), []);
  eq('at most 4', selectStun(['stun:a:1', 'stun:b:1', 'stun:c:1', 'stun:d:1', 'stun:e:1'], [], creator).length, 4);
  eq('nothing at all', selectStun([], [], []), []);
  // A relay's server may be a name (it is the relay's own host), never a loopback one.
  const relays = ['stun:relay.example:3478', 'stun:[2606:4700::1111]:3479'];
  eq('own, the relays , then the creator s', selectStun(['stun:9.9.9.9:3478'], relays, creator), [
    'stun:9.9.9.9:3478',
    'stun:relay.example:3478',
    'stun:[2606:4700::1111]:3479',
    'stun:1.1.1.1:3478',
  ]);
  eq('a relay s server that is its own: once, as its own', selectStun(['stun:relay.example:3478'], relays, []), ['stun:relay.example:3478', 'stun:[2606:4700::1111]:3479']);
  eq('a creator s server that a relay named: once', selectStun([], ['stun:1.1.1.1:3478'], creator), ['stun:1.1.1.1:3478', 'stun:1.1.1.2:3478']);
  eq(
    'a relay s server: refused below 1024, at a loopback or private host, or in another form',
    selectStun([], ['stun:relay.example:1023', 'stun:localhost:3478', 'stun:a.localhost:3478', 'stun:127.0.0.1:3478', 'stun:[fd00::1]:3478', 'stun:Relay.example:3478', 'stuns:relay.example:3478', 'stun:relay.example:03478', 'stun:relay.example'], []),
    [],
  );
}
{
  // Caps: per beacon, and overall.
  const book = new EndpointBook();
  const many = Array.from({ length: 10 }, (_, i) => `wss://t${i}.example`);
  book.add(beacon(S(1), NOW, [webrtc(...many), ...many.map((_, i) => https(`https://o${i}.example`))]), NOW);
  const capped = book.snapshot(NOW);
  eq('per-beacon caps', { ...capped, origins: [...capped.origins].sort(), originSources: [...capped.originSources].sort((x, y) => x.url.localeCompare(y.url)) }, {
    origins: ['https://o0.example', 'https://o1.example', 'https://o2.example', 'https://o3.example'],
    originSources: [0, 1, 2, 3].map((i) => ({ url: `https://o${i}.example`, tier: 3 })),
    trackers: ['wss://t0.example', 'wss://t1.example', 'wss://t2.example', 'wss://t3.example'],
    stunServers: [],
    stunCreator: [],
    stunSeeders: [],
    seeders: 1,
    availability: allOf(1),
  });
  for (let i = 2; i <= 12; i++) {
    const four = [0, 1, 2, 3].map((j) => https(`https://p${i}-${j}.example`));
    book.add(beacon(S(i), NOW, [webrtc(`wss://u${i}.example`), ...four]), NOW);
  }
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
  eq('an origin with the renditions it serves', book.snapshot(NOW).originSources, [{ url: 'https://o3.example', renditions: ['360p'], tier: 3 }]);
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
  eq('origins: absent serves all, a list serves those', [...book.snapshot(NOW).originSources].sort((x, y) => x.url.localeCompare(y.url)), [
    { url: 'https://all.example', tier: 3 },
    { url: 'https://o3.example', renditions: ['360p'], tier: 3 },
    { url: 'https://o7.example', renditions: ['720p'], tier: 3 },
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
  eq('claims narrow, never widen', book.snapshot(NOW).originSources, [{ url: 'https://x.example', renditions: ['360p'], tier: 3 }]);
  book.add(beacon(S(4), NOW, [served('https://x.example', '1080p')]), NOW);
  eq('conflicting claims: it serves none', book.snapshot(NOW).originSources, [{ url: 'https://x.example', renditions: [], tier: 3 }]);
  book.add(beacon(S(5), NOW, [served('https://y.example', '720p'), served('https://y.example', '720p', '360p')]), NOW);
  eq('one beacon naming an origin twice', book.snapshot(NOW).originSources.find((o) => o.url === 'https://y.example'), { url: 'https://y.example', renditions: ['720p'], tier: 3 });
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
  { url: 'https://a.example', renditions: null, tier: 4 },
  { url: 'https://b.example', renditions: null, tier: 4 },
  { url: 'http://127.0.0.1:9', renditions: ['360p', '720p'], tier: 4 },
]);
eq('an origin serving none', checkOriginSources([{ url: 'https://a.example', renditions: [] }]), [{ url: 'https://a.example', renditions: [], tier: 4 }]);
eq('an origin with a tier', checkOriginSources([{ url: 'https://a.example', tier: 1 }]), [{ url: 'https://a.example', renditions: null, tier: 1 }]);
refuses('a tier out of range', () => checkOriginSources([{ url: 'https://a.example', tier: 5 as never }]), TypeError, /tier of/);
eq('an origin given twice: first wins', checkOriginSources([{ url: 'https://a.example', renditions: ['720p'] }, 'https://a.example/']), [
  { url: 'https://a.example', renditions: ['720p'], tier: 4 },
]);
refuses('origin renditions not a list', () => checkOriginSources([{ url: 'https://a.example', renditions: '720p' as never }]), TypeError, /renditions of https:\/\/a.example/);
refuses('origin renditions null', () => checkOriginSources([{ url: 'https://a.example', renditions: null as never }]), TypeError, /renditions of/);
refuses('origin renditions with an empty id', () => checkOriginSources([{ url: 'https://a.example', renditions: [''] }]), TypeError, /renditions of/);
refuses('origin renditions, 33', () => checkOriginSources([{ url: 'https://a.example', renditions: Array.from({ length: 33 }, (_, i) => `r${i}`) }]), TypeError, /at most 32/);
refuses('an origin object without a url', () => checkOriginSources([{ renditions: ['720p'] } as never]), TypeError, /not an origin base/);
refuses('a null origin', () => checkOriginSources([null as never]), TypeError, /not an origin base/);
refuses('origins not a list', () => checkOriginSources('https://a.example' as never), TypeError, /must be a list/);
refuses('too many origins', () => checkOriginSources(Array.from({ length: MAX_ORIGINS + 9 }, (_, i) => `https://o${i}.example`)), TypeError, new RegExp(`at most ${MAX_ORIGINS + 8}`));

// Hints (what beacons claim an origin serves): they order, never remove (nfx #85).
eq('mayServe: no claim', mayServe(['720p'], null), true);
eq('mayServe: overlap', mayServe(['720p', '360p'], ['360p']), true);
eq('mayServe: disjoint', mayServe(['720p'], ['360p']), false);
eq('mayServe: a claim of none', mayServe(null, []), false);
eq('mayServe: some, every rendition asked for', mayServe(null, ['360p']), true);
{
  const o = (url: string, renditions: string[] | null) => ({ url, renditions });
  const list = [o('a', ['360p']), o('b', null), o('c', ['720p']), o('d', [])];
  eq('originOrder: a hint naming none of the allowed goes last, kept', originOrder(list, ['720p']).map((x) => x.url), ['b', 'c', 'a', 'd']);
  eq('originOrder: every rendition allowed', originOrder(list, null).map((x) => x.url), ['a', 'b', 'c', 'd']);
  eq('originOrder: nothing removed', originOrder(list, ['4320p']).length, 4);
  eq('originOrder: stable within each group', originOrder([o('x', ['1']), o('y', ['2']), o('z', ['1'])], ['2']).map((x) => x.url), ['y', 'x', 'z']);
}
const ladder = ['1080p', '720p', '360p'];
eq('probeOrder: no hint', probeOrder(ladder, null), ladder);
eq('probeOrder: named first, the rest kept', probeOrder(ladder, ['360p']), ['360p', '1080p', '720p']);
eq('probeOrder: a claim of none removes nothing', probeOrder(ladder, []), ladder);
eq('probeOrder: ids the list lacks are ignored', probeOrder(['720p'], ['4320p', '720p']), ['720p']);
{
  const many = Array.from({ length: 40 }, (_, i) => `r${i}`);
  eq('probeOrder: at most MAX_RENDITIONS', probeOrder(many, null).length, MAX_RENDITIONS);
  eq('probeOrder: the hinted ones survive the cap, in the caller order', probeOrder(many, ['r39', 'r38']).slice(0, 3), ['r38', 'r39', 'r0']);
}

eq('every rendition, every one held', sessionRenditions(ladder, null, null), ladder);
eq('the caller order', sessionRenditions(ladder, ['360p', '1080p'], null), ['360p', '1080p']);
eq('cut to what the origin holds', sessionRenditions(ladder, ['360p', '1080p'], ['1080p', '720p']), ['1080p']);
eq('held ids the list lacks', sessionRenditions(ladder, null, ['720p', '4320p']), ['720p']);
eq('none of the allowed held', sessionRenditions(ladder, ['720p'], ['360p']), []);
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
      { id: '1080p', playlist: H(1), playlistSize: 1 },
      { id: '720p', playlist: H(2), playlistSize: 1 },
      { id: '360p', playlist: H(3), playlistSize: 1 },
    ],
    master: H(9),
  });
  const sized = { ...list, files: list.files.map((f) => (f.name === 'r720.m3u8' ? { ...f, size: -1 } : f.name === 'r360.m3u8' ? { ...f, size: '7' } : f)) };
  eq('an unusable size is null', hashListLevels(JSON.stringify(sized)).renditions.map((r) => r.playlistSize), [1, null, null]);
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

// ---- Asking the origin what it holds (nfx #85): the probe runner, the GET, the init URI ---
const unhandled: unknown[] = [];
process.on('unhandledRejection', (e) => void unhandled.push(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A probe answering from `table` (id → status, or an Error to throw), after `ms`. */
const answers = (table: Record<string, number | Error>, ms = 1, log: string[] = []): Probe => async (id) => {
  log.push(id);
  await sleep(ms);
  const a = table[id];
  if (a instanceof Error) throw a;
  return a ?? 404;
};
const outcomes = (m: Map<string, unknown>) => Object.fromEntries(m);
eq('probe defaults', [PROBE_TIMEOUT_MS, PROBE_CONCURRENCY, PROBE_MAX_BYTES], [8000, 6, 65536]);
{
  const m = await probeAll(['720p', '360p', '1080p', '240p', 'x'], answers({ '720p': 200, '360p': 206, '1080p': 404, '240p': 500, x: new Error('network down') }));
  eq('probeAll: 200 and 206 hold, nothing else does', outcomes(m), {
    '720p': { held: true, status: 200 },
    '360p': { held: true, status: 206 },
    '1080p': { held: false, why: 'HTTP 404' },
    '240p': { held: false, why: 'HTTP 500' },
    x: { held: false, why: 'network down' },
  });
  eq('probeAll: in the order asked', [...m.keys()], ['720p', '360p', '1080p', '240p', 'x']);
  eq('probeAll: nothing to ask', (await probeAll([], answers({}))).size, 0);
  eq('probeAll: a concurrency that is no number', outcomes(await probeAll(['a'], answers({ a: 200 }), { concurrency: Number.NaN })), { a: { held: true, status: 200 } });
  eq('probeAll: a deadline of 0 offers nothing', [...(await probeAll(['a'], answers({ a: 200 }, 5), { timeoutMs: 0 })).values()].some((o) => o.held), false);
}
{
  // At most `concurrency` at once, started in the order given.
  let now = 0;
  let most = 0;
  const started: string[] = [];
  const probe: Probe = async (id) => {
    started.push(id);
    now += 1;
    most = Math.max(most, now);
    await sleep(5);
    now -= 1;
    return 200;
  };
  const ids = Array.from({ length: 9 }, (_, i) => `r${i}`);
  const m = await probeAll(ids, probe, { concurrency: 2 });
  eq('probeAll: bounded in parallel', [most, started, [...m.values()].every((o) => o.held)], [2, ids, true]);
  most = 0;
  await probeAll(ids, probe);
  eq('probeAll: 6 at once by default', most, 6);
}
{
  // One deadline for all: a probe that never answers, and ignores its signal, is cut off;
  // the ids never reached are not held either, and probeAll still resolves on time.
  const seen: AbortSignal[] = [];
  const hang: Probe = (id, signal) => {
    seen.push(signal);
    return id === 'fast' ? Promise.resolve(200) : new Promise<number>(() => {});
  };
  const t0 = Date.now();
  const m = await probeAll(['fast', 'stuck', 'never'], hang, { timeoutMs: 60, concurrency: 1 });
  const took = Date.now() - t0;
  eq('probeAll: the deadline', outcomes(m), {
    fast: { held: true, status: 200 },
    stuck: { held: false, why: 'no answer within 60 ms' },
    never: { held: false, why: 'not probed within 60 ms' },
  });
  eq('probeAll: resolves at the deadline', took >= 55 && took < 2000, true);
  eq('probeAll: the probes are told to stop', seen.every((s) => s.aborted), true);
  // A probe that rejects after its deadline is not an unhandled rejection.
  const late: Probe = (_, signal) => new Promise<number>((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('late')), 5)));
  eq('probeAll: a late rejection', outcomes(await probeAll(['a'], late, { timeoutMs: 20 })), { a: { held: false, why: 'no answer within 20 ms' } });
}
{
  // The caller's signal: aborting rejects with its reason and stops every probe.
  const ctl = new AbortController();
  const seen: AbortSignal[] = [];
  const p = probeAll(['a', 'b'], (_, signal) => {
    seen.push(signal);
    return new Promise<number>(() => {});
  }, { signal: ctl.signal, timeoutMs: 60_000 });
  await sleep(5);
  ctl.abort(new Error('viewer left'));
  let got = 'resolved';
  try {
    await p;
  } catch (e) {
    got = (e as Error).message;
  }
  eq('probeAll: aborted', [got, seen.length, seen.every((s) => s.aborted)], ['viewer left', 2, true]);
  let called = 0;
  let pre = 'resolved';
  try {
    await probeAll(['a'], async () => (called += 1), { signal: AbortSignal.abort(new Error('already')) });
  } catch (e) {
    pre = (e as Error).message;
  }
  eq('probeAll: aborted before it starts', [pre, called], ['already', 0]);
  // Its timer and listeners go with it: no timeout left behind.
  const timers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  await probeAll(['a', 'b'], answers({ a: 200, b: 200 }), { timeoutMs: 60_000, signal: new AbortController().signal });
  await sleep(5);
  eq('probeAll: leaves no timer', timers(), before);
}
{
  // The GET: no Range header, credentials omitted, at most PROBE_MAX_BYTES of the body read,
  // none of an error's; an origin without Range support answers 200 with the whole file.
  const calls: { url: string; init: RequestInit }[] = [];
  let pulled = 0;
  let cancelled = 0;
  const stream = (chunk: number, total: number): ReadableStream<Uint8Array> => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        if (sent >= total) return c.close();
        const n = Math.min(chunk, total - sent);
        sent += n;
        c.enqueue(new Uint8Array(n));
      },
      cancel() {
        cancelled += 1;
      },
    });
  };
  const serve = (status: number, body: () => ReadableStream<Uint8Array> | null) => async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body(), { status });
  };
  const sig = new AbortController().signal;
  eq('probeStatus: a small init, read whole', await probeStatus(serve(200, () => stream(1000, 3000)), 'https://o.example/r/i.mp4', sig), 200);
  eq('probeStatus: read to the end, nothing cancelled', [cancelled, calls[0]?.init.headers, calls[0]?.init.credentials, calls[0]?.init.cache, calls[0]?.init.signal === sig], [0, undefined, 'omit', 'no-cache', true]);
  pulled = 0;
  eq('probeStatus: an endless 200 (no Range)', await probeStatus(serve(200, () => stream(16 * 1024, Number.MAX_SAFE_INTEGER)), 'https://o.example/r/i.mp4', sig), 200);
  await sleep(1);
  eq('probeStatus: cut at the cap', [pulled <= PROBE_MAX_BYTES / (16 * 1024) + 2, cancelled], [true, 1]);
  pulled = 0;
  eq('probeStatus: a 404', await probeStatus(serve(404, () => stream(1000, 1_000_000)), 'https://o.example/r/i.mp4', sig), 404);
  await sleep(1);
  eq('probeStatus: an error body is not read', [pulled <= 1, cancelled], [true, 2]);
  eq('probeStatus: a 206', await probeStatus(serve(206, () => stream(10, 10)), 'https://o.example/r/i.mp4', sig), 206);
  eq('probeStatus: no body', await probeStatus(serve(200, () => null), 'https://o.example/r/i.mp4', sig), 200);
  eq('probeStatus: a smaller cap', await probeStatus(serve(200, () => stream(100, 1_000_000)), 'https://o.example/r/i.mp4', sig, 250), 200);
  let failed = '';
  try {
    await probeStatus(async () => {
      throw new TypeError('Failed to fetch');
    }, 'https://o.example/r/i.mp4', sig);
  } catch (e) {
    failed = (e as Error).message;
  }
  eq('probeStatus: a network failure rejects', failed, 'Failed to fetch');
  // Aborted mid-body: the read rejects, so probeAll counts it as no answer.
  const ctl = new AbortController();
  const slow = async (_: string, init: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
        init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200 });
  };
  const pending = probeStatus(slow, 'https://o.example/r/i.mp4', ctl.signal);
  await sleep(5);
  ctl.abort();
  let aborted = '';
  try {
    await pending;
  } catch (e) {
    aborted = (e as Error).name;
  }
  eq('probeStatus: aborted mid-body', aborted, 'AbortError');
}
{
  const pl = 'https://o.example/nfx/root/aaaa.m3u8';
  const seg = (n: number) => `${String(n).repeat(64)}.m4s`;
  eq('initUrl: EXT-X-MAP, resolved against the playlist', initUrl(`#EXTM3U\n#EXT-X-MAP:URI="${'b'.repeat(64)}.mp4"\n#EXTINF:2,\n${seg(1)}\n`, pl), `https://o.example/nfx/root/${'b'.repeat(64)}.mp4`);
  eq('initUrl: other attributes first, CRLF', initUrl(`#EXTM3U\r\n#EXT-X-MAP:BYTERANGE="9@0",URI="init.mp4"\r\n`, pl), 'https://o.example/nfx/root/init.mp4');
  eq('initUrl: no map, the first segment', initUrl(`#EXTM3U\n# a comment\n\n#EXTINF:2,\n  ${seg(2)}  \n#EXTINF:2,\n${seg(3)}\n`, pl), `https://o.example/nfx/root/${seg(2)}`);
  eq('initUrl: neither', initUrl('#EXTM3U\n#EXT-X-ENDLIST\n', pl), null);
  eq('initUrl: an empty URI', initUrl('#EXTM3U\n#EXT-X-MAP:URI=""\n', pl), null);
}
{
  const many = new Map(Array.from({ length: 10 }, (_, i): [string, { held: false; why: string }] => [i === 0 ? 'x'.repeat(100) : `r${i}`, { held: false, why: 'HTTP 404' }]));
  const line = describeProbes(many);
  eq('describe: capped', [line.startsWith(`${'x'.repeat(64)}…: HTTP 404; r1: HTTP 404`), line.endsWith('; and 2 more')], [true, true]);
  eq('describe: held', describeProbes(new Map([['720p', { held: true, status: 200 }]])), '720p: HTTP 200');
}
{
  // One origin's part of open(): a hint orders the asking and nothing else.
  const ids = ['720p', '360p'];
  const asked: string[] = [];
  // A hostile beacon narrows an origin that holds both to 360p: both are still offered.
  const both = await selectRenditions(ids, null, ['360p'], answers({ '720p': 200, '360p': 200 }, 1, asked));
  eq('a hostile narrowing hint is ignored', [both.renditions, asked, [...both.outcomes.keys()], both.unasked], [['720p', '360p'], ['360p', '720p'], ['360p', '720p'], 0]);
  // The viewer wants 720p, which the hint leaves out: the origin is still asked, and used.
  asked.length = 0;
  const wanted = await selectRenditions(ids, ['720p'], ['360p'], answers({ '720p': 200, '360p': 200 }, 1, asked));
  eq('a hint cannot take away a wanted rendition', [wanted.renditions, asked], [['720p'], ['720p']]);
  // A hint widening what the origin holds adds nothing: 720p's init answers 404.
  const lying = await selectRenditions(ids, null, ['720p', '360p'], answers({ '720p': 404, '360p': 200 }));
  eq('a hint cannot add a level', [lying.renditions, lying.outcomes.get('720p')], [['360p'], { held: false, why: 'HTTP 404' }]);
  eq('a claim of none: still asked', (await selectRenditions(ids, null, [], answers({ '720p': 200, '360p': 200 }))).renditions, ['720p', '360p']);
  eq('it holds none', (await selectRenditions(ids, ['720p'], null, answers({}))).renditions, []);
  eq('the caller order, not the asking order', (await selectRenditions(ids, ['360p', '720p'], ['720p'], answers({ '720p': 200, '360p': 200 }))).renditions, ['360p', '720p']);
  let range = '';
  asked.length = 0;
  try {
    await selectRenditions(ids, ['4320p'], null, answers({}, 1, asked));
  } catch (e) {
    range = e instanceof RangeError ? 'RangeError' : String(e);
  }
  eq('an id the hash list lacks: refused before any probe', [range, asked.length], ['RangeError', 0]);
  const forty = Array.from({ length: 40 }, (_, i) => `r${i}`);
  const capped = await selectRenditions(forty, null, ['r39'], answers(Object.fromEntries(forty.map((id) => [id, 200]))));
  eq('at most 32 asked; the rest are not offered', [capped.outcomes.size, capped.unasked, capped.renditions.length, capped.renditions.includes('r39'), capped.renditions.includes('r38')], [32, 8, 32, true, false]);
}
await sleep(20);
eq('no unhandled rejection from any probe', unhandled.map(String), []);

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

// ---- the remote candidate filter (remoteCandidates: 'global', nutflix-pear ADR 0023 rule 5) --
eq('nostr signaling, remote candidates global', checkSignaling({ kind: 'nostr', relays: ['wss://r.example/'], remoteCandidates: 'global' }), {
  kind: 'nostr',
  relays: ['wss://r.example'],
  remoteCandidates: 'global',
});
eq('nostr signaling, remote candidates all', checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], remoteCandidates: 'all' }), {
  kind: 'nostr',
  relays: ['wss://r.example'],
  remoteCandidates: 'all',
});
throws('remote candidates neither all nor global', () =>
  checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], remoteCandidates: 'private' as RemoteCandidates }),
);
throws('remote candidates not a string', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], remoteCandidates: 1 as unknown as RemoteCandidates }));
throws('remote candidates global with trackers (not filtered there)', () =>
  checkSignaling({ kind: 'trackers', urls: ['wss://t.example'], remoteCandidates: 'global' } as unknown as Signaling),
);
eq('remote candidates all with trackers', checkSignaling({ kind: 'trackers', urls: ['wss://t.example'], remoteCandidates: 'all' } as unknown as Signaling), {
  kind: 'trackers',
  urls: ['wss://t.example'],
});
eq('ipFamily', ['1.2.3.4', '2a00::1', '01.2.3.4', '2A00::1', 'host.local', '::ffff:1.2.3.4', ''].map(ipFamily), [4, 6, null, null, null, null, null]);
eq(
  'documentation blocks: refused for a STUN server and for ICE',
  ['192.0.2.1', '198.51.100.1', '203.0.113.1', '2001:db8::1'].map((a) => [globalUnicast(a, 'stun'), globalUnicast(a, 'ice')]),
  [
    [false, false],
    [false, false],
    [false, false],
    [false, false],
  ],
);
eq(
  '3fff::/20: refused for a STUN server',
  ['3fff::1', '3fff:fff:ffff::1'].map((a) => globalUnicast(a, 'stun')),
  [false, false],
);
throws('filterRemoteSdp: another mode', () => filterRemoteSdp('v=0\r\n', 'none' as RemoteCandidates));
throws('filterRemoteSdp: not a string', () => filterRemoteSdp(null as unknown as string, 'global'));
{
  const v = JSON.parse(readFileSync(join(here, 'test-vectors/remote-sdp.json'), 'utf8')) as {
    max_kept: number;
    head: string[];
    tail: string[];
    cases: { name: string; mode?: RemoteCandidates; in?: string[]; out?: string[]; in_raw?: string; out_raw?: string }[];
  };
  const sdp = (lines: string[]): string => [...v.head, ...lines, ...v.tail].map((l) => `${l}\r\n`).join('');
  eq('remote SDP: at most 16 kept', [MAX_REMOTE_CANDIDATES, v.max_kept], [16, 16]);
  for (const c of v.cases) {
    const input = c.in_raw ?? sdp(c.in ?? []);
    eq(`remote SDP: ${c.name}`, filterRemoteSdp(input, c.mode ?? 'global'), c.out_raw ?? sdp(c.out ?? []));
  }
  eq('remote SDP vectors', [v.cases.length, new Set(v.cases.map((c) => c.name)).size], [36, 36]);
  const cap = v.cases.find((c) => c.name === 'dropped candidates do not count toward the 16');
  const counted = filterRemoteSdpCounted(sdp(cap?.in ?? []), 'global');
  eq('remote SDP: counts', [counted.kept, counted.dropped], [16, 5]);
  eq('remote SDP: all is the identity', filterRemoteSdp('v=0\ra=candidate:x\n', 'all'), 'v=0\ra=candidate:x\n');
}

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
    originSources: [{ url: 'https://seed.example/nfx', tier: verified.seeder === verified.creator ? 1 : 3 }],
    trackers: ['wss://tracker.example/announce'],
    stunServers: [],
    stunCreator: [],
    stunSeeders: [],
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
    // The tier (NFX-17 §4.2) is book-unit.ts's to check; here, what each origin serves.
    const served = snap.originSources.map(({ tier: _tier, ...o }) => o);
    eq(`vector ${c.name}`, [served, snap.availability], want[c.name]);
  }
  for (const c of v.invalid) throws(`invalid vector ${c.name}`, () => verifyBeacon(JSON.stringify(c.event), v.now));
}
{
  // The hash list vector through nfx-wasm: what open() reads of it, and its master cut.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/hashlist.json'), 'utf8')) as {
    rendered_bytes_sha256: string;
    hashlist: { files: { name: string; sha256: string; size: number }[] };
    playlists: Record<string, string>;
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(v.hashlist, null, 2)}\n`);
  eq('hash list vector bytes', sha256Hex(bytes), v.rendered_bytes_sha256);
  const list = VerifiedHashList.fromRoot(bytes, v.rendered_bytes_sha256);
  const levels = hashListLevels(list.toJSON());
  const sha = (name: string): string | undefined => v.hashlist.files.find((f) => f.name === name)?.sha256;
  const size = (name: string): number | undefined => v.hashlist.files.find((f) => f.name === name)?.size;
  eq('hash list vector levels', levels, { renditions: [{ id: '720p', playlist: sha('r720.m3u8'), playlistSize: size('r720.m3u8') }], master: sha('master.m3u8') });
  // The vector's own playlist names its init by content name (NFX-05 §3).
  const r720 = v.playlists['r720.m3u8'] ?? '';
  const under = `https://seed.example/nfx/${v.rendered_bytes_sha256}/`;
  eq('vector playlist: its init', initUrl(r720, `${under}${sha('r720.m3u8')}.m3u8`), `${under}${sha('init-720.mp4')}.mp4`);
  // And the playlist verifies under that URL, so open() may read it.
  eq('vector playlist verifies', list.check(`/nfx/${v.rendered_bytes_sha256}/${sha('r720.m3u8')}.m3u8`, new TextEncoder().encode(r720)), sha('r720.m3u8'));
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
  {
    const vr = v as unknown as {
      video_rooms: { address: string; video_room_id: string; pubkey: string }[];
      video_room_refused: { name: string; address: string }[];
    };
    for (const r of vr.video_rooms) {
      eq(`video room id of ${r.address.slice(0, 12)}…`, MeshRoom.videoRoomId(r.address), r.video_room_id);
      eq(`video room key of ${r.address.slice(0, 12)}…`, MeshRoom.forVideo(r.address).pubkey, r.pubkey);
      eq('a video room is the room of its id', new MeshRoom(r.video_room_id).pubkey, r.pubkey);
    }
    for (const r of vr.video_room_refused) throws(`video room refused: ${r.name}`, () => MeshRoom.forVideo(r.address));
  }
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

// ---- STUN servers named over Nostr: the NFX-10 §1 vectors ----------------------------------
/** A STUN service announcement as nfx-wasm's `verifyStunAnnouncement` returns it. */
interface VerifiedStunAnnouncement {
  operator: string;
  addr: string;
  networks: string[];
  created_at: number;
  expiration: number;
}
{
  // Announcements, through nfx-wasm.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/stun-announcement.json'), 'utf8')) as {
    now: number;
    valid: { name: string; event: unknown; reads_as: unknown }[];
    invalid: { name: string; event: unknown }[];
  };
  for (const c of v.valid) {
    // nfx-wasm writes the keys sorted; the vector, in its own order: compare field by field.
    const r = JSON.parse(verifyStunAnnouncement(JSON.stringify(c.event), v.now)) as VerifiedStunAnnouncement;
    const want = c.reads_as as VerifiedStunAnnouncement;
    eq(
      `announcement ${c.name}`,
      [r.operator, r.addr, r.networks, r.created_at, r.expiration],
      [want.operator, want.addr, want.networks, want.created_at, want.expiration],
    );
  }
  for (const c of v.invalid) throws(`announcement ${c.name}`, () => verifyStunAnnouncement(JSON.stringify(c.event), v.now));
  eq('announcement vector counts', [v.valid.length, v.invalid.length], [5, 38]);
}
{
  // Selection: the same verdicts as nfx-proto (Rust) and the generator (Python). Only the
  // creator's beacons are an input; strangers' and announcements are not.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/stun-select.json'), 'utf8')) as {
    max: number;
    cases: { name: string; own: string[]; creator: string; beacons: [string, string][]; selected: string[] }[];
    fallback: {
      name: string;
      own: string[];
      in_use: string[];
      mapped: boolean;
      beacons: [string, string][];
      signaling: string[];
      selected: string[];
    }[];
    global_unicast: { yes: string[]; no: string[] };
  };
  eq('max', v.max, MAX_ICE_SERVERS);
  for (const c of v.cases) {
    // As the book takes a beacon: through beaconStun, then the creator's alone.
    const creator = c.beacons.flatMap(([signer, addr]) => {
      const url = beaconStun(addr);
      return signer === c.creator && url !== null ? [url] : [];
    });
    const got = selectStun(
      c.own.map((a) => `stun:${a}`),
      [],
      creator,
      v.max,
    );
    eq(`select ${c.name}`, got, c.selected.map((a) => `stun:${a}`));
  }
  eq('select vector count', v.cases.length, 21);
  for (const a of v.global_unicast.yes) eq(`global unicast ${a}`, beaconStun(a) !== null, true);
  for (const a of v.global_unicast.no) eq(`not global unicast ${a}`, beaconStun(a), null);
  // The fallback: the same verdicts, and an announcement is not even an input.
  const url = (a: string): string => `stun:${a}`;
  for (const c of v.fallback) {
    const seeders: { seeder: string; urls: string[] }[] = [];
    for (const [seeder, addr] of c.beacons) {
      const held = seeders.find((s) => s.seeder === seeder);
      if (held) held.urls.push(url(addr));
      else seeders.push({ seeder, urls: [url(addr)] });
    }
    const got = selectStunFallback(c.own.map(url), c.in_use.map(url), c.mapped, seeders, c.signaling, v.max);
    eq(`fallback ${c.name}`, got.map((p) => p.url), c.selected.map(url));
  }
  eq('fallback vector count', v.fallback.length, 22);
}
{
  // The fallback as one session's state (NFX-10 §1).
  const X = 'stun:1.1.1.1:3478';
  const Y = 'stun:1.0.0.1:3478';
  const OWN = 'stun:9.9.9.9:3478';
  const sdpAt = (ip: string): string => `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 2122260223 ${ip} 50000 typ host\r\n`;
  const noMapping = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=candidate:1 1 udp 2122260223 abcd.local 50000 typ host\r\n';
  const mapping = `${noMapping}a=candidate:2 1 udp 1686052607 1.2.3.4 41000 typ srflx raddr 0.0.0.0 rport 0\r\n`;
  const seeders = [
    { seeder: 's1', urls: [X], expiration: 1000 },
    { seeder: 's2', urls: [Y], expiration: 2000 },
  ];
  const book = new StunFallbackBook({ own: [OWN], seeders: () => seeders }, [OWN]);
  book.signaled('p1', sdpAt('1.1.1.1'));
  eq('fallback: off until a gathering found no mapping', book.serversFor('p1', 500), []);
  book.gathered(mapping);
  eq('fallback: off while a mapping came back', book.serversFor('p1', 500), []);
  book.gathered(noMapping);
  eq('fallback: the seeder at this peer\'s address', book.serversFor('p1', 500), [X]);
  eq('fallback: the same server again, for the same peer', book.serversFor('p1', 500), [X]);
  eq('fallback: not a peer it never heard an SDP from', book.serversFor('p2', 500), []);
  book.signaled('p3', sdpAt('8.8.8.8'));
  eq('fallback: not a peer at no seeder\'s address', book.serversFor('p3', 500), []);
  eq('fallback: an expired beacon names nothing', book.serversFor('p1', 1000), []);
  book.forget('p1');
  eq('fallback: not after the peer left', book.serversFor('p1', 500), []);
  const before = 'v=0\r\na=candidate:1 1 udp 2122260223 1.1.1.1 50000 typ host\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
  book.signaled('p4', before);
  eq('fallback: a candidate outside any media section counts for nothing', book.serversFor('p4', 500), []);
  book.gathered(mapping);
  book.signaled('p1', sdpAt('1.1.1.1'));
  eq('fallback: off again once a mapping came back', book.serversFor('p1', 500), []);

  // At most 4 in the whole session, its own included, across peers.
  const many = [1, 2, 3, 4].map((i) => ({ seeder: `s${i}`, urls: [`stun:1.1.1.${i}:3478`], expiration: 1000 }));
  const capped = new StunFallbackBook({ own: [OWN], seeders: () => many }, [OWN, 'stun:9.9.9.10:3478']);
  capped.gathered(noMapping);
  const asked = [1, 2, 3, 4].flatMap((i) => {
    capped.signaled(`p${i}`, sdpAt(`1.1.1.${i}`));
    return capped.serversFor(`p${i}`, 500);
  });
  eq('fallback: two of its own, so two more in the session', asked, ['stun:1.1.1.1:3478', 'stun:1.1.1.2:3478']);

  const broken = new StunFallbackBook({ own: [OWN], seeders: () => { throw new Error('page'); } }, [OWN]);
  broken.gathered(noMapping);
  broken.signaled('p1', sdpAt('1.1.1.1'));
  eq('fallback: a page function that throws means none', broken.serversFor('p1', 500), []);

  // With no STUN server of its own, every gathering ends with no mapping: it falls back too.
  const none = new StunFallbackBook({ own: [], seeders: () => seeders }, []);
  none.signaled('p1', sdpAt('1.1.1.1'));
  none.gathered(noMapping);
  eq('fallback: with no server of its own too', none.serversFor('p1', 500), [X]);
  none.signaled('p2', sdpAt('8.8.8.8'));
  eq('fallback: with none, still only at a signaled peer\'s address', none.serversFor('p2', 500), []);
  none.gathered(mapping);
  eq('fallback: with none, off once a server it asks gave a mapping', none.serversFor('p1', 500), []);

  // With relayStun, what the session has asked (its relays' servers included) is what counts.
  const viaRelays = new StunFallbackBook({ own: [], seeders: () => seeders }, []);
  viaRelays.signaled('p1', sdpAt('1.1.1.1'));
  viaRelays.gathered(noMapping);
  const four = ['stun:a.example:3478', 'stun:b.example:3478', 'stun:c.example:3478', 'stun:d.example:3478'];
  eq('fallback: none once the session asked 4 (relayStun)', viaRelays.serversFor('p1', 500, four), []);
  eq('fallback: one while there is room (relayStun)', viaRelays.serversFor('p1', 500, four.slice(0, 3)), [X]);

  eq('stunHost', [X, 'stun:[2606:4700::1111]:3478', 'stun:10.0.0.1:3478', 'stuns:1.1.1.1:3478'].map(stunHost), ['1.1.1.1', '2606:4700::1111', null, null]);
  const seedersFn = (): typeof seeders => seeders;
  eq(
    'checkSignaling keeps stunFallback',
    checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [OWN], seeders: seedersFn } }),
    { kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [OWN], seeders: seedersFn } },
  );
  throws('stunFallback needs nostr', () => checkSignaling({ kind: 'trackers', urls: ['wss://t.example'], stunFallback: { own: [OWN], seeders: seedersFn } } as unknown as Signaling));
  eq(
    'stunFallback.own may be empty',
    checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [], seeders: seedersFn } }),
    { kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [], seeders: seedersFn } },
  );
  throws('stunFallback.own over 4', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: ['stun:a:1', 'stun:b:1', 'stun:c:1', 'stun:d:1', 'stun:e:1'], seeders: seedersFn } }));
  throws('stunFallback.own not STUN', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: ['https://x.example'], seeders: seedersFn } }));
  throws('stunFallback.seeders not a function', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [OWN], seeders: [] as never } }));
  const withFallback: Signaling = { kind: 'nostr', relays: ['wss://r.example'], stunFallback: { own: [OWN], seeders: seedersFn } };
  throws('stunFallback.own must be among iceServers', () => checkStunFallbackServers(withFallback, [{ urls: [X] }]));
  checkStunFallbackServers(withFallback, [{ urls: [OWN] }]);
  eq(
    'checkSignaling keeps relayStun, each own URL once',
    checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], relayStun: { own: [OWN, OWN] } }),
    { kind: 'nostr', relays: ['wss://r.example'], relayStun: { own: [OWN] } },
  );
  throws('relayStun needs nostr', () => checkSignaling({ kind: 'trackers', urls: ['wss://t.example'], relayStun: { own: [] } } as unknown as Signaling));
  throws('relayStun.own over 4', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], relayStun: { own: ['stun:a:1', 'stun:b:1', 'stun:c:1', 'stun:d:1', 'stun:e:1'] } }));
  throws('relayStun.own not STUN', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], relayStun: { own: ['https://x.example'] } }));
  throws('relayStun with no own', () => checkSignaling({ kind: 'nostr', relays: ['wss://r.example'], relayStun: {} as never }));
  const withRelayStun: Signaling = { kind: 'nostr', relays: ['wss://r.example'], relayStun: { own: [OWN] } };
  throws('relayStun.own must be among iceServers', () => checkStunFallbackServers(withRelayStun, [{ urls: [X] }]));
  checkStunFallbackServers(withRelayStun, [{ urls: [OWN] }]);
}
{
  // STUN at the relays a session signals through (NFX-10 §1): the generator's verdicts.
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/relay-stun.json'), 'utf8')) as {
    max: number;
    relays: { name: string; relay: string; nip11: unknown; stun: string | null }[];
    cases: { name: string; own: string[]; relays: { relay: string; nip11: unknown }[]; creator: string[]; selected: string[] }[];
  };
  eq('relay-stun max', v.max, MAX_ICE_SERVERS);
  for (const c of v.relays) eq(`relay-stun ${c.name}`, relayStunUrl(c.relay, parseRelayInfo(c.nip11)), c.stun);
  for (const c of v.cases) {
    const named = c.relays.flatMap((r) => relayStunUrl(r.relay, parseRelayInfo(r.nip11)) ?? []);
    eq(`relay-stun select ${c.name}`, selectStun(c.own, named, c.creator, v.max), c.selected);
  }
  eq('relay-stun vector counts', [v.relays.length, v.cases.length], [40, 16]);
  eq(
    'relayStunHost',
    ['wss://Relay.Example:7777/x', 'wss://[2606:4700::1111]', 'wss://1.1.1.1', 'ws://127.0.0.1:7447', 'wss://relay.example/?q', 'wss://u@relay.example', 'https://relay.example'].map(relayStunHost),
    ['relay.example', '[2606:4700::1111]', '1.1.1.1', null, null, null, null],
  );
}
{
  // A relay's NIP-11 document (./src/relay-info.ts), through a stand-in fetch: no network.
  eq(
    'relayInfoUrl',
    ['wss://relay.example', 'wss://relay.example:7777/nostr', 'ws://127.0.0.1:7447', 'wss://[2606:4700::1111]/', 'https://relay.example', 'wss://u:p@relay.example', 'nope'].map(relayInfoUrl),
    ['https://relay.example/', 'https://relay.example:7777/nostr', 'http://127.0.0.1:7447/', 'https://[2606:4700::1111]/', null, null, null],
  );
  const nfx = { networks: ['nfx:mainnet:1'], kinds: [38504, 20464, 5, 25050], roles: ['catalog', 'signaling'], stun_port: 3478 };
  const json = JSON.stringify({ name: 'relay', supported_nips: [1, 11], nfx });
  const calls: { url: string; init: RequestInit }[] = [];
  const answer =
    (status: number, body: () => BodyInit | null, headers: Record<string, string> = {}) =>
    async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(body(), { status, headers });
    };
  const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  const text = (t: string): Uint8Array => new TextEncoder().encode(t);
  eq('fetchRelayInfo: the nfx object', await fetchRelayInfo('wss://relay.example:7777/nostr', {}, answer(200, () => json)), { nfx });
  const first = calls[0];
  eq('fetchRelayInfo: the relay s own URL, https', first?.url, 'https://relay.example:7777/nostr');
  eq('fetchRelayInfo: asks for NIP-11', (first?.init.headers as Record<string, string> | undefined)?.Accept, 'application/nostr+json');
  eq(
    'fetchRelayInfo: no credentials, referrer, cache or redirect',
    [first?.init.credentials, first?.init.referrerPolicy, first?.init.cache, first?.init.redirect, first?.init.mode],
    ['omit', 'no-referrer', 'no-store', 'error', 'cors'],
  );
  await fetchRelayInfo('ws://127.0.0.1:7447', {}, answer(200, () => json));
  eq('fetchRelayInfo: ws is http', calls.at(-1)?.url, 'http://127.0.0.1:7447/');
  const n = calls.length;
  eq('fetchRelayInfo: not a relay URL', await fetchRelayInfo('https://relay.example', {}, answer(200, () => json)), null);
  eq('fetchRelayInfo: and nothing fetched', calls.length, n);
  eq('fetchRelayInfo: a general relay', await fetchRelayInfo('wss://r.example', {}, answer(200, () => '{"name":"general"}')), { nfx: null });
  eq('fetchRelayInfo: a 404', await fetchRelayInfo('wss://r.example', {}, answer(404, () => json)), null);
  eq('fetchRelayInfo: a 204', await fetchRelayInfo('wss://r.example', {}, answer(204, () => null)), null);
  eq('fetchRelayInfo: not JSON', await fetchRelayInfo('wss://r.example', {}, answer(200, () => 'hello')), null);
  eq('fetchRelayInfo: not an object', await fetchRelayInfo('wss://r.example', {}, answer(200, () => '[1,2]')), null);
  eq('fetchRelayInfo: null', await fetchRelayInfo('wss://r.example', {}, answer(200, () => 'null')), null);
  eq('fetchRelayInfo: not UTF-8', await fetchRelayInfo('wss://r.example', {}, answer(200, () => streamOf(new Uint8Array([0x7b, 0xff, 0x7d])))), null);
  eq('fetchRelayInfo: a network failure', await fetchRelayInfo('wss://r.example', {}, async () => { throw new TypeError('failed to fetch'); }), null);
  const padded = json + ' '.repeat(RELAY_INFO_MAX_BYTES - json.length);
  eq('fetchRelayInfo: 64 KiB is read', await fetchRelayInfo('wss://r.example', {}, answer(200, () => streamOf(text(padded)))), { nfx });
  eq('fetchRelayInfo: past 64 KiB, as read', await fetchRelayInfo('wss://r.example', {}, answer(200, () => streamOf(text(`${padded} `)))), null);
  eq(
    'fetchRelayInfo: past 64 KiB, by its length',
    await fetchRelayInfo('wss://r.example', {}, answer(200, () => json, { 'content-length': String(RELAY_INFO_MAX_BYTES + 1) })),
    null,
  );
  // Time: an answer that never comes, one deaf to the signal, a body that never ends, an abort.
  const never = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  let t0 = Date.now();
  eq('fetchRelayInfo: no answer in time', await fetchRelayInfo('wss://r.example', { timeoutMs: 50 }, never), null);
  eq('fetchRelayInfo: no answer in time, given up then', Date.now() - t0 < 1_000, true);
  t0 = Date.now();
  eq('fetchRelayInfo: a fetch deaf to the signal', await fetchRelayInfo('wss://r.example', { timeoutMs: 50 }, () => new Promise<Response>(() => {})), null);
  eq('fetchRelayInfo: deaf, given up then', Date.now() - t0 < 1_000, true);
  const endless = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(text('{"nfx":'));
      },
    });
  t0 = Date.now();
  eq('fetchRelayInfo: a body that never ends', await fetchRelayInfo('wss://r.example', { timeoutMs: 50 }, answer(200, endless)), null);
  eq('fetchRelayInfo: never ends, given up then', Date.now() - t0 < 1_000, true);
  const ctl = new AbortController();
  const abortedOne = fetchRelayInfo('wss://r.example', { signal: ctl.signal }, never);
  ctl.abort();
  eq('fetchRelayInfo: aborted', await abortedOne, null);
  eq('fetchRelayInfo: already aborted', await fetchRelayInfo('wss://r.example', { signal: ctl.signal }, answer(200, () => json)), null);

  // Read defensively: only fields of their type, list entries of theirs, nothing else.
  eq(
    'parseRelayInfo: defensive',
    parseRelayInfo({ nfx: { networks: ['a', 1, 'a', 'x'.repeat(129)], kinds: [25050, '5', 5.5, -1, 65536, 25050, 7], roles: 'signaling', stun_port: 3478.5, more: 1 } }),
    { nfx: { networks: ['a'], kinds: [25050, 7] } },
  );
  eq('parseRelayInfo: stun_port below 1024', parseRelayInfo({ nfx: { stun_port: 1023 } }), { nfx: {} });
  eq('parseRelayInfo: stun_port as text', parseRelayInfo({ nfx: { stun_port: '3478' } }), { nfx: {} });
  eq('parseRelayInfo: stun_port', parseRelayInfo({ nfx: { stun_port: 65535 } }), { nfx: { stun_port: 65535 } });
  eq('parseRelayInfo: nfx null or a list', [parseRelayInfo({ nfx: null }), parseRelayInfo({ nfx: [] })], [{ nfx: null }, { nfx: null }]);
  eq('parseRelayInfo: not an object', [null, [], 'x', 3, undefined].map(parseRelayInfo), [null, null, null, null, null]);

  // One fetch per relay per session, shared by every caller.
  let fetched = 0;
  const counting = async (): Promise<Response> => {
    fetched += 1;
    return new Response(json, { status: 200 });
  };
  const cache = new RelayInfoCache({ fetch: counting });
  const [c1, c2] = await Promise.all([cache.get('wss://relay.example'), cache.get('wss://relay.example')]);
  await cache.get('wss://relay.example');
  eq('RelayInfoCache: one fetch per relay', fetched, 1);
  eq('RelayInfoCache: one answer for every caller', c1 === c2 && c1 !== null, true);
  await cache.get('wss://relay2.example');
  eq('RelayInfoCache: another relay, another fetch', fetched, 2);
  cache.destroy();
  eq('RelayInfoCache: nothing after destroy', await cache.get('wss://relay3.example'), null);
  eq('RelayInfoCache: and no fetch', fetched, 2);
}
{
  // A session's relays' STUN (./src/relay-stun.ts): read beside the sockets, never waited for;
  // each connection asks its own, the relays' known by then, the rest; 4 in the session at most.
  const OWN = 'stun:9.9.9.9:3478';
  const C1 = 'stun:1.0.0.1:3478';
  const C2 = 'stun:8.8.8.8:3478';
  const R1 = 'stun:relay.example:3478';
  const R2 = 'stun:relay2.example:3479';
  const relays = ['wss://relay.example', 'ws://127.0.0.1:7447', 'wss://plain.example', 'wss://relay2.example', 'wss://down.example'];
  const docs: Record<string, unknown> = {
    'https://relay.example/': { nfx: { kinds: [38504, 20464, 5, 25050], stun_port: 3478 } },
    'https://plain.example/': { nfx: { kinds: [38504, 20464, 5], stun_port: 3478 } },
    'https://relay2.example/': { nfx: { kinds: [25050], stun_port: 3479 } },
  };
  const make = (): { book: RelayStunBook; fetched: string[]; lines: string[] } => {
    const fetched: string[] = [];
    const lines: string[] = [];
    const served = async (url: string): Promise<Response> => {
      fetched.push(url);
      const d = docs[url];
      return d === undefined ? new Response('no', { status: 503 }) : new Response(JSON.stringify(d), { status: 200 });
    };
    return { book: new RelayStunBook({ own: [OWN] }, relays, (m) => lines.push(m), { fetch: served }), fetched, lines };
  };

  const early = make();
  await sleep(10);
  eq('relayStun: no document asked of a loopback relay', early.fetched, ['https://relay.example/', 'https://plain.example/', 'https://relay2.example/', 'https://down.example/']);
  eq('relayStun: what the relays named, in their order', early.book.named, [R1, R2]);
  eq('relayStun: logged', early.lines, [`mesh: relay wss://relay.example answers STUN at ${R1}`, `mesh: relay wss://relay2.example answers STUN at ${R2}`]);
  eq('relayStun: its own, the relays , then the creator s, 4 at most', early.book.serversFor([C1, OWN, C2]), [OWN, R1, R2, C1]);
  eq('relayStun: the same for the next connection', early.book.serversFor([C1, OWN, C2]), [OWN, R1, R2, C1]);
  eq('relayStun: the session asked 4', early.book.asked.length, 4);
  early.book.destroy();

  // The first connection before any document: what it asked counts, and a late one joins
  // while there is room.
  const late = make();
  eq('relayStun: before the documents, the configured servers', late.book.serversFor([OWN, C1, C2]), [OWN, C1, C2]);
  await sleep(10);
  eq('relayStun: then a relay s, while there is room', late.book.serversFor([OWN, C1, C2]), [OWN, R1, C1, C2]);
  eq('relayStun: and never a fifth', late.book.asked.length, 4);
  late.book.destroy();

  // The fallback's servers count toward the 4 too.
  const fallen = make();
  eq('relayStun: no server configured', fallen.book.serversFor([]), []);
  fallen.book.noteAsked(['stun:1.1.1.1:3478', 'stun:1.1.1.2:3478', 'stun:1.1.1.3:3478']);
  await sleep(10);
  eq('relayStun: one slot left for the relays', fallen.book.serversFor([]), [R1]);
  fallen.book.destroy();

  // Destroyed before its documents came: nothing learned.
  const gone = make();
  gone.book.destroy();
  await sleep(10);
  eq('relayStun: nothing after destroy', gone.book.named, []);

  // The order as a pure function.
  const asked = new Set<string>();
  eq('relayStunServers: own, relays, rest, each once', relayStunServers([C1, OWN, C1], [OWN], [R1, R1, 'stun:localhost:3478'], asked), [OWN, R1, C1]);
  eq('relayStunServers: records what it asked', [...asked], [OWN, R1, C1]);
  eq('relayStunServers: a max', relayStunServers([C2], [], [R2], asked, 4), [R2]);
}
{
  // The stats panel's sources (nfx #99): per-peer counters from the engine's events, and the
  // selected candidate pair of each open connection, read only when asked.
  type Stat = Record<string, unknown>;
  const report = (stats: Stat[]) => ({ forEach: (cb: (s: Stat) => void) => stats.forEach(cb) });
  const conn = (stats: Stat[], state = 'connected') => ({ connectionState: state, getStats: async () => report(stats) });
  const chrome: Stat[] = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' },
    { id: 'P1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L1', remoteCandidateId: 'R1' },
    { id: 'P2', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L1', remoteCandidateId: 'R2', currentRoundTripTime: 0.0234 },
    { id: 'L1', type: 'local-candidate', candidateType: 'srflx', address: '198.51.100.7', port: 50000, protocol: 'udp' },
    { id: 'R1', type: 'remote-candidate', candidateType: 'host', address: 'x.local', port: 1, protocol: 'udp' },
    { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.9', port: 61234, protocol: 'udp' },
  ];
  eq('pair: the transport names it', selectedPair(report(chrome)), {
    address: '203.0.113.9', port: 61234, remoteType: 'srflx', localType: 'srflx', protocol: 'udp', path: 'direct', rttMs: 23,
  });
  eq('pair: a TURN relay on either side is relayed', selectedPair(report([
    { id: 'P', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R' },
    { id: 'L', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R', type: 'remote-candidate', candidateType: 'host', ip: '192.0.2.1', port: 9, protocol: 'tcp' },
  ])), { address: '192.0.2.1', port: 9, remoteType: 'host', localType: 'relay', protocol: 'tcp', path: 'relayed', rttMs: null });
  eq('pair: none selected yet', selectedPair(report([
    { id: 'P', type: 'candidate-pair', nominated: true, state: 'in-progress', localCandidateId: 'L', remoteCandidateId: 'R' },
  ])).path, 'unknown');
  eq('pair: hostile values are bounded', selectedPair(report([
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: -1 },
    { id: 'L', type: 'local-candidate', candidateType: '<b>' },
    { id: 'R', type: 'remote-candidate', candidateType: 'evil', address: `a\u0000<script>${'9'.repeat(100)}`, port: 70000, protocol: 'sctp' },
  ])), { address: `a?<script>${'9'.repeat(54)}`, port: null, remoteType: '', localType: '', protocol: '', path: 'direct', rttMs: null });
  eq('printable: control and non-ASCII characters', printable('-NX0100-\u0007é', 64), '-NX0100-??');
  eq('printable: not a string', printable(42, 64), '');

  let t = 1000;
  const book = new PeerBook(() => t);
  const a = conn(chrome);
  book.connect({ peerId: 'peerA', infoHash: 'h720', trackerUrl: 'nostr:wss://relay.example', connection: a });
  book.connect({ peerId: 'peerA', infoHash: 'h360', trackerUrl: 'nostr:wss://relay.example', connection: conn(chrome) });
  book.connect({ peerId: 'peerB', infoHash: 'h720', trackerUrl: 'wss://tracker.example', connection: conn([], 'closed') });
  t = 2000;
  book.received('peerA', 1000);
  book.received('peerA', 500);
  book.segment('peerA');
  book.sent('peerB', 70);
  book.received('stranger', 5); // bytes before (or without) a connect still count
  eq('connected: closed connections do not count', book.connected(), 2);
  eq('peer list: open first, then most bytes', book.list().map((p) => [p.id, p.connected, p.down, p.up, p.segments]), [
    ['peerA', true, 1500, 0, 1],
    ['peerB', false, 0, 70, 0],
    ['stranger', false, 5, 0, 0],
  ]);
  eq('peer list: via and times', (({ via, since, last }) => ({ via, since, last }))(book.list()[0]!), { via: 'nostr:wss://relay.example', since: 1000, last: 2000 });
  book.close({ peerId: 'peerA', infoHash: 'h360' });
  eq('close: one swarm of two', book.connected(), 1);
  const released = new PeerBook(() => t);
  released.connect({ peerId: 'r', infoHash: 'h', trackerUrl: '', connection: conn(chrome) });
  released.received('r', 9);
  released.release();
  eq('release: connections dropped, counters kept', [released.connected(), released.list()[0]?.down], [0, 9]);
  const asked: string[] = [];
  const spied = { connectionState: 'connected', getStats: async () => (asked.push('x'), report(chrome)) };
  const quiet = new PeerBook(() => t);
  quiet.connect({ peerId: 'p', infoHash: 'h', trackerUrl: '', connection: spied });
  quiet.received('p', 1);
  void quiet.list();
  void quiet.connected();
  eq('getStats is never called but by addresses()', asked.length, 0);
  eq('addresses: one per open peer', await book.addresses(), [{
    id: 'peerA', address: '203.0.113.9', port: 61234, remoteType: 'srflx', localType: 'srflx', protocol: 'udp', path: 'direct', rttMs: 23,
  }]);
  const broken = new PeerBook(() => t);
  broken.connect({ peerId: 'q', infoHash: 'h', trackerUrl: '', connection: { connectionState: 'connected', getStats: async () => { throw new Error('closed'); } } });
  eq('addresses: a failing getStats is unknown', (await broken.addresses())[0]?.path, 'unknown');
  const many = new PeerBook(() => t);
  for (let i = 0; i < 300; i += 1) many.received(`p${i}`, i + 1);
  eq('peer list: bounded', [many.list().length, many.list()[0]?.id], [MAX_PEERS_LISTED, 'p299']);
  const ids = new PeerBook(() => t);
  ids.received('x'.repeat(100), 1);
  eq('peer ids: cut to 64', ids.list()[0]?.id.length, 64);
  const twins = new PeerBook(() => t);
  twins.received('-WW0100-abcdefghijk\u0001', 1);
  twins.received('-WW0100-abcdefghijk\u0002', 2);
  eq('peer ids that print the same stay two peers', twins.list().map((p) => [p.id, p.down]), [
    ['-WW0100-abcdefghijk?', 2],
    ['-WW0100-abcdefghijk?', 1],
  ]);
}

{
  // keepSubscribed (decision record 0111): an ended subscription is opened again, backing off.
  type Opened = { onEvent: (j: string) => void; onEose: () => void; onEnd: (w: string) => void; closed: boolean };
  const opened: Opened[] = [];
  const open = ((_u: string, _f: unknown, onEvent: (j: string) => void, onEose: () => void, onEnd: (w: string) => void) => {
    const o: Opened = { onEvent, onEose, onEnd, closed: false };
    opened.push(o);
    return { close: () => { o.closed = true; } };
  }) as Parameters<typeof keepSubscribed>[3];
  const due: { fn: () => void; ms: number; dead: boolean }[] = [];
  const timers = {
    set: (fn: () => void, ms: number) => { const t = { fn, ms, dead: false }; due.push(t); return t; },
    clear: (h: unknown) => { (h as { dead: boolean }).dead = true; },
  };
  const fire = (): number => {
    const t = due.find((x) => !x.dead);
    if (t === undefined) return -1;
    t.dead = true;
    t.fn();
    return t.ms;
  };
  const got: string[] = [];
  const sub = keepSubscribed('wss://r.example', {}, (j) => got.push(j), open, timers);
  const waits: number[] = [];
  for (let i = 0; i < 7; i++) {
    opened.at(-1)?.onEnd('websocket error');
    opened.at(-1)?.onEnd('websocket closed'); // a second report of the same end is ignored
    waits.push(fire());
  }
  eq('keepSubscribed: reopens after 1 s, doubling to 30 s', waits, [
    RESUBSCRIBE_MIN_MS, 2_000, 4_000, 8_000, 16_000, RESUBSCRIBE_MAX_MS, RESUBSCRIBE_MAX_MS,
  ]);
  eq('keepSubscribed: one subscription per open', opened.length, 8);
  opened.at(-1)?.onEvent('{"kind":20464}');
  opened.at(-1)?.onEnd('websocket closed');
  eq('keepSubscribed: events reach the caller; after an answer the first wait again', [got, fire()], [['{"kind":20464}'], RESUBSCRIBE_MIN_MS]);
  sub.close();
  eq('keepSubscribed: close closes the open subscription', [opened.length, opened.at(-1)?.closed], [9, true]);
  opened.at(-1)?.onEnd('websocket closed'); // its own end, reported after close
  eq('keepSubscribed: nothing reopens after close', [fire(), opened.length], [-1, 9]);
  const sub2 = keepSubscribed('wss://r.example', {}, () => {}, open, timers);
  opened.at(-1)?.onEnd('websocket error');
  sub2.close();
  eq('keepSubscribed: close cancels a pending reopen', [fire(), opened.length], [-1, 10]);
}

{
  // ICE gathering ends shortly after the first server-reflexive candidate (decision record 0111).
  const line = (typ: string): string => `candidate:1 1 udp 1686052607 203.0.113.9 50000 typ ${typ} raddr 0.0.0.0 rport 0`;
  eq('srflx: by type, or by the typ field when the browser gives no type', [
    isServerReflexive({ type: 'srflx', candidate: line('srflx') }),
    isServerReflexive({ type: null, candidate: line('srflx') }),
    isServerReflexive({ candidate: line('srflx') }),
    isServerReflexive({ candidate: 'candidate:1 1 udp 1 203.0.113.9 50000 typ srflx' }),
    isServerReflexive({ type: 'host', candidate: line('srflx') }),
    isServerReflexive({ candidate: line('host') }),
    isServerReflexive({ candidate: line('relay') }),
    isServerReflexive({ candidate: 'candidate:1 1 udp 1 203.0.113.9 50000 typ srflxy' }),
    isServerReflexive({}),
  ], [true, true, true, true, false, false, false, false, false]);
}

{
  // The test page's panel (src/nerd.ts): its rows and sources, pure.
  const base = {
    engine: 'hls.js 1.7.4 + p2p-media-loader 4.0.0',
    origin: 'https://origin.example/nfx',
    root: 'ab'.repeat(32),
    video: 'ns:vid',
    verified: 7,
    rejected: [],
    levels: [{ index: 0, id: '720p', width: 1280, height: 720, bitrate: 2_500_000 }],
    level: 0,
    playing: true,
    originBytes: 4096,
    bandwidthEstimate: 12_340_000,
  };
  const sample = { width: 1280, height: 720, bufferAhead: 12.34, dropped: 3, frames: 900 };
  const lone = nerdView({ ...base, mesh: null }, sample, 'Big Buck');
  eq('panel: no mesh says so', lone.rows.find(([k]) => k === 'Mesh')?.[1], 'off: every byte from the origin');
  eq('panel: one source, the origin, its segments not counted', lone.sources.map((x) => [x.kind, x.id, x.down, x.segments]), [['origin', 'origin.example', 4096, null]]);
  eq('panel: playback rows', ['Resolution', 'Rendition', 'Bandwidth estimate', 'Buffer health', 'Dropped frames'].map((k) => lone.rows.find(([r]) => r === k)?.[1]), [
    '1280x720', '720p (2500 kb/s)', '12.34 Mb/s', '12.3 s', '3 of 900',
  ]);
  const key = 'cd'.repeat(32);
  const meshStats: MeshStats = {
      signaling: 'nostr', trackers: [], relays: ['wss://relay.example', 'wss://r2.example'], swarms: [],
      bytes: { http: 1000, p2p: 3000 }, uploaded: 500, peers: 3, rejected: [], connected: 2,
      segments: { http: 1, p2p: 3 },
      peerList: [
        { id: key, via: 'nostr:wss://relay.example', down: 3000, up: 0, segments: 3, connected: true, since: 1, last: 2 },
        { id: '-NX0100-abcdefghijkl', via: 'wss://tracker.example/announce', down: 0, up: 500, segments: 0, connected: false, since: 1, last: 2 },
      ],
      signal: { open: 1, sent: 4, received: 9, offers: 1, answers: 1 },
      source: 'peers-then-https', rescues: 1, waiting: false, webrtc: 'ok',
      startup: { peerMs: 900, peerSegmentMs: 1400, segmentMs: 1400 },
  };
  const meshed = nerdView({ ...base, mesh: meshStats }, sample, null);
  eq('panel: where segments come from', meshed.rows.find(([k]) => k === 'Segment source')?.[1], 'peers, then HTTPS (1 rescued)');
  eq('panel: WebRTC', meshed.rows.find(([k]) => k === 'WebRTC')?.[1], 'ok');
  eq('panel: share from peers', meshed.rows.find(([k]) => k === 'From peers')?.[1], '75% (2.93 KiB of 3.91 KiB of segments)');
  eq('panel: signaling', meshed.rows.find(([k]) => k === 'Signaling')?.[1], 'Nostr, 1 of 2 relays open');
  eq('panel: sources', meshed.sources.map((x) => [x.kind, x.id, x.label, x.via, x.down, x.up, x.connected]), [
    ['origin', 'origin.example', 'HTTPS origin', '', 5096, 0, true],
    ['webrtc', 'cdcdcdcd', 'peer', 'nostr', 3000, 0, true],
    ['webrtc', '-NX0100-abcdefghijkl', 'nfxd bridge?', 'tracker.example', 0, 500, false],
  ]);
  const peersOnly = nerdView({ ...base, origin: null, mesh: { ...meshStats, files: { peers: 2, files: 4, bytes: 2048, videoRoom: true } } }, sample, null);
  eq('panel: no origin, no origin row', peersOnly.sources.map((x) => x.kind), ['webrtc', 'webrtc']);
  eq('panel: start-up files from peers', peersOnly.rows.find(([k]) => k === 'Start-up files from peers')?.[1], '4 (2.00 KiB), 2 with a file channel, in the video room');
  eq('shortId: a session key', shortId(key), 'cdcdcdcd');
  eq('shortId: anything else', shortId('x'.repeat(40)).length, 20);
  eq('formatBytes', [0, 1023, 1024, 10 * 1024 * 1024, -1].map(formatBytes), ['0 B', '1023 B', '1.00 KiB', '10.0 MiB', '–']);
  const at = (o: Partial<Parameters<typeof addressText>[0] & object>) => ({
    id: 'p', address: '203.0.113.9', port: 443, remoteType: 'srflx', localType: 'host', protocol: 'udp', path: 'direct' as const, rttMs: 20, ...o,
  });
  eq('address: IPv4', addressText(at({})), '203.0.113.9:443');
  eq('address: IPv6', addressText(at({ address: '2001:db8::1' })), '[2001:db8::1]:443');
  eq('address: hidden', addressText(at({ address: '' })), 'hidden by browser');
  eq('address: mDNS', addressText(at({ address: 'f1e2.local' })), 'hidden by browser (mDNS)');
  eq('address: none', addressText(undefined), '–');
  eq('path: direct', pathText(at({})), 'direct (srflx/udp, 20 ms)');
  eq('path: unknown', pathText(at({ path: 'unknown' })), '–');
  eq('n is a shortcut on a checkbox or button, text in a field', [
    typingInto({ tagName: 'INPUT', type: 'checkbox' }),
    typingInto({ tagName: 'BUTTON' }),
    typingInto({ tagName: 'INPUT', type: 'text' }),
    typingInto({ tagName: 'INPUT' }),
    typingInto({ tagName: 'TEXTAREA' }),
    typingInto({ tagName: 'DIV', isContentEditable: true }),
  ], [false, false, true, true, true, true]);
}

// ---- where segments come from: segmentSource, peerWaitMs, and the engine's configuration ----
eq('segment source: the default is HTTPS first', checkSegmentSource({}, true), { segmentSource: 'https-first', peerWaitMs: PEER_WAIT_MS });
eq('segment source: peers first, the wait given', checkSegmentSource({ segmentSource: 'peers-then-https', peerWaitMs: 0 }, true), {
  segmentSource: 'peers-then-https',
  peerWaitMs: 0,
});
eq('segment source: peers first without a mesh is allowed (it plays from the origin)', checkSegmentSource({ segmentSource: 'peers-then-https' }, false).segmentSource, 'peers-then-https');
eq('segment source: httpWindow goes with HTTPS first', checkSegmentSource({ httpWindow: 2 }, true).segmentSource, 'https-first');
refuses('segment source: peers only without a mesh', () => checkSegmentSource({ segmentSource: 'peers-only' }, false), TypeError, /needs signaling/);
refuses('segment source: an unknown one', () => checkSegmentSource({ segmentSource: 'carrier-pigeon' }, true), TypeError, /must be one of/);
refuses('segment source: null', () => checkSegmentSource({ segmentSource: null }, true), TypeError, /must be one of/);
refuses('peerWaitMs: not whole', () => checkSegmentSource({ peerWaitMs: 1.5 }, true), TypeError, /peerWaitMs/);
refuses('peerWaitMs: negative', () => checkSegmentSource({ peerWaitMs: -1 }, true), TypeError, /peerWaitMs/);
refuses('peerWaitMs: too long', () => checkSegmentSource({ peerWaitMs: MAX_PEER_WAIT_MS + 1 }, true), TypeError, /peerWaitMs/);
refuses('peerWaitMs: text', () => checkSegmentSource({ peerWaitMs: '4000' }, true), TypeError, /peerWaitMs/);
refuses('httpWindow beside peers first', () => checkSegmentSource({ segmentSource: 'peers-then-https', httpWindow: 2 }, true), TypeError, /httpWindow/);
refuses('httpWindow beside peers only', () => checkSegmentSource({ segmentSource: 'peers-only', httpWindow: 0 }, true), TypeError, /httpWindow/);
{
  const blank = (): MeshStats => ({
    signaling: 'trackers', trackers: [], relays: [], swarms: [], bytes: { http: 0, p2p: 0 }, uploaded: 0, peers: 0, rejected: [],
    connected: 0, segments: { http: 0, p2p: 0 }, peerList: [], signal: null,
    source: 'https-first', rescues: 0, waiting: false, webrtc: 'unknown', startup: { peerMs: null, peerSegmentMs: null, segmentMs: null },
  });
  const trackers: Signaling = { kind: 'trackers', urls: ['wss://t.example'] };
  const core = (tuning: Parameters<typeof meshConfig>[5], stats = blank()): Record<string, unknown> =>
    meshConfig({} as never, trackers, [], stats, () => undefined, tuning).p2p.core as unknown as Record<string, unknown>;
  const policyKeys = ['segmentPolicy', 'peerWaitMs', 'highDemandTimeWindow', 'httpDownloadTimeWindow', 'p2pDownloadTimeWindow', 'simultaneousHttpDownloads', 'segmentMemoryStorageLimit'];
  const pick = (c: Record<string, unknown>): unknown[] => policyKeys.map((k) => c[k]);
  eq('engine: HTTPS first leaves the engine as published', pick(core({})), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  eq('engine: the httpWindow test knob, as before (the policy named, which is the default)', pick(core({ httpWindow: 2 })), ['http-first', undefined, 2, 2, 120, 1, undefined]);
  eq('engine: peers, then HTTPS', pick(core({ segmentSource: 'peers-then-https', peerWaitMs: 2500 })), [
    'peer-first', 2500, 15, PEER_AHEAD_SECONDS, PEER_AHEAD_SECONDS, 1, PEER_STORAGE_MIB,
  ]);
  eq('engine: peers only, the default wait', pick(core({ segmentSource: 'peers-only' })), [
    'peer-only', PEER_WAIT_MS, 15, PEER_AHEAD_SECONDS, PEER_AHEAD_SECONDS, 1, PEER_STORAGE_MIB,
  ]);
  const stats = blank();
  core({ segmentSource: 'peers-only' }, stats);
  eq('engine: the stats say where segments come from', stats.source, 'peers-only');
  // What `Session.setSegmentSource` hands the running engine: every key one it takes while it runs.
  eq('switching: to peers only', segmentWindows('peers-only', { peerWaitMs: 0 }), {
    segmentPolicy: 'peer-only', peerWaitMs: 0, highDemandTimeWindow: 15, httpDownloadTimeWindow: PEER_AHEAD_SECONDS, p2pDownloadTimeWindow: PEER_AHEAD_SECONDS, simultaneousHttpDownloads: 1,
  });
  eq('switching: to peers, then HTTPS', segmentWindows('peers-then-https').segmentPolicy, 'peer-first');
  eq('switching: back to HTTPS first restores the engine\'s published settings', segmentWindows('https-first'), {
    segmentPolicy: 'http-first', highDemandTimeWindow: 15, httpDownloadTimeWindow: 3000, p2pDownloadTimeWindow: 6000, simultaneousHttpDownloads: 2,
  });
  eq('switching: back to HTTPS first with the test knob', segmentWindows('https-first', { httpWindow: 4 }).httpDownloadTimeWindow, 4);
  eq('switching: no setting the engine fixes when it is made', Object.keys(segmentWindows('peers-only')).includes('segmentMemoryStorageLimit'), false);

  // The engine's events, as the session's counters read them.
  const counted = blank();
  const rescued: string[] = [];
  const cfg = meshConfig({} as never, trackers, [], counted, () => undefined, { segmentSource: 'peers-then-https', onRescue: (u) => rescued.push(u) });
  const handlers = new Map<string, (...a: never[]) => void>();
  cfg.p2p.onHlsJsCreated({ p2pEngine: { addEventListener: (name, h) => void handlers.set(name, h) } });
  const fire = (name: string, ...a: unknown[]): void => (handlers.get(name) as ((...x: unknown[]) => void) | undefined)?.(...a);
  fire('onPeerConnect', { peerId: 'p1', infoHash: 'i', trackerUrl: 'wss://t.example' });
  fire('onSegmentLoaded', { downloadSource: 'p2p', peerId: 'p1', segment: { url: 'https://o.example/r/a.m4s' } });
  fire('onSegmentLoaded', { downloadSource: 'http', segment: { url: 'https://o.example/r/b.m4s' } });
  fire('onSegmentLoaded', { downloadSource: 'http', segment: {} });
  eq('rescues: each HTTP segment with peers first is one', [counted.rescues, rescued], [2, ['https://o.example/r/b.m4s', '']]);
  eq('rescues: segments are still counted by source', counted.segments, { http: 2, p2p: 1 });
  counted.source = 'https-first';
  fire('onSegmentLoaded', { downloadSource: 'http', segment: { url: 'https://o.example/r/c.m4s' } });
  eq('rescues: with no start heard, the count follows the source the session has now', [counted.rescues, counted.segments.http], [2, 3]);
  // The source can change while a download runs: what it was when the download began counts.
  const seg = (name: string): { runtimeId: string; url: string } => ({ runtimeId: `rt-${name}`, url: `https://o.example/r/${name}.m4s` });
  counted.source = 'peers-then-https';
  fire('onSegmentStart', { downloadSource: 'http', segment: seg('d') });
  counted.source = 'peers-only';
  fire('onSegmentLoaded', { downloadSource: 'http', segment: seg('d') });
  eq('rescues: one that began as a rescue is one, though HTTPS was switched off before it ended', [counted.rescues, rescued.at(-1)], [3, 'https://o.example/r/d.m4s']);
  counted.source = 'https-first';
  fire('onSegmentStart', { downloadSource: 'http', segment: seg('e') });
  counted.source = 'peers-then-https';
  fire('onSegmentLoaded', { downloadSource: 'http', segment: seg('e') });
  eq('rescues: one that began with HTTPS first is not one, though peers came first by its end', counted.rescues, 3);
  fire('onSegmentStart', { downloadSource: 'http', segment: seg('f') });
  fire('onSegmentAbort', { downloadSource: 'http', segment: seg('f') });
  counted.source = 'https-first';
  fire('onSegmentLoaded', { downloadSource: 'http', segment: seg('f') });
  eq('rescues: an aborted download is forgotten', counted.rescues, 3);
  fire('onSegmentStart', { downloadSource: 'p2p', segment: seg('g') });
  fire('onSegmentLoaded', { downloadSource: 'p2p', peerId: 'p1', segment: seg('g') });
  eq('rescues: a segment from a peer is never one', counted.rescues, 3);
  eq('startup: the first peer and the first segments are timed', [counted.startup.peerMs, counted.startup.peerSegmentMs, counted.startup.segmentMs].map((x) => typeof x === 'number' && x >= 0), [true, true, true]);
  const plain = blank();
  const cfg2 = meshConfig({} as never, trackers, [], plain, () => undefined, {});
  const h2 = new Map<string, (...a: never[]) => void>();
  cfg2.p2p.onHlsJsCreated({ p2pEngine: { addEventListener: (name, h) => void h2.set(name, h) } });
  (h2.get('onSegmentLoaded') as unknown as (d: unknown) => void)({ downloadSource: 'http', segment: { url: 'x' } });
  eq('rescues: none with HTTPS first', plain.rescues, 0);
}

// ---- PlayIntent: is playing what was last asked of the element? --------------------------------
{
  const auto = new PlayIntent(true);
  eq('intent: autoplay asks for playback from the start', auto.wanted, true);
  auto.paused();
  eq('intent: paused before the first frame, nothing is asked any more', auto.wanted, false);
  auto.played();
  eq('intent: played again', auto.wanted, true);
  auto.refused();
  eq('intent: a refused play() asks for nothing until a gesture plays it', auto.wanted, false);
  auto.played();
  eq('intent: the gesture', auto.wanted, true);
  const manual = new PlayIntent(false);
  eq('intent: without autoplay nothing is asked until someone plays', manual.wanted, false);
  manual.played();
  manual.paused();
  eq('intent: play then pause', manual.wanted, false);
}

// ---- probeWebRtc: can this browser's WebRTC reach anyone? (stand-in connections) ------------
{
  type Ev = { candidate: { candidate?: string; protocol?: string | null } | null };
  /** A connection that hands `events` to its listener once the offer is set, then (unless `hang`) ends gathering. */
  const standIn = (events: Ev['candidate'][], opts: { hang?: boolean; failOffer?: boolean } = {}): { C: ProbeConnection; closed: () => number } => {
    let closed = 0;
    class C {
      #cb: ((e: Ev) => void) | null = null;
      createDataChannel(): unknown {
        return {};
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        if (opts.failOffer) throw new Error('offer refused');
        return { type: 'offer', sdp: 'v=0' };
      }
      async setLocalDescription(): Promise<void> {
        queueMicrotask(() => {
          for (const c of events) this.#cb?.({ candidate: c });
          if (!opts.hang) this.#cb?.({ candidate: null });
        });
      }
      addEventListener(_name: 'icecandidate', cb: (e: Ev) => void): void {
        this.#cb = cb;
      }
      close(): void {
        closed += 1;
      }
    }
    return { C: C as unknown as ProbeConnection, closed: () => closed };
  };
  const host = { candidate: 'candidate:1 1 udp 2113937151 f1e2.local 54321 typ host', protocol: 'udp' };
  const srflx = { candidate: 'candidate:2 1 UDP 1677729535 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0' };
  const tcp = { candidate: 'candidate:3 1 tcp 1518280447 f1e2.local 9 typ host tcptype active', protocol: 'tcp' };

  eq('probe: no RTCPeerConnection at all', await probeWebRtc([], 50, undefined as unknown as ProbeConnection), {
    ok: false, udp: 0, why: 'this browser has no RTCPeerConnection',
  });
  const good = standIn([host, srflx]);
  eq('probe: UDP candidates, by the property or by the line', await probeWebRtc([], 50, good.C), { ok: true, udp: 2, why: '2 UDP candidates' });
  eq('probe: the connection is closed afterwards', good.closed(), 1);
  eq('probe: one candidate', (await probeWebRtc([], 50, standIn([host]).C)).why, '1 UDP candidate');
  const none = await probeWebRtc([], 50, standIn([]).C);
  eq('probe: gathering ended with nothing', [none.ok, none.udp, /no network candidate/.test(none.why)], [false, 0, true]);
  const onlyTcp = await probeWebRtc([], 50, standIn([tcp]).C);
  eq('probe: TCP alone reaches no mesh peer', [onlyTcp.ok, /no UDP candidate \(1 other\)/.test(onlyTcp.why)], [false, true]);
  // An offer that never settles: the time limit ends the probe, and the connection is closed.
  let stuckClosed = 0;
  const stuck = class {
    createDataChannel(): unknown {
      return {};
    }
    createOffer(): Promise<{ type: string; sdp: string }> {
      return new Promise(() => undefined);
    }
    async setLocalDescription(): Promise<void> {
      return undefined;
    }
    addEventListener(): void {
      return undefined;
    }
    close(): void {
      stuckClosed += 1;
    }
  } as unknown as ProbeConnection;
  const stuckAt = Date.now();
  const never = await probeWebRtc([], 60, stuck);
  eq('probe: an offer that never settles ends at the time limit, closed', [never.ok, Date.now() - stuckAt < 1000, stuckClosed], [false, true, 1]);
  const stuckCtl = new AbortController();
  const stuckPending = probeWebRtc([], 60_000, stuck, stuckCtl.signal);
  await sleep(20);
  stuckCtl.abort();
  eq('probe: or at the abort', [(await stuckPending).ok, stuckClosed], [false, 2]);
  // An offer that settles after the time limit: nothing more is asked of the closed connection.
  let lateDescriptions = 0;
  let lateClosed = 0;
  const late2 = class {
    createDataChannel(): unknown {
      return {};
    }
    createOffer(): Promise<{ type: string; sdp: string }> {
      return new Promise((ok) => setTimeout(() => ok({ type: 'offer', sdp: 'v=0' }), 120));
    }
    async setLocalDescription(): Promise<void> {
      lateDescriptions += 1;
    }
    addEventListener(): void {
      return undefined;
    }
    close(): void {
      lateClosed += 1;
    }
  } as unknown as ProbeConnection;
  const lateOffer = await probeWebRtc([], 40, late2);
  await sleep(160);
  eq('probe: an offer that settles after the time limit is dropped, not applied to the closed connection', [lateOffer.ok, lateDescriptions, lateClosed], [false, 0, 1]);
  const lateCtl = new AbortController();
  const latePending = probeWebRtc([], 60_000, late2, lateCtl.signal);
  await sleep(20);
  lateCtl.abort();
  await latePending;
  await sleep(160);
  eq('probe: nor one that settles after the abort', [lateDescriptions, lateClosed], [0, 2]);
  const hung = standIn([], { hang: true });
  const before = Date.now();
  const late = await probeWebRtc([], 60, hung.C);
  eq('probe: gathering that never ends stops at the time limit, with nothing found', [late.ok, Date.now() - before < 1000, hung.closed()], [false, true, 1]);
  eq('probe: a candidate before the time limit counts', (await probeWebRtc([], 60, standIn([host], { hang: true }).C)).ok, true);
  const refused = standIn([], { failOffer: true });
  const failed = await probeWebRtc([], 50, refused.C);
  eq('probe: a refused offer is not thrown', [failed.ok, /WebRTC failed to start: offer refused/.test(failed.why), refused.closed()], [false, true, 1]);
  const thrower = class {
    constructor() {
      throw new Error('disabled by policy');
    }
  } as unknown as ProbeConnection;
  eq('probe: a constructor that throws', (await probeWebRtc([], 50, thrower)).why, 'RTCPeerConnection refused: disabled by policy');
  const stopped = standIn([host], { hang: true });
  const ctl = new AbortController();
  const pending = probeWebRtc([], 60_000, stopped.C, ctl.signal);
  await sleep(20);
  ctl.abort();
  const cut = await pending;
  eq('probe: an abort ends it at once, with what it had found, and closes the connection', [cut.ok, cut.udp, stopped.closed()], [true, 1, 1]);
  const gone = new AbortController();
  gone.abort();
  eq('probe: already aborted', (await probeWebRtc([], 60_000, standIn([], { hang: true }).C, gone.signal)).ok, false);
  eq('probe: an empty candidate ends gathering (older engines)', (await probeWebRtc([], 5000, standIn([host, { candidate: '' }], { hang: true }).C)).udp, 1);
}

// ---- the file channel (NFX-10 §6.10) --------------------------------------------------------
{
  const hex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  type Msg = { name: string; hex: string; req?: number; sha256?: string; root?: string; bytes_hex?: string; flags?: number; reads_as_flags?: number; whole?: number[]; part?: number[]; read_only?: boolean };
  const v = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/file-channel.json'), 'utf8')) as {
    label: string;
    limits: Record<string, number>;
    root: string;
    messages: Msg[];
    transfers: Record<'hash_list' | 'init', { sha256: string; size: number; messages: string[] }> & {
      three_data_messages: { size: number; sha256: string; req: number; get_hex: string; messages: { length: number; head_hex: string; sha256: string }[] };
    };
    beacons_answer: { events: fc.NostrEvent[]; text: string; messages: string[] };
  };
  eq('file channel: label', v.label, fc.LABEL);
  eq('file channel: limits', [v.limits.max_message, v.limits.max_data, v.limits.max_open_requests, v.limits.max_have_json, v.limits.max_have_ids, v.limits.max_beacons, v.limits.max_beacons_answer], [fc.MAX_MESSAGE, fc.MAX_DATA, fc.MAX_OPEN_REQUESTS, fc.MAX_HAVE_JSON, fc.MAX_HAVE_IDS, fc.MAX_BEACONS, fc.MAX_BEACONS_ANSWER]);
  for (const m of v.messages) {
    const bytes = hex(m.hex);
    let got: fc.Message;
    try {
      got = fc.decode(bytes);
    } catch (e) {
      eq(`file channel: ${m.name} reads`, String(e), 'no error');
      continue;
    }
    eq(`file channel: ${m.name} type`, got.t, m.name.split('-')[0]);
    if (m.req !== undefined && 'req' in got) eq(`file channel: ${m.name} req`, got.req, m.req);
    if (got.t === 'get') eq(`file channel: ${m.name} sha`, got.sha, m.sha256);
    if (got.t === 'list') eq(`file channel: ${m.name} root`, got.root, m.root);
    if (got.t === 'data') eq(`file channel: ${m.name} bytes`, toHex(got.bytes), m.bytes_hex);
    if (got.t === 'hello') eq(`file channel: ${m.name} flags`, got.flags & (fc.FLAG_FILES | fc.FLAG_BEACONS), m.reads_as_flags ?? m.flags);
    if (got.t === 'have') eq(`file channel: ${m.name} indices`, [got.have.whole, got.have.part], [m.whole, m.part]);
    if (!m.read_only) eq(`file channel: ${m.name} written as read`, toHex(fc.encode(got)), m.hex);
  }
  const received = (msgs: Uint8Array[]): { req: number; sha: string; file: Uint8Array } => {
    const first = fc.decode(msgs[0]!);
    if (first.t !== 'get') throw new Error('a transfer begins with get');
    const parts: Uint8Array[] = [];
    msgs.slice(1).forEach((m, i) => {
      const d = fc.decode(m);
      if (d.t === 'data' && d.req === first.req) parts.push(d.bytes);
      else if (d.t === 'end' && d.req === first.req) eq('file channel: end comes last', i, msgs.length - 2);
      else eq('file channel: an unexpected message in a transfer', d.t, 'data or end');
    });
    const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      file.set(p, at);
      at += p.length;
    }
    return { req: first.req, sha: first.sha, file };
  };
  for (const key of ['hash_list', 'init'] as const) {
    const t = v.transfers[key];
    const msgs = t.messages.map(hex);
    const { req, sha, file } = received(msgs);
    eq(`file channel: ${key} transfer`, [sha, sha256Hex(file), file.length], [t.sha256, t.sha256, t.size]);
    eq(`file channel: ${key} written as sent`, fc.dataMessages(req, file).map(toHex), t.messages.slice(1));
  }
  eq('file channel: the hash list is asked for by the root', v.transfers.hash_list.sha256, v.root);
  const big = v.transfers.three_data_messages;
  const bigFile = Uint8Array.from({ length: big.size }, (_, i) => i % 251);
  eq('file channel: the three-message file', sha256Hex(bigFile), big.sha256);
  const bigMsgs = fc.dataMessages(big.req, bigFile);
  eq('file channel: three data messages, then end', bigMsgs.map((m) => [m.length, toHex(m.subarray(0, 16)), sha256Hex(m)]), big.messages.map((m) => [m.length, m.head_hex, m.sha256]));
  const ba = v.beacons_answer;
  eq('file channel: a beacons answer is written as the vector', new TextDecoder().decode(fc.beaconsAnswer(ba.events)), ba.text);
  eq('file channel: and read back', fc.readBeaconsAnswer(new TextEncoder().encode(ba.text)), ba.events);
  eq('file channel: its messages', ba.messages, [toHex(fc.encode({ t: 'beacons', req: 3 })), ...fc.dataMessages(3, new TextEncoder().encode(ba.text)).map(toHex)]);

  const bad = JSON.parse(readFileSync(join(here, '../../spec/test-vectors/file-channel-invalid.json'), 'utf8')) as {
    messages: { name: string; hex: string }[];
    sequences: { name: string; sent: string[] }[];
    beacons_refused: { name: string; text: string }[];
  };
  for (const m of bad.messages) throws(`file channel refuses ${m.name}`, () => fc.decode(hex(m.hex)));
  for (const s of bad.sequences) {
    const ch = new fc.Channel();
    const sent = s.sent.map(hex);
    let early = '';
    sent.slice(0, -1).forEach((m, i) => {
      try {
        ch.read(m);
      } catch (e) {
        early ||= `message ${i}: ${String(e)}`;
      }
    });
    eq(`file channel: ${s.name} reads up to its last message`, early, '');
    throws(`file channel: ${s.name} closes the channel`, () => ch.read(sent[sent.length - 1]!));
  }
  for (const b of bad.beacons_refused) throws(`file channel refuses the beacons answer ${b.name}`, () => fc.readBeaconsAnswer(new TextEncoder().encode(b.text)));
  // The book: a third get of one file is answered missing at once, and is never open.
  const ch = new fc.Channel();
  ch.read(Uint8Array.of(4, 1, 0));
  const get = (req: number) => fc.encode({ t: 'get', req, sha: v.root });
  for (const [req, want] of [[1, 'serve'], [2, 'serve'], [3, 'missing']] as const) {
    const r = ch.read(get(req));
    eq(`file channel: get ${req} of one file`, r.t === 'request' ? r.admit : r.t, want);
    if (want === 'serve') eq('file channel: its answer closes it', ch.answered(req), true);
  }
  eq('file channel: nothing open after', ch.openCount, 0);
  throws('file channel: a req that is not a u32', () => fc.encode({ t: 'end', req: 2 ** 32 }));
  throws('file channel: an empty file', () => fc.dataMessages(1, new Uint8Array(0)));
}

console.log(`unit: ${ran - bad}/${ran} ok`);
process.exit(bad === 0 ? 0 : 1);
