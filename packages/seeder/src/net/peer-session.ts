/**
 * PeerSession — one replication connection, as the seeder sees it.
 *
 * Identity: the Noise public key (transport, known at handshake) and, once `pay/1` `HELLO`
 * binds one, the Nostr pubkey (payment identity). Accounting always goes to the
 * `PaymentEngineSeeder` under `accountId()`; before `HELLO` that is the Noise key hex used
 * *as* the pubkey string (same 32-byte hex shape — the provisional identity of ADR 0004
 * (d)), and on `bindPubkey()` the engine moves that accounting onto the real pubkey with
 * `rebind(noiseHex, pubkey)` (per-core counts included, provisional entry dropped). A
 * viewer that never sends `HELLO` is therefore cut after `windowBlocks` like any other
 * non-payer.
 *
 * The cut (spike S-A, ADR 0003): `onUpload()` is called synchronously from Hypercore's
 * `upload` event, calls `recordUpload(id, 1, core)` (synchronous by contract), and if the
 * returned window has `outstanding > windowBlocks` bans (ban list + engine + hyperswarm
 * `PeerInfo`) and destroys the stream IN THE SAME TICK. No `await` anywhere on that path.
 */
import type {
  CoreKeyHex,
  MuxLike,
  NostrPubkey,
  PayMessage,
  PaymentEngineSeeder,
  PayProtocolEvents,
  PeerWindow,
  PricePolicy,
  VerifyResult,
} from '@sovit/core';
import type { ReplicationStream } from 'hypercore';
import type { PeerInfo } from 'hyperswarm';

import type { Logger } from '../log/logger.js';
import type { BanList } from '../store/ban-list.js';
import { toHex } from '../util/hex.js';

export type CutReason = Parameters<PayProtocolEvents['close']>[0];

export interface PeerSessionInfo {
  readonly noiseKeyHex: string;
  readonly pubkey: NostrPubkey | null;
  readonly uploadedBlocks: number;
  readonly uploadedBytes: number;
  readonly openedAt: number;
  readonly cutReason: CutReason | null;
  readonly closed: boolean;
  readonly window: PeerWindow | undefined;
}

export interface PeerSessionOptions {
  readonly noiseKey: Uint8Array;
  readonly stream: ReplicationStream;
  readonly engine: PaymentEngineSeeder;
  readonly banList: BanList;
  readonly logger: Logger;
  /** hyperswarm PeerInfo when the connection came through the swarm; `ban(true)` target. */
  readonly peerInfo?: PeerInfo | null;
  readonly now?: () => number;
  /** Called exactly once when the underlying stream closes (after any cut). */
  readonly onClose?: (session: PeerSession) => void;
}

export class PeerSession {
  readonly noiseKey: Uint8Array;
  readonly noiseKeyHex: string;
  readonly stream: ReplicationStream;
  readonly openedAt: number;

  private pubkeyBound: NostrPubkey | null = null;
  private provisionalUploads = 0;
  private uploaded = 0;
  private uploadedBytesTotal = 0;
  private readonly coresUploaded = new Set<string>();
  private cutWith: CutReason | null = null;
  private isClosed = false;
  private readonly engine: PaymentEngineSeeder;
  private readonly banList: BanList;
  private readonly log: Logger;
  private readonly peerInfo: PeerInfo | null;

  constructor(opts: PeerSessionOptions) {
    this.noiseKey = opts.noiseKey;
    this.noiseKeyHex = toHex(opts.noiseKey);
    this.stream = opts.stream;
    this.engine = opts.engine;
    this.banList = opts.banList;
    this.peerInfo = opts.peerInfo ?? null;
    this.openedAt = (opts.now ?? Date.now)();
    this.log = opts.logger.child({ noiseKey: this.noiseKeyHex });
    this.stream.once('close', () => {
      this.isClosed = true;
      opts.onClose?.(this);
    });
  }

