/**
 * Unit checks for ./src/fetcher.ts (NFX-17 §4.3), on a hand-driven clock and a scripted
 * `fetch`: a silent source is left at 4 s (a hedge starts at 2 s), bytes that do not verify
 * stop a source, a drip below the floor is given up, an open source over its time limit
 * while the buffer is low is given up, the third place goes to a configured source, and a
 * file every source failed is tried again after 10 s.
 */
import { ALL_FAILED_WAIT_MS, type FetchDeps, type FileSpec, Meter, TICK_MS, fetchFile } from './src/fetcher';
import { type SourceInfo, SourceSet, type Tier } from './src/sources';

let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

class Clock {
  t = 0;
  #timers: { at: number; run: () => void }[] = [];
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => new Promise((r) => this.at(this.t + ms, r));
  at(at: number, run: () => void): void {
    this.#timers.push({ at, run });
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + 50);
      const due = this.#timers.filter((x) => x.at <= this.t);
      this.#timers = this.#timers.filter((x) => x.at > this.t);
      for (const x of due) x.run();
      await flush();
    }
  }
}

/** How a source answers: an HTTP status, and chunks at times (ms after the request). */
interface Script {
  status?: number;
  chunks?: [number, Uint8Array][];
  /** Close the body after the last chunk (default true); false leaves it open forever. */
  end?: boolean;
}

function scriptedFetch(clock: Clock, scripts: Map<string, Script>, asked: string[]) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    asked.push(url);
    const sc = scripts.get(url.slice(0, url.indexOf('/root/'))) ?? { status: 404 };
    if ((sc.status ?? 200) !== 200) return new Response(null, { status: sc.status });
    const t0 = clock.t;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        init.signal?.addEventListener('abort', () => {
          try {
            c.error(new DOMException('aborted', 'AbortError'));
          } catch {
            // closed already
          }
        });
        const chunks = sc.chunks ?? [];
        for (const [dt, b] of chunks) clock.at(t0 + dt, () => {
          try {
            c.enqueue(b);
          } catch {
            // aborted
          }
        });
        if (sc.end !== false) {
          const last = chunks.length > 0 ? chunks[chunks.length - 1]![0] : 0;
          clock.at(t0 + last, () => {
            try {
              c.close();
            } catch {
              // aborted
            }
          });
        }
      },
    });
    return new Response(body, { status: 200 });
  };
}

const FILE = new Uint8Array(250_000).fill(7);
const WRONG = new Uint8Array(250_000).fill(8);
const spec: FileSpec = { path: 'root/seg.m4s', size: FILE.byteLength, mediaTime: 2, rendition: '720p' };
const src = (url: string, tier: Tier): SourceInfo => ({ url, tier, renditions: null, firm: null });
/** The whole file at once, `after` ms in. */
const whole = (after: number, bytes: Uint8Array = FILE): Script => ({ chunks: [[after, bytes]] });

async function run(
  sources: SourceInfo[],
  scripts: [string, Script][],
  opts: { buffer?: number; maxMs?: number; file?: FileSpec; len?: number } = {},
): Promise<{ source: string | null; ms: number; asked: string[]; set: SourceSet }> {
  const clock = new Clock();
  const set = new SourceSet(
    (() => {
      let n = 0;
      return () => (n += 1) / 1000;
    })(),
  );
  set.update(sources, 0);
  const asked: string[] = [];
  const deps: FetchDeps = {
    sources: set,
    meter: new Meter(),
    fetch: scriptedFetch(clock, new Map(scripts), asked),
    now: clock.now,
    sleep: clock.sleep,
    bufferAhead: () => opts.buffer ?? 30,
    verify: (b) => b.byteLength === (opts.len ?? FILE.byteLength) && b.every((x) => x === 7),
  };
  let result: { bytes: Uint8Array; source: string } | null = null;
  const ctl = new AbortController();
  const p = fetchFile(opts.file ?? spec, deps, ctl.signal).then(
    (r) => (result = r),
    () => {},
  );
  const limit = opts.maxMs ?? 30_000;
  while (result === null && clock.t < limit) await clock.advance(TICK_MS);
  const ms = clock.t;
  ctl.abort();
  await clock.advance(TICK_MS);
  await p;
  return { source: (result as { source: string } | null)?.source ?? null, ms, asked: asked.map((u) => u.slice(0, u.indexOf('/root/'))), set };
}

