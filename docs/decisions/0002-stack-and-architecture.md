# 2. Stack and architecture: Hypercore transport, Nostr catalog, Cashu payment, one React UI

Date: 2026-09-04

## Status

Accepted

## Context

`nutflix` is a P2P video network where multiple peers seed a creator's video and are paid
per block in Cashu ecash, with a creator-chosen mint and a default 50/50 seeder/creator
split. It needs a desktop app and a web portal that share identity, wallet and protocol,
and a UI that competes with YouTube rather than looking like a protocol demo.

The full design is in `docs/plan/build-plan.md` (the *what*) and the delivery method in
the execution plan (not published) (the *how*). This record captures the decisions that are
expensive to reverse.

## Decision

- **Transport/storage:** Hyperblobs on creator-keyed Hypercores, moved between peers by
  Hypercore replication over Hyperswarm. No custom transfer protocol.
- **Payment:** a side channel `pay/1` (protomux) muxed onto the same stream as
  replication. Chunk-first, pay-after-verify; loss per interaction bounded to a window
  of blocks.
- **Ecash:** Cashu via `@cashu/cashu-ts` (NUT-03/04/05/11/12). Viewer balance in a
  NIP-60 wallet so it roams between desktop and web. No Lightning code, no custody.
- **Catalog/social:** Nostr. NIP-71 video events, NIP-22 comments, NIP-51 sets,
  NIP-61 nutzaps for creator payout. No Autobase.
- **Blossom:** an addressing and indexing layer at the gateway only (sha256 of the full
  file in the NIP-71 `x` tag; gateway keeps sha256→blob index). Not the wire format.
- **Runtime:** the protocol library (`@sovit/core`) is runtime-agnostic (Bare, Node,
  browser). Pear is a deployment target, not a dependency.
- **Frontend:** one React + Vite + Tailwind codebase (`@sovit/ui`) behind a
  `NetworkAdapter` interface, with two thin shells (pear-electron, static web).
- **Language/tooling:** TypeScript strict across the monorepo; npm workspaces; Vitest;
  ESLint; Storybook for `ui`.
- **Naming:** "Nutflix" is brand only. Package scope `@sovit/`, protocol id `pay/1`,
  and repo identifiers stay neutral so a forced rename touches the icon and README.
- **Licence:** unchanged — AGPL-3.0-or-later (ADR 0001 context).

## Consequences

- Hypercore's per-block Merkle verification is reused as the "wrong bytes" control,
  roughly halving the audit surface versus a hand-written chunk protocol.
- The audit surface is small and named: `core/src/payment`, `core/src/signer`,
  `core/src/pay-protocol`, `core/src/wallet/spend.ts`, `gateway/src/auth`. These are
  locked until a dedicated security stage (the unpublished execution plan, §3).
- Contracts in `packages/core/src/contracts/` are frozen before parallel work begins;
  changing them is an orchestrator-only action with a version bump.
- Several assumptions (A4 per-peer upload gating, A8 browser Hypercore, A9 block size,
  Spike C ffmpeg on Bare) are unverified at the time of this decision and are resolved
  by the Stage 0 spikes in `docs/spikes/`. If A8 fails the web portal falls back to
  gateway-served sha256 segments + MSE; the rest of the design is unaffected.
- The view count, trending and recommendation features are honest approximations
  (paid views, sats/hour, client-side similarity) and are labelled as such in the UI.
- Brand risk is accepted with mitigation (no trademark filing, neutral code identifiers,
  a reserved second name).
