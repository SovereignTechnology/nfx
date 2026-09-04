/**
 * LOCKED until Stage 2 (SECURITY.md §locked). Interface re-exports and tests only.
 * The real PaymentEngine is implemented here by the Stage 2 security session.
 */
export type {
  PaymentEngine,
  PaymentEngineViewer,
  PaymentEngineSeeder,
  PaymentEngineConfig,
  PayMessage,
  VerifyResult,
  RejectReason,
  PeerWindow,
  BlockRange,
} from '../contracts/payment.js';
