/**
 * Minimal ambient declarations for the Holepunch stack, covering EXACTLY the surface the
 * seeder uses. Written against the pinned versions (hypercore@11.35.3, hyperblobs@2.12.1,
 * corestore@7.12.2, hyperswarm@4.17.0, hyperdht@6.34.0) by reading their source — see
 * docs/lanes/L2.md. Nothing here is a full typing of those libraries.
 */

declare module 'hypercore' {
  import type { EventEmitter } from 'node:events';

  /**
   * The `peer` argument of the `upload` / `download` events: `lib/replicator.js` `Peer`.
   * Only public-ish fields the seeder reads. `stream` is the protomux stream, i.e. the
   * Noise secret stream of the connection (hyperswarm `conn`); `remotePublicKey` is the
   * remote Noise public key (32 bytes), set from `stream.remotePublicKey` at peer creation.
   */
  export interface ReplicationPeer {
    readonly remotePublicKey: Uint8Array;
    readonly stream: ReplicationStream;
  }

  /** Duplex-ish stream (streamx). Only what we call. */
  export interface ReplicationStream {
    readonly remotePublicKey: Uint8Array | null;
    readonly publicKey: Uint8Array | null;
    readonly noiseStream: ReplicationStream;
    readonly rawStream: ReplicationStream | null;
    readonly opened: Promise<boolean>;
    readonly destroyed: boolean;
    /**
     * On the Noise stream: set by `Hypercore.createProtocolStream()` to the `Protomux`
     * instance of this connection (`hypercore/index.js` `noiseStream.userData = protocol`).
     * Absent on stand-ins that never went through Hypercore.
     */
    readonly userData?: unknown;
    destroy(err?: Error): void;
    on(event: 'close' | 'connect', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'close' | 'connect', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    pipe<T extends { pipe: unknown }>(dest: T): T;
  }

  /** Forwarded to `NoiseSecretStream` when a boolean is passed (fresh stream). */
  export interface ReplicationStreamOptions {
    readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly keepAlive?: number | false;
  }

  export interface HypercoreGetOptions {
    readonly wait?: boolean;
    readonly timeout?: number;
  }

  export interface HypercoreEvents {
    upload: (index: number, byteLength: number, peer: ReplicationPeer) => void;
    download: (index: number, byteLength: number, peer: ReplicationPeer) => void;
    'peer-add': (peer: ReplicationPeer) => void;
    'peer-remove': (peer: ReplicationPeer) => void;
    append: () => void;
    close: () => void;
  }

  class Hypercore extends EventEmitter {
    readonly key: Uint8Array;
    readonly discoveryKey: Uint8Array;
    readonly length: number;
    readonly byteLength: number;
    readonly contiguousLength: number;
    readonly opened: boolean;
    readonly closed: boolean;
    readonly writable: boolean;
    readonly peers: readonly ReplicationPeer[];
    ready(): Promise<void>;
    close(): Promise<void>;
    has(index: number): Promise<boolean>;
    get(index: number, opts?: HypercoreGetOptions): Promise<Uint8Array | null>;
    append(block: Uint8Array | readonly Uint8Array[]): Promise<{ length: number }>;
    replicate(isInitiator: boolean | ReplicationStream): ReplicationStream;
    on<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
    off<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
    once<K extends keyof HypercoreEvents>(event: K, cb: HypercoreEvents[K]): this;
  }

  export default Hypercore;
}

declare module 'corestore' {
  import type Hypercore from 'hypercore';
  import type { ReplicationStream } from 'hypercore';

  export interface CorestoreGetOptions {
    readonly name?: string;
    readonly key?: Uint8Array;
  }

  class Corestore {
    constructor(storage: string);
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: CorestoreGetOptions): Hypercore;
    /**
     * Boolean → returns the raw side of a fresh Noise stream to pipe somewhere; a stream
     * with a `noiseStream` (e.g. a hyperswarm connection) → attaches to it and returns it.
     */
    replicate(
      isInitiator: boolean | ReplicationStream,
      opts?: ReplicationStreamOptions,
    ): ReplicationStream;
  }

  export default Corestore;
}

declare module 'hyperblobs' {
  import type Hypercore from 'hypercore';
  import type { HypercoreGetOptions } from 'hypercore';

  /** Exactly `{ byteOffset, blockOffset, blockLength, byteLength }` as `put()` returns. */
  export interface BlobId {
    readonly byteOffset: number;
    readonly blockOffset: number;
    readonly blockLength: number;
    readonly byteLength: number;
  }

  export interface BlobWriteStream {
    readonly id: BlobId;
    write(chunk: Uint8Array): boolean;
    end(): void;
    once(event: 'close' | 'drain', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    on(event: 'drain', cb: () => void): this;
    off(event: 'drain', cb: () => void): this;
    destroy(err?: Error): void;
  }

  export interface BlobReadStream extends AsyncIterable<Uint8Array> {
    destroy(err?: Error): void;
  }

  export interface BlobGetOptions extends HypercoreGetOptions {
    readonly start?: number;
    readonly end?: number;
    readonly length?: number;
  }

  class Hyperblobs {
    constructor(core: Hypercore, opts?: { readonly blockSize?: number });
    readonly core: Hypercore;
    readonly blockSize: number;
    ready(): Promise<void>;
    close(): Promise<void>;
    put(blob: Uint8Array, opts?: { readonly blockSize?: number }): Promise<BlobId>;
    get(id: BlobId, opts?: BlobGetOptions): Promise<Uint8Array | null>;
    clear(id: BlobId): Promise<void>;
    createReadStream(id: BlobId, opts?: BlobGetOptions): BlobReadStream;
    createWriteStream(): BlobWriteStream;
  }

  export default Hyperblobs;
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  import type { ReplicationStream } from 'hypercore';

  export interface PeerInfo {
    readonly publicKey: Uint8Array;
    readonly topics: readonly Uint8Array[];
    readonly banned: boolean;
    readonly client: boolean;
    ban(banStatus?: boolean): void;
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface HyperswarmOptions {
    readonly keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly seed?: Uint8Array;
    readonly maxPeers?: number;
    readonly bootstrap?: readonly { host: string; port: number }[];
    /** Return `true` to REJECT the connection. Must be synchronous. */
    readonly firewall?: (remotePublicKey: Uint8Array) => boolean;
  }

  export interface SwarmConnection extends ReplicationStream {
    readonly remotePublicKey: Uint8Array;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    readonly dht: { address(): { host: string; port: number } | null };
    readonly peers: ReadonlyMap<string, PeerInfo>;
    readonly connections: ReadonlySet<SwarmConnection>;
    readonly destroyed: boolean;
    join(
      topic: Uint8Array,
      opts?: { readonly server?: boolean; readonly client?: boolean },
    ): PeerDiscovery;
    leave(topic: Uint8Array): Promise<void>;
    flush(): Promise<void>;
    listen(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', cb: (conn: SwarmConnection, info: PeerInfo) => void): this;
    on(event: 'ban', cb: (info: PeerInfo, err: Error) => void): this;
    on(event: 'update', cb: () => void): this;
  }

  export default Hyperswarm;
}

declare module 'hyperdht' {
  class DHT {
    constructor(opts?: { readonly bootstrap?: readonly { host: string; port: number }[] });
    static keyPair(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
    destroy(): Promise<void>;
  }
  export default DHT;
}

declare module 'hyperdht/testnet.js' {
  export interface Testnet {
    readonly bootstrap: readonly { host: string; port: number }[];
    destroy(): Promise<void>;
  }
  function createTestnet(size?: number): Promise<Testnet>;
  export default createTestnet;
}
