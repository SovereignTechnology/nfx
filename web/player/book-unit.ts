/**
 * Unit checks for EndpointBook's NFX-17 §4.2 rules: origins in tiers (the creator's beacon,
 * rated keys, open keys), never ranked by how many keys name them; at most 16 keys first
 * heard on one relay; random replacement of unprotected keys; the creator's, rated keys and
 * the first key to name a host that delivered never replaced. Needs nothing built:
 * `tsx book-unit.ts`.
 */
import { EndpointBook, MAX_SEEDERS, MAX_SEEDERS_PER_RELAY, type VerifiedBeacon } from './src/endpoints';

let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const NOW = 1_800_000_000;
const CREATOR = 'c'.repeat(64);
const S = (n: number): string => n.toString(16).padStart(64, '0');
function beacon(seeder: string, endpoints: unknown[]): VerifiedBeacon {
  return { seeder, creator: CREATOR, created_at: NOW, expiration: NOW + 60, a: 'x', content: { endpoints } };
}
const https = (url: string, renditions?: string[]) => (renditions ? { t: 'https', url, renditions } : { t: 'https', url });
function counter(): () => number {
  let n = 0;
  return () => ((n += 7) % 100) / 100;
}

{
  // Tiers: the creator's origin first, a rated key's next, then the open ones.
  const book = new EndpointBook({ random: counter(), rated: new Set([S(2)]) });
  book.add(beacon(S(1), [https('https://open.example')]), NOW, 'wss://r1');
  book.add(beacon(S(2), [https('https://rated.example')]), NOW, 'wss://r1');
  book.add(beacon(CREATOR, [https('https://creator.example')]), NOW, 'wss://r1');
  eq('tiers', book.snapshot(NOW).originSources, [
    { url: 'https://creator.example', tier: 1 },
    { url: 'https://rated.example', tier: 2 },
    { url: 'https://open.example', tier: 3 },
  ]);
}
{
  // An origin named by many open keys does not outrank one named by a single open key: both
  // are tier 3, ordered by this book's draw, and the draw does not depend on counts.
  const orders = new Set<string>();
  for (let seed = 1; seed <= 8; seed++) {
    let n = seed;
    const book = new EndpointBook({ random: () => ((n = (n * 37 + 11) % 101) / 101) });
    for (let i = 1; i <= 10; i++) book.add(beacon(S(i), [https('https://popular.example')]), NOW, 'wss://r1');
    book.add(beacon(S(50), [https('https://lonely.example')]), NOW, 'wss://r2');
    orders.add(book.snapshot(NOW).origins.join(' '));
  }
  eq('ten keys naming an origin do not always rank it first', [...orders].some((o) => o.startsWith('https://lonely')), true);
}
{
  // At most 16 keys first heard on one relay: the 17th replaces one of that relay's.
  const book = new EndpointBook({ random: counter() });
  for (let i = 1; i <= MAX_SEEDERS_PER_RELAY; i++) book.add(beacon(S(i), [https(`https://a${i}.example`)]), NOW, 'wss://flood');
  eq('the 17th from one relay is taken', book.add(beacon(S(100), [https('https://new.example')]), NOW, 'wss://flood'), true);
  eq('that relay still holds 16', book.snapshot(NOW).seeders, MAX_SEEDERS_PER_RELAY);
  eq('another relay is not crowded', book.add(beacon(S(200), [https('https://b.example')]), NOW, 'wss://other'), true);
  eq('17 in all', book.snapshot(NOW).seeders, MAX_SEEDERS_PER_RELAY + 1);
}
{
  // A full table: a key from a relay under its quota replaces one of the relay holding most.
  const book = new EndpointBook({ random: counter() });
  let k = 1;
  for (const r of ['wss://r1', 'wss://r2', 'wss://r3', 'wss://r4']) {
    for (let i = 0; i < MAX_SEEDERS_PER_RELAY; i++, k++) book.add(beacon(S(k), []), NOW, r);
  }
  eq('full', book.snapshot(NOW).seeders, MAX_SEEDERS);
  eq('a fifth relay still gets in', book.add(beacon(S(900), [https('https://fifth.example')]), NOW, 'wss://r5'), true);
  eq('still 64', book.snapshot(NOW).seeders, MAX_SEEDERS);
  eq('and is held', book.snapshot(NOW).origins.includes('https://fifth.example'), true);
  // A key with no relay named is refused when the table is full, as before.
  eq('no relay: refused when full', book.add(beacon(S(901), []), NOW), false);
  // The creator is always taken.
  eq('the creator past the cap', book.add(beacon(CREATOR, [https('https://creator.example')]), NOW, 'wss://r1'), true);
}
{
  // The first key to name a host that delivered is never replaced; others from its relay are.
  const book = new EndpointBook();
  for (let i = 1; i <= MAX_SEEDERS_PER_RELAY; i++) book.add(beacon(S(i), [https(`https://p${i}.example`)]), NOW, 'wss://r');
  book.delivered('https://p3.example/some/prefix');
  for (let i = 0; i < 200; i++) book.add(beacon(S(1000 + i), [https(`https://x${i}.example`)]), NOW, 'wss://r');
  eq('the deliverer stays', book.snapshot(NOW).origins.includes('https://p3.example'), true);
  eq('the rest were replaced', book.snapshot(NOW).origins.filter((u) => u.startsWith('https://p')).length, 1);
}
{
  // Claims: an origin takes the tier of the best key naming it, and the claims of that tier.
  const book = new EndpointBook({ random: counter() });
  book.add(beacon(S(1), [https('https://shared.example', ['240p'])]), NOW, 'wss://r');
  book.add(beacon(CREATOR, [https('https://shared.example', ['720p', '1080p'])]), NOW, 'wss://r');
  eq('the creator decides its claim', book.snapshot(NOW).originSources, [
    { url: 'https://shared.example', renditions: ['720p', '1080p'], tier: 1 },
  ]);
}

{
  // A seeder heard by broadcast whose beacon has expired may be told again; a live one may not.
  const book = new EndpointBook({ random: counter() });
  const told = (seeder: string, at: number): VerifiedBeacon => ({
    seeder,
    creator: CREATOR,
    created_at: at,
    expiration: at + 120,
    a: 'x',
    content: { endpoints: [https('https://told.example')] },
  });
  book.add(beacon(S(1), [https('https://heard.example')]), NOW, 'wss://r');
  eq('a live broadcast needs no tell', book.addTold(told(S(1), NOW), NOW + 10), false);
  eq('an expired one may be told', book.addTold(told(S(1), NOW + 200), NOW + 200), true);
  eq('and its tell counts', book.snapshot(NOW + 200).origins, ['https://told.example']);
}

console.log(`book: ${ran - bad}/${ran} passed`);
process.exit(bad === 0 ? 0 : 1);
