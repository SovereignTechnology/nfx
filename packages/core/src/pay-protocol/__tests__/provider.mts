/**
 * L10 provider indirection for the `pay/1` codec (Stage 2 seam).
 *
 * There is no codec in Stage 1 — `packages/core/src/pay-protocol/` is locked and holds only
 * re-exports. The fuzz harness in `codec.fuzz.test.ts` is complete and real; it is
 * `describe.skipIf`-ed on `getCodec() === undefined`. Stage 2 (execution plan §3 Part A
 * step 4, `core/src/pay-protocol/` compact-encoding codec) unskips it by returning the
 * implementation here:
 *
 *   import { PayProtocolCodecImpl } from '../codec.js';   // or whatever it is named
 *   export function getCodec(): PayProtocolCodec | undefined { return new PayProtocolCodecImpl(); }
 *
 * `.mts` so vitest's `__tests__/**\/*.ts` include glob does not collect it as a test file.
 */
import type { PayProtocolCodec } from '../../contracts/index.js';

export function getCodec(): PayProtocolCodec | undefined {
  return undefined;
}

/** Human-readable reason printed in the describe title while the suite is skipped. */
export const SKIP_REASON =
  'skipped until Stage 2 implements packages/core/src/pay-protocol/ and wires getCodec() in provider.mts';
