/**
 * The file channel (NFX-10 §6.10): a WebRTC data channel labelled `nfx-files/1` that carries a
 * video's start-up files (hash list, playlists, init segments, thumbnails, subtitles) between
 * peers, so a page can start with no origin. Media segments never travel on it.
 *
 * This module is the wire only, the same rules as nfx-proto's `file_channel` (both read
 * `spec/test-vectors/file-channel.json`): `decode` refuses every length and type the section
 * does not allow and `encode` writes exactly what `decode` takes; `Channel` reads one side of a
 * channel (the peer's `hello` first and once, its requests counted). Verifying a file's bytes
 * is the caller's (NFX-05 §§4–5), as is every NFX-03 check of a beacon (file-beacons.ts).
 */

export const LABEL = 'nfx-files/1';
export const VERSION = 1;
/** `hello` flag bit 0: the sender answers `get` and `list`. */
export const FLAG_FILES = 1;
/** `hello` flag bit 1: the sender answers `beacons`. */
export const FLAG_BEACONS = 2;
export const MAX_MESSAGE = 16_384;
export const MAX_DATA = MAX_MESSAGE - 5;
export const MAX_OPEN_REQUESTS = 8;
export const MAX_ANSWERS_PER_FILE = 2;
export const MIN_HAVE_JSON = 2;
export const MAX_HAVE_JSON = 2_048;
export const MAX_HAVE_IDS = 32;
/** The smallest peer `max-message-size` (RFC 8841 §6) the channel runs over: the longest `have` with its header. */
export const MIN_PEER_MESSAGE = 5 + MAX_HAVE_JSON;
export const MAX_BEACONS = 4;
export const MAX_BEACON_BYTES = 16_384;
export const MAX_BEACONS_ANSWER = 65_536;
export const MAX_HASH_LIST = 16 * 1024 * 1024;
/** The most `data` bytes a server queues per channel ahead of the transport (`bufferedAmount`). */
export const MAX_QUEUED = 256 * 1024;
export const HELLO_TIMEOUT_MS = 3_000;

export const TYPES = ['get', 'data', 'end', 'missing', 'hello', 'cancel', 'busy', 'list', 'have', 'beacons'] as const;

/**
 * Which renditions of a hash list a server holds, each named by its index in the hash list's
 * `renditions` (0 for the first): distinct, below `MAX_HAVE_IDS`, none in both. Whether an index
 * is below that hash list's length is the reader's to check (`haveFits`).
 */
export interface Have {
  readonly whole: readonly number[];
  readonly part: readonly number[];
}

export type Message =
  | { readonly t: 'get'; readonly req: number; readonly sha: string }
  | { readonly t: 'data'; readonly req: number; readonly bytes: Uint8Array }
  | { readonly t: 'end'; readonly req: number }
  | { readonly t: 'missing'; readonly req: number }
  | { readonly t: 'hello'; readonly version: number; readonly flags: number }
  | { readonly t: 'cancel'; readonly req: number }
  | { readonly t: 'busy'; readonly req: number }
  | { readonly t: 'list'; readonly req: number; readonly root: string }
  | { readonly t: 'have'; readonly req: number; readonly have: Have }
  | { readonly t: 'beacons'; readonly req: number };

/** A protocol error: the receiver closes the channel (and a video-room connection with it). */
export class FileChannelError extends Error {
  override readonly name = 'FileChannelError';
}

