import type { PayMessage, RejectReason } from './payment.js';
import type { CashuP2pkPubkey, MintUrl, NostrPubkey, Sats } from './primitives.js';

/**
 * `pay/1` — the payment side channel muxed onto the Hypercore replication stream
 * (build-plan §2.3, assumption A3). Protocol name on the wire: `pay/1`.
 *
 * Message codec = `compact-encoding`. State machine and protomux attach land in Stage 2
 * (`core/src/pay-protocol/`, locked). The fuzz harness (L10) targets the codec.
 */

export const PAY_PROTOCOL_NAME = 'pay/1' as const;
export const PAY_PROTOCOL_VERSION = 1 as const;

export interface HelloMessage {
  readonly type: 'HELLO';
  readonly version: number;
  readonly pubkey: NostrPubkey;
  /** Schnorr signature over `challenge` by `pubkey`, proving key possession. */
  readonly challenge: string;
  readonly signature: string;
  /** Seeder → viewer: what this seeder charges. Viewer → seeder: what it can pay with. */
  readonly acceptedMints: readonly MintUrl[];
  readonly satsPerBlock: Sats;
  readonly split: { readonly seeder: number; readonly creator: number };
  /** Seeder's own P2PK pubkey (lock target for `seederProofs`). */
  readonly p2pk: CashuP2pkPubkey;
}

export interface PayWireMessage {
  readonly type: 'PAY';
  readonly payload: PayMessage;
}

export interface AckMessage {
  readonly type: 'ACK';
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly ok: boolean;
  readonly reason?: RejectReason;
}

export interface PriceMessage {
  readonly type: 'PRICE';
  readonly satsPerBlock: Sats;
  /** Blocks at the old price still honoured; viewer may leave. */
  readonly effectiveFromBlock: number;
}

export type PayProtocolMessage = HelloMessage | PayWireMessage | AckMessage | PriceMessage;

export type PayProtocolState =
  | 'idle'
  | 'hello-sent'
  | 'open' // both HELLOs verified
  | 'closed';

/**
 * Minimal view of a protomux instance the protocol attaches to. Kept structural so the
 * contract has no dependency on `protomux`; the implementation narrows it.
 */
export interface MuxLike {
  createChannel(opts: {
    protocol: string;
    id?: Uint8Array | null;
    onopen?: () => void;
    onclose?: () => void;
    ondestroy?: () => void;
  }): unknown;
}

export interface PayProtocolEvents {
  open: (peer: HelloMessage) => void;
  pay: (msg: PayMessage) => void;
  ack: (msg: AckMessage) => void;
  price: (msg: PriceMessage) => void;
  /** Local decision to cut the stream (window exceeded / banned / protocol error). */
  close: (reason: 'window-exceeded' | 'banned' | 'protocol-error' | 'remote' | 'local') => void;
}

export interface PayProtocol {
  readonly state: PayProtocolState;
  readonly peer: HelloMessage | null;

  /** Attach to a mux shared with Hypercore replication on the same stream. */
  attach(mux: MuxLike): void;

  sendHello(hello: Omit<HelloMessage, 'type'>): void;
  sendPay(msg: PayMessage): void;
  sendAck(ack: Omit<AckMessage, 'type'>): void;
  sendPrice(price: Omit<PriceMessage, 'type'>): void;

  /**
   * Cut this peer. Per spike S-A there is no per-peer upload pause in Hypercore, so this is
   * `peerInfo.ban(true)` (hyperswarm, prevents reconnect) followed by `stream.destroy()`.
   * For `window-exceeded` it MUST run synchronously inside the `upload` handler (no await,
   * no ACK first); for protocol decisions an `ACK{ok:false}` may be sent before the cut.
   */
  cut(reason: Parameters<PayProtocolEvents['close']>[0]): void;

  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void;
}

/** Codec contract, fuzzed by L10. Must never throw on arbitrary bytes: return `null`. */
export interface PayProtocolCodec {
  encode(msg: PayProtocolMessage): Uint8Array;
  decode(buf: Uint8Array): PayProtocolMessage | null;
}
