/**
 * `--dev-mocks`: run the gateway against the explicit, cheatable mocks from
 * `@sovit/core` so the L7 web-shell has something to talk to before Stage 2 lands.
 *
 * NOT FOR PRODUCTION — and the code makes that hard to miss: `main()` only loads this
 * module behind the flag and logs a `warn` line on every start. What it substitutes:
 *   - `MockPaymentEngine('honest')` for both engine roles: accepts mock proofs, i.e. a
 *     peer can "pay" with nothing of value;
 *   - a `BlossomAuth` that accepts EVERY token without looking at it, attributing the
 *     upload to the `pubkey` field of the (unverified) event if it parses, else a fixed
 *     all-zero pubkey. There is deliberately no partial verification here: anything
 *     smarter would be an auth implementation outside the locked `src/auth/`;
 *   - a `pay/1` stand-in that records but never puts anything on the wire, so browsers
 *     that do not pay are still window-cut exactly as in production;
 *   - HELLO "signatures" that are the literal string `dev-unsigned`.
 *
 * Execution plan §0 rule 4 says mocks are never imported by production code paths; this
 * module is the one, flag-gated exception and docs/lanes/L3.md flags it for review.
 */
import type {
  AckMessage,
  HelloMessage,
  MuxLike,
  NostrPubkey,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
  PayProtocolState,
  PriceMessage,
} from '@sovit/core';
import { mocks } from '@sovit/core';

import type { BlossomAuth, BlossomAuthRequest, BlossomAuthResult } from '../auth/index.js';
import type { GatewayConfig } from '../config.js';
import type { RuntimeDeps } from './providers.js';

const ZERO_PUBKEY = '00'.repeat(32) as NostrPubkey;

class DevAcceptAllAuth implements BlossomAuth {
  private readonly denied = new Set<NostrPubkey>();

  verify(req: BlossomAuthRequest): Promise<BlossomAuthResult> {
    let pubkey = ZERO_PUBKEY;
    const b64 = req.header.startsWith('Nostr ') ? req.header.slice(6) : '';
    try {
      const ev: unknown = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      const pk =
        typeof ev === 'object' && ev !== null ? (ev as { pubkey?: unknown }).pubkey : undefined;
      if (typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk)) pubkey = pk as NostrPubkey;
    } catch {
      // unparseable → attributed to the zero pubkey; still accepted (dev mode)
    }
    if (this.denied.has(pubkey))
      return Promise.resolve({ ok: false, status: 403, reason: 'denied' });
    return Promise.resolve({
      ok: true,
      pubkey,
      event: {
        kind: 24242,
        created_at: req.now,
        tags: [],
        content: '',
        pubkey,
        id: '' as never,
        sig: '',
      },
    });
  }
  allow(pubkey: NostrPubkey): void {
    this.denied.delete(pubkey);
  }
  deny(pubkey: NostrPubkey): void {
    this.denied.add(pubkey);
  }
}

type Listeners = { [K in keyof PayProtocolEvents]: Set<PayProtocolEvents[K]> };

class DevPayProtocol implements PayProtocol {
  state: PayProtocolState = 'idle';
  peer: HelloMessage | null = null;
  private readonly listeners: Listeners = {
    open: new Set(),
    pay: new Set(),
    ack: new Set(),
    price: new Set(),
    close: new Set(),
  };
  attach(_mux: MuxLike): void {
    this.state = 'idle';
  }
  sendHello(_hello: Omit<HelloMessage, 'type'>): void {
    this.state = 'hello-sent';
  }
  sendPay(_msg: PayMessage): void {
    // dev mode: nothing leaves the process
  }
  sendAck(_ack: Omit<AckMessage, 'type'>): void {
    // dev mode
  }
  sendPrice(_price: Omit<PriceMessage, 'type'>): void {
    // dev mode
  }
  cut(reason: Parameters<PayProtocolEvents['close']>[0]): void {
    this.state = 'closed';
    for (const cb of this.listeners.close) cb(reason);
  }
  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void {
    const set = this.listeners[event] as Set<PayProtocolEvents[K]>;
    set.add(cb);
    return () => set.delete(cb);
  }
}

export function devMockDeps(config: GatewayConfig): RuntimeDeps {
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: {
      acceptedMints: config.acceptedMints,
      ownP2pk: config.identity.p2pk,
      ownPubkey: config.identity.pubkey,
      flushEveryBlocks: config.flushEveryBlocks,
      flushEveryMs: config.flushEveryMs,
    },
  });
  return {
    seederEngine: engine,
    viewerEngine: engine,
    auth: new DevAcceptAllAuth(),
    payProtocol: () => new DevPayProtocol(),
    identity: { signChallenge: () => Promise.resolve('dev-unsigned') },
  };
}