  get pubkey(): NostrPubkey | null {
    return this.pubkeyBound;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get cutReason(): CutReason | null {
    return this.cutWith;
  }

  get uploadedBlocks(): number {
    return this.uploaded;
  }

  /** Distinct cores this session has uploaded at least one block from (hex keys). */
  get uploadedCores(): ReadonlySet<string> {
    return this.coresUploaded;
  }

  /**
   * The `Protomux` instance of this connection, when the stream went through Hypercore's
   * `createProtocolStream()` (every `Seeder.replicate()` / swarm stream does). This is what
   * a `PayProtocol` attaches to; `null` on a stream that carries no muxer.
   */
  get mux(): MuxLike | null {
    const m: unknown = this.stream.noiseStream.userData;
    return isMuxLike(m) ? m : null;
  }

  /** Identity the PaymentEngine accounts under. See the module comment. */
  accountId(): NostrPubkey {
    return this.pubkeyBound ?? (this.noiseKeyHex as NostrPubkey);
  }

  info(): PeerSessionInfo {
    return {
      noiseKeyHex: this.noiseKeyHex,
      pubkey: this.pubkeyBound,
      uploadedBlocks: this.uploaded,
      uploadedBytes: this.uploadedBytesTotal,
      openedAt: this.openedAt,
      cutReason: this.cutWith,
      closed: this.isClosed,
      window: this.engine.window(this.accountId()),
    };
  }

  /**
   * SYNCHRONOUS. Called from inside Hypercore's `upload` handler, before the block is
   * written to the wire. Returns the post-update window.
   */
  onUpload(coreKeyHex: string, index: number, byteLength: number): PeerWindow | null {
    if (this.cutWith !== null || this.isClosed) return null;
    this.uploaded++;
    this.uploadedBytesTotal += byteLength;
    this.coresUploaded.add(coreKeyHex);
    if (this.pubkeyBound === null) this.provisionalUploads++;
    // v3: the core travels with the count so the engine can answer `range-not-uploaded`
    // per core (ADR 0004 (c)); the window itself stays per peer, summed over cores.
    const w = this.engine.recordUpload(this.accountId(), 1, coreKeyHex as CoreKeyHex);
    if (w.outstanding > w.windowBlocks) {
      this.log.warn('window exceeded — cutting', {
        core: coreKeyHex,
        index,
        outstanding: w.outstanding,
        windowBlocks: w.windowBlocks,
      });
      this.cut('window-exceeded');
    }
    return w;
  }

  /**
   * Bind the Nostr pubkey from a verified `HELLO`. Refuses (and cuts) a banned pubkey.
   * Moves the provisional accounting (blocks uploaded before the bind, per core) onto
   * `pubkey` with `engine.rebind()` (ADR 0004 (d)): the engine SUMS it into any window the
   * pubkey already has from another session, drops the provisional entry, and — if the
   * merged `outstanding` crosses the window — bans and fires `onWindowExceeded`
   * synchronously, exactly like `recordUpload`. The seeder's `onWindowExceeded`
   * subscription then cuts this session before `rebind` even returns; the check below is
   * belt and braces for an engine without listeners.
   */
  bindPubkey(pubkey: NostrPubkey): boolean {
    if (this.cutWith !== null || this.isClosed) return false;
    if (this.banList.isPubkeyBanned(pubkey) || this.engine.isBanned(pubkey)) {
      this.log.warn('banned pubkey attempted HELLO — cutting', { pubkey });
      this.pubkeyBound = pubkey;
      this.cut('banned');
      return false;
    }
    if (this.pubkeyBound !== null && this.pubkeyBound !== pubkey) {
      this.log.warn('pubkey rebind attempt — cutting', { pubkey, bound: this.pubkeyBound });
      this.cut('protocol-error');
      return false;
    }
    const alreadyBound = this.pubkeyBound === pubkey;
    this.pubkeyBound = pubkey;
    const provisional = this.provisionalUploads;
    this.provisionalUploads = 0;
    if (!alreadyBound) {
      const w = this.engine.rebind(this.noiseKeyHex as NostrPubkey, pubkey);
      if (w.outstanding > w.windowBlocks) {
        this.cut('window-exceeded');
        return false;
      }
      if (w.banned) {
        // A ban carried over by the merge (engine-side state we could not see above).
        this.cut('banned');
        return false;
      }
    }
    this.log.info('pubkey bound', { pubkey, provisionalBlocks: provisional });
    return true;
  }

  /** Seeder-side `PAY` handling: offline verification via the engine (invariant 4). */
  async verifyPay(msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    if (this.cutWith !== null || this.isClosed)
      return { ok: false, reason: 'peer-banned', detail: 'session cut' };
    const r = await this.engine.verify(this.accountId(), msg, policy);
    if (r.ok) this.log.debug('PAY accepted', { blocks: r.blocks, credited: r.credited });
    else this.log.info('PAY rejected', { reason: r.reason, detail: r.detail });
    return r;
  }

  /**
   * Cut this peer. Synchronous, idempotent. For `window-exceeded` and `banned` the peer is
   * banned on both keys (ban list, engine, hyperswarm PeerInfo) BEFORE the destroy so it
   * cannot reconnect (S-A finding 6). Other reasons just drop the connection.
   */
  cut(reason: CutReason): void {
    if (this.cutWith !== null) return;
    this.cutWith = reason;
    const banning = reason === 'window-exceeded' || reason === 'banned';
    if (banning) {
      const pubkey = this.pubkeyBound;
      // Record the Noise key if it is not banned yet; keep an existing pubkey ban's reason.
      if (!this.banList.isNoiseBanned(this.noiseKey)) {
        const prior = pubkey !== null ? this.banList.entryFor(pubkey) : undefined;
        this.banList.ban({ pubkey, noiseKey: this.noiseKey, reason: prior?.reason ?? reason });
      }
      const id = this.accountId();
      if (!this.engine.isBanned(id)) this.engine.ban(id, reason, this.noiseKey);
      this.peerInfo?.ban(true);
    }
    this.log.info('cut', { reason, pubkey: this.pubkeyBound, banned: banning });
    if (!this.stream.destroyed) this.stream.destroy();
  }
}

/** Structural check for the contract's `MuxLike` (a protomux instance has `createChannel`). */
function isMuxLike(x: unknown): x is MuxLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { createChannel?: unknown }).createChannel === 'function'
  );
}
