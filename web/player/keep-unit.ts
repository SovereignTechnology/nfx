/**
 * Unit checks for keeping (./src/keep/, NFX-18, NFX-10 §7) and the provider tiers of
 * ./src/session-sources.ts (decision record 0112 point 8), in Node: the store over an
 * in-memory backend with IndexedDB's all-or-nothing transactions, sha256 from node:crypto, a
 * hand-driven clock for deadlines, and a fake media element for the play clock. The same store
 * over real IndexedDB is e2e-keep.ts's.
 *
 * - store: a file's bytes and entry in one transaction (a failure between them leaves
 *   neither), keys `<root>/<sha256>`, eviction of watched-only videos least recently played
 *   first, never one playing or downloaded, `full` at the cap, a read that fails its sha256
 *   dropped and never returned, a rendition recorded held in the commit that completes it;
 * - session: nothing written before the minimum of seconds played (seeks count nothing), then
 *   everything held in RAM; the engine storage's usage is RAM only; a tampered stored file is
 *   refused and fetched again; the end of a session deletes nothing;
 * - tiers: the keep store, then the next provider, then HTTP; null hands on at once, a
 *   deadline starts the next tier too, the last tier with a chance waits; a provider that
 *   throws or sends bytes that do not verify counts as null; one may decline a role; an empty
 *   HTTP set ends nothing at once.
 *
 * Usage: npm run unit:keep
 */
import { createHash } from 'node:crypto';

import type { CommonCoreConfig, StreamConfig } from 'p2p-media-loader-core';

import { ALL_FAILED_WAIT_MS } from './src/fetcher';
import { KeepSession, type PlayClockElement, playlistLayout } from './src/keep/session-store';
import { type KeepBackend, type KeepTx, Keeper, STORES, type StoreName } from './src/keep/store';
import { type FileProvider, type FileWant, SessionSources, type SourcesEnv } from './src/session-sources';

let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const sha = (b: Uint8Array | string): string => createHash('sha256').update(typeof b === 'string' ? Buffer.from(b) : b).digest('hex');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Bytes made at run time, never fixed key material. */
const blob = (label: string, size: number): Uint8Array => {
  const out = new Uint8Array(size);
  const seed = createHash('sha256').update(label).digest();
  for (let i = 0; i < size; i++) out[i] = seed[i % seed.length]! ^ (i & 0xff);
  return out;
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

/** IndexedDB's semantics, in memory: a transaction's writes land together when it ends, or not at all. */
class MemBackend implements KeepBackend {
  readonly data = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  /** Fail the put that matches (an injected error, as a quota error would be). */
  failPut: ((store: StoreName, key: string) => boolean) | null = null;
  transactions = 0;

  async run<T>(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: KeepTx) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const work = new Map(stores.map((s) => [s, new Map(this.data.get(s))]));
    const of = (s: StoreName): Map<string, unknown> => {
      const m = work.get(s);
      if (!m) throw new Error(`store ${s} is not in this transaction`);
      return m;
    };
    const write = (s: StoreName): Map<string, unknown> => {
      if (mode === 'readonly') throw new Error('readonly transaction');
      return of(s);
    };
    const tx: KeepTx = {
      get: async (s, k) => structuredClone(of(s).get(k)),
      put: async (s, k, v) => {
        if (this.failPut?.(s, k)) throw new Error('injected failure');
        write(s).set(k, structuredClone(v));
      },
      delete: async (s, k) => {
        write(s).delete(k);
      },
      keys: async (s, lo, hi) => [...of(s).keys()].filter((k) => k >= lo && k <= hi).sort(),
      values: async (s) => [...of(s).values()].map((v) => structuredClone(v)),
    };
    const r = await fn(tx);
    if (mode === 'readwrite') for (const [s, m] of work) this.data.set(s, m);
    return r;
  }

  close(): void {}

  count(s: StoreName): number {
    return this.data.get(s)!.size;
  }
}

class Clock {
  t = 0;
  #timers: { at: number; run: () => void }[] = [];
  now = (): number => this.t;
  sleep = (ms: number): Promise<void> => new Promise((r) => this.#timers.push({ at: this.t + ms, run: r }));
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    // What is already due at this instant settles before time moves on.
    await flush();
    while (this.t < end) {
      this.t = Math.min(end, this.t + 50);
      const due = this.#timers.filter((x) => x.at <= this.t);
      this.#timers = this.#timers.filter((x) => x.at > this.t);
      for (const x of due) x.run();
      await flush();
    }
  }
}

