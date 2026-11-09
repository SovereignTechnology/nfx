/**
 * Signaling over Nostr (NFX-10 §6): how mesh peers find each other and exchange WebRTC
 * offers and answers through ordinary Nostr relays, with no tracker and no TURN.
 *
 * - `NostrSignaler`, one per `open()` session: a fresh random session key (never a user's),
 *   the relay sockets (`RelayPool`), and `factory`, which p2p-media-loader calls once per
 *   stream swarm through `signalingClientFactory` (the hook web/player/engine adds).
 * - `RoomClient`, one per stream swarm: joins the swarm's room, announces presence every
 *   30 s, and negotiates peer connections: the lower session key offers (NFX-10 §6.6), each
 *   SDP complete (ICE gathering finished) and NIP-44 encrypted to its receiver. It claims a
 *   peer from the engine before negotiating and reports each peer connected or failed, so
 *   the engine keeps its peer de-duplication and limits.
 *
 * Every event is built, signed, checked and decrypted by nfx-proto in WASM (MeshSession,
 * MeshRoom), the same code native peers use. Every event is signed when it is sent: stock
 * relays refuse ephemeral events older than about 60 s. Relays and events are untrusted:
 * everything a stranger can make this hold is bounded (`LIMITS`).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { PeerConnectError } from 'p2p-media-loader-core';

import { MeshRoom, MeshSession } from '../out/wasm/nfx_wasm.js';

import {
  LIMITS,
  OfferBackoff,
  PresenceBook,
  SeenIds,
  SenderLimiter,
  eventHead,
  eventId,
  nowSeconds,
  offersTo,
  overBytes,
} from './signal-book';

export { LIMITS, PresenceBook, SeenIds, SenderLimiter, eventId, nowSeconds, offersTo };

/** NFX-10 §6 constants the library uses (nfx-proto holds the same). */
export const PRESENCE_INTERVAL_MS = 30_000;
export const KIND_SIGNAL = 25050;
export const PROTOCOL = 'nfx-mesh/1';
const FRESH_SECONDS = 60;
const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A socket must stay open this long before its reconnect backoff starts over. */
const RECONNECT_STABLE_MS = 30_000;
/** At most this many relay notices logged per socket per minute. */
const LOG_PER_MINUTE = 6;
/** On close, how long a socket waits for the relay to acknowledge (OK) what it sent last. */
const CLOSE_GRACE_MS = 2_000;

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---- relays --------------------------------------------------------------------------------

type Filter = () => Record<string, unknown>;

interface Sub {
  filter: Filter;
  onEvent: (eventJson: string) => void;
}

/** One relay's socket, opened while any subscription needs it, reopened with backoff. */
class RelaySocket {
  #ws: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #backoff = RECONNECT_MIN_MS;
  #openedAt = 0;
  #closed = false;
  #logged = { minute: 0, count: 0 };
  /** Ids of events sent on this socket that the relay has not acknowledged yet (at most a few). */
  readonly #unacked = new Set<string>();
  #finish: (() => void) | null = null;

