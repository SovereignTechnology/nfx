/**
 * The file channel's requester side (NFX-10 §6.10): `FilePeer` over a stand-in channel pair,
 * and `FileChannelProvider`'s choosing of peers, against scripted servers that read with
 * ./src/file-channel.ts's `Channel` (so the page's side of the protocol is checked too).
 * The provider's 2 s / 4 s / 10 s waits run on a clock 100 times faster than the real one.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';

import * as fc from './src/file-channel';
import { type DataChannelLike, FilePeer } from './src/file-peer';
import { FileChannelProvider, type WantLike } from './src/file-provider';

let bad = 0;
let ran = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

// ---- a channel pair -------------------------------------------------------------------------
type L = (e: { data: unknown }) => void;
class End implements DataChannelLike {
  readonly label = fc.LABEL;
  readyState: string;
  binaryType = 'blob';
  other: End | null = null;
  readonly sent: Uint8Array[] = [];
  readonly #l = new Map<string, Set<(e: never) => void>>();
  constructor(state = 'open') {
    this.readyState = state;
  }
  send(data: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(data.slice());
    const peer = this.other!;
    const copy = data.slice().buffer;
    queueMicrotask(() => {
      if (peer.readyState === 'open') peer.fire('message', { data: copy });
    });
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.fire('close');
    this.other?.close();
  }
  open(): void {
    this.readyState = 'open';
    this.fire('open');
  }
  fire(type: string, e?: unknown): void {
    for (const f of [...(this.#l.get(type) ?? [])]) (f as (e: unknown) => void)(e);
  }
  addEventListener(type: string, f: L | (() => void)): void {
    let s = this.#l.get(type);
    if (s === undefined) this.#l.set(type, (s = new Set()));
    s.add(f as never);
  }
  removeEventListener(type: string, f: L | (() => void)): void {
    this.#l.get(type)?.delete(f as never);
  }
}
function pair(state = 'open'): [End, End] {
  const a = new End(state);
  const b = new End(state);
  a.other = b;
  b.other = a;
  return [a, b];
}

// ---- a scripted server ----------------------------------------------------------------------
type Mode = 'serve' | 'missing' | 'busy' | 'silent' | 'corrupt' | 'oversize' | 'no-hello';
class Server {
  readonly book = new fc.Channel();
  gets = 0;
  lists = 0;
  open = 0;
  maxOpen = 0;
  cancels = 0;
  error: string | null = null;
  readonly #reqs = new Set<number>();
  constructor(
    readonly ch: End,
    readonly files: Map<string, Uint8Array>,
    readonly o: { mode?: Mode; have?: fc.Have; delayMs?: number; flags?: number } = {},
  ) {
    ch.binaryType = 'arraybuffer';
    ch.addEventListener('message', (e) => this.#read(new Uint8Array(e.data as ArrayBuffer)));
    if (o.mode !== 'no-hello') ch.send(fc.encode({ t: 'hello', version: 1, flags: o.flags ?? fc.FLAG_FILES }));
  }
  #read(m: Uint8Array): void {
    let r: fc.Read;
    try {
      r = this.book.read(m);
    } catch (e) {
      this.error = String(e);
      return;
    }
    if (r.t === 'cancelled') {
      this.cancels += 1;
      if (this.#reqs.delete(r.req)) this.open -= 1;
      return;
    }
    if (r.t !== 'request') return;
    if (r.asked.t === 'list') this.lists += 1;
    else this.gets += 1;
    const { req, asked, admit } = r;
    this.open += 1;
    this.#reqs.add(req);
    this.maxOpen = Math.max(this.maxOpen, this.open);
    const answer = (msgs: Uint8Array[]): void => {
      // Cancelled meanwhile: nothing to answer.
      if (!this.#reqs.delete(req)) return;
      this.open -= 1;
      this.book.answered(req);
      for (const x of msgs) if (this.ch.readyState === 'open') this.ch.send(x);
    };
    const mode = this.o.mode ?? 'serve';
    if (mode === 'silent') return;
    setTimeout(() => {
      if (asked.t === 'list') return answer([fc.encode({ t: 'have', req, have: this.o.have ?? { whole: [], part: [] } })]);
      if (asked.t !== 'file') return answer([fc.encode({ t: 'missing', req })]);
      const f = this.files.get(asked.sha);
      if (mode === 'busy') return answer([fc.encode({ t: 'busy', req })]);
      if (mode === 'missing' || f === undefined || admit === 'missing') return answer([fc.encode({ t: 'missing', req })]);
      if (mode === 'corrupt') return answer(fc.dataMessages(req, f.map((x) => x ^ 1)));
      if (mode === 'oversize') return answer(fc.dataMessages(req, new Uint8Array(f.length + 1)));
      answer(fc.dataMessages(req, f));
    }, this.o.delayMs ?? 1);
  }
}

// ---- FilePeer -------------------------------------------------------------------------------
{
  const big = bytes(2 * fc.MAX_DATA + 100, 3);
  const small = bytes(50, 9);
  const files = new Map([
    [sha(big), big],
    [sha(small), small],
  ]);
  const [page, srv] = pair();
  const server = new Server(srv, files, { have: { whole: [1], part: [0] } });
  const p = new FilePeer('a'.repeat(64), page);
  eq('peer: our hello first, setting no bit', [...page.sent[0]!], [4, 1, 0]);
  eq('peer: ready with the server flags', await p.ready, fc.FLAG_FILES);
  const got = await p.get(sha(big), big.length);
  eq('peer: a file over three data messages', got.t === 'file' ? sha(got.bytes) : got.t, sha(big));
  eq('peer: missing', (await p.get('0'.repeat(64), 10)).t, 'missing');
  const have = await p.list('f'.repeat(64));
  eq('peer: have, by index', have.t === 'have' ? have.have : have.t, { whole: [1], part: [0] });
  // Nine at once: never more than eight open on the wire.
  server.maxOpen = 0;
  const nine = await Promise.all(Array.from({ length: 9 }, (_, i) => p.get(String(i).repeat(64), 10)));
  eq('peer: nine asked, all answered', nine.map((a) => a.t), Array(9).fill('missing'));
  eq('peer: at most eight open', server.maxOpen, fc.MAX_OPEN_REQUESTS);
  // One file asked twice at once: the second waits for the first (never two open for one file).
  const twice = await Promise.all([p.get(sha(small), 50), p.get(sha(small), 50)]);
  eq('peer: one file asked twice, answered twice', twice.map((a) => (a.t === 'file' ? sha(a.bytes) : a.t)), [sha(small), sha(small)]);
  eq('peer: the server saw no protocol error', server.error, null);
  p.close();
  eq('peer: closed after close', [p.closed, page.readyState], [true, 'closed']);
  eq('peer: a get after close', (await p.get(sha(small), 50)).t, 'closed');
}
{
  // Cancel: a request whose signal aborts sends cancel and settles cancelled.
  const [page, srv] = pair();
  const server = new Server(srv, new Map(), { mode: 'silent' });
  const p = new FilePeer('b'.repeat(64), page);
  await p.ready;
  const ctl = new AbortController();
  const asked = p.get('2'.repeat(64), 10, ctl.signal);
  await sleep(5);
  ctl.abort();
  eq('peer: cancelled', (await asked).t, 'cancelled');
  await sleep(5);
  eq('peer: the server got cancel', [server.cancels, server.open, p.openRequests], [1, 0, 0]);
  // closeWhenIdle waits for the open request, then closes.
  const pending = p.get('3'.repeat(64), 10);
  await sleep(5);
  p.closeWhenIdle();
  eq('peer: still open with a request open', p.closed, false);
  eq('peer: no new request once told to close', (await p.get('4'.repeat(64), 10)).t, 'closed');
  srv.send(fc.encode({ t: 'missing', req: 2 }));
  eq('peer: the open request is answered', (await pending).t, 'missing');
  eq('peer: then closes', p.closed, true);
}
{
  // More bytes than asked for: the channel closes and onBroken is told.
  const f = bytes(100, 1);
  const [page, srv] = pair();
  new Server(srv, new Map([[sha(f), f]]), { mode: 'oversize' });
  const why: string[] = [];
  const p = new FilePeer('c'.repeat(64), page, (w) => why.push(w));
  await p.ready;
  eq('peer: more than maxBytes', (await p.get(sha(f), 100)).t, 'closed');
  eq('peer: told why', why, ['more than 100 bytes for one file']);
}
{
  // No hello: ready rejects, the channel closes.
  const [page, srv] = pair();
  new Server(srv, new Map(), { mode: 'no-hello' });
  const why: string[] = [];
  const p = new FilePeer('d'.repeat(64), page, (w) => why.push(w), 30);
  let rejected = false;
  await p.ready.catch(() => {
    rejected = true;
  });
  eq('peer: no hello in time', [rejected, p.closed, why], [true, true, ['no hello within 3 s']]);
}
{
  // A channel still connecting: hello goes when it opens. A peer that asks us is answered missing.
  const [page, srv] = pair('connecting');
  const p = new FilePeer('e'.repeat(64), page);
  eq('peer: nothing sent while connecting', page.sent.length, 0);
  page.open();
  srv.open();
  srv.binaryType = 'arraybuffer';
  const answers: number[][] = [];
  srv.addEventListener('message', (e) => answers.push([...new Uint8Array(e.data as ArrayBuffer)]));
  srv.send(fc.encode({ t: 'hello', version: 1, flags: 0 }));
  await p.ready;
  srv.send(fc.encode({ t: 'get', req: 7, sha: '5'.repeat(64) }));
  await sleep(5);
  eq('peer: hello on open, then missing for what it is asked', answers, [[4, 1, 0], [3, 7, 0, 0, 0]]);
  p.close();
}

// ---- FileChannelProvider --------------------------------------------------------------------
const FAST = 100;
const fast = {
  now: () => performance.now() * FAST,
  sleep: (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(done, ms / FAST);
      function done(): void {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    }),
};
const list = bytes(3000, 5);
const root = sha(list);
const init = bytes(400, 6);
const want = (s: string, role = 'init', lastChance = false, rendition: string | null = '720p'): WantLike => ({
  path: `${root}/${s}.mp4`,
  sha256: s,
  role,
  rendition,
  maxBytes: 1 << 20,
  lastChance,
});
const checks = (s: string) => (b: Uint8Array) => sha(b) === s;
const serverFor = (prov: FileChannelProvider, key: string, files: Map<string, Uint8Array>, o: ConstructorParameters<typeof Server>[2] = {}, room: 'stream' | 'video' = 'stream'): Server => {
  const [page, srv] = pair();
  const s = new Server(srv, files, o);
  prov.add(key, page, room);
  return s;
};
const all = new Map([
  [root, list],
  [sha(init), init],
]);
{
  const prov = new FileChannelProvider({ root, ...fast });
  const s1 = serverFor(prov, 'k1', all, { have: { whole: [1], part: [] } });
  await sleep(5);
  const got = await prov.get(want(root, 'hashlist', false, null), checks(root), new AbortController().signal);
  eq('provider: the hash list', got === null ? null : sha(got), root);
  eq('provider: its stats', [prov.stats.files, prov.stats.bytes, prov.ready], [1, list.length, 1]);
  await prov.haveFromAll(1000, new AbortController().signal);
  eq('provider: no levels before the hash list names the indices', prov.levels(['1080p', '720p']), { whole: [], part: [] });
  prov.learnHashList(['1080p', '720p'], new Map());
  eq('provider: levels from have (whole)', prov.levels(['1080p', '720p']), { whole: ['720p'], part: [] });
  eq('provider: only allowed renditions count', prov.levels(['1080p']), { whole: [], part: [] });
  // The cache answers a second ask with no request.
  const before = s1.gets;
  const again = await prov.get(want(root, 'hashlist', false, null), checks(root), new AbortController().signal);
  eq('provider: kept for the session', [again === null ? null : sha(again), s1.gets - before], [root, 0]);
  eq('provider: declines segments', await prov.get(want(sha(init), 'segment'), checks(sha(init)), new AbortController().signal), null);
  prov.destroy();
}
{
  // missing → the next peer; bytes that do not verify drop the peer for the session.
  const dropped: string[] = [];
  const prov = new FileChannelProvider({ root, ...fast, random: () => 0.5, onMismatch: (k) => dropped.push(k) });
  serverFor(prov, 'liar', all, { mode: 'corrupt' });
  serverFor(prov, 'empty', all, { mode: 'missing' });
  serverFor(prov, 'good', all, { delayMs: 20 });
  await sleep(5);
  const got = await prov.get(want(sha(init)), checks(sha(init)), new AbortController().signal);
  eq('provider: the good peer delivers', got === null ? null : sha(got), sha(init));
  eq('provider: the liar is dropped', [dropped, prov.has('liar'), prov.ready], [['liar'], false, 2]);
  prov.destroy();
}
{
  // A peer that sends nothing: another joins after 2 s, it is given up on after 4 s.
  const prov = new FileChannelProvider({ root, ...fast, random: () => 0 });
  const quiet = serverFor(prov, 'quiet', all, { mode: 'silent' });
  await sleep(5);
  const t0 = performance.now();
  const p = prov.get(want(sha(init)), checks(sha(init)), new AbortController().signal);
  await sleep(5);
  serverFor(prov, 'late', all);
  const got = await p;
  const fakeMs = (performance.now() - t0) * FAST;
  eq('provider: a second peer joins the stalled request', got === null ? null : sha(got), sha(init));
  eq('provider: after about 2 s, not 4', fakeMs >= 1500 && fakeMs < 4000, true);
  eq('provider: the stalled request is cancelled', quiet.cancels, 1);
  prov.destroy();
}
{
  // No peer: a tier that is not the last hands on after the first-peer wait; the last one waits.
  const prov = new FileChannelProvider({ root, ...fast, firstPeerWaitMs: 2000 });
  const t0 = performance.now();
  eq('provider: no peer, not the last tier', await prov.get(want(sha(init)), checks(sha(init)), new AbortController().signal), null);
  eq('provider: after the first-peer wait', (performance.now() - t0) * FAST >= 1500, true);
  eq('provider: then at once', await prov.get(want(sha(init)), checks(sha(init)), new AbortController().signal), null);
  const asked = prov.get(want(sha(init), 'init', true), checks(sha(init)), new AbortController().signal);
  await sleep(10);
  eq('provider: the last tier wants it', prov.wanting, true);
  serverFor(prov, 'k', all);
  const got = await asked;
  eq('provider: the last tier waits for a peer', got === null ? null : sha(got), sha(init));
  eq('provider: and wants nothing after', prov.wanting, false);
  prov.destroy();
}
{
  // part only when no peer names a rendition whole; a have that lies is ignored after missing.
  const prov = new FileChannelProvider({ root, ...fast, random: () => 0 });
  serverFor(prov, 'p', new Map(), { have: { whole: [], part: [1] } });
  serverFor(prov, 'q', all, { have: { whole: [], part: [0] } });
  serverFor(prov, 'r', new Map(), { have: { whole: [2, 7], part: [] } });
  await sleep(5);
  await prov.haveFromAll(1000, new AbortController().signal);
  prov.learnHashList(['360p', '480p', '720p'], new Map());
  eq('provider: levels from part (a have past the list is ignored)', prov.levels(['360p', '480p', '720p']), { whole: [], part: ['360p', '480p'] });
  const got = await prov.get(want(sha(init), 'init', false, '480p'), checks(sha(init)), new AbortController().signal);
  eq('provider: p named 480p but has nothing; q delivers', got === null ? null : sha(got), sha(init));
  eq('provider: p has its have ignored', prov.levels(['360p', '480p', '720p']), { whole: [], part: ['360p'] });
  prov.destroy();
}
{
  // A stream-room channel replaces a video-room one, which closes once idle; the sweep closes
  // a video-room channel idle for 30 s.
  const prov = new FileChannelProvider({ root, ...fast });
  const [vpage, vsrv] = pair();
  new Server(vsrv, all);
  prov.add('k', vpage, 'video');
  await sleep(5);
  const [spage, ssrv] = pair();
  new Server(ssrv, all);
  prov.add('k', spage, 'stream');
  await sleep(5);
  eq('provider: the video-room channel closed, the stream one held', [vpage.readyState, spage.readyState, prov.has('k')], ['closed', 'open', true]);
  const [xpage, xsrv] = pair();
  new Server(xsrv, all);
  prov.add('k', xpage, 'video');
  eq('provider: a second channel to a held stream peer is closed', xpage.readyState, 'closed');
  const [ipage, isrv] = pair();
  new Server(isrv, all);
  prov.add('idle', ipage, 'video');
  await sleep(5);
  prov.sweep();
  eq('provider: a fresh video-room channel survives the sweep', ipage.readyState, 'open');
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    prov.sweep();
  } finally {
    Date.now = realNow;
  }
  eq('provider: an idle one does not', [ipage.readyState, prov.has('idle'), spage.readyState], ['closed', false, 'open']);
  prov.destroy();
  eq('provider: destroy closes every channel', spage.readyState, 'closed');
}

console.log(`files: ${ran - bad}/${ran} ok`);
process.exit(bad === 0 ? 0 : 1);
