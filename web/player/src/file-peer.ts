/**
 * One peer's file channel (NFX-10 §6.10), the requester's side: a page that asks a peer for
 * start-up files over an `nfx-files/1` data channel, and answers nothing (its `hello` sets no
 * bit, so a compliant peer asks it nothing; a peer that asks anyway gets `missing`).
 *
 * - Our `hello` goes when the channel opens (at once if it is open already). `ready` settles
 *   once the peer's `hello` has come (with its flags), or rejects 3 s after the opening
 *   without one, closing the channel.
 * - `get` / `list` each open one request (at most 8 at once, and one file never asked twice at
 *   once: more wait their turn) and settle
 *   with the answer: the file's bytes, which the caller verifies; `have`; or `missing` /
 *   `busy`. A peer that sends more than `maxBytes` for a file, a `data` for no open request
 *   of ours, or anything `file-channel.ts` refuses has broken the protocol: the channel
 *   closes, every open request settles `closed`, and `onBroken` is told.
 * - `progress` is told of every byte, so the caller can give up on a peer that has gone
 *   quiet (the choosing of peers is the provider's, ./file-provider.ts).
 * - Aborting a request's signal sends `cancel` and settles it `cancelled`.
 * - `closeWhenIdle` closes the channel once no request is open or waiting (at once if none
 *   is), so a channel being replaced finishes what it carries.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as fc from './file-channel';

/** What a `FilePeer` needs of an `RTCDataChannel` (tests pass a stand-in). */
export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: 'message', f: (e: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close' | 'error', f: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'message', f: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'open' | 'close' | 'error', f: () => void): void;
}

export type Answer =
  | { readonly t: 'file'; readonly bytes: Uint8Array }
  | { readonly t: 'have'; readonly have: fc.Have }
  | { readonly t: 'missing' }
  | { readonly t: 'busy' }
  | { readonly t: 'cancelled' }
  | { readonly t: 'closed' };

interface Pending {
  readonly kind: 'get' | 'list';
  /** The file asked for (a `get`), which no second open request may ask for. */
  readonly sha: string | null;
  readonly maxBytes: number;
  readonly parts: Uint8Array[];
  got: number;
  readonly settle: (a: Answer) => void;
  readonly progress: ((bytes: number) => void) | undefined;
}

interface Waiting {
  readonly message: (req: number) => fc.Message;
  readonly pending: Omit<Pending, 'parts' | 'got'>;
  readonly signal: AbortSignal | undefined;
}

export class FilePeer {
  readonly ready: Promise<number>;
  readonly #ch: DataChannelLike;
  readonly #book = new fc.Channel();
  readonly #open = new Map<number, Pending>();
  readonly #openShas = new Set<string>();
  readonly #waiting: Waiting[] = [];
  #nextReq = 1;
  #closed = false;
  #closeWhenIdle = false;
  /** When we last asked or were answered (ms, `Date.now()`), or when the channel came. */
  lastActivity = Date.now();
  #onHello: (flags: number) => void = () => {};
  #helloTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #onMessage = (e: { data: unknown }): void => this.#read(e.data);
  readonly #onClose = (): void => this.#end(null);
  readonly #onOpen = (): void => this.#start();
  readonly #helloTimeoutMs: number;
  #reject: (e: Error) => void = () => {};