  constructor(
    readonly url: string,
    private readonly pool: RelayPool,
  ) {}

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  ensure(): void {
    if (this.#closed || this.#ws !== null || this.#timer !== null) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.pool.log(`relay ${this.url}: ${message(e)}`);
      this.#retry();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#openedAt = Date.now();
      for (const [id, sub] of this.pool.subs) this.send(['REQ', id, sub.filter()]);
      this.pool.opened(this);
    };
    ws.onmessage = (m: MessageEvent) => {
      const text = typeof m.data === 'string' ? m.data : '';
      if (text.length === 0 || overBytes(text, LIMITS.maxMessage)) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'OK' && typeof msg[1] === 'string' && this.#unacked.delete(msg[1]) && this.#unacked.size === 0) {
        this.#finish?.();
      }
      if (this.#closed) return;
      if (msg[0] === 'EVENT' && typeof msg[1] === 'string' && msg[2] !== null && typeof msg[2] === 'object') {
        this.pool.subs.get(msg[1])?.onEvent(JSON.stringify(msg[2]));
      } else if (msg[0] === 'OK' && msg[2] === false && typeof msg[1] === 'string' && this.pool.sentRecently(msg[1])) {
        this.#log(`relay ${this.url} refused an event: ${String(msg[3] ?? '').slice(0, 200)}`);
      } else if (msg[0] === 'CLOSED' && typeof msg[1] === 'string' && this.pool.subs.has(msg[1])) {
        this.#log(`relay ${this.url} closed a subscription: ${String(msg[2] ?? '').slice(0, 200)}`);
      }
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      // A relay that accepts and drops at once is retried with a growing wait, not every second.
      if (this.#openedAt !== 0 && Date.now() - this.#openedAt >= RECONNECT_STABLE_MS) this.#backoff = RECONNECT_MIN_MS;
      this.#openedAt = 0;
      this.#retry();
    };
    ws.onerror = () => {
      // onclose follows
    };
  }

  #log(m: string): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#logged.minute !== minute) this.#logged = { minute, count: 0 };
    if (++this.#logged.count <= LOG_PER_MINUTE) this.pool.log(m);
  }

  #retry(): void {
    if (this.#closed || this.pool.subs.size === 0) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.ensure();
    }, wait);
  }

  send(msg: unknown[]): boolean {
    if (!this.open || this.#closed) return false;
    try {
      this.#ws!.send(JSON.stringify(msg));
    } catch {
      return false;
    }
    const id = msg[0] === 'EVENT' ? (msg[1] as { id?: unknown } | null)?.id : undefined;
    if (typeof id === 'string') {
      this.#unacked.add(id);
      if (this.#unacked.size > 16) this.#unacked.delete(this.#unacked.values().next().value as string);
    }
    return true;
  }

  /**
   * Close for good. Sends nothing more; an open socket first waits (at most CLOSE_GRACE_MS)
   * for the relay to acknowledge what it sent last, such as a room's `disconnect`, so that is
   * not lost to the close.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const ws = this.#ws;
    const finish = (): void => {
      this.#finish = null;
      if (grace !== null) clearTimeout(grace);
      this.#ws = null;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // closing anyway
        }
      }
    };
    let grace: ReturnType<typeof setTimeout> | null = null;
    if (ws !== null && ws.readyState === WebSocket.OPEN && this.#unacked.size > 0) {
      ws.onopen = null;
      ws.onclose = finish;
      this.#finish = finish;
      grace = setTimeout(finish, CLOSE_GRACE_MS);
    } else {
      finish();
    }
  }
}

/** The session's relays: one socket each, shared by its rooms; events go to all of them. */
export class RelayPool {
  readonly subs = new Map<string, Sub>();
  readonly #sockets: RelaySocket[];
  readonly #onOpen = new Set<(send: (eventJson: string) => void) => void>();
  /** Ids of the events this session sent lately, so only refusals of ours are logged. */
  readonly #sent = new Set<string>();
  #seq = 0;
  #destroyed = false;

  constructor(
    relays: readonly string[],
    readonly log: (m: string) => void,
  ) {
    this.#sockets = relays.map((url) => new RelaySocket(url, this));
  }

  /** Subscribe on every relay; `filter` is evaluated at each REQ (so `since` stays fresh). */
  subscribe(
    filter: Filter,
    onEvent: (eventJson: string) => void,
    onOpen: (send: (eventJson: string) => void) => void,
  ): () => void {
    if (this.#destroyed) return () => {};
    const id = `nfx-mesh-${++this.#seq}`;
    this.subs.set(id, { filter, onEvent });
    this.#onOpen.add(onOpen);
    for (const s of this.#sockets) {
      if (s.open) s.send(['REQ', id, filter()]);
      else s.ensure();
    }
    return () => {
      if (!this.subs.delete(id)) return;
      this.#onOpen.delete(onOpen);
      for (const s of this.#sockets) s.send(['CLOSE', id]);
      if (this.subs.size === 0) this.#closeSockets();
    };
  }

  /** A socket (re)opened: each room may send its presence to that socket alone. */
  opened(socket: RelaySocket): void {
    const send = (eventJson: string): void => {
      const event = this.#parse(eventJson);
      if (event !== null) socket.send(['EVENT', event]);
    };
    for (const f of [...this.#onOpen]) f(send);
  }

  sentRecently(id: string): boolean {
    return this.#sent.has(id);
  }

  #parse(eventJson: string): { id?: unknown } | null {
    try {
      const event = JSON.parse(eventJson) as { id?: unknown };
      if (typeof event.id === 'string') {
        this.#sent.add(event.id);
        if (this.#sent.size > 64) this.#sent.delete(this.#sent.values().next().value as string);
      }
      return event;
    } catch {
      return null;
    }
  }

  /** Send a signed event to every open relay; how many took it. Never queued (NFX-10 §6.4). */
  publish(eventJson: string): number {
    const event = this.#parse(eventJson);
    if (event === null) return 0;
    let sent = 0;
    for (const s of this.#sockets) if (s.send(['EVENT', event])) sent += 1;
    return sent;
  }

  get openCount(): number {
    return this.#sockets.filter((s) => s.open).length;
  }

  #closeSockets(): void {
    for (const s of this.#sockets) s.close();
    this.#sockets.splice(0, this.#sockets.length, ...this.#sockets.map((s) => new RelaySocket(s.url, this)));
  }

  destroy(): void {
    this.#destroyed = true;
    this.subs.clear();
    this.#onOpen.clear();
    this.#sent.clear();
    for (const s of this.#sockets) s.close();
  }
}

// ---- the engine hook's types (p2p-media-loader-core as patched by web/player/engine) -------

/** What the engine gives a signaling client for one stream swarm. */
export interface SignalingContext {
  infoHash: string;
  streamSwarmId: string;
  peerId: string;
  rtcConfig: () => RTCConfiguration | undefined;
  channelConfig?: RTCDataChannelInit;
  claimPeer: (peerId: string) => boolean;
  shouldGenerateOffers: () => boolean;
  offerTimeout?: () => number;
  iceGatheringTimeout?: () => number;
  connectionTimeout?: () => number;
}

interface ClientEvents {
  peerConnected: (e: { peerId: string; connection: RTCPeerConnection; channel: RTCDataChannel }) => void;
  peerConnectFailed: (e: { peerId: string; error: PeerConnectError }) => void;
  warning: (w: unknown) => void;
  error: (e: unknown) => void;
}

/** Counters a page can read (`MeshStats` carries the relays). */
export interface SignalerStats {
  sent: number;
  received: number;
  offers: number;
  answers: number;
}

// ---- the session -----------------------------------------------------------------------------

/** One session's Nostr signaling: its key, its relays, and a client per stream swarm. */
export class NostrSignaler {
  readonly session: MeshSession;
  readonly pool: RelayPool;
  readonly stats: SignalerStats = { sent: 0, received: 0, offers: 0, answers: 0 };
  readonly #rooms = new Set<RoomClient>();
  #destroyed = false;

  constructor(
    readonly relays: readonly string[],
    readonly log: (m: string) => void,
  ) {
    this.session = newSession();
    this.pool = new RelayPool(relays, log);
  }

  /** p2p-media-loader's `signalingClientFactory`: one client per stream swarm. */
  readonly factory = (ctx: SignalingContext): RoomClient => {
    const client = new RoomClient(ctx, this, () => this.#rooms.delete(client));
    if (!this.#destroyed) this.#rooms.add(client);
    return client;
  };

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Close every room (sending their `disconnect`s first) and the relay sockets. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const r of [...this.#rooms]) r.destroy();
    this.pool.destroy();
    this.session.free();
  }
}

function newSession(): MeshSession {
  // A random 32 bytes is a valid key but with probability ~2^-128; try again if not.
  for (;;) {
    try {
      return new MeshSession(random(32), random(16));
    } catch {
      // out of range: draw again
    }
  }
}

interface Negotiation {
  role: 'offerer' | 'answerer';
  pc: RTCPeerConnection;
  /** The offer's event id, once sent (offerer). */
  offerId: string | null;
  /** Hands the answer's SDP to the waiting offerer. */
  answer: ((sdp: string) => void) | null;
  /** Set when the negotiation is dropped without failing the peer's claim (glare). */
  superseded: boolean;
  /** Ends every wait of the negotiation at once (glare, destroy). */
  abort: AbortController;
}

/** A promise that also rejects when `signal` aborts, and cleans up after itself either way. */
function abortable<T>(signal: AbortSignal, run: (resolve: (v: T) => void, reject: (e: Error) => void) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    let cleanup: () => void = () => {};
    const onAbort = (): void => {
      cleanup();
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup = run(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        cleanup();
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        cleanup();
        reject(e);
      },
    );
  });
}

/** One stream swarm's room: presence, and the offer/answer exchange with its peers. */
export class RoomClient {
  readonly url: string;
  readonly #ctx: SignalingContext;
  readonly #s: NostrSignaler;
  readonly #forget: () => void;
  readonly #listeners = new Map<keyof ClientEvents, Set<(...a: never[]) => void>>();
  readonly #presence = new PresenceBook();
  readonly #seen = new SeenIds();
  readonly #limiter = new SenderLimiter();
  readonly #backoff = new OfferBackoff();
  readonly #negotiating = new Map<string, Negotiation>();
  #room: MeshRoom | null = null;
  #me = '';
  #unsubscribe: (() => void) | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #started = false;
  #destroyed = false;

  constructor(ctx: SignalingContext, signaler: NostrSignaler, forget: () => void) {
    this.#ctx = ctx;
    this.#s = signaler;
    this.#forget = forget;
    this.url = `nostr:${signaler.relays.join(',')}`;
  }

  addEventListener<K extends keyof ClientEvents>(name: K, f: ClientEvents[K]): void {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(f as (...a: never[]) => void);
  }

  removeEventListener<K extends keyof ClientEvents>(name: K, f: ClientEvents[K]): void {
    this.#listeners.get(name)?.delete(f as (...a: never[]) => void);
  }

  #emit<K extends keyof ClientEvents>(name: K, arg: Parameters<ClientEvents[K]>[0]): void {
    if (this.#destroyed) return;
    for (const f of [...(this.#listeners.get(name) ?? [])]) {
      try {
        (f as (a: typeof arg) => void)(arg);
      } catch (e) {
        globalThis.reportError?.(e);
      }
    }
  }

  start(): void {
    if (this.#started || this.#destroyed || this.#s.destroyed) return;
    this.#started = true;
    this.#room = new MeshRoom(this.#ctx.streamSwarmId);
    this.#me = this.#s.session.pubkey;
    const room = this.#room.pubkey;
    this.#unsubscribe = this.#s.pool.subscribe(
      () => ({ kinds: [KIND_SIGNAL], '#P': [room], since: nowSeconds() - FRESH_SECONDS }),
      (json) => this.#onEvent(json),
      (send) => this.#announce(send),
    );
    this.#announce();
    this.#timer = setInterval(() => {
      this.#presence.prune(nowSeconds());
      this.#announce();
    }, PRESENCE_INTERVAL_MS);
    this.#s.log(`mesh: nostr room ${room.slice(0, 12)}… for ${this.#ctx.streamSwarmId}`);
  }

  /**
   * Our presence, signed now, to every relay already open (never queued), or with `send` to
   * the one relay that just opened.
   */
  #announce(send?: (eventJson: string) => void): void {
    if (this.#destroyed || this.#room === null) return;
    const ev = this.#s.session.connect(this.#room, nowSeconds());
    if (send) send(ev);
    else this.#publish(ev);
  }

  #publish(eventJson: string): void {
    if (this.#s.pool.publish(eventJson) > 0) this.#s.stats.sent += 1;
  }

  #onEvent(json: string): void {
    if (this.#destroyed || this.#room === null) return;
    // Our own events come back from every relay: dropped before any verification. Only ids of
    // events that verified are remembered, so a relay cannot hide a real event by sending a
    // forgery under its id first.
    const head = eventHead(json);
    if (head === null || head.pubkey === this.#me || this.#seen.has(head.id)) return;
    let r: { ignored?: string; type?: string; id: string; sender: string; expiration?: number; content?: string; offer?: string; created_at: number };
    try {
      r = JSON.parse(this.#s.session.read(this.#room, json, nowSeconds())) as typeof r;
    } catch {
      return; // invalid (NFX-10 §6.5): dropped
    }
    if (r.ignored !== undefined) return;
    this.#seen.add(r.id);
    this.#s.stats.received += 1;
    const now = nowSeconds();
    switch (r.type) {
      case 'connect':
        if (this.#presence.add(r.sender, r.created_at, r.expiration ?? 0, now)) this.#maybeOffer(r.sender);
        break;
      case 'disconnect':
        this.#presence.add(r.sender, r.created_at, null, now);
        break;
      case 'offer':
        this.#onOffer(r.sender, r.id, r.content ?? '');
        break;
      case 'answer':
        this.#onAnswer(r.sender, r.offer ?? '', r.content ?? '');
        break;
    }
  }

  /**
   * On a peer's presence: offer if this session's key is the lower one, the room has a free
   * negotiation and fewer than `LIMITS.pendingOffersPerRoom` offers of ours are pending (so a
   * crowd of keys that never answer cannot take the slots answering needs), and no failed
   * offer to that peer is still backing off.
   */
  #maybeOffer(peer: string): void {
    if (this.#negotiating.has(peer) || !offersTo(this.#me, peer)) return;
    if (this.#negotiating.size >= LIMITS.negotiationsPerRoom) return;
    let offering = 0;
    for (const n of this.#negotiating.values()) if (n.role === 'offerer') offering += 1;
    if (offering >= LIMITS.pendingOffersPerRoom || !this.#backoff.allowed(peer, Date.now())) return;
    if (!this.#ctx.shouldGenerateOffers() || !this.#ctx.claimPeer(peer)) return;
    void this.#offer(peer);
  }

  #open(sender: string, content: string): string | null {
    if (!this.#limiter.take(sender, Date.now())) return null;
    try {
      return this.#s.session.open(sender, content);
    } catch {
      return null;
    }
  }

  #onOffer(peer: string, offerId: string, content: string): void {
    const held = this.#negotiating.get(peer);
    if (held && (held.role === 'answerer' || offersTo(this.#me, peer))) return; // ours stands, or a repeat
    if (!held && this.#negotiating.size >= LIMITS.negotiationsPerRoom) return;
    const sdp = this.#open(peer, content);
    if (sdp === null) return;
    if (held) {
      // Glare, and the peer's key is lower: its offer stands. Drop ours, keep the claim.
      held.superseded = true;
      this.#negotiating.delete(peer);
      held.abort.abort();
      held.pc.close();
    } else if (!this.#ctx.claimPeer(peer)) {
      return;
    }
    void this.#answer(peer, offerId, sdp);
  }

  #onAnswer(peer: string, offerId: string, content: string): void {
    const held = this.#negotiating.get(peer);
    if (!held || held.role !== 'offerer' || held.offerId !== offerId || held.answer === null) return;
    const sdp = this.#open(peer, content);
    if (sdp === null) return;
    const deliver = held.answer;
    held.answer = null;
    deliver(sdp);
  }

  /** A negotiation for `peer`, registered; null (and the claim released) if no peer connection could be made. */
  #begin(peer: string, role: Negotiation['role'], offerId: string | null): Negotiation | null {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(this.#ctx.rtcConfig());
    } catch (e) {
      this.#release(peer, e);
      return null;
    }
    const n: Negotiation = { role, pc, offerId, answer: null, superseded: false, abort: new AbortController() };
    this.#negotiating.set(peer, n);
    return n;
  }

  async #offer(peer: string): Promise<void> {
    const n = this.#begin(peer, 'offerer', null);
    if (n === null) return;
    const { pc } = n;
    try {
      const channel = pc.createDataChannel('webtorrent', this.#ctx.channelConfig);
      channel.binaryType = 'arraybuffer';
      await pc.setLocalDescription(await pc.createOffer());
      await this.#gathered(pc, n.abort.signal);
      this.#check(n, peer);
      const ev = this.#s.session.offer(this.#room!, peer, pc.localDescription!.sdp, random(32), nowSeconds());
      n.offerId = eventId(ev);
      // Armed before the offer goes out: its answer cannot come sooner.
      const answer = abortable<string>(n.abort.signal, (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer in time')), LIMITS.answerTimeoutMs);
        n.answer = resolve;
        return () => {
          clearTimeout(timer);
          n.answer = null;
        };
      });
      answer.catch(() => {}); // awaited below; a rejection before then is not unhandled
      this.#publish(ev);
      this.#s.stats.offers += 1;
      this.#s.log(`mesh: nostr offer to ${peer.slice(0, 12)}…`);
      const sdp = await answer;
      this.#check(n, peer);
      await pc.setRemoteDescription({ type: 'answer', sdp });
      const open = await this.#connected(pc, channel, n.abort.signal);
      this.#check(n, peer);
      this.#negotiating.delete(peer);
      this.#backoff.connected(peer);
      this.#emit('peerConnected', { peerId: peer, connection: pc, channel: open });
    } catch (e) {
      if (!n.superseded && !this.#destroyed) this.#backoff.failed(peer, Date.now());
      this.#failed(n, peer, e);
    }
  }

  async #answer(peer: string, offerId: string, offerSdp: string): Promise<void> {
    const n = this.#begin(peer, 'answerer', offerId);
    if (n === null) return;
    const { pc } = n;
    const channelP = this.#connected(pc, null, n.abort.signal);
    channelP.catch(() => {}); // awaited below
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await this.#gathered(pc, n.abort.signal);
      this.#check(n, peer);
      const ev = this.#s.session.answer(this.#room!, peer, offerId, pc.localDescription!.sdp, random(32), nowSeconds());
      this.#publish(ev);
      this.#s.stats.answers += 1;
      this.#s.log(`mesh: nostr answer to ${peer.slice(0, 12)}…`);
      const open = await channelP;
      this.#check(n, peer);
      this.#negotiating.delete(peer);
      this.#emit('peerConnected', { peerId: peer, connection: pc, channel: open });
    } catch (e) {
      this.#failed(n, peer, e);
    }
  }

  /** Throws unless `n` is still this peer's live negotiation. */
  #check(n: Negotiation, peer: string): void {
    if (this.#destroyed) throw new Error('signaling destroyed');
    if (n.superseded || this.#negotiating.get(peer) !== n) throw new Error('superseded');
  }

  #failed(n: Negotiation, peer: string, e: unknown): void {
    n.abort.abort();
    try {
      n.pc.close();
    } catch {
      // closed already
    }
    if (n.superseded) return; // its claim went to the negotiation that replaced it
    if (this.#negotiating.get(peer) === n) this.#negotiating.delete(peer);
    if (!this.#destroyed) this.#s.log(`mesh: nostr ${n.role === 'offerer' ? 'offer to' : 'answer to'} ${peer.slice(0, 12)}… failed: ${message(e)}`);
    this.#release(peer, e);
  }

  /** Give the engine back its claim on `peer` (`peerConnectFailed`). */
  #release(peer: string, e: unknown): void {
    this.#emit('peerConnectFailed', {
      peerId: peer,
      error: new PeerConnectError('connection-failed', message(e), e),
    });
  }

  /** Wait until ICE gathering is complete (the SDP then carries every candidate), or the timeout. */
  #gathered(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
    return abortable<void>(signal, (resolve, reject) => {
      const onState = (): void => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
      const onCandidate = (e: RTCPeerConnectionIceEvent): void => {
        if (e.candidate === null) resolve();
      };
      const onSignaling = (): void => {
        if (pc.signalingState === 'closed') reject(new Error('peer connection closed while gathering'));
      };
      const timer = setTimeout(() => resolve(), this.#ctx.iceGatheringTimeout?.() ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', onState);
      pc.addEventListener('icecandidate', onCandidate);
      pc.addEventListener('signalingstatechange', onSignaling);
      if (pc.iceGatheringState === 'complete') queueMicrotask(resolve);
      return () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onState);
        pc.removeEventListener('icecandidate', onCandidate);
        pc.removeEventListener('signalingstatechange', onSignaling);
      };
    });
  }

  /** The data channel once open: the offerer's own, or the one the offerer opens. */
  #connected(pc: RTCPeerConnection, own: RTCDataChannel | null, signal: AbortSignal): Promise<RTCDataChannel> {
    return abortable<RTCDataChannel>(signal, (resolve, reject) => {
      let channel: RTCDataChannel | null = null;
      const onOpen = (): void => resolve(channel!);
      const onClose = (): void => reject(new Error('data channel closed before it opened'));
      const onIce = (): void => {
        const st = pc.iceConnectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected' || pc.signalingState === 'closed') {
          reject(new Error(`ICE connection ${st}`));
        }
      };
      const bind = (c: RTCDataChannel): void => {
        channel = c;
        c.binaryType = 'arraybuffer';
        c.addEventListener('open', onOpen);
        c.addEventListener('close', onClose);
        c.addEventListener('error', onClose);
        if (c.readyState === 'open') queueMicrotask(onOpen);
        else if (c.readyState === 'closing' || c.readyState === 'closed') queueMicrotask(onClose);
      };
      const onChannel = (e: RTCDataChannelEvent): void => {
        if (channel === null) bind(e.channel);
      };
      // The answerer's wait also covers its own answer's gathering and the trip back.
      const wait =
        (this.#ctx.connectionTimeout?.() ?? DEFAULT_CONNECTION_TIMEOUT_MS) +
        (own === null ? (this.#ctx.iceGatheringTimeout?.() ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS) : 0);
      const timer = setTimeout(() => reject(new Error('data channel open timeout')), wait);
      pc.addEventListener('iceconnectionstatechange', onIce);
      pc.addEventListener('signalingstatechange', onIce);
      if (own) bind(own);
      else pc.addEventListener('datachannel', onChannel);
      return () => {
        clearTimeout(timer);
        pc.removeEventListener('iceconnectionstatechange', onIce);
        pc.removeEventListener('signalingstatechange', onIce);
        pc.removeEventListener('datachannel', onChannel);
        if (channel) {
          channel.removeEventListener('open', onOpen);
          channel.removeEventListener('close', onClose);
          channel.removeEventListener('error', onClose);
        }
      };
    });
  }

  /**
   * Leave: our `disconnect` to the relays, then close every connection still negotiating
   * (connections already reported belong to the engine) and send no further events.
   */
  destroy(): void {
    if (this.#destroyed) return;
    if (this.#room !== null) {
      try {
        this.#publish(this.#s.session.disconnect(this.#room, nowSeconds()));
      } catch {
        // best effort
      }
    }
    this.#destroyed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const n of this.#negotiating.values()) {
      n.abort.abort();
      n.pc.close();
    }
    this.#negotiating.clear();
    this.#listeners.clear();
    this.#room?.free();
    this.#room = null;
    this.#forget();
  }
}
