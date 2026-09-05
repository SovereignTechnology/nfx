/**
 * Runtime provider seam for the CLI entry — the same pattern as L10's
 * `src/auth/__tests__/provider.mts`. In Stage 1 every real dependency is absent:
 *
 *   - `PaymentEngine`  → `packages/core/src/payment/`   (locked until Stage 2)
 *   - `PayProtocol`    → `packages/core/src/pay-protocol/` (locked until Stage 2)
 *   - `BlossomAuth`    → `packages/gateway/src/auth/`   (locked until Stage 2)
 *   - HELLO signing    → the `Signer` (Stage 2)
 *
 * so `getRuntimeDeps()` returns `undefined` and `main()` refuses to start with a clear,
 * redacted error (exit 78 = EX_CONFIG). Stage 2 fills this function in; nothing else in
 * the entry path changes. `--dev-mocks` (`cli/dev-mocks.ts`) is the explicit, loudly
 * logged way to run the gateway against `MockPaymentEngine('honest')` for L7 development.
 */
import type { GatewayConfig } from '../config.js';
import type { GatewayDeps } from '../gateway.js';

export type RuntimeDeps = Pick<
  GatewayDeps,
  'seederEngine' | 'viewerEngine' | 'auth' | 'payProtocol' | 'identity'
>;

export function getRuntimeDeps(_config: GatewayConfig): RuntimeDeps | undefined {
  return undefined;
}

export const MISSING_PROVIDERS_REASON =
  'no runtime providers wired: PaymentEngine, PayProtocol, BlossomAuth and the Signer land in Stage 2 (see cli/providers.ts); use --dev-mocks for development only';
