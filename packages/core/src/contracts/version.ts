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
 *   3 — 2026-09-04 Post-Wave-1 batch (ADR 0004). Additive; every v2 consumer compiles.
 *       (a) `NostrKind.ReleaseNotice = 30071` for the reproducible-build event (L9 request;
 *       30063 rejected — vendored NIP-51 owns it with a different shape). (b) `hyperUrl`
 *       doc corrected to the hex grammar L1/L8/fixtures implement; z32 never accepted.
 *       (c) L2 flag 1 ACCEPTED: `BlockRange.core?` — a `pay/1` channel spans many cores,
 *       policy is per video, so PAY must name the core; optional now, REQUIRED at the
 *       Stage 2 bump; `recordUpload(peer, blocks, core?)` alongside. (d) L2 flag 2
 *       ACCEPTED: `PaymentEngineSeeder.rebind(from, to)` replaces the replay-on-HELLO
 *       workaround for pre-HELLO accounting under the Noise-key hex.
 *   4 — 2026-09-23 Post-L5 (ADR 0007). Additive. (a) `VideoStats.likes`, `.dislikes`
 *       (required — dislikes are always shown) and `.myReaction?`. (b) `NetworkAdapter
 *       .unreact(videoId)` — NIP-09 deletion; un-like must never be sent as a `-` dislike.
 *       (c) `PricePolicy.split` doc points at ADR 0007 (min PAY size + creator carry,
 *       implemented in Stage 2). The Stage 2 bump planned as "v4" in docs/status.md is v5.
 */
export const CONTRACTS_VERSION = 4 as const;
