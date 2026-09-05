/**
 * Minimal ambient declarations for the Holepunch stack, covering EXACTLY the surface the
 * gateway (and the `@sovit/seeder` `.d.ts` it consumes) touches. `@sovit/seeder` keeps its
 * own copy under `src/types/` which `tsc -b` does not emit into `dist/`, so every consumer
 * must supply the same module shapes — this file is that copy plus `userData` (the protomux
 * instance Hypercore parks on the Noise stream) which the `pay/1` attach needs.
 *
 * Written against hypercore@11.35.3, hyperblobs@2.12.1, corestore@7.12.2, hyperswarm@4.17.0
 * by reading their source. Nothing here is a full typing of those libraries.
 */

declare module 'hypercore' {
  import type { EventEmitter } from 'node:events';

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
    /** Set by `Hypercore.createProtocolStream` to the `Protomux` instance of this connection. */
    userData: unknown;
    destroy(err?: Error): void;
    end(): void;
    on(event: 'close' | 'connect', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'close' | 'connect', cb: () => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    pipe<T extends { pipe: unknown }>(dest: T): T;
  }

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
  import type { ReplicationStream, ReplicationStreamOptions } from 'hypercore';

  export interface CorestoreGetOptions {
    readonly name?: string;
    readonly key?: Uint8Array;
  }

  class Corestore {
    constructor(storage: string);
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: CorestoreGetOptions): Hypercore;
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

  /** streamx Readable: async-iterable, destroyable. */
  export interface BlobReadStream extends AsyncIterable<Uint8Array> {
    readonly destroyed: boolean;
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
