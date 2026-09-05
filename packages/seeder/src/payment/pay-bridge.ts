/**
 * Wires a `PayProtocol` instance (contracts/pay-protocol.ts — implementation lands in
 * Stage 2, `core/src/pay-protocol/`, locked) to a `PeerSession`:
 *
 *   HELLO (open)  → `session.bindPubkey()`      (banned pubkey → cut)
 *   PAY           → core check (v3) → `session.verifyPay(msg, policy(range.core))`
 *                   → `sendAck()`; accepted blocks feed the scheduler
 *   close(reason) → mirror a remote/protocol cut on the session
 *
 * v3 (ADR 0004 (c)): `PayMessage.range.core` selects the `PricePolicy` the PAY is verified
 * against, and a PAY WITHOUT `core` is refused as `malformed` — without reaching the engine
 * — when the stream replicates more than one core (contract text on `BlockRange.core`).
 * With one core the v2 aggregate semantics still apply, so a v2 client keeps working
 * against a single-video seeder until the Stage 2 bump makes `core` required.
 *
 * The seeder never calls `protocol.cut()`: the session owns the ban+destroy so the ban
 * list and the swarm `PeerInfo` are always updated together.
 */
import type { CoreKeyHex, PayProtocol, PricePolicy } from '@sovit/core';

import type { Logger } from '../log/logger.js';
import type { PeerSession } from '../net/peer-session.js';
import type { FlushScheduler } from './flush-scheduler.js';

export interface PayBridgeOptions {
  readonly session: PeerSession;
  readonly protocol: PayProtocol;
  /**
   * Price policy to verify this peer's `PAY` messages against, resolved per `range.core`
   * (`undefined` for a core-less v2 PAY on a single-core stream). A `() => PricePolicy`
   * (the v2 shape) is still accepted and simply ignores the core.
   */
  readonly policy: (core?: CoreKeyHex) => PricePolicy;
  /**
   * How many cores this session's stream replicates. Defaults to the number of distinct
   * cores the session has uploaded from (`session.uploadedCores.size`); the seeder passes
   * the Corestore view (cores with a replication peer on this stream), which also counts
   * cores the peer has attached to but not yet pulled from.
   */
  readonly replicatedCores?: () => number;
  readonly scheduler: Pick<FlushScheduler, 'notePaidBlocks'>;
  readonly logger: Logger;
}

export function attachPayBridge(opts: PayBridgeOptions): () => void {
  const { session, protocol, scheduler } = opts;
  const log = opts.logger.child({ noiseKey: session.noiseKeyHex });
  const offs: (() => void)[] = [];
  const coresOnStream = (): number =>
    Math.max(opts.replicatedCores?.() ?? 0, session.uploadedCores.size);

  offs.push(
    protocol.on('open', (hello) => {
      session.bindPubkey(hello.pubkey);
    }),
  );

  offs.push(
    protocol.on('pay', (msg) => {
      void (async () => {
        const core = msg.range.core;
        if (core === undefined && coresOnStream() > 1) {
          // Contract (`BlockRange.core`, v3): more than one core on the stream ⇒ a PAY that
          // does not say which core it pays for cannot be verified against a policy or a
          // per-core upload count. Refuse before the engine sees it.
          log.info('PAY rejected', {
            reason: 'malformed',
            detail: 'no range.core on a multi-core stream',
          });
          if (session.closed) return;
          protocol.sendAck({
            fromBlock: msg.range.fromBlock,
            toBlock: msg.range.toBlock,
            ok: false,
            reason: 'malformed',
          });
          return;
        }
        const r = await session.verifyPay(msg, opts.policy(core));
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
