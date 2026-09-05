/**
 * Maps Noise key → PeerSession, applies admission control (ban list, rate limits, stream
 * cap) and attaches the `upload` gate to every seeded core.
 */
import type { NostrPubkey, PaymentEngineSeeder } from '@sovit/core';
import type Hypercore from 'hypercore';
import type { ReplicationPeer, ReplicationStream } from 'hypercore';
import type { PeerInfo } from 'hyperswarm';

import type { Logger } from '../log/logger.js';
import type { BanList } from '../store/ban-list.js';
import { toHex } from '../util/hex.js';
import { PeerSession } from './peer-session.js';
import type { RateLimiter } from './rate-limit.js';

export type SessionEvent =
  | { readonly type: 'open'; readonly session: PeerSession }
  | { readonly type: 'close'; readonly session: PeerSession }
  | {
      readonly type: 'refused';
      readonly noiseKeyHex: string;
      readonly reason: 'banned' | 'global-cap' | 'per-key-cap' | 'connect-rate';
    };

export interface SessionRegistryOptions {
  readonly engine: PaymentEngineSeeder;
  readonly banList: BanList;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly now?: () => number;
}

export class SessionRegistry {
  private readonly byNoise = new Map<string, PeerSession>();
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly engine: PaymentEngineSeeder;
  private readonly banList: BanList;
  private readonly rateLimiter: RateLimiter;
  private readonly log: Logger;
  private readonly now: (() => number) | undefined;

  constructor(opts: SessionRegistryOptions) {
    this.engine = opts.engine;
    this.banList = opts.banList;
    this.rateLimiter = opts.rateLimiter;
    this.log = opts.logger;
    this.now = opts.now;
  }

  on(cb: (e: SessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get size(): number {
    return this.byNoise.size;
  }

  get(noiseKey: Uint8Array | string): PeerSession | undefined {
    return this.byNoise.get(typeof noiseKey === 'string' ? noiseKey : toHex(noiseKey));
  }

  all(): readonly PeerSession[] {
    return [...this.byNoise.values()];
  }

  find(pubkey: NostrPubkey): readonly PeerSession[] {
    return this.all().filter((s) => s.pubkey === pubkey || s.noiseKeyHex === pubkey);
  }

  /**
   * Admit a connection whose Noise handshake has completed. Refuses (destroys) when the
   * Noise key is banned or a rate limit / cap is hit. Returns the session or `null`.
   */
  admit(stream: ReplicationStream, peerInfo: PeerInfo | null = null): PeerSession | null {
    const noiseKey = stream.remotePublicKey;
    if (noiseKey === null) {
      stream.destroy(new Error('admit before handshake'));
      return null;
    }
    const hex = toHex(noiseKey);
    const existing = this.byNoise.get(hex);
    if (existing?.stream === stream) return existing;

    if (this.banList.isNoiseBanned(hex)) {
      this.log.info('refused banned noise key', { noiseKey: hex });
      peerInfo?.ban(true);
      stream.destroy();
      this.emit({ type: 'refused', noiseKeyHex: hex, reason: 'banned' });
      return null;
    }
    const admitted = this.rateLimiter.admit(hex);
    if (!admitted.ok) {
      this.log.warn('refused by rate limit', { noiseKey: hex, reason: admitted.reason });
      stream.destroy();
      this.emit({ type: 'refused', noiseKeyHex: hex, reason: admitted.reason });
      return null;
    }
    // A second stream from the same key replaces the registry entry (per-key cap decides
    // how many may be live); the old session keeps running until its own stream closes.
    const session = new PeerSession({
      engine: this.engine,
      banList: this.banList,
      logger: this.log,
      noiseKey,
      stream,
      peerInfo,
      ...(this.now ? { now: this.now } : {}),
      onClose: (s) => {
        admitted.release();
        if (this.byNoise.get(hex) === s) this.byNoise.delete(hex);
        this.emit({ type: 'close', session: s });
      },
    });
    this.byNoise.set(hex, session);
    this.emit({ type: 'open', session });
    return session;
  }

  /**
   * Attach the synchronous upload gate to a core. Every `upload` event resolves the peer's
   * session by Noise key and forwards to `session.onUpload()`. Returns a detach function.
   */
  attachUploadGate(core: Hypercore): () => void {
    const coreKeyHex = toHex(core.key);
    const handler = (index: number, byteLength: number, peer: ReplicationPeer): void => {
      const session = this.resolvePeer(peer);
      if (session === null) return;
      session.onUpload(coreKeyHex, index, byteLength);
    };
    core.on('upload', handler);
    return () => {
      core.off('upload', handler);
    };
  }

  /** Cut every session bound to (or provisionally accounted as) `pubkey`. */
  cutPubkey(pubkey: NostrPubkey, reason: 'window-exceeded' | 'banned'): number {
    let n = 0;
    for (const s of this.find(pubkey)) {
      s.cut(reason);
      n++;
    }
    return n;
  }

  closeAll(): void {
    for (const s of this.all()) if (!s.stream.destroyed) s.stream.destroy();
  }

  /**
   * A peer whose stream was never admitted (e.g. a replication stream handed to
   * `Corestore.replicate()` directly, bypassing the swarm) gets a session on first upload
   * — through the same admission rules, so a banned or rate-limited key is still cut
   * before its first block leaves.
   */
  private resolvePeer(peer: ReplicationPeer): PeerSession | null {
    const hex = toHex(peer.remotePublicKey);
    const found = this.byNoise.get(hex);
    if (found && !found.closed) return found;
    return this.admit(peer.stream, null);
  }

  private emit(e: SessionEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.log.error('session listener threw', { error: err });
      }
    }
  }
}
