/**
 * @sovit/core — runtime-agnostic protocol library (build-plan §2.1).
 *
 * Stage 0 exports: frozen contracts + mocks. Stage 1 lanes add `nostr/`, `manifest/`,
 * `media/`; Stage 2 fills the locked audit surface (`payment/`, `signer/`, `pay-protocol/`,
 * `wallet/spend.ts`).
 */
export * from './contracts/index.js';
export * as mocks from './mocks/index.js';
export * as nostr from './nostr/index.js';
export * as manifest from './manifest/index.js';
export * as media from './media/index.js';
