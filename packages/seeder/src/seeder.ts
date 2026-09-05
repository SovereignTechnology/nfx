/**
 * Seeder — the daemon's public façade (build-plan §2.1 `@sovit/seeder`). This is the API
 * L3 (gateway) and L6 (desktop shell) consume; see docs/lanes/L2.md "Public API".
 *
 * Composition:
 *   BlobStore (Corestore + Hyperblobs, CAS index, disk cap)
 *   SessionRegistry (Noise key → PeerSession, admission, synchronous upload gate)
 *   SwarmManager (hyperswarm, ban-list firewall, join per core)
 *   FlushScheduler (PaymentEngine.flush every N blocks / T ms)
 *   BanList (Noise + Nostr, persisted)
 *   Logger (redacting; the only output path)
 */
import type {
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PaymentEngineSeeder,
  PayProtocol,
  PricePolicy,
  Sats,
  UnixSeconds,
} from '@sovit/core';
import type { BlobReadStream } from 'hyperblobs';
import type { ReplicationStream, ReplicationStreamOptions } from 'hypercore';
import type { PeerInfo, SwarmConnection } from 'hyperswarm';

import type { SeederCrypto } from './adapters/crypto.js';
import type { SeederFs } from './adapters/fs.js';
import { BlobStore } from './blobs/blob-store.js';
import type { PutOptions, PutResult, SeedCore } from './blobs/blob-store.js';
import { resolveConfig } from './config.js';
import type { ResolvedSeederConfig, SeederConfig } from './config.js';
import type { Logger } from './log/logger.js';
import { silentLogger } from './log/logger.js';
import type { CutReason, PeerSession, PeerSessionInfo } from './net/peer-session.js';
import { RateLimiter } from './net/rate-limit.js';
import { SessionRegistry } from './net/session-registry.js';
import type { SessionEvent } from './net/session-registry.js';
import { SwarmManager } from './net/swarm.js';
import { FlushScheduler } from './payment/flush-scheduler.js';
import type { FlushResult, FlushTrigger } from './payment/flush-scheduler.js';
import { attachPayBridge } from './payment/pay-bridge.js';
import { BanList } from './store/ban-list.js';
import type { PersistedBan } from './store/ban-list.js';
import { CasIndex } from './store/cas-index.js';
import type { CasEntry } from './store/cas-index.js';
import { DiskCap } from './store/disk-cap.js';
import { toHex } from './util/hex.js';

export interface SeederDeps {
  readonly engine: PaymentEngineSeeder & { readonly config?: EngineConfigLike };
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly logger?: Logger;
  readonly now?: () => number;
}

interface EngineConfigLike {
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}

export type SeederEvent =
  | { readonly type: 'session-open'; readonly session: PeerSessionInfo }
  | { readonly type: 'session-close'; readonly session: PeerSessionInfo }
  | { readonly type: 'session-cut'; readonly session: PeerSessionInfo; readonly reason: CutReason }
  | { readonly type: 'session-refused'; readonly noiseKeyHex: string; readonly reason: string }
  | { readonly type: 'blob-added'; readonly entry: CasEntry; readonly deduplicated: boolean }
  | { readonly type: 'blob-removed'; readonly sha256: string }
  | { readonly type: 'flush'; readonly result: FlushResult; readonly trigger: FlushTrigger }
  | {
      readonly type: 'double-spend';
      readonly peer: NostrPubkey;
      readonly mint: MintUrl;
      readonly amount: Sats;
    };

export interface SeederStats {
  readonly cores: number;
  readonly blobs: number;
  readonly usedBytes: number;
  readonly capBytes: number;
  readonly sessions: number;
  readonly swarmConnections: number;
  readonly bans: number;
  readonly flushes: number;
  readonly pendingPaidBlocks: number;
}

