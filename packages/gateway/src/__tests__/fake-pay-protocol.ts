/**
 * Structural stand-in for the contract `PayProtocol` (real one: Stage 2,
 * `core/src/pay-protocol/`, locked) — the same shape L2 used. Records what the gateway
 * sends (HELLO / PAY / ACK / PRICE) and lets a test inject remote events. `attach()`
 * records the mux it was given so a test can assert the gateway attached to a protomux.
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
  attachedTo: MuxLike | null = null;
  readonly hellos: Omit<HelloMessage, 'type'>[] = [];
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

  attach(mux: MuxLike): void {
    this.attachedTo = mux;
  }
  sendHello(hello: Omit<HelloMessage, 'type'>): void {
    this.hellos.push(hello);
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

  // ---- test hooks: the remote side
  remoteHello(hello: HelloMessage): void {
    this.peer = hello;
    this.state = 'open';
    for (const cb of this.listeners.open) cb(hello);
  }
  remotePay(msg: PayMessage): void {
    for (const cb of this.listeners.pay) cb(msg);
  }
  remoteAck(ack: AckMessage): void {
    for (const cb of this.listeners.ack) cb(ack);
  }
  remotePrice(price: PriceMessage): void {
    for (const cb of this.listeners.price) cb(price);
  }
  remoteClose(reason: Parameters<PayProtocolEvents['close']>[0]): void {
    this.state = 'closed';
    for (const cb of this.listeners.close) cb(reason);
  }
}

export function helloFrom(
  pubkey: HelloMessage['pubkey'],
  o: Partial<Omit<HelloMessage, 'type' | 'pubkey'>> = {},
): HelloMessage {
  return {
    type: 'HELLO',
    version: 1,
    pubkey,
    challenge: 'c',
    signature: 's',
    acceptedMints: o.acceptedMints ?? [],
    satsPerBlock: o.satsPerBlock ?? (1 as HelloMessage['satsPerBlock']),
    split: o.split ?? { seeder: 50, creator: 50 },
    p2pk: o.p2pk ?? (('02' + '00'.repeat(32)) as HelloMessage['p2pk']),
  };
}
