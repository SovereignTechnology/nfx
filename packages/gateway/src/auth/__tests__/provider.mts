/**
 * L10 provider indirection for `BlossomAuth` (Stage 2 seam).
 *
 * `packages/gateway/src/auth/` is locked and holds only the interface in Stage 1. The suite
 * in `blossom-auth.test.ts` is complete and real; it is `describe.skipIf`-ed on
 * `getBlossomAuth() === undefined`. Stage 2 (execution plan §3 Part A step 5, kind 24242
 * verification for BUD-02/04/09) unskips it by returning a FRESH instance per call here:
 *
 *   import { BlossomAuthImpl } from '../blossom-auth.js';   // or whatever it is named
 *   export function getBlossomAuth(): BlossomAuth | undefined { return new BlossomAuthImpl(); }
 *
 * A fresh instance per call matters: the replay and deny-list tests assume no state leaks
 * between tests.
 *
 * `.mts` so vitest's `__tests__/**\/*.ts` include glob does not collect it as a test file.
 */
import type { BlossomAuth } from '../index.js';

export function getBlossomAuth(): BlossomAuth | undefined {
  return undefined;
}

export const SKIP_REASON =
  'skipped until Stage 2 implements packages/gateway/src/auth/ and wires getBlossomAuth() in provider.mts';
