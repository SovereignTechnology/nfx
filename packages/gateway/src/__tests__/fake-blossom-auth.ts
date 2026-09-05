/**
 * Test double for the LOCKED `BlossomAuth` interface (`src/auth/index.ts`). Lives OUTSIDE
 * `src/auth/` on purpose: the real implementation (kind-24242 parsing, expiry, replay,
 * `nostr-tools` `verifyEvent`) is Stage 2's. This fake never looks at the header beyond
 * recording it — it answers whatever the test scripted, so the handler's 401/403/ok
 * paths can be exercised without any signature code existing in this package.
 */
import type { NostrEvent, NostrPubkey } from '@sovit/core';

import type { BlossomAuth, BlossomAuthRequest, BlossomAuthResult } from '../auth/index.js';

export type ScriptedResult =
  | { readonly ok: true; readonly pubkey: NostrPubkey }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly reason: Extract<BlossomAuthResult, { ok: false }>['reason'];
    };

export class FakeBlossomAuth implements BlossomAuth {
  readonly calls: BlossomAuthRequest[] = [];
  readonly allowed: NostrPubkey[] = [];
  readonly denied: NostrPubkey[] = [];
  /** Next results, consumed in order; when empty `defaultResult` is used. */
  readonly queue: ScriptedResult[] = [];
  defaultResult: ScriptedResult;

  constructor(defaultResult: ScriptedResult = { ok: false, status: 401, reason: 'malformed' }) {
    this.defaultResult = defaultResult;
  }

  verify(req: BlossomAuthRequest): Promise<BlossomAuthResult> {
    this.calls.push(req);
    const r = this.queue.shift() ?? this.defaultResult;
    if (!r.ok) return Promise.resolve({ ok: false, status: r.status, reason: r.reason });
    const event: NostrEvent = {
      kind: 24242,
      created_at: req.now - 1,
      tags:
        req.sha256 === undefined
          ? [['t', req.verb]]
          : [
              ['t', req.verb],
              ['x', req.sha256],
            ],
      content: 'fake',
      pubkey: r.pubkey,
      id: 'ee'.repeat(32) as NostrEvent['id'],
      sig: 'fake-sig',
    };
    return Promise.resolve({ ok: true, pubkey: r.pubkey, event });
  }

  allow(pubkey: NostrPubkey): void {
    this.allowed.push(pubkey);
  }

  deny(pubkey: NostrPubkey): void {
    this.denied.push(pubkey);
  }
}
