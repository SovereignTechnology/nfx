/**
 * LOCKED until Stage 2 (SECURITY.md §locked). Interface re-exports and tests only.
 * `pay/1` codec, state machine and protomux attach land here in Stage 2.
 */
export type {
  PayProtocol,
  PayProtocolCodec,
  PayProtocolMessage,
  HelloMessage,
  PayWireMessage,
  AckMessage,
  PriceMessage,
  PayProtocolState,
  PayProtocolEvents,
  MuxLike,
} from '../contracts/pay-protocol.js';
export { PAY_PROTOCOL_NAME, PAY_PROTOCOL_VERSION } from '../contracts/pay-protocol.js';
