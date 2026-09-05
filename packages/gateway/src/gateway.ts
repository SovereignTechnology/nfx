/**
 * Gateway — `@sovit/seeder` plus a WS bridge, Blossom HTTP and upstream paying
 * (build-plan §5). This is the façade the CLI entry (`cli/main.ts`), the L7 web-shell's
 * dev harness and the tests drive. See docs/lanes/L3.md for the public surface.
 *
 * To a browser the gateway IS a seeder: every session (WS-bridged or swarm) gets a `pay/1`
 * instance from the injected factory, the seeder's pay bridge (HELLO → bind, PAY → verify
 * → ACK) and a `HELLO` disclosing the gateway's OWN price = base policy marked up by
 * `markupPercent` (build-plan §9 Q4, resolved by ADR 0005; default 0). Toward upstream
 * seeders it is a viewer: `UpstreamPayer` pays per verified block with `range.core` set.
 *
 * One `PaymentEngine` interface, two roles (contracts/payment.ts): `seederEngine` accounts
 * downstream peers, `viewerEngine` mints upstream payments. Pass the same object for both
 * or one per side. Stage 1 wires `MockPaymentEngine('honest')`; Stage 2 drops the real
 * engine behind the same interfaces.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Duplex as NodeDuplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type {
  CoreKeyHex,
  MuxLike,
  PaymentEngineSeeder,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { PAY_PROTOCOL_VERSION } from '@sovit/core';
import type {
  Logger,
  PeerSessionInfo,
  SeedCore,
  SeederCrypto,
  SeederEvent,
  SeederFs,
} from '@sovit/seeder';
import { RateLimiter, Seeder, fromHex, nodeAdapters, silentLogger } from '@sovit/seeder';

import type { BlossomAuth } from './auth/index.js';
import { BlossomHandler, UPLOAD_SPOOL_DIR } from './blossom/handler.js';
import type { MirrorFetch } from './blossom/handler.js';
import { OwnerIndex, ReportStore } from './blossom/store.js';
import type { GatewayConfig } from './config.js';
import { gatewayPolicy, gatewayPrice } from './config.js';
import { UpstreamPayer, helloPolicyResolver } from './upstream/payer.js';
import type { UpstreamPolicyResolver } from './upstream/payer.js';
import { WsBridge } from './ws/bridge.js';

/** The gateway's `pay/1` identity. Signing is NOT this package's — inject a Signer-backed one. */
export interface GatewayIdentity {
  /** Prove possession of `config.identity.pubkey` over `challenge` (Schnorr, by the Signer). */
  signChallenge(challenge: string): Promise<string>;
}

/**
 * Builds a NOT-yet-attached `PayProtocol` for one session; the gateway calls
 * `attach(mux)` itself. Stage 2 supplies the real one (`core/src/pay-protocol/`, locked).
 */
export type PayProtocolFactory = (session: PeerSessionInfo) => PayProtocol;

export interface GatewayDeps {
  readonly seederEngine: PaymentEngineSeeder & {
    readonly config?: { readonly flushEveryBlocks: number; readonly flushEveryMs: number };
  };
  readonly viewerEngine: PaymentEngineViewer;
  /** `null` = no provider yet (Stage 1 runtime): authenticated Blossom verbs answer 503. */
  readonly auth: BlossomAuth | null;
  /** `null` = no `pay/1` implementation yet: sessions run without it and non-payers are cut. */
  readonly payProtocol: PayProtocolFactory | null;
  readonly identity: GatewayIdentity;
  readonly fs?: SeederFs;
  readonly crypto?: SeederCrypto;
  readonly logger?: Logger;
  /** Milliseconds since epoch. */
  readonly now?: () => number;
  readonly mirrorFetch?: MirrorFetch;
  readonly upstreamPolicy?: UpstreamPolicyResolver;
}

export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
}

export interface GatewayStats {
  readonly listening: GatewayAddress | null;
  readonly seeder: ReturnType<Seeder['stats']>;
  readonly wsConnections: number;
  readonly httpActive: number;
  readonly upstream: ReturnType<UpstreamPayer['stats']>;
  readonly satsPerBlock: Sats;
}

