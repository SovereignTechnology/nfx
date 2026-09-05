/**
 * Wires a `PayProtocol` instance (contracts/pay-protocol.ts — implementation lands in
 * Stage 2, `core/src/pay-protocol/`, locked) to a `PeerSession`:
 *
 *   HELLO (open)  → `session.bindPubkey()`      (banned pubkey → cut)
 *   PAY           → `session.verifyPay()` → `sendAck()`; accepted blocks feed the scheduler
 *   close(reason) → mirror a remote/protocol cut on the session
 *
 * The seeder never calls `protocol.cut()`: the session owns the ban+destroy so the ban
 * list and the swarm `PeerInfo` are always updated together.
 */
import type { PayProtocol, PricePolicy } from '@sovit/core';

import type { Logger } from '../log/logger.js';
import type { PeerSession } from '../net/peer-session.js';
import type { FlushScheduler } from './flush-scheduler.js';

export interface PayBridgeOptions {
  readonly session: PeerSession;
  readonly protocol: PayProtocol;
  /** Price policy to verify this peer's `PAY` messages against. */
  readonly policy: () => PricePolicy;
  readonly scheduler: Pick<FlushScheduler, 'notePaidBlocks'>;
  readonly logger: Logger;
}

export function attachPayBridge(opts: PayBridgeOptions): () => void {
  const { session, protocol, scheduler } = opts;
  const log = opts.logger.child({ noiseKey: session.noiseKeyHex });
  const offs: (() => void)[] = [];

  offs.push(
    protocol.on('open', (hello) => {
      session.bindPubkey(hello.pubkey);
    }),
  );

  offs.push(
    protocol.on('pay', (msg) => {
      void (async () => {
        const r = await session.verifyPay(msg, opts.policy());
        if (session.closed) return;
        protocol.sendAck(
          r.ok
            ? { fromBlock: msg.range.fromBlock, toBlock: msg.range.toBlock, ok: true }
            : {
                fromBlock: msg.range.fromBlock,
                toBlock: msg.range.toBlock,
                ok: false,
                reason: r.reason,
              },
        );
        if (r.ok) scheduler.notePaidBlocks(r.blocks);
        else if (r.reason === 'peer-banned') session.cut('banned');
      })().catch((err: unknown) => {
        log.error('pay handling failed', { error: err });
        session.cut('protocol-error');
      });
    }),
  );

  offs.push(
    protocol.on('close', (reason) => {
      if (reason === 'window-exceeded' || reason === 'banned') session.cut(reason);
      else if (reason === 'protocol-error') session.cut('protocol-error');
    }),
  );

  return () => {
    for (const off of offs) off();
  };
}
