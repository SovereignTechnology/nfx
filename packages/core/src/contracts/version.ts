/**
 * Contracts version (execution plan §0 rule 1).
 *
 * Bumped by the orchestrator, and only the orchestrator, whenever anything under
 * `packages/core/src/contracts/` changes. Every lane records the version it was issued
 * against in `docs/lanes/<lane>.md`; a lane on a stale version is re-issued, never merged.
 *
 * History:
 *   1 — 2026-09-04 Stage 0 initial draft (pre-spike). Not frozen yet.
 */
export const CONTRACTS_VERSION = 1 as const;