export class Seeder {
  readonly config: ResolvedSeederConfig;
  readonly log: Logger;
  readonly banList: BanList;
  readonly index: CasIndex;
  readonly diskCap: DiskCap;
  readonly rateLimiter: RateLimiter;
  readonly sessions: SessionRegistry;
  readonly blobs: BlobStore;
  readonly swarm: SwarmManager | null;
  readonly scheduler: FlushScheduler;
  private readonly engine: PaymentEngineSeeder;
  private readonly listeners = new Set<(e: SeederEvent) => void>();
  private readonly gates = new Map<string, () => void>();
  private readonly protocols = new Map<PeerSession, PayProtocol>();
  private readonly unsubs: (() => void)[] = [];
  private policyOverride: PricePolicy | null;
  private readonly corePolicies = new Map<CoreKeyHex, PricePolicy>();
  private started = false;
  private closed = false;

  private constructor(
    config: ResolvedSeederConfig,
    deps: SeederDeps,
    loaded: { readonly banList: BanList; readonly index: CasIndex },
  ) {
    this.config = config;
    this.engine = deps.engine;
    this.log = (deps.logger ?? silentLogger).child({ component: 'seeder' });
    this.policyOverride = config.policy;
    this.banList = loaded.banList;
    this.index = loaded.index;
    this.diskCap = new DiskCap(config.diskCapBytes, this.index.totalBytes());
    this.rateLimiter = new RateLimiter(config.rateLimits, deps.now ?? Date.now);
    this.sessions = new SessionRegistry({
      engine: deps.engine,
      banList: this.banList,
      rateLimiter: this.rateLimiter,
      logger: this.log,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.blobs = new BlobStore({
      storageDir: config.storageDir,
      blockSize: config.blockSize,
      fs: deps.fs,
      crypto: deps.crypto,
      index: this.index,
      diskCap: this.diskCap,
      logger: this.log,
      onCoreOpened: (sc) => {
        this.onCoreOpened(sc);
      },
    });
    this.swarm = config.swarm
      ? new SwarmManager({
          config: config.swarm,
          banList: this.banList,
          registry: this.sessions,
          logger: this.log,
          onSession: (session, conn, info) => {
            this.onSwarmSession(session, conn, info);
          },
        })
      : null;
    this.scheduler = new FlushScheduler(deps.engine, {
      everyBlocks: config.flushEveryBlocks,
      everyMs: config.flushEveryMs,
      logger: this.log,
    });
  }

  /** Open storage, load the ban list + CAS index, size the disk cap. Does not touch the network. */
  static async create(userConfig: SeederConfig, deps: SeederDeps): Promise<Seeder> {
    const config = resolveConfig(userConfig, deps.fs.join.bind(deps.fs), deps.engine.config);
    const log = (deps.logger ?? silentLogger).child({ component: 'seeder' });
    await deps.fs.mkdir(config.dataDir, { recursive: true });
    await deps.fs.mkdir(config.storageDir, { recursive: true });
    const nowSec = (): UnixSeconds => Math.floor((deps.now ?? Date.now)() / 1000) as UnixSeconds;
    const banList = new BanList({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
      now: nowSec,
    });
    const index = new CasIndex({
      fs: deps.fs,
      crypto: deps.crypto,
      dataDir: config.dataDir,
      now: nowSec,
    });
    await banList.load();
    await index.load();
    if (banList.corruptOnLoad)
      log.error('ban list on disk was unreadable; starting with an empty list');
    if (index.corruptOnLoad)
      log.error('CAS index on disk was unreadable; starting with an empty index');

    const seeder = new Seeder(config, deps, { banList, index });
    await seeder.blobs.ready();
    seeder.wireEvents();
    seeder.log.info('seeder created', {
      dataDir: config.dataDir,
      blobs: index.entries().length,
      usedBytes: seeder.diskCap.usedBytes,
      capBytes: config.diskCapBytes,
      bans: banList.entries().length,
    });
    return seeder;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the swarm (if configured), join every open core, arm the flush scheduler. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.scheduler.start();
    if (this.swarm) {
      this.swarm.start();
      for (const sc of this.blobs.openCores()) this.swarm.join(sc.core.discoveryKey);
    }
    this.log.info('seeder started', { swarm: this.swarm !== null });
  }

  /** Graceful stop: final flush, drop every connection, close swarm + store, persist. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    for (const off of this.unsubs) off();
    await this.scheduler.stop({ flush: true });
    this.sessions.closeAll();
    for (const detach of this.gates.values()) detach();
    this.gates.clear();
    if (this.swarm) await this.swarm.destroy();
    await this.blobs.close();
    await Promise.all([this.banList.flushed(), this.index.flushed()]);
    this.log.info('seeder closed');
  }

  on(cb: (e: SeederEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ------------------------------------------------------------------ blobs

  openCore(name?: string): Promise<SeedCore> {
    return this.blobs.openCore(name);
  }

  putBytes(bytes: Uint8Array, opts?: PutOptions): Promise<PutResult> {
    return this.blobs.putBytes(bytes, opts).then((r) => this.afterPut(r));
  }

  putFile(path: string, opts?: PutOptions): Promise<PutResult> {
    return this.blobs.putFile(path, opts).then((r) => this.afterPut(r));
  }

  putStream(
    source: () => AsyncIterable<Uint8Array>,
    size: number,
    opts?: PutOptions,
  ): Promise<PutResult> {
    return this.blobs.putStream(source, size, opts).then((r) => this.afterPut(r));
  }

  hasBlob(sha256: string): boolean {
    return this.index.has(sha256);
  }

  blob(sha256: string): CasEntry | undefined {
    return this.index.get(sha256);
  }

  listBlobs(): readonly CasEntry[] {
    return this.index.entries();
  }

  getBlob(sha256: string, opts?: { readonly wait?: boolean }): Promise<Uint8Array | null> {
    return this.blobs.get(sha256, opts);
  }

  createBlobReadStream(
    sha256: string,
    opts?: { readonly start?: number; readonly end?: number; readonly wait?: boolean },
  ): BlobReadStream | null {
    return this.blobs.createReadStream(sha256, opts);
  }

  async removeBlob(sha256: string): Promise<boolean> {
    const ok = await this.blobs.remove(sha256);
    if (ok) this.emit({ type: 'blob-removed', sha256 });
    return ok;
  }

  // ------------------------------------------------------------------ network

  /**
   * Replicate over a stream you own (gateway WS bridge, tests). Boolean → a fresh Noise
   * stream is created; pipe the returned raw stream to the remote. A stream with a
   * `noiseStream` (hyperswarm connection) → attached as-is. The session is admitted once
   * the Noise handshake completes; a refused stream is destroyed. NOTE: without
   * `opts.keyPair` every fresh stream gets a NEW Noise identity (Corestore behaviour), so
   * pass the node's stable key pair when bans are expected to stick.
   */
  replicate(
    isInitiator: boolean | ReplicationStream,
    opts?: ReplicationStreamOptions,
  ): ReplicationStream {
    const stream = this.blobs.store.replicate(isInitiator, opts);
    const noise = stream.noiseStream;
    const admit = (): void => {
      const s = this.sessions.admit(noise, null);
      if (s !== null) this.log.debug('direct stream admitted', { noiseKey: s.noiseKeyHex });
    };
    if (noise.remotePublicKey !== null) admit();
    else noise.once('connect', admit);
    return stream;
  }

  /**
   * Attach a `pay/1` protocol instance to a session (the implementation arrives in Stage 2;
   * the seeder only depends on the contract). Returns a detach function.
   */
  attachPayProtocol(session: PeerSession, protocol: PayProtocol): () => void {
    const detach = attachPayBridge({
      session,
      protocol,
      policy: (core) => this.policyFor(core),
      replicatedCores: () => this.replicatedCores(session),
      scheduler: this.scheduler,
      logger: this.log,
    });
    this.protocols.set(session, protocol);
    session.stream.once('close', () => this.protocols.delete(session));
    return () => {
      this.protocols.delete(session);
      detach();
    };
  }

  /** The DEFAULT policy (`config.policy` / `setPolicy()`): what a core without its own gets. */
  policy(): PricePolicy {
    if (this.policyOverride === null)
      throw new Error('seeder has no PricePolicy configured; cannot verify PAY');
    return this.policyOverride;
  }

  /**
   * v3 (ADR 0004 (c)): the policy a `PAY` for `core` is verified against — the per-core
   * policy set with `setCorePolicy()`, else the default. `PricePolicy` is per video
   * (`creatorP2pk`, `satsPerBlock`, mints), so a multi-video seeder or a gateway sets one
   * per core; a single-video seeder just uses the default. Throws like `policy()` when
   * neither exists.
   */
  policyFor(core?: CoreKeyHex): PricePolicy {
    if (core !== undefined) {
      const p = this.corePolicies.get(core);
      if (p !== undefined) return p;
    }
    return this.policy();
  }

  /**
   * Set (or with `null` clear) the policy for one core. No `PRICE` is announced: the v2
   * `PRICE` message carries no core, so it cannot express a per-core change (a PRICE from
   * `setPolicy()` applies to every core on a connection). Peers learn the price for a core
   * from the manifest / `HELLO` and their `PAY` is verified against this policy from now on.
   */
  setCorePolicy(core: CoreKeyHex, policy: PricePolicy | null): void {
    if (policy === null) this.corePolicies.delete(core);
    else this.corePolicies.set(core, policy);
  }

  /** Per-core policies currently set (does not include the default). */
  corePolicyMap(): ReadonlyMap<CoreKeyHex, PricePolicy> {
    return this.corePolicies;
  }

  /**
   * Change the DEFAULT price policy. With `announce` (default) every live `pay/1` peer gets a
   * `PRICE` message; blocks already uploaded stay at the old price (`effectiveFromBlock`).
   */
  setPolicy(policy: PricePolicy, opts: { readonly announce?: boolean } = {}): void {
    const prev = this.policyOverride;
    const changed = prev !== null && prev.satsPerBlock !== policy.satsPerBlock;
    this.policyOverride = policy;
    if (!(opts.announce ?? true) || !changed) return;
    for (const [session, protocol] of this.protocols) {
      if (session.closed) continue;
      protocol.sendPrice({
        satsPerBlock: policy.satsPerBlock,
        effectiveFromBlock: session.uploadedBlocks,
      });
    }
  }

  session(noiseKey: Uint8Array | string): PeerSession | undefined {
    return this.sessions.get(noiseKey);
  }

  sessionInfos(): readonly PeerSessionInfo[] {
    return this.sessions.all().map((s) => s.info());
  }

  // ------------------------------------------------------------------ bans

  bans(): readonly PersistedBan[] {
    return this.banList.entries();
  }

  ban(target: { pubkey?: NostrPubkey; noiseKey?: Uint8Array }, reason: string): void {
    this.banList.ban({ pubkey: target.pubkey ?? null, noiseKey: target.noiseKey ?? null, reason });
    if (target.pubkey !== undefined) {
      if (!this.engine.isBanned(target.pubkey))
        this.engine.ban(target.pubkey, reason, target.noiseKey);
      this.sessions.cutPubkey(target.pubkey, 'banned');
    }
    if (target.noiseKey !== undefined) {
      this.sessions.get(target.noiseKey)?.cut('banned');
      this.swarm?.peerInfo(target.noiseKey)?.ban(true);
    }
  }

  unban(target: { pubkey?: NostrPubkey; noiseKey?: Uint8Array }): boolean {
    const ok = this.banList.unban(target);
    if (target.pubkey !== undefined && this.engine.isBanned(target.pubkey))
      this.engine.unban(target.pubkey);
    if (target.noiseKey !== undefined) this.swarm?.peerInfo(target.noiseKey)?.ban(false);
    return ok;
  }

  // ------------------------------------------------------------------ payment

  flushNow(): Promise<FlushResult> {
    return this.scheduler.flush('manual');
  }

  stats(): SeederStats {
    return {
      cores: this.blobs.openCores().length,
      blobs: this.index.entries().length,
      usedBytes: this.diskCap.usedBytes,
      capBytes: this.diskCap.capBytes,
      sessions: this.sessions.size,
      swarmConnections: this.swarm?.connections ?? 0,
      bans: this.banList.entries().length,
      flushes: this.scheduler.flushes,
      pendingPaidBlocks: this.scheduler.pendingBlocks,
    };
  }

  // ------------------------------------------------------------------ internals

  private afterPut(r: PutResult): PutResult {
    if (r.ok) this.emit({ type: 'blob-added', entry: r.entry, deduplicated: r.deduplicated });
    return r;
  }

  /**
   * Cores this session's stream replicates, as Corestore sees it: every open core with a
   * replication peer whose Noise key is the session's. Hypercore attaches a core to a
   * stream when both sides announce its discovery key, so this counts cores the peer has
   * opened even before it pulls a block. The bridge takes the max of this and the cores
   * the session has actually uploaded from.
   */
  private replicatedCores(session: PeerSession): number {
    let n = 0;
    for (const sc of this.blobs.openCores()) {
      if (sc.core.closed) continue;
      for (const peer of sc.core.peers) {
        if (peer.stream === session.stream || toHex(peer.remotePublicKey) === session.noiseKeyHex) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  private onCoreOpened(sc: SeedCore): void {
    if (!this.gates.has(sc.keyHex))
      this.gates.set(sc.keyHex, this.sessions.attachUploadGate(sc.core));
    if (this.started && this.swarm) this.swarm.join(sc.core.discoveryKey);
  }

  private onSwarmSession(session: PeerSession, conn: SwarmConnection, _info: PeerInfo): void {
    this.blobs.store.replicate(conn);
    this.log.info('swarm session', { noiseKey: session.noiseKeyHex });
  }

  private wireEvents(): void {
    this.unsubs.push(
      this.sessions.on((e: SessionEvent) => {
        switch (e.type) {
          case 'open':
            this.emit({ type: 'session-open', session: e.session.info() });
            break;
          case 'close': {
            const info = e.session.info();
            if (info.cutReason !== null)
              this.emit({ type: 'session-cut', session: info, reason: info.cutReason });
            this.emit({ type: 'session-close', session: info });
            break;
          }
          case 'refused':
            this.emit({ type: 'session-refused', noiseKeyHex: e.noiseKeyHex, reason: e.reason });
            break;
        }
      }),
    );
    // Belt and braces: an engine-side window decision (e.g. from a replayed bind) cuts too.
    this.unsubs.push(
      this.engine.onWindowExceeded((w) => {
        this.sessions.cutPubkey(w.peer, 'window-exceeded');
      }),
    );
    this.unsubs.push(
      this.engine.onDoubleSpend((peer, detail) => {
        this.log.warn('double-spend reported by mint — banning', {
          peer,
          mint: detail.mint,
          amount: detail.amount,
        });
        const noise = this.sessions.find(peer)[0]?.noiseKey ?? null;
        this.banList.ban({ pubkey: peer, noiseKey: noise, reason: 'double-spend' });
        this.sessions.cutPubkey(peer, 'banned');
        if (noise) this.swarm?.peerInfo(noise)?.ban(true);
        this.emit({ type: 'double-spend', peer, mint: detail.mint, amount: detail.amount });
      }),
    );
    this.unsubs.push(
      this.scheduler.onFlush((result, trigger) => {
        this.emit({ type: 'flush', result, trigger });
      }),
    );
  }

  private emit(e: SeederEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.log.error('seeder listener threw', { error: err });
      }
    }
  }
}
