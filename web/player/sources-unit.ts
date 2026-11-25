/**
 * Unit checks for ./src/sources.ts (NFX-17 §§4.2-4.3): the tier order, one source per host,
 * the per-file and per-session caps on open hosts, the reserved third place, strikes, rests,
 * give-ups and bytes that do not verify. Needs nothing installed: `node sources-unit.ts`.
 */
import {
  MAX_OPEN_SOURCES,
  NEW_OPEN_HOSTS,
  NEW_OPEN_HOST_EVERY_MS,
  OPEN_HOSTS_PER_FILE,
  REST_MS,
  type SourceInfo,
  SourceSet,
  type Tier,
  bestTier,
  capOpenHosts,
  hostOf,
} from './src/sources';

let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** A repeatable random source: 0.1, 0.2, … in the order sources are first seen. */
function counter(): () => number {
  let n = 0;
  return () => (n += 1) / 1000;
}
const src = (url: string, tier: Tier, renditions: string[] | null = null, firm: string[] | null = renditions): SourceInfo => ({
  url,
  tier,
  renditions,
  firm,
});
/** Every source `set` offers for one file, in order, until none is left. */
function drain(set: SourceSet, rendition: string | null, now: number): string[] {
  const plan = set.plan(rendition);
  const out: string[] = [];
  for (let s = set.next(plan, now); s !== null; s = set.next(plan, now)) out.push(s.url);
  return out;
}
const T = 1_000_000;

eq('host of a URL', hostOf('https://a.example:8443/nfx/x'), 'https://a.example:8443');
eq('host of junk', hostOf('not a url'), null);

