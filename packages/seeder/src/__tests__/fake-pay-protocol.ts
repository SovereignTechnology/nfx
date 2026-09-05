/**
 * In-memory stand-in for the contract `PayProtocol` (the real one lands in Stage 2). It
 * records what the seeder sends and lets tests inject remote events.
 */
import type {
  AckMessage,
  HelloMessage,
  MuxLike,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
  PayProtocolState,
  PriceMessage,
} from '@sovit/core';

type Listeners = { [K in keyof PayProtocolEvents]: Set<PayProtocolEvents[K]> };

export class FakePayProtocol implements PayProtocol {
  state: PayProtocolState = 'idle';
  peer: HelloMessage | null = null;
  readonly acks: AckMessage[] = [];
  readonly prices: PriceMessage[] = [];
  readonly sentPays: PayMessage[] = [];
  readonly cuts: Parameters<PayProtocolEvents['close']>[0][] = [];
  private readonly listeners: Listeners = {
    open: new Set(),
    pay: new Set(),
    ack: new Set(),
    price: new Set(),
    close: new Set(),
  };

  attach(_mux: MuxLike): void {
    this.state = 'hello-sent';
  }
  sendHello(_hello: Omit<HelloMessage, 'type'>): void {
    this.state = 'hello-sent';
  }
  sendPay(msg: PayMessage): void {
    this.sentPays.push(msg);
  }
  sendAck(ack: Omit<AckMessage, 'type'>): void {
    this.acks.push({ type: 'ACK', ...ack });
  }
  sendPrice(price: Omit<PriceMessage, 'type'>): void {
    this.prices.push({ type: 'PRICE', ...price });
  }
  cut(reason: Parameters<PayProtocolEvents['close']>[0]): void {
    this.cuts.push(reason);
    this.state = 'closed';
  }
  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void {
    const set = this.listeners[event] as Set<PayProtocolEvents[K]>;
    set.add(cb);
    return () => set.delete(cb);
  }

  // ---- test hooks: simulate the remote side
  remoteHello(hello: HelloMessage): void {
    this.peer = hello;
    this.state = 'open';
    for (const cb of this.listeners.open) cb(hello);
  }
  remotePay(msg: PayMessage): void {
    for (const cb of this.listeners.pay) cb(msg);
  }
  remoteClose(reason: Parameters<PayProtocolEvents['close']>[0]): void {
    this.state = 'closed';
    for (const cb of this.listeners.close) cb(reason);
  }
}

export function hello(pubkey: HelloMessage['pubkey']): HelloMessage {
  return {
    type: 'HELLO',
    version: 1,
    pubkey,
    challenge: 'c',
    signature: 's',
    acceptedMints: [],
    satsPerBlock: 1 as never,
    split: { seeder: 50, creator: 50 },
    p2pk: ('02' + '00'.repeat(32)) as never,
  };
}
