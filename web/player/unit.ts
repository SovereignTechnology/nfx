/**
 * Unit checks for the player's pure parts (`npm run unit`, after `npm run wasm`): the URL
 * sanitisers, the beacon endpoint book behind `watchEndpoints`, `open()`'s option checks,
 * and the Nostr signaler's bookkeeping (presence, glare, freshness, bounds). One case runs
 * the spec's signed beacon vector through nfx-wasm into the book, so the shape
 * `verifyBeacon` returns is the shape the book reads; the NFX-10 §6 vectors run through
 * nfx-wasm's MeshSession, which builds and reads every signaling event in the browser.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import initWasm, { MeshRoom, MeshSession, verifyBeacon } from './out/wasm/nfx_wasm.js';
import type { Signaling } from './src/api';
import {
  EndpointBook,
  MAX_ORIGINS,
  MAX_SEEDERS,
  type VerifiedBeacon,
  beaconStun,
  beaconTracker,
  checkIceServers,
  checkOrigins,
  checkSignaling,
  checkTrackers,
  originBase,
  checkRelays,
  pageOrigin,
} from './src/endpoints';
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

{
  const book = new EndpointBook();
  eq('first beacon taken', book.add(beacon(S(1), NOW, [https('https://a.example/'), webrtc('wss://t1.example')]), NOW), true);
  eq('first snapshot', book.snapshot(NOW), {
    origins: ['https://a.example'],
    trackers: ['wss://t1.example'],
    stunServers: [],
    seeders: 1,
  });
  eq('same beacon again (a second relay)', book.add(beacon(S(1), NOW, [https('https://z.example')]), NOW), false);
  eq('older beacon', book.add(beacon(S(1), NOW - 5, [https('https://z.example')]), NOW), false);
  eq('unchanged by the older one', book.snapshot(NOW).origins, ['https://a.example']);
  // The newer beacon replaces what the seeder said: its tracker is withdrawn.
  eq('newer beacon', book.add(beacon(S(1), NOW + 1, [https('https://b.example')]), NOW + 1), true);
  eq('newer replaces', book.snapshot(NOW + 1), { origins: ['https://b.example'], trackers: [], stunServers: [], seeders: 1 });
  // It expires at NOW + 121.
  eq('expired out', book.snapshot(NOW + 121), { origins: [], trackers: [], stunServers: [], seeders: 0 });
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
  eq('only valid endpoints kept', book.snapshot(NOW), { origins: [], trackers: ['wss://ok.example'], stunServers: [], seeders: 1 });
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
    stunServers: [],
    seeders: 3,
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
    trackers: ['wss://t0.example', 'wss://t1.example', 'wss://t2.example', 'wss://t3.example'],
    stunServers: [],
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
    trackers: ['wss://tracker.example/announce'],
    stunServers: [],
    seeders: 1,
  });
}
throws('vector beacon past its expiration', () => verifyBeacon(JSON.stringify(vector.event), verified.expiration + 1));

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