{
  const r = await run([src('https://a.example', 3)], [['https://a.example', whole(500)]]);
  eq('a healthy source delivers', r.source, 'https://a.example');
  eq('at once', r.ms <= 1000, true);
}
{
  // Silent from the start: a hedge at 2 s, and it is left by 4 s.
  const r = await run(
    [src('https://silent.example', 3), src('https://good.example', 3)],
    [
      ['https://silent.example', { chunks: [], end: false }],
      ['https://good.example', whole(300)],
    ],
  );
  eq('silent source: another delivers', r.source, 'https://good.example');
  eq('within the hedge, not the 4 s give-up', r.ms <= 3000, true);
}
{
  // Bytes that do not verify: that source is stopped for the session, the next delivers.
  const r = await run(
    [src('https://liar.example', 1), src('https://good.example', 3)],
    [
      ['https://liar.example', whole(100, WRONG)],
      ['https://good.example', whole(100)],
    ],
  );
  eq('bad bytes: the next source delivers', r.source, 'https://good.example');
  eq('the liar is out', r.set.list(r.ms).find((s) => s.url === 'https://liar.example')?.bad, true);
}
{
  // A drip (16 kbit/s) from an open source, another source idle. With the buffer low (a start, a
  // seek), the request is joined by another source at 2 s, which delivers and sets the link rate:
  // the drip is then far under the floor.
  const drip: [number, Uint8Array][] = [];
  for (let t = 100; t < 20_000; t += 500) drip.push([t, new Uint8Array(1000).fill(7)]);
  const r = await run(
    [src('https://drip.example', 3), src('https://good.example', 4)],
    [
      ['https://drip.example', { chunks: drip, end: false }],
      ['https://good.example', whole(100)],
    ],
    { buffer: 1 },
  );
  eq('drip, buffer low: another source delivers', r.source, 'https://good.example');
  eq('within the hedge', r.ms <= 3500, true);
}
{
  // The same drip with the buffer full costs nothing and is left alone: it is the only request
  // measured, so it is the link rate, and a slow link is not a slow source (a drip is only
  // given up once the buffer runs low, by the open-source time limit and the hedge above).
  const drip: [number, Uint8Array][] = [];
  for (let t = 100; t < 20_000; t += 500) drip.push([t, new Uint8Array(1000).fill(7)]);
  const r = await run(
    [src('https://drip.example', 3), src('https://good.example', 4)],
    [
      ['https://drip.example', { chunks: drip, end: false }],
      ['https://good.example', whole(100)],
    ],
    { buffer: 30, maxMs: 9_000 },
  );
  eq('drip, buffer full: not given up', r.source, null);
  eq('and not demoted', r.set.list(r.ms).find((s) => s.url === 'https://drip.example')?.stopped, false);
}
{
  // Open sources that keep above the 1 Mbit/s floor (~1.04 Mbit/s) but far under a 1 MB, 2 s
  // file's pace (4 Mbit/s), with the buffer low: each is given up at its time limit (4 s), not
  // when its body overruns the file (7.7 s), and the configured source delivers at about 6 s.
  // Without the time limit it would be after 7.7 s.
  const BIG = new Uint8Array(1_000_000).fill(7);
  const pace: [number, Uint8Array][] = [];
  for (let t = 100; t < 60_000; t += 100) pace.push([t, new Uint8Array(13_000).fill(7)]);
  const r = await run(
    [src('https://slow1.example', 3), src('https://slow2.example', 3), src('https://slow3.example', 3), src('https://cfg.example', 4)],
    [
      ['https://slow1.example', { chunks: pace, end: false }],
      ['https://slow2.example', { chunks: pace, end: false }],
      ['https://slow3.example', { chunks: pace, end: false }],
      ['https://cfg.example', whole(200, BIG)],
    ],
    { buffer: 1, len: BIG.byteLength, file: { path: 'root/seg.m4s', size: BIG.byteLength, mediaTime: 2, rendition: '720p' } },
  );
  eq('low buffer: the configured source delivers', r.source, 'https://cfg.example');
  eq('before an overrun could have ended the open sources', r.ms < 7_000, true);
}
{
  // Every source failed: wait 10 s, then start again.
  const r = await run(
    [src('https://err.example', 3)],
    [['https://err.example', { status: 503 }]],
    { maxMs: ALL_FAILED_WAIT_MS + 2_000 },
  );
  eq('all failed: no file yet', r.source, null);
  eq('asked again after the wait', r.asked.length >= 2, true);
}
{
  // Longer than the hash list says: not this file.
  const r = await run(
    [src('https://long.example', 3), src('https://good.example', 3)],
    [
      ['https://long.example', whole(100, new Uint8Array(FILE.byteLength + 10).fill(7))],
      ['https://good.example', whole(100)],
    ],
  );
  eq('too long: the next delivers', r.source, 'https://good.example');
}

{
  // A file of unknown size (the hash list): a source that sends past its limit is left.
  const endless: [number, Uint8Array][] = [];
  for (let t = 50; t < 20_000; t += 50) endless.push([t, new Uint8Array(100_000).fill(7)]);
  const r = await run(
    [src('https://endless.example', 3), src('https://good.example', 3)],
    [
      ['https://endless.example', { chunks: endless, end: false }],
      ['https://good.example', whole(100)],
    ],
    { file: { path: 'root/seg.m4s', size: null, mediaTime: null, rendition: null, maxBytes: FILE.byteLength } },
  );
  eq('an endless body is cut at the limit', r.source, 'https://good.example');
  eq('the endless source is out', r.set.list(r.ms).find((s) => s.url === 'https://endless.example')?.bad, true);
}

{
  // A viewer on a 400 kbit/s link, one source: the link rate is learnt before the 1 Mbit/s floor
  // is applied, so a slow link is not mistaken for a slow source.
  const LEN = 300_000;
  const slow: [number, Uint8Array][] = [];
  for (let t = 100; t <= 6_000; t += 100) slow.push([t, new Uint8Array(5_000).fill(7)]);
  const r = await run(
    [src('https://only.example', 3)],
    [['https://only.example', { chunks: slow }]],
    { len: LEN, maxMs: 20_000, file: { path: 'root/list', size: LEN, mediaTime: null, rendition: null } },
  );
  eq('a slow link still gets its file', r.source, 'https://only.example');
  eq('without a give-up', r.set.list(r.ms).find((s) => s.url === 'https://only.example')?.stopped, false);
}

console.log(`fetcher: ${ran - bad}/${ran} passed`);
process.exit(bad === 0 ? 0 : 1);