{
  // Tiers 1, 2, open (in the order drawn), then 4; key counts play no part.
  const set = new SourceSet(counter());
  set.update(
    [
      src('https://config.example', 4),
      src('https://open-b.example', 3),
      src('https://open-a.example', 3),
      src('https://rated.example', 2),
      src('https://creator.example', 1),
    ],
    T,
  );
  eq('tier order', drain(set, null, T), [
    'https://creator.example',
    'https://rated.example',
    'https://open-b.example',
    'https://open-a.example',
    'https://config.example',
  ]);
}
{
  // One source per host before a second of the same host.
  const set = new SourceSet(counter());
  set.update([src('https://h1.example/a', 3), src('https://h1.example/b', 3), src('https://h2.example/a', 3)], T);
  eq('one per host first', drain(set, null, T).slice(0, 2), ['https://h1.example/a', 'https://h2.example/a']);
}
{
  // At most 3 open hosts for one file.
  const set = new SourceSet(counter());
  set.update([1, 2, 3, 4, 5].map((i) => src(`https://o${i}.example`, 3)), T);
  eq('3 open hosts per file', drain(set, null, T).length, OPEN_HOSTS_PER_FILE);
  eq('and for the next file too', drain(set, null, T).length, OPEN_HOSTS_PER_FILE);
}
{
  // Six new open hosts per session, then one per 30 s, each behind tier 4. Each file's hosts
  // give up, so the next file reaches new ones.
  const set = new SourceSet(counter());
  set.update([...Array(9).keys()].map((i) => src(`https://n${i}.example`, 3)), T);
  set.update([src('https://config.example', 4)], T);
  const seen = new Set<string>();
  for (let f = 0; f < 3; f++) {
    for (const u of drain(set, null, T)) {
      seen.add(u);
      set.outcome(u, { kind: 'give-up' }, T);
    }
  }
  eq('six new hosts in all', [...seen].filter((u) => u.startsWith('https://n')).length, NEW_OPEN_HOSTS);
  const later = drain(set, null, T + NEW_OPEN_HOST_EVERY_MS);
  const fresh = later.filter((u) => u.startsWith('https://n') && !seen.has(u));
  eq('one more after 30 s', fresh.length, 1);
  eq('tier 4 ahead of it', later.indexOf('https://config.example') < later.indexOf(fresh[0] ?? ''), true);
}
{
  // A claim orders, never removes: a source said to serve the rendition comes first; a 404
  // outside its firm claim is no strike.
  const set = new SourceSet(counter());
  set.update([src('https://720.example', 3, ['720p'], ['720p']), src('https://any.example', 3, null, ['720p'])], T);
  eq('claims order, never remove', drain(set, '1080p', T), ['https://any.example', 'https://720.example']);
  set.outcome('https://any.example', { kind: 'not-held', rendition: '1080p' }, T);
  set.outcome('https://any.example', { kind: 'not-held', rendition: '1080p' }, T);
  eq('no strike outside the firm claim', set.list(T).find((s) => s.url === 'https://any.example')?.stopped, false);
  set.outcome('https://any.example', { kind: 'not-held', rendition: '720p' }, T);
  set.outcome('https://any.example', { kind: 'not-held', rendition: '720p' }, T);
  eq('a strike inside it', set.list(T).find((s) => s.url === 'https://any.example')?.stopped, true);
}
{
  // Two strikes in six stop a source for 30 s; stopped twice, it goes behind every other.
  const set = new SourceSet(counter());
  set.update([src('https://c.example', 1), src('https://o.example', 3)], T);
  set.outcome('https://c.example', { kind: 'error' }, T);
  set.outcome('https://c.example', { kind: 'delivered', realTime: true }, T);
  set.outcome('https://c.example', { kind: 'error' }, T);
  eq('stopped', drain(set, null, T), ['https://o.example']);
  eq('rested', drain(set, null, T + REST_MS)[0], 'https://c.example');
  set.outcome('https://c.example', { kind: 'error' }, T + REST_MS);
  set.outcome('https://c.example', { kind: 'error' }, T + REST_MS);
  eq('stopped twice: last', drain(set, null, T + 3 * REST_MS), ['https://o.example', 'https://c.example']);
}
{
  // Bytes that do not verify: never again, even after a wake.
  const set = new SourceSet(counter());
  set.update([src('https://c.example', 1), src('https://o.example', 3)], T);
  set.outcome('https://c.example', { kind: 'bad-bytes' }, T);
  set.wake();
  eq('bad bytes: gone', drain(set, null, T + 10 * REST_MS), ['https://o.example']);
}
{
  // An open source that gave up goes behind tier 4; a tier 1 one to the end of its own tier.
  const set = new SourceSet(counter());
  set.update(
    [src('https://c1.example', 1), src('https://c2.example', 1), src('https://a.example', 3), src('https://b.example', 3), src('https://cfg.example', 4)],
    T,
  );
  set.outcome('https://a.example', { kind: 'give-up' }, T);
  set.outcome('https://c1.example', { kind: 'give-up' }, T);
  eq('given up: behind', drain(set, null, T), [
    'https://c2.example',
    'https://c1.example',
    'https://b.example',
    'https://cfg.example',
    'https://a.example',
  ]);
}
{
  // The previous file's source goes first only if it delivered at real-time speed.
  const set = new SourceSet(counter());
  set.update([src('https://c.example', 1), src('https://o.example', 3)], T);
  set.outcome('https://o.example', { kind: 'delivered', realTime: true }, T);
  eq('real-time deliverer first', drain(set, null, T)[0], 'https://o.example');
  set.outcome('https://o.example', { kind: 'delivered', realTime: false }, T);
  eq('a slow one is not', drain(set, null, T)[0], 'https://c.example');
}
{
  // Open hosts that delivered at real-time speed come first among open sources.
  const set = new SourceSet(counter());
  set.update([src('https://x.example', 3), src('https://y.example', 3), src('https://z.example', 3)], T);
  set.outcome('https://z.example', { kind: 'delivered', realTime: true }, T);
  set.outcome('https://x.example', { kind: 'give-up' }, T);
  eq('delivered first', drain(set, null, T)[0], 'https://z.example');
}
{
  // The reserved place goes to the best tier 1, 2 or 4 source not yet asked for the file.
  const set = new SourceSet(counter());
  set.update([src('https://o1.example', 3), src('https://o2.example', 3), src('https://cfg.example', 4)], T);
  const plan = set.plan(null);
  set.next(plan, T);
  set.next(plan, T);
  eq('reserved', set.reserved(plan, T)?.url, 'https://cfg.example');
  eq('only once', set.reserved(plan, T), null);
}
{
  // At most 32 open sources; the least recently used goes; tier 4 stays.
  const set = new SourceSet(counter());
  set.update([src('https://cfg.example', 4)], T);
  set.update([...Array(MAX_OPEN_SOURCES + 3).keys()].map((i) => src(`https://m${i}.example`, 3)), T);
  const held = set.list(T);
  eq('open capped', held.filter((s) => s.tier === 3).length, MAX_OPEN_SOURCES);
  eq('tier 4 kept', held.some((s) => s.url === 'https://cfg.example'), true);
}