const fail = (why: string): never => {
  throw new FileChannelError(`file channel: ${why}`);
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += HEX[x];
  return s;
};
const fromHex32 = (h: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/.test(h)) fail('a sha256 that is not 64 lowercase hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

function exactly(body: number, n: number, name: string): void {
  if (body !== n) fail(`\`${name}\` is ${body} bytes after its type, not ${n}`);
}

function checkHave(have: Have): void {
  const seen = new Set<number>();
  for (const i of [...have.whole, ...have.part]) {
    if (!isIndex(i)) fail(`\`have\` holds something other than an index below ${MAX_HAVE_IDS}`);
    if (seen.has(i)) fail(`\`have\` names rendition ${i} twice`);
    seen.add(i);
  }
}

/** A number with an integer value 0 to 31 (`1.0` parses as 1, as it does for every JSON reader). */
function isIndex(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < MAX_HAVE_IDS;
}

/** Whether every index of `have` names a rendition of a hash list with `renditions` renditions. */
export function haveFits(have: Have, renditions: number): boolean {
  return [...have.whole, ...have.part].every((i) => i < renditions);
}

/** Read a `have` body. Members other than `whole` and `part` are ignored. */
export function parseHave(json: Uint8Array): Have {
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8.decode(json));
  } catch {
    return fail('`have` is not JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail('`have` is not an object');
  const list = (key: string): number[] => {
    const a = (v as Record<string, unknown>)[key];
    if (!Array.isArray(a)) return fail(`\`have\` has no \`${key}\` array`);
    for (const x of a) if (!isIndex(x)) fail(`\`have\` \`${key}\` holds something other than an index below ${MAX_HAVE_IDS}`);
    return (a as number[]).map((x) => (x === 0 ? 0 : x)); // -0 reads as 0
  };
  const have = { whole: list('whole'), part: list('part') };
  checkHave(have);
  return have;
}

/** The body a server sends: `{"whole":[…],"part":[…]}`, compact. */
export function haveJson(have: Have): Uint8Array {
  checkHave(have);
  const b = utf8.encode(JSON.stringify({ whole: have.whole, part: have.part }));
  if (b.length > MAX_HAVE_JSON) fail(`\`have\` of ${b.length} bytes`);
  return b;
}

/** Read one data-channel message. Throws `FileChannelError` for anything the section refuses. */
export function decode(msg: Uint8Array): Message {
  if (msg.length === 0) return fail('an empty message');
  if (msg.length > MAX_MESSAGE) return fail(`a message of ${msg.length} bytes`);
  const t = msg[0]!;
  const body = msg.length - 1;
  const req = (): number => (msg[1]! | (msg[2]! << 8) | (msg[3]! << 16) | (msg[4]! << 24)) >>> 0;
  const sha = (): string => toHex(msg.subarray(5, 37));
  switch (t) {
    case 0:
      exactly(body, 36, 'get');
      return { t: 'get', req: req(), sha: sha() };
    case 1:
      if (body < 5) fail('`data` carries no byte');
      return { t: 'data', req: req(), bytes: msg.subarray(5) };
    case 2:
      exactly(body, 4, 'end');
      return { t: 'end', req: req() };
    case 3:
      exactly(body, 4, 'missing');
      return { t: 'missing', req: req() };
    case 4:
      exactly(body, 2, 'hello');
      if (msg[1] !== VERSION) fail(`\`hello\` of version ${msg[1]}`);
      return { t: 'hello', version: msg[1]!, flags: msg[2]! };
    case 5:
      exactly(body, 4, 'cancel');
      return { t: 'cancel', req: req() };
    case 6:
      exactly(body, 4, 'busy');
      return { t: 'busy', req: req() };
    case 7:
      exactly(body, 36, 'list');
      return { t: 'list', req: req(), root: sha() };
    case 8:
      if (body < 4 + MIN_HAVE_JSON || body > 4 + MAX_HAVE_JSON) fail(`\`have\` JSON of ${Math.max(0, body - 4)} bytes`);
      return { t: 'have', req: req(), have: parseHave(msg.subarray(5)) };
    case 9:
      exactly(body, 4, 'beacons');
      return { t: 'beacons', req: req() };
    default:
      return fail(`unknown type ${t}`);
  }
}

function withReq(t: number, req: number, rest: Uint8Array | null): Uint8Array {
  if (!Number.isInteger(req) || req < 0 || req > 0xffff_ffff) fail(`req ${req} is not a u32`);
  const out = new Uint8Array(5 + (rest?.length ?? 0));
  out[0] = t;
  new DataView(out.buffer).setUint32(1, req, true);
  if (rest) out.set(rest, 5);
  return out;
}

/** Write a message. Refuses what `decode` would refuse. */
export function encode(m: Message): Uint8Array {
  switch (m.t) {
    case 'get':
      return withReq(0, m.req, fromHex32(m.sha));
    case 'data':
      if (m.bytes.length === 0 || m.bytes.length > MAX_DATA) fail(`\`data\` of ${m.bytes.length} bytes`);
      return withReq(1, m.req, m.bytes);
    case 'end':
      return withReq(2, m.req, null);
    case 'missing':
      return withReq(3, m.req, null);
    case 'hello':
      if (m.version !== VERSION) fail(`\`hello\` of version ${m.version}`);
      return Uint8Array.of(4, VERSION, m.flags & 0xff);
    case 'cancel':
      return withReq(5, m.req, null);
    case 'busy':
      return withReq(6, m.req, null);
    case 'list':
      return withReq(7, m.req, fromHex32(m.root));
    case 'have':
      return withReq(8, m.req, haveJson(m.have));
    case 'beacons':
      return withReq(9, m.req, null);
  }
}

/** A file's bytes as the `data` messages that carry it, in order, then its `end`. */
export function dataMessages(req: number, file: Uint8Array): Uint8Array[] {
  if (file.length === 0) fail('an empty file');
  const out: Uint8Array[] = [];
  for (let i = 0; i < file.length; i += MAX_DATA) out.push(encode({ t: 'data', req, bytes: file.subarray(i, i + MAX_DATA) }));
  out.push(encode({ t: 'end', req }));
  return out;
}

/** A signed Nostr event, as NIP-01 sends it. */
export interface NostrEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/** NFX-17 §1.2's compact form: the members in NIP-01 order, no whitespace. */
export function compactEvent(e: NostrEvent): string {
  return JSON.stringify({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });
}

/** A `beacons` answer: 1 to 4 kind-20464 events as one JSON array of their compact forms. */
export function beaconsAnswer(beacons: readonly NostrEvent[]): Uint8Array {
  if (beacons.length === 0 || beacons.length > MAX_BEACONS) fail(`a \`beacons\` answer of ${beacons.length} events`);
  const parts = beacons.map((e) => {
    if (e.kind !== 20464) fail('a `beacons` answer holds an event that is not a beacon');
    const one = compactEvent(e);
    if (utf8.encode(one).length > MAX_BEACON_BYTES) fail(`a beacon of ${one.length} characters`);
    return one;
  });
  const all = utf8.encode(`[${parts.join(',')}]`);
  if (all.length > MAX_BEACONS_ANSWER) fail(`a \`beacons\` answer of ${all.length} bytes`);
  return all;
}

const isU = (x: unknown, max: number): boolean => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= max;

/** Every NIP-01 member, of its type (as nfx-proto's `Event` takes it: `kind` a u16). */
function isEventShape(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pubkey === 'string' &&
    isU(o.created_at, Number.MAX_SAFE_INTEGER) &&
    isU(o.kind, 0xffff) &&
    Array.isArray(o.tags) &&
    o.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string')) &&
    typeof o.content === 'string' &&
    typeof o.sig === 'string'
  );
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Read a `beacons` answer: its events, in order, before any NFX-03 check. Refuses what
 * `beaconsAnswer` would not write, so every reader takes the same bytes as the same events.
 */
export function readBeaconsAnswer(bytes: Uint8Array): NostrEvent[] {
  if (bytes.length > MAX_BEACONS_ANSWER) fail(`a \`beacons\` answer of ${bytes.length} bytes`);
  let v: unknown;
  try {
    v = JSON.parse(fromUtf8.decode(bytes));
  } catch {
    return fail('a `beacons` answer is not JSON');
  }
  if (!Array.isArray(v)) return fail('a `beacons` answer is not an array');
  const events = v as NostrEvent[];
  for (const e of events) if (!isEventShape(e)) fail('a `beacons` answer holds a non-event');
  if (!sameBytes(beaconsAnswer(events), bytes)) fail('a `beacons` answer is not in its compact form');
  return events;
}

export type Asked = { readonly t: 'file'; readonly sha: string } | { readonly t: 'list'; readonly root: string } | { readonly t: 'beacons' };

/** What `Channel.read` gives. */
export type Read =
  | { readonly t: 'hello'; readonly flags: number }
  | { readonly t: 'request'; readonly req: number; readonly asked: Asked; readonly admit: 'serve' | 'missing' }
  | { readonly t: 'cancelled'; readonly req: number; readonly wasOpen: boolean }
  | { readonly t: 'answer'; readonly message: Message };

/**
 * One side's reading of a channel: the peer's `hello` first and once; its requests, at most
 * eight open, no `req` open twice, no file asked twice at once, and a file answered at most
 * twice (a third `get` is admitted as `missing`). Every throw is a protocol error.
 */
export class Channel {
  #peerFlags: number | null = null;
  readonly #open = new Map<number, Asked>();
  readonly #answered = new Map<string, number>();

  read(bytes: Uint8Array): Read {
    const m = decode(bytes);
    if (m.t === 'hello') {
      if (this.#peerFlags !== null) fail('a second `hello`');
      this.#peerFlags = m.flags & (FLAG_FILES | FLAG_BEACONS);
      return { t: 'hello', flags: this.#peerFlags };
    }
    if (this.#peerFlags === null) fail('a message before `hello`');
    let asked: Asked;
    switch (m.t) {
      case 'get':
        asked = { t: 'file', sha: m.sha };
        break;
      case 'list':
        asked = { t: 'list', root: m.root };
        break;
      case 'beacons':
        asked = { t: 'beacons' };
        break;
      case 'cancel':
        return { t: 'cancelled', req: m.req, wasOpen: this.#open.delete(m.req) };
      default:
        return { t: 'answer', message: m };
    }
    if (this.#open.has(m.req)) fail(`request ${m.req} is already open`);
    if (this.#open.size >= MAX_OPEN_REQUESTS) fail(`more than ${MAX_OPEN_REQUESTS} open requests`);
    if (asked.t === 'file') {
      const sha = asked.sha;
      for (const a of this.#open.values()) if (a.t === 'file' && a.sha === sha) fail('two open requests for one file');
      const n = this.#answered.get(sha) ?? 0;
      if (n >= MAX_ANSWERS_PER_FILE) return { t: 'request', req: m.req, asked, admit: 'missing' };
      this.#answered.set(sha, n + 1);
    }
    this.#open.set(m.req, asked);
    return { t: 'request', req: m.req, asked, admit: 'serve' };
  }

  /** The flags of the peer's `hello`, once it has arrived. */
  get peerFlags(): number | null {
    return this.#peerFlags;
  }

  /** We sent our last answer to `req`. Whether it was open. */
  answered(req: number): boolean {
    return this.#open.delete(req);
  }

  get openCount(): number {
    return this.#open.size;
  }
}