function isMuxLike(x: unknown): x is MuxLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { createChannel?: unknown }).createChannel === 'function'
  );
}

export class Gateway {
  readonly config: GatewayConfig;
  readonly seeder: Seeder;
  readonly log: Logger;
  readonly payer: UpstreamPayer;
  readonly bridge: WsBridge;
  readonly blossom: BlossomHandler;
  readonly owners: OwnerIndex;
  readonly reports: ReportStore;
  private readonly server: Server;
  private readonly httpLimiter: RateLimiter;
  private readonly deps: GatewayDeps;
  private readonly detachers = new Map<string, () => void>();
  private readonly coreDetachers = new Map<string, () => void>();
  private readonly upstreamPolicies = new Map<CoreKeyHex, PricePolicy>();
  private readonly unsubs: (() => void)[] = [];
  private address: GatewayAddress | null = null;
  private closed = false;

  private constructor(
    config: GatewayConfig,
    deps: GatewayDeps,
    seeder: Seeder,
    loaded: { owners: OwnerIndex; reports: ReportStore },
  ) {
    this.config = config;
    this.deps = deps;
    this.seeder = seeder;
    this.log = (deps.logger ?? silentLogger).child({ component: 'gateway' });
    this.owners = loaded.owners;
    this.reports = loaded.reports;
    for (const [k, v] of Object.entries(config.upstream.policies))
      this.upstreamPolicies.set(k as CoreKeyHex, v);

    this.payer = new UpstreamPayer({
      engine: deps.viewerEngine,
      logger: this.log,
      payEveryBlocks: config.upstream.payEveryBlocks,
      ownMints: config.acceptedMints,
      policyFor:
        deps.upstreamPolicy ?? helloPolicyResolver(config.policy, () => this.upstreamPolicies),
    });
    this.bridge = new WsBridge({ seeder, limits: config.ws, logger: this.log });
    this.blossom = new BlossomHandler({
      seeder,
      auth: deps.auth,
      config: config.blossom,
      http: config.http,
      dataDir: config.dataDir,
      owners: loaded.owners,
      reports: loaded.reports,
      logger: this.log,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.mirrorFetch ? { mirrorFetch: deps.mirrorFetch } : {}),
    });
    this.httpLimiter = new RateLimiter(
      {
        maxStreams: config.http.maxConcurrentRequests,
        maxStreamsPerKey: config.http.maxConcurrentPerClient,
        connectsPerWindow: config.http.requestsPerWindow,
        windowMs: config.http.windowMs,
      },
      deps.now ?? Date.now,
    );
    this.server = createServer({
      // Slow-loris: headers must arrive quickly; bodies are bounded by their own idle
      // timeout in http/body.ts (a multi-GB upload legitimately outlives any fixed cap).
      headersTimeout: config.http.headersTimeoutMs,
      requestTimeout: 0,
      keepAliveTimeout: config.http.socketIdleTimeoutMs,
      maxHeaderSize: 16 * 1024,
    });
    this.server.on('connection', (socket) => {
      socket.setTimeout(config.http.socketIdleTimeoutMs, () => {
        socket.destroy();
      });
    });
    this.server.on('request', (req, res) => {
      this.onRequest(req, res);
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.onUpgrade(req, socket, head);
    });
    this.server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      if (err.code === 'ECONNRESET' || !socket.writable) {
        socket.destroy();
        return;
      }
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  /** Open storage, load side tables, create the seeder. Does not listen or touch the network. */
  static async create(config: GatewayConfig, deps: GatewayDeps): Promise<Gateway> {
    const logger = deps.logger ?? silentLogger;
    const fs = deps.fs ?? nodeAdapters.fs;
    const crypto = deps.crypto ?? nodeAdapters.crypto;
    const seeder = await Seeder.create(
      {
        dataDir: config.dataDir,
        blockSize: config.blockSize,
        diskCapBytes: config.diskCapBytes,
        rateLimits: config.rateLimits,
        swarm: config.swarm,
        policy: gatewayPolicy(config),
        flushEveryBlocks: config.flushEveryBlocks,
        flushEveryMs: config.flushEveryMs,
      },
      {
        engine: deps.seederEngine,
        fs,
        crypto,
        logger,
        ...(deps.now ? { now: deps.now } : {}),
      },
    );
    await seeder.openCore('blobs');
    await mkdir(path.join(config.dataDir, UPLOAD_SPOOL_DIR), { recursive: true, mode: 0o700 });
    const owners = new OwnerIndex(config.dataDir, logger);
    const reports = new ReportStore(config.dataDir, logger);
    await Promise.all([owners.load(), reports.load()]);
    if (deps.auth) {
      for (const pk of config.blossom.allowPubkeys) deps.auth.allow(pk);
      for (const pk of config.blossom.denyPubkeys) deps.auth.deny(pk);
    }
    const gw = new Gateway(config, deps, seeder, { owners, reports });
    gw.wireSeeder();
    for (const sc of seeder.blobs.openCores()) gw.watchCore(sc);
    gw.log.info('gateway created', {
      dataDir: config.dataDir,
      satsPerBlock: gw.price(),
      markupPercent: config.markupPercent,
      auth: deps.auth !== null,
      payProtocol: deps.payProtocol !== null,
    });
    return gw;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the seeder (swarm if configured) and bind the HTTP/WS listener. */
  async listen(): Promise<GatewayAddress> {
    if (this.closed) throw new Error('gateway is closed');
    if (this.address) return this.address;
    this.seeder.start();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.listen.port, this.config.listen.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const a = this.server.address() as AddressInfo;
    this.address = { host: a.address, port: a.port };
    this.log.info('gateway listening', {
      host: a.address,
      port: a.port,
      wsPath: this.config.ws.path,
    });
    return this.address;
  }

  /** Graceful stop: pay what is owed upstream, drop sockets, close seeder + listener. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubs) off();
    await this.payer.flush().catch(() => undefined);
    await this.bridge.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
    for (const off of this.detachers.values()) off();
    this.detachers.clear();
    for (const off of this.coreDetachers.values()) off();
    this.coreDetachers.clear();
    await this.seeder.close();
    await Promise.all([this.owners.flushed(), this.reports.flushed()]);
    this.address = null;
    this.log.info('gateway closed');
  }

  // ------------------------------------------------------------------ pricing

  /** What `HELLO` discloses: `ceil(policy.satsPerBlock × (100 + markupPercent) / 100)`. */
  price(): Sats {
    return gatewayPrice(this.config);
  }

  /** Per-core policy used when paying upstream (creator P2PK etc. from the manifest). */
  setUpstreamPolicy(core: CoreKeyHex, policy: PricePolicy): void {
    this.upstreamPolicies.set(core, policy);
  }

  // ------------------------------------------------------------------ upstream cores

  /**
   * Replicate a remote core (read-only replica) and pay for what is downloaded from it.
   * Hex or raw key. Idempotent.
   */
  async openUpstreamCore(key: CoreKeyHex | string | Uint8Array): Promise<SeedCore> {
    const raw = typeof key === 'string' ? fromHex(key) : key;
    const sc = await this.seeder.blobs.openCoreByKey(raw);
    this.watchCore(sc);
    return sc;
  }

  stats(): GatewayStats {
    return {
      listening: this.address,
      seeder: this.seeder.stats(),
      wsConnections: this.bridge.connections,
      httpActive: this.httpLimiter.activeStreams,
      upstream: this.payer.stats(),
      satsPerBlock: this.price(),
    };
  }

  // ------------------------------------------------------------------ internals

  private watchCore(sc: SeedCore): void {
    if (this.coreDetachers.has(sc.keyHex)) return;
    this.coreDetachers.set(sc.keyHex, this.payer.attachCore(sc.core));
  }

  private wireSeeder(): void {
    this.unsubs.push(
      this.seeder.on((e: SeederEvent) => {
        switch (e.type) {
          case 'session-open':
            this.onSessionOpen(e.session);
            break;
          case 'session-close': {
            const off = this.detachers.get(e.session.noiseKeyHex);
            if (off) {
              this.detachers.delete(e.session.noiseKeyHex);
              off();
            }
            break;
          }
          case 'session-cut':
            this.log.info('session cut', { noiseKey: e.session.noiseKeyHex, reason: e.reason });
            break;
          case 'blob-removed':
            this.owners.remove(e.sha256 as Parameters<OwnerIndex['remove']>[0]);
            break;
          case 'session-refused':
          case 'blob-added':
          case 'flush':
          case 'double-spend':
            break;
        }
      }),
    );
  }

  private onSessionOpen(info: PeerSessionInfo): void {
    const session = this.seeder.session(info.noiseKeyHex);
    if (!session) return;
    if (this.deps.payProtocol === null) {
      this.log.warn('session without pay/1 (no protocol factory wired)', {
        noiseKey: info.noiseKeyHex,
      });
      return;
    }
    const mux: unknown = session.stream.noiseStream.userData;
    if (!isMuxLike(mux)) {
      this.log.error('session stream carries no protomux — cannot attach pay/1', {
        noiseKey: info.noiseKeyHex,
      });
      return;
    }
    const protocol = this.deps.payProtocol(info);
    protocol.attach(mux);
    const detachBridge = this.seeder.attachPayProtocol(session, protocol);
    const detachPayer = this.payer.attachPeer(info.noiseKeyHex, protocol);
    this.detachers.set(info.noiseKeyHex, () => {
      detachBridge();
      detachPayer();
    });
    void this.sendHello(session.noiseKeyHex, protocol);
  }

  /** HELLO: the gateway's own price (base marked up by %), its mints, split and P2PK target. */
  private async sendHello(noiseKeyHex: string, protocol: PayProtocol): Promise<void> {
    const challenge = randomBytes(32).toString('hex');
    let signature: string;
    try {
      signature = await this.deps.identity.signChallenge(challenge);
    } catch (err) {
      this.log.error('HELLO signing failed', { noiseKey: noiseKeyHex, error: err });
      return;
    }
    if (protocol.state === 'closed') return;
    const policy = gatewayPolicy(this.config);
    protocol.sendHello({
      version: PAY_PROTOCOL_VERSION,
      pubkey: this.config.identity.pubkey,
      challenge,
      signature,
      acceptedMints: this.config.acceptedMints,
      satsPerBlock: policy.satsPerBlock,
      split: policy.split,
      p2pk: this.config.identity.p2pk,
    });
    this.log.debug('HELLO sent', { noiseKey: noiseKeyHex, satsPerBlock: policy.satsPerBlock });
  }

  private clientKey(req: IncomingMessage): string {
    if (this.config.http.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const admitted = this.httpLimiter.admit(this.clientKey(req));
    if (!admitted.ok) {
      res.statusCode = 429;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Retry-After', String(Math.ceil(this.config.http.windowMs / 1000)));
      res.setHeader('X-Reason', 'rate limited');
      res.end();
      return;
    }
    res.once('close', admitted.release);
    this.blossom.handle(req, res).catch((err: unknown) => {
      this.log.error('request handler threw', { error: err });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('X-Reason', 'internal error');
        res.end();
      } else res.destroy();
    });
  }

  private onUpgrade(req: IncomingMessage, socket: NodeDuplex, head: Buffer): void {
    // The WS bridge has its own liveness (ping/pong); the plain-HTTP idle timer must go.
    (socket as NodeDuplex & { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    const admitted = this.httpLimiter.admit(this.clientKey(req));
    if (!admitted.ok) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n', () => {
        socket.destroy();
      });
      return;
    }
    socket.once('close', admitted.release);
    const refused = this.bridge.handleUpgrade(req, socket, head);
    if (refused !== null) this.log.info('ws upgrade refused', { reason: refused });
  }
}