{
  // A beacon cannot demote a source the caller configured, or one the creator names.
  const set = new SourceSet(counter());
  set.update([src('https://cfg.example', 4), src('https://c.example', 1)], T);
  set.update([src('https://cfg.example', 3), src('https://c.example', 3)], T);
  eq('tiers kept', set.list(T).map((s) => s.tier), [4, 1]);
  eq('best tier', [bestTier(3, 4), bestTier(4, 2), bestTier(3, 3), bestTier(1, 4)], [4, 2, 3, 1]);
}
{
  // A host that sent bytes that do not verify stays out under any URL, even after eviction.
  const set = new SourceSet(counter());
  set.update([src('https://liar.example/a', 3), src('https://ok.example', 3)], T);
  set.outcome('https://liar.example/a', { kind: 'bad-bytes' }, T);
  set.update([src('https://liar.example/b', 3)], T);
  eq('a bad host, another path', drain(set, null, T), ['https://ok.example']);
}

{
  // Bad bytes from a source evicted while it was being asked: its host is still out.
  const set = new SourceSet(counter());
  set.outcome('https://gone.example/a', { kind: 'bad-bytes' }, T);
  set.update([src('https://gone.example/b', 3), src('https://ok.example', 3)], T);
  eq('rejects', [set.rejects('https://gone.example/c'), set.rejects('https://ok.example')], [true, false]);
  eq('an evicted liar stays out', drain(set, null, T), ['https://ok.example']);
}

{
  // `open()` probes at most 3 open HOSTS, not 3 entries (NFX-17 §4.2): three paths on one
  // host are one host, and creator, rated and configured entries never count.
  const e = (url: string, tier: number) => ({ url, tier });
  const order = [
    e('https://creator.example', 1),
    e('https://a.example/x', 3),
    e('https://a.example/y', 3),
    e('https://a.example/z', 3),
    e('https://b.example', 3),
    e('https://c.example', 3),
    e('https://d.example', 3),
    e('https://fallback.example', 4),
  ];
  eq(
    'three open hosts, however many entries each',
    capOpenHosts(order, null).map((o) => o.url),
    ['https://creator.example', 'https://a.example/x', 'https://a.example/y', 'https://a.example/z', 'https://b.example', 'https://c.example', 'https://fallback.example'],
  );
  eq(
    'the deliverer is kept even past the cap',
    capOpenHosts(order, 'https://d.example').map((o) => o.url).includes('https://d.example'),
    true,
  );
  eq('a cap of 1', capOpenHosts(order, null, 1).map((o) => o.url), ['https://creator.example', 'https://a.example/x', 'https://a.example/y', 'https://a.example/z', 'https://fallback.example']);
}

console.log(`sources: ${ran - bad}/${ran} passed`);
process.exit(bad === 0 ? 0 : 1);
