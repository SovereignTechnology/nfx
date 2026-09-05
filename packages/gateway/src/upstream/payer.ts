/**
 * UpstreamPayer — the gateway as a VIEWER toward the seeders it pulls from (build-plan §5
 * "pays upstream"; SECURITY.md invariant 1 "pay after verify").
 *
 * Per (upstream peer, core) it counts Hypercore `download` events — each one is a block
 * whose Merkle proof already verified — and, every `payEveryBlocks` contiguous verified
 * blocks, asks `PaymentEngineViewer.pay(range, seeder, policy)` for a `PayMessage` and puts
 * it on the wire through the peer's `PayProtocol` (contract interface; Stage 2 implements
 * the codec/state machine, tests use a structural fake).
 *
 * CONTRACTS v3 (ADR 0004): every `BlockRange` built here carries `core`. The gateway
 * replicates many cores over one stream, so a core-less `PAY` would be `malformed` at any
 * v3 seeder — and `range-not-uploaded` is per core.
 *
 * Only peers that sent a verified `HELLO` (protocol `open`) are paid: without it there is
 * no pubkey / P2PK / mint to lock proofs to. Blocks downloaded from such a peer are still
 * counted and paid the moment its HELLO arrives.
 *
 * `PRICE` (seeder → viewer): `effectiveFromBlock` is honoured by splitting a run at the
 * boundary; blocks below it are paid at the old price. The message carries no core (v2
 * shape), so the new price applies to every core on that peer — see docs/lanes/L3.md.
 */
import type {
  BlockRange,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
} from '@sovit/core';
import type Hypercore from 'hypercore';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

/** Policy to pay `core` blocks from this peer under; `null` = do not pay (log + skip). */
export type UpstreamPolicyResolver = (
  core: CoreKeyHex,
  hello: HelloMessage,
  peer: string,
) => PricePolicy | null;

export interface UpstreamPayerOptions {
  readonly engine: PaymentEngineViewer;
  readonly logger: Logger;
  readonly payEveryBlocks: number;
  /** Mints the gateway can pay with; the first one the seeder also accepts is used. */
  readonly ownMints: readonly MintUrl[];
  readonly policyFor: UpstreamPolicyResolver;
}

interface PriceOverride {
  readonly satsPerBlock: Sats;
  readonly effectiveFromBlock: number;
}

interface PeerState {
  readonly noiseHex: string;
  readonly protocol: PayProtocol;
  hello: HelloMessage | null;
  price: PriceOverride | null;
  /** core → sorted set of downloaded-but-unpaid block indexes. */
  readonly pending: Map<CoreKeyHex, Set<number>>;
  /** core → indexes already paid (replay guard). */
  readonly paid: Map<CoreKeyHex, Set<number>>;
  chain: Promise<void>;
  closed: boolean;
}

export interface UpstreamPayerStats {
  readonly pays: number;
  readonly blocksPaid: number;
  readonly acksOk: number;
  readonly acksRejected: number;
  readonly skippedNoPolicy: number;
}

/** Read through a function so TS's property narrowing does not survive the `await`s. */
function isClosed(s: PeerState): boolean {
  return s.closed;
}

function contiguousRuns(sorted: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  let prev = 0;
  for (const i of sorted) {
    if (start === null) {
      start = i;
    } else if (i !== prev + 1) {
      runs.push([start, prev]);
      start = i;
    }
    prev = i;
  }
  if (start !== null) runs.push([start, prev]);
  return runs;
}

export class UpstreamPayer {
  private readonly engine: PaymentEngineViewer;
  private readonly log: Logger;
  private readonly payEvery: number;
  private readonly ownMints: readonly MintUrl[];
  private readonly policyFor: UpstreamPolicyResolver;
  private readonly peers = new Map<string, PeerState>();
  private readonly counters = {
    pays: 0,
    blocksPaid: 0,
    acksOk: 0,
    acksRejected: 0,
    skippedNoPolicy: 0,
  };

  constructor(o: UpstreamPayerOptions) {
    this.engine = o.engine;
    this.log = o.logger.child({ component: 'upstream-payer' });
    this.payEvery = Math.max(1, o.payEveryBlocks);
    this.ownMints = o.ownMints;
    this.policyFor = o.policyFor;
  }

  stats(): UpstreamPayerStats {
    return { ...this.counters };
  }

