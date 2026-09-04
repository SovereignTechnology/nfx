/**
 * Mocks — execution plan §0 rule 4. Explicit and cheatable. Never imported by production
 * code paths; lanes use them to integrate before the real implementations exist.
 */
export * from './fixtures.js';
export * from './mock-payment-engine.js';
export * from './mock-wallet.js';
export * from './mock-network-adapter.js';