  constructor(
    /** The peer's session key. */
    readonly peer: string,
    channel: DataChannelLike,
    /** Told once when the peer breaks the protocol (a mismatch is the caller's to report). */
    readonly onBroken: (why: string) => void = () => {},
    helloTimeoutMs = fc.HELLO_TIMEOUT_MS,
  ) {
    this.#ch = channel;
    this.#helloTimeoutMs = helloTimeoutMs;
    channel.binaryType = 'arraybuffer';
    this.ready = new Promise<number>((resolve, reject) => {
      this.#onHello = resolve;
      this.#reject = reject;
    });
    this.ready.catch(() => {}); // a caller that never awaits it is not left an unhandled rejection
    channel.addEventListener('message', this.#onMessage);
    channel.addEventListener('close', this.#onClose);
    channel.addEventListener('error', this.#onClose);
    if (channel.readyState === 'open') this.#start();
    else if (channel.readyState === 'connecting') channel.addEventListener('open', this.#onOpen, { once: true });
    else this.#end(null);
  }

  /** The channel is open: our `hello`, and the peer's has 3 s. */
  #start(): void {
    if (this.#closed) return;
    this.#helloTimer = setTimeout(() => this.#end('no hello within 3 s'), this.#helloTimeoutMs);
    this.#send({ t: 'hello', version: fc.VERSION, flags: 0 });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The flags of the peer's `hello`, once it has come. */
  get flags(): number | null {
    return this.#book.peerFlags;
  }

  /** Requests open with the peer now. */
  get openRequests(): number {
    return this.#open.size;
  }

  /** Ask for the file `sha` (the manifest's root asks for the hash list), at most `maxBytes`. */
  get(sha: string, maxBytes: number, signal?: AbortSignal, progress?: (bytes: number) => void): Promise<Answer> {
    return this.#ask((req) => ({ t: 'get', req, sha }), 'get', sha, maxBytes, signal, progress);
  }

  /** Ask which renditions of hash list `root` the peer holds. */
  list(root: string, signal?: AbortSignal): Promise<Answer> {
    return this.#ask((req) => ({ t: 'list', req, root }), 'list', null, 0, signal, undefined);
  }

  /** Requests open or waiting. */
  get busy(): boolean {
    return this.#open.size > 0 || this.#waiting.length > 0;
  }

  /** Close the channel; every open request settles `closed`. */
  close(): void {
    this.#end(null);
  }

  /** Close the channel once no request is open or waiting. */
  closeWhenIdle(): void {
    this.#closeWhenIdle = true;
    if (!this.busy) this.#end(null);
  }

  #ask(
    message: (req: number) => fc.Message,
    kind: Pending['kind'],
    sha: string | null,
    maxBytes: number,
    signal: AbortSignal | undefined,
    progress: ((bytes: number) => void) | undefined,
  ): Promise<Answer> {
    if (this.#closed || this.#closeWhenIdle) return Promise.resolve({ t: 'closed' });
    if (signal?.aborted) return Promise.resolve({ t: 'cancelled' });
    this.lastActivity = Date.now();
    return new Promise<Answer>((resolve) => {
      const w: Waiting = { message, pending: { kind, sha, maxBytes, settle: resolve, progress }, signal };
      this.#waiting.push(w);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.#waiting.indexOf(w);
          if (i >= 0) {
            this.#waiting.splice(i, 1);
            resolve({ t: 'cancelled' });
            this.#idle();
          }
        },
        { once: true },
      );
      this.#pump();
    });
  }

  /** A channel told to close when idle closes now if it is. */
  #idle(): void {
    if (this.#closeWhenIdle && !this.busy) this.#end(null);
  }

  /** Send waiting requests while fewer than 8 are open and the peer's `hello` has come. */
  #pump(): void {
    if (this.#closed || this.#book.peerFlags === null) return;
    this.#idle();
    if (this.#closed) return;
    while (this.#open.size < fc.MAX_OPEN_REQUESTS) {
      // The first waiting request whose file is not asked for already.
      const i = this.#waiting.findIndex((x) => x.pending.sha === null || !this.#openShas.has(x.pending.sha));
      if (i < 0) break;
      const w = this.#waiting.splice(i, 1)[0]!;
      if (w.signal?.aborted) continue;
      const req = this.#nextReq++;
      const p: Pending = { ...w.pending, parts: [], got: 0 };
      this.#open.set(req, p);
      if (p.sha !== null) this.#openShas.add(p.sha);
      w.signal?.addEventListener(
        'abort',
        () => {
          if (this.#open.get(req) !== p) return;
          this.#settled(req, p);
          this.#send({ t: 'cancel', req });
          p.settle({ t: 'cancelled' });
          this.#pump();
        },
        { once: true },
      );
      this.#send(w.message(req));
    }
  }

  #send(m: fc.Message): void {
    if (this.#closed) return;
    try {
      this.#ch.send(fc.encode(m) as Uint8Array<ArrayBuffer>);
    } catch {
      this.#end(null);
    }
  }

  #read(data: unknown): void {
    if (this.#closed) return;
    if (!(data instanceof ArrayBuffer)) {
      this.#end('a message that is not binary');
      return;
    }
    let r: fc.Read;
    try {
      r = this.#book.read(new Uint8Array(data));
    } catch (e) {
      this.#end(e instanceof Error ? e.message : String(e));
      return;
    }
    switch (r.t) {
      case 'hello':
        if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer);
        this.#onHello(r.flags);
        this.#pump();
        return;
      case 'request':
        // We answer nothing (our hello said so): `missing`, at once.
        if (r.admit === 'serve') this.#book.answered(r.req);
        this.#send({ t: 'missing', req: r.req });
        return;
      case 'cancelled':
        return;
      case 'answer':
        this.#answer(r.message);
    }
  }

  #answer(m: fc.Message): void {
    if (!('req' in m)) return;
    const p = this.#open.get(m.req);
    // An answer for a request that is not open may have crossed our `cancel`.
    if (p === undefined) return;
    this.lastActivity = Date.now();
    const done = (a: Answer): void => {
      this.#settled(m.req, p);
      p.settle(a);
      this.#pump();
    };
    switch (m.t) {
      case 'data':
        if (p.kind !== 'get') return this.#end('data for a list');
        p.got += m.bytes.length;
        if (p.got > p.maxBytes) return this.#end(`more than ${p.maxBytes} bytes for one file`);
        // The message's buffer belongs to this event: keep a copy.
        p.parts.push(m.bytes.slice());
        p.progress?.(m.bytes.length);
        return;
      case 'end': {
        if (p.kind !== 'get') return this.#end('end for a list');
        const bytes = new Uint8Array(p.got);
        let at = 0;
        for (const part of p.parts) {
          bytes.set(part, at);
          at += part.length;
        }
        return done({ t: 'file', bytes });
      }
      case 'have':
        if (p.kind !== 'list') return this.#end('have for a get');
        return done({ t: 'have', have: m.have });
      case 'missing':
        return done({ t: 'missing' });
      case 'busy':
        return done({ t: 'busy' });
      default:
        return this.#end(`${m.t} from a server`);
    }
  }

  /** Request `req` is no longer open. */
  #settled(req: number, p: Pending): void {
    this.#open.delete(req);
    if (p.sha !== null) this.#openShas.delete(p.sha);
  }

  /** Close for good: `why` is a protocol error (told to `onBroken`), null a plain close. */
  #end(why: string | null): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer);
    this.#ch.removeEventListener('message', this.#onMessage);
    this.#ch.removeEventListener('close', this.#onClose);
    this.#ch.removeEventListener('error', this.#onClose);
    this.#ch.removeEventListener('open', this.#onOpen);
    // `ready` that never settled: settled now (a no-op once it has).
    this.#reject(new Error(why ?? 'closed'));
    try {
      this.#ch.close();
    } catch {
      // closed already
    }
    for (const p of this.#open.values()) p.settle({ t: 'closed' });
    this.#open.clear();
    this.#openShas.clear();
    for (const w of this.#waiting.splice(0)) w.pending.settle({ t: 'closed' });
    if (why !== null) {
      try {
        this.onBroken(why);
      } catch (e) {
        globalThis.reportError?.(e);
      }
    }
  }
}