  /** Register a peer's `pay/1` instance. Returns a detach function. */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const state: PeerState = {
      noiseHex,
      protocol,
      hello: protocol.peer,
      price: null,
      pending: new Map(),
      paid: new Map(),
      chain: Promise.resolve(),
      closed: false,
    };
    this.peers.set(noiseHex, state);
    const offs = [
      protocol.on('open', (hello) => {
        state.hello = hello;
        this.log.info('upstream HELLO', {
          peer: noiseHex,
          pubkey: hello.pubkey,
          satsPerBlock: hello.satsPerBlock,
        });
        // Pre-HELLO downloads become payable now; runs shorter than `payEveryBlocks`
        // wait for more blocks or for `flush()` (close), like any other tail.
        this.schedule(state, false);
      }),
      protocol.on('price', (p) => {
        state.price = { satsPerBlock: p.satsPerBlock, effectiveFromBlock: p.effectiveFromBlock };
        this.log.info('upstream PRICE', {
          peer: noiseHex,
          satsPerBlock: p.satsPerBlock,
          effectiveFromBlock: p.effectiveFromBlock,
        });
      }),
      protocol.on('ack', (ack) => {
        if (ack.ok) this.counters.acksOk++;
        else {
          this.counters.acksRejected++;
          this.log.warn('upstream rejected PAY', {
            peer: noiseHex,
            fromBlock: ack.fromBlock,
            toBlock: ack.toBlock,
            reason: ack.reason,
          });
        }
      }),
      protocol.on('close', () => {
        state.closed = true;
      }),
    ];
    return () => {
      state.closed = true;
      for (const off of offs) off();
      if (this.peers.get(noiseHex) === state) this.peers.delete(noiseHex);
    };
  }

  /** Subscribe to a core's `download` events. Returns a detach function. */
  attachCore(core: Hypercore): () => void {
    const coreHex = toHex(core.key) as CoreKeyHex;
    const handler = (
      index: number,
      _byteLength: number,
      peer: { remotePublicKey: Uint8Array },
    ): void => {
      this.onDownload(coreHex, index, toHex(peer.remotePublicKey));
    };
    core.on('download', handler);
    return () => {
      core.off('download', handler);
    };
  }

  /** A verified block arrived from `noiseHex` for `core`. Synchronous; pays asynchronously. */
  onDownload(core: CoreKeyHex, index: number, noiseHex: string): void {
    const state = this.peers.get(noiseHex);
    if (!state || state.closed) return;
    if (state.paid.get(core)?.has(index)) return;
    let set = state.pending.get(core);
    if (!set) {
      set = new Set();
      state.pending.set(core, set);
    }
    set.add(index);
    if (set.size >= this.payEvery) this.schedule(state, false);
  }

  /** Pay every pending run for every peer (or one peer). Used at close and by tests. */
  flush(noiseHex?: string): Promise<void> {
    const targets = noiseHex === undefined ? [...this.peers.values()] : [this.peers.get(noiseHex)];
    const waits: Promise<void>[] = [];
    for (const s of targets) {
      if (!s) continue;
      this.schedule(s, true);
      waits.push(s.chain);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private schedule(state: PeerState, force: boolean): void {
    state.chain = state.chain
      .then(() => this.payPending(state, force))
      .catch((err: unknown) => {
        this.log.error('upstream pay failed', { peer: state.noiseHex, error: err });
      });
  }

  private async payPending(state: PeerState, force: boolean): Promise<void> {
    if (state.closed || state.hello === null) return;
    const hello = state.hello;
    for (const [core, set] of state.pending) {
      if (set.size === 0) continue;
      const sorted = [...set].sort((a, b) => a - b);
      for (const [from, to] of contiguousRuns(sorted)) {
        const n = to - from + 1;
        if (!force && n < this.payEvery) continue;
        const ranges = this.splitAtPrice(state, { core, fromBlock: from, toBlock: to });
        for (const range of ranges) {
          const policy = this.resolvePolicy(state, core, hello, range);
          if (policy === null) {
            this.counters.skippedNoPolicy++;
            continue;
          }
          const mint = hello.acceptedMints.find((m) => this.ownMints.includes(m));
          if (mint === undefined) {
            this.counters.skippedNoPolicy++;
            this.log.warn('no common mint with upstream — not paying', {
              peer: state.noiseHex,
              core,
            });
            continue;
          }
          const msg = await this.engine.pay(
            range,
            { pubkey: hello.pubkey, p2pk: hello.p2pk, mint },
            policy,
          );
          if (isClosed(state)) return;
          state.protocol.sendPay(msg);
          this.counters.pays++;
          this.counters.blocksPaid += range.toBlock - range.fromBlock + 1;
          let paidSet = state.paid.get(core);
          if (!paidSet) {
            paidSet = new Set();
            state.paid.set(core, paidSet);
          }
          for (let i = range.fromBlock; i <= range.toBlock; i++) {
            paidSet.add(i);
            set.delete(i);
          }
          this.log.debug('PAY sent upstream', {
            peer: state.noiseHex,
            core,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
          });
        }
      }
    }
  }

  private splitAtPrice(state: PeerState, r: Required<BlockRange>): Required<BlockRange>[] {
    const p = state.price;
    if (p === null || p.effectiveFromBlock <= r.fromBlock || p.effectiveFromBlock > r.toBlock)
      return [r];
    return [
      { core: r.core, fromBlock: r.fromBlock, toBlock: p.effectiveFromBlock - 1 },
      { core: r.core, fromBlock: p.effectiveFromBlock, toBlock: r.toBlock },
    ];
  }

  private resolvePolicy(
    state: PeerState,
    core: CoreKeyHex,
    hello: HelloMessage,
    range: Required<BlockRange>,
  ): PricePolicy | null {
    const base = this.policyFor(core, hello, state.noiseHex);
    if (base === null) {
      this.log.warn('no policy for upstream core — not paying', { peer: state.noiseHex, core });
      return null;
    }
    const p = state.price;
    if (p !== null && range.fromBlock >= p.effectiveFromBlock)
      return { ...base, satsPerBlock: p.satsPerBlock };
    return base;
  }
}

/**
 * Default resolver: price/split/mints from the seeder's HELLO, `creatorP2pk` + block size
 * from a per-core map (manifest-derived, `config.upstream.policies` / `setUpstreamPolicy`)
 * falling back to the gateway's base policy.
 */
export function helloPolicyResolver(
  base: PricePolicy,
  perCore: () => ReadonlyMap<CoreKeyHex, PricePolicy>,
): UpstreamPolicyResolver {
  return (core, hello) => {
    const override = perCore().get(core);
    return {
      satsPerBlock: hello.satsPerBlock,
      blockSize: override?.blockSize ?? base.blockSize,
      mints: hello.acceptedMints,
      split: hello.split,
      creatorP2pk: override?.creatorP2pk ?? base.creatorP2pk,
    };
  };
}
