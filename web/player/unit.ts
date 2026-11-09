/**
 * Unit checks for the player's pure parts (`npm run unit`, after `npm run wasm`): the URL
 * sanitisers, the beacon endpoint book behind `watchEndpoints`, and `open()`'s option
 * checks. One case runs the spec's signed beacon vector through nfx-wasm into the book,
 * so the shape `verifyBeacon` returns is the shape the book reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import initWasm, { verifyBeacon } from './out/wasm/nfx_wasm.js';
import type { Signaling } from './src/api';
import {
  EndpointBook,
  MAX_ORIGINS,
  MAX_SEEDERS,
  type VerifiedBeacon,
  beaconTracker,
  checkIceServers,
  checkOrigins,
  checkSignaling,
  checkTrackers,
  originBase,
  pageOrigin,
} from './src/endpoints';

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

// ---- EndpointBook ------------------------------------------------------------------------
const NOW = 1_800_000_000;
const S = (n: number): string => n.toString(16).padStart(64, '0');
function beacon(seeder: string, createdAt: number, endpoints: unknown, ttl = 120): VerifiedBeacon {
  return { seeder, created_at: createdAt, expiration: createdAt + ttl, a: 'x', content: { endpoints } };
}
const https = (url: string) => ({ t: 'https', url });
const webrtc = (...urls: unknown[]) => ({ t: 'webrtc', tracker_urls: urls, renditions: ['720p'] });

{
  const book = new EndpointBook();
  eq('first beacon taken', book.add(beacon(S(1), NOW, [https('https://a.example/'), webrtc('wss://t1.example')]), NOW), true);
  eq('first snapshot', book.snapshot(NOW), { origins: ['https://a.example'], trackers: ['wss://t1.example'], seeders: 1 });
  eq('same beacon again (a second relay)', book.add(beacon(S(1), NOW, [https('https://z.example')]), NOW), false);
  eq('older beacon', book.add(beacon(S(1), NOW - 5, [https('https://z.example')]), NOW), false);
  eq('unchanged by the older one', book.snapshot(NOW).origins, ['https://a.example']);
  // The newer beacon replaces what the seeder said: its tracker is withdrawn.
  eq('newer beacon', book.add(beacon(S(1), NOW + 1, [https('https://b.example')]), NOW + 1), true);
  eq('newer replaces', book.snapshot(NOW + 1), { origins: ['https://b.example'], trackers: [], seeders: 1 });
  // It expires at NOW + 121.
  eq('expired out', book.snapshot(NOW + 121), { origins: [], trackers: [], seeders: 0 });
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
  eq('only valid endpoints kept', book.snapshot(NOW), { origins: [], trackers: ['wss://ok.example'], seeders: 1 });
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
    trackers: ['wss://shared.example', 'wss://lonely.example'],
    seeders: 3,
  });
}
{
  // Caps: per beacon, and overall.
  const book = new EndpointBook();
  const many = Array.from({ length: 10 }, (_, i) => `wss://t${i}.example`);
  book.add(beacon(S(1), NOW, [webrtc(...many), ...many.map((_, i) => https(`https://o${i}.example`))]), NOW);
  eq('per-beacon caps', book.snapshot(NOW), {
    origins: ['https://o0.example', 'https://o1.example', 'https://o2.example', 'https://o3.example'],
    trackers: ['wss://t0.example', 'wss://t1.example', 'wss://t2.example', 'wss://t3.example'],
    seeders: 1,
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
throws('a signaling kind this build lacks', () => checkSignaling({ kind: 'nostr', urls: [] } as unknown as Signaling));
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
    trackers: ['wss://tracker.example/announce'],
    seeders: 1,
  });
}
throws('vector beacon past its expiration', () => verifyBeacon(JSON.stringify(vector.event), verified.expiration + 1));

console.log(`unit: ${ran - bad}/${ran} ok`);
process.exit(bad === 0 ? 0 : 1);
