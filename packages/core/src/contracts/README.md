# Contracts

Frozen interface surface for the whole monorepo. See the execution plan (not published) §0 rule 1.

- **Writer:** the orchestrator only (CODEOWNERS).
- **Version:** `CONTRACTS_VERSION` in `version.ts`; `scripts/check-contracts-version.sh` fails a change without a bump.
- **Contents:** types, interfaces, and `as const` constants. ESLint rejects functions and classes here.
- **Requesting a change:** a lane writes `docs/contract-requests/<lane>.md` and stops.

| File | Contract |
|------|----------|
| `primitives.ts` | Branded hex/URL/sats types, `Result` |
| `nostr.ts` | Event/filter shapes, `NostrKind` table, `Profile`, relays |
| `signer.ts` | `Signer` (local / NIP-46 / NIP-07), optional `signSecret` |
| `cashu.ts` | Wire-shape proofs, `LockedProofSet`, keysets, quotes |
| `wallet.ts` | `Wallet` — NIP-60 wallet: quote, P2PK send, receive, melt, history |
| `manifest.ts` | `VideoManifest`, `Rendition`, `HyperblobRef`, NIP-71 tag schema, price policy |
| `payment.ts` | `PaymentEngine` viewer + seeder sides, `PayMessage`, `VerifyResult`, `PeerWindow` |
| `pay-protocol.ts` | `pay/1` messages `HELLO/PAY/ACK/PRICE`, `PayProtocol`, codec |
| `media.ts` | Probe/ladder/transcode planning with injected `ProcessRunner` + `FsAdapter`, `BlobSink` (spike S-C) |
| `network-adapter.ts` | Everything the UI may call |
