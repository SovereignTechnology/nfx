/**
 * Contracts version (execution plan §0 rule 1).
 *
 * Bumped by the orchestrator, and only the orchestrator, whenever anything under
 * `packages/core/src/contracts/` changes. Every lane records the version it was issued
 * against in `docs/lanes/<lane>.md`; a lane on a stale version is re-issued, never merged.
 *
 * History:
 *   1 — 2026-09-04 Stage 0 initial draft (pre-spike).
 *   2 — 2026-09-04 Post-spike, FROZEN for Stage 1 fan-out. S-A: `recordUpload` is
 *       synchronous-in-`upload`-handler, bans carry the Noise key, `bans()` added.
 *       S-B: `PlaySource` order/docs (service-worker primary, MSE fallback). S-C: new
 *       `media.ts` (pure-planning pipeline with injected `ProcessRunner`/`FsAdapter`).
 */
export const CONTRACTS_VERSION = 2 as const;