/** A media element as far as the play clock reads it. */
class FakeVideo extends EventTarget implements PlayClockElement {
  currentTime = 0;
  seeking = false;
  playbackRate = 1;
  addEventListener(type: string, fn: () => void): void {
    super.addEventListener(type, fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    super.removeEventListener(type, fn);
  }
  /** Play `seconds` in steps of 0.25 s, a `timeupdate` each. */
  play(seconds: number): void {
    for (let s = 0; s < seconds; s += 0.25) {
      this.currentTime += 0.25;
      this.dispatchEvent(new Event('timeupdate'));
    }
  }
  seek(to: number): void {
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
    this.currentTime = to;
    this.dispatchEvent(new Event('timeupdate'));
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
}

/** A small video: a hash list (bytes only; its sha256 is the root), a master, one playlist, an init and four segments. */
function video(label: string) {
  const init = blob(`${label}:init`, 600);
  const segs = [0, 1, 2, 3].map((i) => blob(`${label}:seg${i}`, 4000 + i));
  const initSha = sha(init);
  const segShas = segs.map(sha);
  const playlist = enc(
    ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', `#EXT-X-MAP:URI="${initSha}.mp4"`, ...segShas.flatMap((s) => ['#EXTINF:4.0,', `${s}.m4s`]), '#EXT-X-ENDLIST', ''].join('\n'),
  );
  const playlistSha = sha(playlist);
  const master = enc(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${playlistSha}.m3u8\n`);
  const masterSha = sha(master);
  const hashList = enc(JSON.stringify({ label, files: [masterSha, playlistSha, initSha, ...segShas] }));
  const root = sha(hashList);
  const files = [
    { sha256: masterSha, role: 'playlist-master', size: master.byteLength },
    { sha256: playlistSha, role: 'playlist', size: playlist.byteLength },
    { sha256: initSha, role: 'init', size: init.byteLength },
    ...segs.map((s, i) => ({ sha256: segShas[i]!, role: 'segment', size: s.byteLength })),
  ];
  const swarm = `nfx:test:${label}/360p`;
  const bySha = new Map<string, Uint8Array>([
    [root, hashList],
    [masterSha, master],
    [playlistSha, playlist],
    [initSha, init],
    ...segs.map((s, i): [string, Uint8Array] => [segShas[i]!, s]),
  ]);
  return { root, hashList, master, masterSha, playlist, playlistSha, init, initSha, segs, segShas, files, swarm, bySha, list: { video: `nfx:test:${label}`, files, renditions: [{ id: '360p', playlist: playlistSha, swarm }] } };
}

const want = (root: string, sha256: string, role: FileWant['role'], ext: string, rendition: string | null = null): FileWant => ({
  path: role === 'hashlist' ? root : `${root}/${sha256}.${ext}`,
  root,
  sha256,
  role,
  rendition,
  maxBytes: 1 << 20,
  lastChance: false,
});

const core = { segmentMemoryStorageLimit: 512 } as unknown as CommonCoreConfig;
const stream = { highDemandTimeWindow: 15, httpDownloadTimeWindow: 3000 } as unknown as StreamConfig;
const MiB = 1_048_576;

async function storeChecks(): Promise<void> {
  const now = { t: 1_000 };
  const be = new MemBackend();
  const keeper = new Keeper(be, 30_000, { sha256: sha, now: () => now.t });
  const v = video('a');
  const put = (root: string, b: Uint8Array, role: 'segment' | 'init' | 'hashlist' = 'segment', rendition: string | null = '360p') =>
    keeper.put({ root, video: 'nfx:test:a', sha256: sha(b), role, rendition, bytes: b, reason: 'watched' });

  // One transaction: a failure between the bytes and the entry leaves neither.
  be.failPut = (s) => s === 'files';
  let threw = false;
  try {
    await put(v.root, v.segs[0]!);
  } catch {
    threw = true;
  }
  be.failPut = null;
  eq('store: a failed commit throws', threw, true);
  eq('store: a failed commit leaves no bytes, entry, video or usage', [be.count('bytes'), be.count('files'), be.count('videos'), be.count('meta')], [0, 0, 0, 0]);
  const tx0 = be.transactions;
  eq('store: stored', (await put(v.root, v.segs[0]!)).kind, 'stored');
  eq('store: one write transaction per file', be.transactions - tx0, 1);
  eq('store: keyed <root>/<sha256>, bytes and entry alike', [[...be.data.get('bytes')!.keys()], [...be.data.get('files')!.keys()]], [[`${v.root}/${v.segShas[0]}`], [`${v.root}/${v.segShas[0]}`]]);
  eq('store: again is already', (await put(v.root, v.segs[0]!)).kind, 'already');
  eq('store: bytes that are not the file are refused', (await keeper.put({ root: v.root, video: 'x', sha256: v.segShas[1]!, role: 'segment', rendition: '360p', bytes: v.segs[0]!, reason: 'watched' })).kind, 'refused');
  // The same bytes under two roots are two files.
  const other = video('b');
  eq('store: same bytes, another root: stored', (await put(other.root, v.segs[0]!)).kind, 'stored');
  eq('store: two entries', be.count('files'), 2);
  eq('store: usage counts both', await keeper.usage(), 2 * v.segs[0]!.byteLength);
  await keeper.remove(other.root);
  eq('store: remove takes one root only', [...(await keeper.storedShas(v.root))], [v.segShas[0]]);
  eq('store: remove frees its bytes', await keeper.usage(), v.segs[0]!.byteLength);

  // A read checks the sha256 again; bytes that fail are dropped, never returned.
  eq('store: a read verifies', sha((await keeper.read(v.root, v.segShas[0]!)).bytes!), v.segShas[0]);
  const k = `${v.root}/${v.segShas[0]}`;
  const stored = new Uint8Array(be.data.get('bytes')!.get(k) as ArrayBuffer);
  stored[10] = stored[10]! ^ 1;
  be.data.get('bytes')!.set(k, stored.buffer);
  const tampered = await keeper.read(v.root, v.segShas[0]!);
  eq('store: a tampered file is refused', [tampered.bytes, tampered.refused], [null, true]);
  eq('store: and dropped, entry and bytes', [be.data.get('bytes')!.has(k), be.data.get('files')!.has(k)], [false, false]);
  eq('store: no file left, no video left', [be.count('videos'), await keeper.usage()], [0, 0]);

  // Eviction at the cap: watched-only, least recently played first, never playing or downloaded.
  const fill = async (label: string, at: number, reason: 'watched' | 'downloaded' = 'watched'): Promise<string> => {
    const x = video(label);
    now.t = at;
    const b = blob(`${label}:fill`, 9_000);
    eq(`store: ${label} stored`, (await keeper.put({ root: x.root, video: label, sha256: sha(b), role: 'segment', rendition: '360p', bytes: b, reason })).kind, 'stored');
    return x.root;
  };
  const r1 = await fill('one', 2_000);
  const r2 = await fill('two', 3_000);
  const r3 = await fill('three', 4_000);
  // Played again: now the most recent.
  now.t = 5_000;
  await keeper.touch(r1);
  const roots = async (): Promise<string[]> => (await keeper.list()).map((x) => x.root);
  eq('store: list, most recently played first', await roots(), [r1, r3, r2]);
  const r4 = await fill('four', 6_000);
  eq('store: at the cap, the least recently played watched video goes', (await roots()).sort(), [r1, r3, r4].sort());
  const release = await keeper.protect(r3);
  const r5 = await fill('five', 7_000);
  eq('store: never one that plays: the next least recent goes', (await roots()).sort(), [r3, r4, r5].sort());
  release();
  // A downloaded video is never evicted; with nothing else left to evict, the store is full.
  const kd = new Keeper(new MemBackend(), 20_000, { sha256: sha, now: () => now.t });
  const d1 = video('d1');
  const b1 = blob('d1', 9_000);
  await kd.put({ root: d1.root, video: 'd1', sha256: sha(b1), role: 'segment', rendition: '360p', bytes: b1, reason: 'downloaded' });
  const w1 = video('w1');
  const b2 = blob('w1', 9_000);
  await kd.put({ root: w1.root, video: 'w1', sha256: sha(b2), role: 'segment', rendition: '360p', bytes: b2, reason: 'watched' });
  const stop = await kd.protect(w1.root);
  const b3 = blob('w2', 9_000);
  const w2 = video('w2');
  eq('store: nothing evictable (downloaded, playing): full', (await kd.put({ root: w2.root, video: 'w2', sha256: sha(b3), role: 'segment', rendition: '360p', bytes: b3, reason: 'watched' })).kind, 'full');
  stop();
  // A root another tab plays is not taken (its exclusive Web Lock is not granted), so it stays.
  const claimed: string[] = [];
  const kl = new Keeper(new MemBackend(), 20_000, {
    sha256: sha,
    now: () => now.t,
    claim: async (rs) => {
      claimed.push(...rs);
      return { held: new Set(rs.filter((r) => r !== w1.root)), release: () => {} };
    },
  });
  await kl.put({ root: w1.root, video: 'w1', sha256: sha(b2), role: 'segment', rendition: '360p', bytes: b2, reason: 'watched' });
  await kl.put({ root: d1.root, video: 'd1', sha256: sha(b1), role: 'segment', rendition: '360p', bytes: b1, reason: 'watched' });
  eq('store: a root another tab plays is not evicted', (await kl.put({ root: w2.root, video: 'w2', sha256: sha(b3), role: 'segment', rendition: '360p', bytes: b3, reason: 'watched' })).kind, 'stored');
  eq('store: the other one went', (await kl.list()).map((x) => x.root).sort(), [w1.root, w2.root].sort());
  eq('store: only what was needed was asked for', claimed.filter((r) => r === d1.root).length, 1);

  // Nothing goes for a file that would not fit even then: 16 kB cap, 4 kB watched, 10 kB downloaded, 8 kB more.
  const bf = new MemBackend();
  const kf = new Keeper(bf, 16_000, { sha256: sha, now: () => now.t });
  const fw = video('fw');
  const fd = video('fd');
  const fn = video('fn');
  const bw = blob('fw', 4_000);
  const bd = blob('fd', 10_000);
  const bn = blob('fn', 8_000);
  await kf.put({ root: fw.root, video: 'fw', sha256: sha(bw), role: 'segment', rendition: '360p', bytes: bw, reason: 'watched' });
  await kf.put({ root: fd.root, video: 'fd', sha256: sha(bd), role: 'segment', rendition: '360p', bytes: bd, reason: 'downloaded' });
  eq('store: too big even after every eviction: full', (await kf.put({ root: fn.root, video: 'fn', sha256: sha(bn), role: 'segment', rendition: '360p', bytes: bn, reason: 'watched' })).kind, 'full');
  eq('store: and nothing went for it', [(await kf.list()).map((x) => x.root).sort(), await kf.usage()], [[fw.root, fd.root].sort(), 14_000]);
  // A record that says it holds more than its files do: its eviction is undone, not committed.
  const rec = bf.data.get('videos')!.get(fw.root) as { bytes: number };
  bf.data.get('videos')!.set(fw.root, { ...rec, bytes: 100_000 });
  eq('store: a record that overstates its size: full', (await kf.put({ root: fn.root, video: 'fn', sha256: sha(bn), role: 'segment', rendition: '360p', bytes: bn, reason: 'watched' })).kind, 'full');
  eq('store: and its files are still there', [(await kf.storedShas(fw.root)).size, await kf.usage()], [1, 14_000]);

  // A removal ends keeping for the sessions that started before it, not for later ones, and
  // only once it has committed.
  const br = new MemBackend();
  const kr = new Keeper(br, 1 << 20, { sha256: sha, now: () => now.t });
  const rv = video('rv');
  const rb = blob('rv', 1_000);
  const putR = () => kr.put({ root: rv.root, video: 'rv', sha256: sha(rb), role: 'segment', rendition: '360p', bytes: rb, reason: 'watched' });
  await putR();
  const markA = kr.removalMark(rv.root);
  const relA = await kr.protect(rv.root);
  await kr.remove(rv.root);
  const markB = kr.removalMark(rv.root);
  const relB = await kr.protect(rv.root);
  eq('store: removed for a session that started before the removal', kr.removedSince(rv.root, markA), true);
  eq('store: not for one that started after it, while the first still plays', kr.removedSince(rv.root, markB), false);
  await putR();
  br.failPut = (st) => st === 'meta';
  let removeFailed = false;
  try {
    await kr.remove(rv.root);
  } catch {
    removeFailed = true;
  }
  br.failPut = null;
  eq('store: a removal that fails marks nothing and keeps the files', [removeFailed, kr.removedSince(rv.root, markB), (await kr.storedShas(rv.root)).size], [true, false, 1]);
  relA();
  relB();

  // idle() waits for the writes queued before it, not for later ones.
  let openA: (() => void) | undefined;
  let openB: (() => void) | undefined;
  const qa = kr.enqueue(() => new Promise<void>((r) => (openA = r)));
  let idled = false;
  const idling = kr.idle().then(() => (idled = true));
  const qb = kr.enqueue(() => new Promise<void>((r) => (openB = r)));
  await flush();
  openA?.();
  await flush();
  eq('store: idle is the queue as it was when called', idled, true);
  openB?.();
  await Promise.all([qa, qb, idling]);

  // An entry whose bytes are gone: a read is a miss, the entry goes, and the file is stored again.
  const k0 = `${rv.root}/${sha(rb)}`;
  br.data.get('bytes')!.delete(k0);
  const gone = await kr.read(rv.root, sha(rb));
  eq('store: an entry without its bytes reads as a miss', [gone.bytes, gone.refused], [null, false]);
  eq('store: and goes, entry and usage', [br.data.get('files')!.has(k0), await kr.usage()], [false, 0]);
  eq('store: so the file is stored again when it comes', (await putR()).kind, 'stored');

  // close() takes nothing new, and what is queued still commits.
  let unblock: (() => void) | undefined;
  const blocker = kr.enqueue(() => new Promise<void>((r) => (unblock = r)));
  const cv = video('cv');
  const cb = blob('cv', 500);
  const queued = kr.enqueue(() => kr.put({ root: cv.root, video: 'cv', sha256: sha(cb), role: 'segment', rendition: '360p', bytes: cb, reason: 'watched' }));
  await flush();
  kr.close();
  let refusedNew = false;
  await kr.enqueue(async () => 1).catch(() => (refusedNew = true));
  unblock?.();
  await blocker;
  eq('store: a write queued before close commits', (await queued).kind, 'stored');
  eq('store: nothing new once closing', refusedNew, true);

  // Held is recorded in the commit that completes the rendition, and only then.
  const kh = new Keeper(new MemBackend(), 1 << 20, { sha256: sha, now: () => now.t });
  const h = video('h');
  const members = [h.root, h.masterSha, h.playlistSha, h.initSha, ...h.segShas];
  const order: [Uint8Array, 'hashlist' | 'playlist-master' | 'playlist' | 'init' | 'segment'][] = [
    [h.hashList, 'hashlist'], [h.master, 'playlist-master'], [h.playlist, 'playlist'], [h.init, 'init'], ...h.segs.map((s): [Uint8Array, 'segment'] => [s, 'segment']),
  ];
  let states: string[] = [];
  for (const [b, role] of order) {
    const r = await kh.put({ root: h.root, video: 'h', sha256: sha(b), role, rendition: role === 'init' || role === 'segment' ? '360p' : null, bytes: b, reason: 'watched', completes: [{ id: '360p', members }] });
    if (r.kind === 'stored') states.push(r.renditions.find((x) => x.id === '360p')?.state ?? '-');
  }
  eq('store: filling until the last file, then held', states, ['-', '-', '-', 'filling', 'filling', 'filling', 'filling', 'held']);
  await kh.drop(h.root, h.segShas[2]!);
  eq('store: a dropped file makes its rendition filling again', (await kh.video(h.root))?.renditions, [{ id: '360p', state: 'filling', reasons: ['watched'] }]);
}

async function sessionChecks(): Promise<void> {
  const be = new MemBackend();
  const keeper = new Keeper(be, 1 << 24, { sha256: sha, now: () => 1 });
  const v = video('s');
  const states: string[] = [];
  const session = async (minimumSeconds: number) => {
    const s = new KeepSession({ keeper, root: v.root, minimumSeconds, sha256: sha, onState: (st) => states.push(st) });
    await s.start();
    s.learnList(v.list);
    s.learnPlaylist(new TextDecoder().decode(v.playlist), '360p');
    s.meshOn = true;
    const el = new FakeVideo();
    s.attach(el);
    return { s, el };
  };
  eq('session: playlist layout', playlistLayout(new TextDecoder().decode(v.playlist)), { init: v.initSha, segments: v.segShas });

  // ---- a first play: under the minimum nothing is written ----
  const { s, el } = await session(30);
  s.delivered(want(v.root, v.root, 'hashlist', ''), v.hashList, 'https://o.test');
  s.delivered(want(v.root, v.masterSha, 'playlist-master', 'm3u8'), v.master, 'https://o.test');
  s.delivered(want(v.root, v.playlistSha, 'playlist', 'm3u8'), v.playlist, 'https://o.test');
  s.delivered(want(v.root, v.initSha, 'init', 'mp4', '360p'), v.init, 'https://o.test');
  const st = s.segmentStorage();
  await st.initialize(core, stream, stream);
  const changed: string[] = [];
  st.setSegmentChangeCallback((id) => changed.push(id));
  st.onSegmentRequested(v.root, v.swarm, 0, 0, 4, 'main', false);
  st.onPlaybackUpdated(0, 1);
  // The engine's quirk: a segment stored under the stream last requested, which need not be its
  // own: it is placed by its bytes.
  await st.storeSegment(v.root, 'nfx:test:another/720p', 0, v.segs[0]!.slice().buffer, 0, 4, 'main', false);
  await st.storeSegment(v.root, v.swarm, 1, v.segs[1]!.slice().buffer, 4, 8, 'main', false);
  eq('session: segments placed by their own bytes', [st.hasSegment(v.root, v.swarm, 0), st.hasSegment(v.root, v.swarm, 1), st.hasSegment(v.root, 'nfx:test:another/720p', 0)], [true, true, false]);
  eq('session: the change callback names the segment\'s own stream', changed, [v.swarm, v.swarm]);
  const ramMiB = (v.segs[0]!.byteLength + v.segs[1]!.byteLength) / MiB;
  eq('session: usage is RAM, as the engine counts it', st.getUsage(), { totalCapacity: 512, usedCapacity: ramMiB });
  el.play(10);
  el.seek(200);
  el.play(5);
  el.seek(20);
  await flush();
  eq('session: seeks count nothing', s.stats().playedSeconds, 15);
  eq('session: waiting under the minimum', s.stats().state, 'waiting');
  await keeper.idle();
  eq('session: nothing written under the minimum', [be.count('bytes'), be.count('files'), be.count('videos'), be.count('meta')], [0, 0, 0, 0]);
  // The keep tier serves what the session holds in RAM, written or not.
  eq('session: the RAM copy serves the keep tier', sha((await s.get(want(v.root, v.initSha, 'init', 'mp4', '360p'), () => true, new AbortController().signal))!), v.initSha);

  // A session that ends under the minimum leaves nothing.
  const short = await session(30);
  short.s.delivered(want(v.root, v.root, 'hashlist', ''), v.hashList, 'https://o.test');
  short.el.play(29);
  short.s.close();
  short.el.play(5);
  await keeper.idle();
  eq('session: ended under the minimum: nothing written', [be.count('files'), states.includes('keeping')], [0, false]);

  // ---- past the minimum: everything held is written, and what comes later ----
  el.play(15);
  await flush();
  eq('session: keeping at the minimum', s.stats().state, 'keeping');
  await keeper.idle();
  await flush();
  const stored = await keeper.storedShas(v.root);
  eq('session: the start-up files and the RAM segments written', [v.root, v.masterSha, v.playlistSha, v.initSha, v.segShas[0], v.segShas[1]].map((x) => stored.has(x!)), [true, true, true, true, true, true]);
  st.onPlaybackUpdated(8, 1);
  await st.storeSegment(v.root, v.swarm, 2, v.segs[2]!.slice().buffer, 8, 12, 'main', false);
  await keeper.idle();
  await flush();
  eq('session: a later segment is written as it comes', (await keeper.storedShas(v.root)).has(v.segShas[2]!), true);
  eq('session: written count', s.stats().written, 7);
  eq('session: not held: a segment is missing', s.stats().held, []);
  await st.storeSegment(v.root, v.swarm, 3, v.segs[3]!.slice().buffer, 12, 16, 'main', false);
  await keeper.idle();
  await flush();
  eq('session: held once the last file is stored', s.stats().held, ['360p']);
  // The engine's destroy and the session's end delete nothing.
  st.destroy();
  s.close();
  await keeper.idle();
  eq('session: destroy keeps every file', (await keeper.storedShas(v.root)).size, 8);

  // ---- a second session: from the store, RAM usage only, a tampered file refused ----
  const two = await session(30);
  const st2 = two.s.segmentStorage();
  await st2.initialize(core, stream, stream);
  st2.setSegmentChangeCallback(() => {});
  st2.onSegmentRequested(v.root, v.swarm, 0, 0, 4, 'main', false);
  st2.onPlaybackUpdated(0, 1);
  eq('replay: every segment held, from the store', [0, 1, 2, 3].map((i) => st2.hasSegment(v.root, v.swarm, i)), [true, true, true, true]);
  eq('replay: usage counts RAM only, not the store', st2.getUsage(), { totalCapacity: 512, usedCapacity: 0 });
  eq('replay: a held rendition\'s stored segments are announced', st2.getStoredSegmentIds(v.root, v.swarm).sort(), [0, 1, 2, 3]);
  eq('replay: a segment read from the store', sha(new Uint8Array((await st2.getSegmentData(v.root, v.swarm, 1))!)), v.segShas[1]);
  // Flip one byte of a stored segment and of the init, as other code of the page could.
  for (const x of [v.segShas[2]!, v.initSha]) {
    const k = `${v.root}/${x}`;
    const b = new Uint8Array(be.data.get('bytes')!.get(k) as ArrayBuffer);
    b[b.length - 1] = b[b.length - 1]! ^ 0x80;
    be.data.get('bytes')!.set(k, b.buffer);
  }
  eq('replay: a tampered segment is refused (the engine fetches it)', await st2.getSegmentData(v.root, v.swarm, 2), undefined);
  eq('replay: and no longer held', st2.hasSegment(v.root, v.swarm, 2), false);
  // The tampered init through the tiers: refused by the keep tier, fetched over HTTP, written again.
  const asked: string[] = [];
  const env: SourcesEnv = {
    fetch: async (url) => {
      asked.push(url);
      const name = url.slice(url.lastIndexOf('/') + 1);
      const b = v.bySha.get(name.slice(0, name.indexOf('.')));
      return b ? new Response(b.slice()) : new Response(null, { status: 404 });
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const sources = new SessionSources(v.root, [{ url: 'https://o.test' }], { providers: [two.s], env });
  sources.learnFiles(v.files, v.masterSha);
  two.el.play(31);
  await flush();
  const initPath = `${v.root}/${v.initSha}.mp4`;
  const got = await sources.get(initPath, (b) => sha(b) === v.initSha);
  eq('replay: the tampered init came from HTTP', [got.source, asked], ['https://o.test', [`https://o.test/${initPath}`]]);
  await keeper.idle();
  await flush();
  eq('replay: refused twice', two.s.stats().refused, 2);
  eq('replay: the init is stored again, right', sha((await keeper.read(v.root, v.initSha)).bytes!), v.initSha);
  // The keep tier now serves it: HTTP is not asked.
  const again = await sources.get(initPath, (b) => sha(b) === v.initSha);
  eq('replay: next time from the keep tier', [again.source, asked.length], ['keep:', 1]);
  eq('replay: the playlist from the keep tier', (await sources.get(`${v.root}/${v.playlistSha}.m3u8`, (b) => sha(b) === v.playlistSha)).source, 'keep:');
  eq('replay: the master by its fixed name', (await sources.get(`${v.root}/master.m3u8`, (b) => sha(b) === v.masterSha)).source, 'keep:');
  eq('replay: the hash list by its root', (await sources.get(v.root, (b) => sha(b) === v.root, undefined, true)).source, 'keep:');
  // Bytes that are the file but fail a request's own check (a hash list bound to another
  // manifest) are a miss for that request, and stay.
  eq('replay: a request\'s own check refuses: a miss', await two.s.readFile(v.root, () => false), null);
  eq('replay: and the stored copy stays, not counted as refused', [(await keeper.storedShas(v.root)).has(v.root), two.s.stats().refused], [true, 2]);
  two.s.close();

  // A segment the engine stored before the minimum, and let go before it: still written at the minimum.
  const k3 = new Keeper(new MemBackend(), 1 << 24, { sha256: sha, now: () => 1 });
  const s3 = new KeepSession({ keeper: k3, root: v.root, minimumSeconds: 5, sha256: sha });
  await s3.start();
  s3.learnList(v.list);
  s3.learnPlaylist(new TextDecoder().decode(v.playlist), '360p');
  s3.meshOn = true;
  const el3 = new FakeVideo();
  s3.attach(el3);
  const st3 = s3.segmentStorage();
  await st3.initialize(core, stream, stream);
  st3.onSegmentRequested(v.root, v.swarm, 0, 0, 4, 'main', false);
  st3.onPlaybackUpdated(0, 1);
  await st3.storeSegment(v.root, v.swarm, 0, v.segs[0]!.slice().buffer, 0, 4, 'main', false);
  eq('session: a held segment counts nowhere in the engine\'s usage but its own', st3.getUsage().usedCapacity, v.segs[0]!.byteLength / MiB);
  st3.destroy();
  el3.play(6);
  await flush();
  await k3.idle();
  await flush();
  eq('session: a segment the engine let go before the minimum is written at it', (await k3.storedShas(v.root)).has(v.segShas[0]!), true);
  s3.close();
}

/** A provider driven by a script: when it answers (ms after asked) and with what. */
function provider(name: string, clock: Clock, log: string[], o: { deadlineMs?: number; after?: number; answer?: Uint8Array | null | 'throw' | 'never'; declines?: (w: FileWant) => boolean; aborted?: string[] }): FileProvider {
  return {
    name,
    deadlineMs: o.deadlineMs ?? 1_000,
    ...(o.declines ? { declines: o.declines } : {}),
    get: (w, verify, signal) => {
      log.push(`${name}@${clock.t}${w.lastChance ? ' last' : ''}`);
      signal.addEventListener('abort', () => o.aborted?.push(name));
      const answer = o.answer;
      if (answer === 'never') return new Promise<Uint8Array | null>((r) => signal.addEventListener('abort', () => r(null)));
      // No delay: an answer in the same turn, not at the clock's next step.
      return (o.after ? clock.sleep(o.after) : Promise.resolve()).then(() => {
        if (answer === 'throw') throw new Error('provider broke');
        const b = answer ?? null;
        // A provider runs the check too (decision record 0112 point 8); this one is careless on purpose when told to send bad bytes.
        return b !== null && (verify(b) || name.startsWith('liar')) ? b : null;
      });
    },
  };
}

async function tierChecks(): Promise<void> {
  const v = video('t');
  const seg = `${v.root}/${v.segShas[0]}.m4s`;
  const initPath = `${v.root}/${v.initSha}.mp4`;
  const ok = (b: Uint8Array): boolean => sha(b) === v.segShas[0];
  const okInit = (b: Uint8Array): boolean => sha(b) === v.initSha;
  const setup = (providers: FileProvider[], origins: string[], clock: Clock, asked: string[]) => {
    const env: SourcesEnv = {
      fetch: async (url) => {
        asked.push(`${url}@${clock.t}`);
        const name = url.slice(url.lastIndexOf('/') + 1);
        const b = v.bySha.get(name.slice(0, name.indexOf('.')));
        return b ? new Response(b.slice()) : new Response(null, { status: 404 });
      },
      now: clock.now,
      sleep: clock.sleep,
    };
    const src = new SessionSources(v.root, origins.map((url) => ({ url })), { providers, env });
    src.learnFiles(v.files, v.masterSha);
    const delivered: string[] = [];
    src.bind({ delivered: (x) => delivered.push(x) });
    return { src, delivered };
  };
  const settle = <T>(p: Promise<T>): { done: () => T | undefined; err: () => unknown } => {
    let r: T | undefined;
    let e: unknown;
    p.then((x) => (r = x), (x) => (e = x));
    return { done: () => r, err: () => e };
  };

  {
    // Order: the keep tier first; HTTP is not asked when it answers.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const { src, delivered } = setup([provider('keep:', c, log, { after: 100, answer: v.segs[0]! }), provider('file-channel:', c, log, {})], ['https://o.test'], c, asked);
    const r = settle(src.get(seg, ok));
    await c.advance(200);
    eq('tiers: the keep tier first', [r.done()?.source, log, asked], ['keep:', ['keep:@0'], []]);
    eq('tiers: a provider is no origin that delivered', delivered, []);
  }
  {
    // Null hands on at once; HTTP is the last tier; providers hear of what HTTP delivered.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const heard: string[] = [];
    const keep = { ...provider('keep:', c, log, { answer: null }), delivered: (w: FileWant, b: Uint8Array, from: string) => heard.push(`${w.role}:${sha(b) === w.sha256}:${from}`) };
    const { src, delivered } = setup([keep, provider('file-channel:', c, log, { answer: null })], ['https://o.test'], c, asked);
    const r = settle(src.get(initPath, okInit));
    await c.advance(1_000);
    eq('tiers: null hands on at once, to HTTP last', [r.done()?.source, log, asked], ['https://o.test', ['keep:@0', 'file-channel:@0'], [`https://o.test/${initPath}@0`]]);
    eq('tiers: providers hear what HTTP delivered, verified', heard, ['init:true:https://o.test']);
    eq('tiers: the origin that delivered is reported', delivered, ['https://o.test']);
  }
  {
    // A deadline: the next tier starts too; the first that verifies wins and stops the rest.
    const c = new Clock();
    const log: string[] = [];
    const aborted: string[] = [];
    const asked: string[] = [];
    const { src } = setup([provider('keep:', c, log, { deadlineMs: 500, answer: 'never', aborted }), provider('file-channel:', c, log, { deadlineMs: 2_000, after: 300, answer: v.segs[0]!, aborted })], ['https://o.test'], c, asked);
    const r = settle(src.get(seg, ok));
    await c.advance(1_000);
    eq('tiers: the next tier at the deadline, the slow one stopped', [r.done()?.source, log, aborted.includes('keep:'), asked], ['file-channel:', ['keep:@0', 'file-channel:@500'], true, []]);
  }
  {
    // HTTP after a keep tier's deadline is timed from the round's start, as a provider's answer is.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const { src } = setup([provider('keep:', c, log, { deadlineMs: 500, answer: 'never' })], ['https://o.test'], c, asked);
    const r = settle(src.get(seg, ok));
    await c.advance(1_000);
    const got = r.done();
    eq('tiers: HTTP after the keep deadline, timed from the round start', [got?.source, (got?.firstByteMs ?? 0) >= 500, (got?.totalMs ?? 0) >= 500], ['https://o.test', true, true]);
  }
  {
    // A provider that throws, or sends bytes that do not verify, counts as null.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const lines: string[] = [];
    const { src } = setup([provider('keep:', c, log, { answer: 'throw' }), provider('liar:', c, log, { answer: v.segs[1]! })], ['https://o.test'], c, asked);
    src.bind({ log: (m) => lines.push(m) });
    const r = settle(src.get(seg, ok));
    await c.advance(1_000);
    eq('tiers: a throw and bad bytes are null; HTTP delivers', [r.done()?.source, r.err(), asked.length], ['https://o.test', undefined, 1]);
    eq('tiers: and both are logged', [lines.some((l) => l.includes('keep:') && l.includes('provider broke')), lines.some((l) => l.includes('liar:') && l.includes('do not verify'))], [true, true]);
  }
  {
    // A provider may decline a role at once: the file channel declines segments.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const fc = provider('file-channel:', c, log, { answer: v.init, declines: (w) => w.role === 'segment' });
    const { src } = setup([fc], ['https://o.test'], c, asked);
    const a = settle(src.get(seg, ok));
    await c.advance(500);
    const b = settle(src.get(initPath, okInit));
    await c.advance(500);
    eq('tiers: a declined role is not asked; another role is', [a.done()?.source, b.done()?.source, log], ['https://o.test', 'file-channel:', ['file-channel:@500']]);
  }
  {
    // An empty HTTP set ends nothing at once: the last provider with a chance has no deadline.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const { src } = setup([provider('keep:', c, log, { answer: null }), provider('file-channel:', c, log, { deadlineMs: 1_000, after: 6_000, answer: v.init })], [], c, asked);
    const r = settle(src.get(initPath, okInit, undefined, true));
    await c.advance(5_000);
    eq('tiers: no origin: still waiting on the last provider past its deadline', [r.done(), r.err()], [undefined, undefined]);
    await c.advance(2_000);
    eq('tiers: no origin: the last provider delivers, told it is the last', [r.done()?.source, log], ['file-channel:', ['keep:@0', 'file-channel:@0 last']]);
  }
  {
    // Every tier failed: with `once` that is an error (after every tier); without, a wait and another round.
    const c = new Clock();
    const log: string[] = [];
    const asked: string[] = [];
    const { src } = setup([provider('keep:', c, log, { after: 200, answer: null })], [], c, asked);
    const once = settle(src.get(initPath, okInit, undefined, true));
    await c.advance(100);
    eq('tiers: once: not failed before every tier has answered', once.err(), undefined);
    await c.advance(200);
    eq('tiers: once: failed when every tier has', String(once.err()), `Error: every source failed ${initPath}`);
    let turn = 0;
    const later: FileProvider = {
      name: 'keep:',
      deadlineMs: 1_000,
      get: async () => (turn++ === 0 ? null : v.init),
    };
    const s2 = setup([later], [], c, asked);
    const r = settle(s2.src.get(initPath, okInit));
    await c.advance(ALL_FAILED_WAIT_MS - 500);
    eq('tiers: every tier failed: waiting, not failed', [r.done(), r.err(), turn], [undefined, undefined, 1]);
    await c.advance(1_000);
    eq('tiers: then every tier again', [r.done()?.source, turn], ['keep:', 2]);
  }
  {
    // An abort stops every tier.
    const c = new Clock();
    const log: string[] = [];
    const aborted: string[] = [];
    const asked: string[] = [];
    const { src } = setup([provider('keep:', c, log, { answer: 'never', aborted })], [], c, asked);
    const ctl = new AbortController();
    const r = settle(src.get(initPath, okInit, ctl.signal));
    await c.advance(100);
    ctl.abort();
    await c.advance(100);
    eq('tiers: an abort rejects and stops the provider', [r.err() !== undefined, aborted], [true, ['keep:']]);
  }
  {
    // What providers are told: path, sha256, role, rendition, byte limit; a path the list does not name gets none.
    const c = new Clock();
    const { src } = setup([], [], c, []);
    src.learnPlaylist(new TextDecoder().decode(v.playlist), '360p');
    eq('tiers: a segment want', src.want(seg, undefined), { path: seg, root: v.root, sha256: v.segShas[0], role: 'segment', rendition: '360p', maxBytes: v.segs[0]!.byteLength, lastChance: false });
    eq('tiers: the master by its fixed name', src.want(`${v.root}/master.m3u8`, undefined)?.sha256, v.masterSha);
    eq('tiers: the hash list by its root, the caller\'s limit', [src.want(v.root, 16)?.role, src.want(v.root, 16)?.maxBytes], ['hashlist', 16]);
    eq('tiers: a name the list lacks: no want', src.want(`${v.root}/${'0'.repeat(64)}.m4s`, undefined), null);
    eq('tiers: another root: no want', src.want(`${'1'.repeat(64)}/${v.segShas[0]}.m4s`, undefined), null);
  }
}

await storeChecks();
await sessionChecks();
await tierChecks();
console.log(`keep: ${ran - bad}/${ran} passed`);
process.exit(bad === 0 ? 0 : 1);
