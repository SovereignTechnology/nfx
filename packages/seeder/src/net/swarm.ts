/**
 * Hyperswarm wrapper: one swarm per seeder, one `join(discoveryKey)` per seeded core,
 * ban-list firewall at handshake time (Noise key), admission through the SessionRegistry.
 *
 * `bootstrap` is passed straight to hyperswarm/hyperdht — production uses the default
 * public bootstrap nodes; tests pass a local `hyperdht` testnet so nothing leaves loopback.
 */
import Hyperswarm from 'hyperswarm';
import type { HyperswarmOptions, PeerDiscovery, PeerInfo, SwarmConnection } from 'hyperswarm';

import type { Logger } from '../log/logger.js';
import type { BanList } from '../store/ban-list.js';
import { toHex } from '../util/hex.js';
import type { PeerSession } from './peer-session.js';
import type { SessionRegistry } from './session-registry.js';

export interface SwarmConfig {
  readonly bootstrap?: readonly { host: string; port: number }[];
  readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  readonly seed?: Uint8Array;
  readonly maxPeers?: number;
  /** Join topics as server (announce) and/or client (lookup). Seeders default to server-only. */
  readonly server?: boolean;
  readonly client?: boolean;
}

export interface SwarmManagerOptions {
  readonly config: SwarmConfig;
  readonly banList: BanList;
  readonly registry: SessionRegistry;
  readonly logger: Logger;
  /** Attach replication (and anything else, e.g. `pay/1`) to an admitted connection. */
  readonly onSession: (session: PeerSession, conn: SwarmConnection, info: PeerInfo) => void;
}

export class SwarmManager {
  private swarm: Hyperswarm | null = null;
  private readonly joined = new Map<string, PeerDiscovery>();
  private readonly log: Logger;

  constructor(private readonly opts: SwarmManagerOptions) {
    this.log = opts.logger.child({ component: 'swarm' });
  }

  get started(): boolean {
    return this.swarm !== null;
  }

  get publicKey(): Uint8Array | null {
    return this.swarm?.keyPair.publicKey ?? null;
  }

  get connections(): number {
    return this.swarm?.connections.size ?? 0;
  }

  /** UDP address the swarm's DHT node is bound to (null until listening). */
  address(): { host: string; port: number } | null {
    return this.swarm?.dht.address() ?? null;
  }

  peerInfo(noiseKey: Uint8Array | string): PeerInfo | undefined {
    return this.swarm?.peers.get(typeof noiseKey === 'string' ? noiseKey : toHex(noiseKey));
  }

  start(): void {
    if (this.swarm) return;
    const c = this.opts.config;
    const swarmOpts: HyperswarmOptions = {
      firewall: this.opts.banList.firewall,
      ...(c.bootstrap ? { bootstrap: c.bootstrap } : {}),
      ...(c.keyPair ? { keyPair: c.keyPair } : {}),
      ...(c.seed ? { seed: c.seed } : {}),
      ...(c.maxPeers !== undefined ? { maxPeers: c.maxPeers } : {}),
    };
    const swarm = new Hyperswarm(swarmOpts);
    swarm.on('connection', (conn, info) => {
      const session = this.opts.registry.admit(conn, info);
      if (session === null) return;
      this.opts.onSession(session, conn, info);
    });
    swarm.on('ban', (info, err) => {
      this.log.info('swarm banned peer', { noiseKey: toHex(info.publicKey), error: err.message });
    });
    this.swarm = swarm;
    this.log.info('swarm started', { publicKey: toHex(swarm.keyPair.publicKey) });
  }

  /** Announce/lookup a core. Idempotent per discovery key. */
  join(discoveryKey: Uint8Array): PeerDiscovery {
    if (!this.swarm) throw new Error('swarm not started');
    const hex = toHex(discoveryKey);
    const existing = this.joined.get(hex);
    if (existing) return existing;
    const d = this.swarm.join(discoveryKey, {
      server: this.opts.config.server ?? true,
      client: this.opts.config.client ?? false,
    });
    this.joined.set(hex, d);
    this.log.info('joined topic', { topic: hex });
    return d;
  }

  async leave(discoveryKey: Uint8Array): Promise<void> {
    const hex = toHex(discoveryKey);
    const d = this.joined.get(hex);
    if (!d) return;
    this.joined.delete(hex);
    await d.destroy();
  }

  /** Waits for pending announces/connections (test helper; heavyweight). */
  async flush(): Promise<void> {
    await this.swarm?.flush();
  }

  async flushedAll(): Promise<void> {
    await Promise.all([...this.joined.values()].map((d) => d.flushed()));
  }

  async destroy(): Promise<void> {
    const swarm = this.swarm;
    if (!swarm) return;
    this.swarm = null;
    this.joined.clear();
    await swarm.destroy();
    this.log.info('swarm destroyed');
  }
}
