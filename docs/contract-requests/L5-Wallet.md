# Contract request — L5-Wallet (against `CONTRACTS_VERSION = 3`)

**Status: notes, not blockers.** The Wallet screen ships against v3. Each item below has a
workaround in the screen; none needs to land before merge. Ordered by how much it matters.

## 1. `Settings.autoTopUp` cannot be switched off through `updateSettings`

`updateSettings(patch: Partial<Settings>)` merges a patch, and `autoTopUp` is an optional key.
Under the repo's `exactOptionalPropertyTypes`, `{ autoTopUp: undefined }` is not a valid
`Partial<Settings>`, and even with a cast the key would not survive the gateway's JSON hop
(`undefined` properties are dropped), so an adapter that merges patches can never clear it.

**Workaround shipped:** "off" is written as `{ belowSats: 0, fromMint }` — "top up when a mint
drops below 0 sats" can never trigger — and the screen reads `belowSats <= 0` (or a missing
key) as off (`isAutoTopUpOn` in `screens/Wallet/invoice.ts`). The engine that runs auto
top-up must treat `belowSats: 0` as disabled; please make that normative.

**Suggested (v4):** make the off state explicit, either

```ts
readonly autoTopUp?: { readonly enabled: boolean; readonly belowSats: Sats; readonly fromMint: MintUrl };
```

or `autoTopUp?: { … } | null` with `null` meaning off.

## 2. Pending mint quotes are not resumable

`pollQuote` mints the ecash when it sees PAID. The screen polls only while the "Add funds"
sheet is open (as briefed: polling stops on close/unmount). If the viewer pays after closing
the sheet, or the app restarts mid-payment, nothing in v3 lets any UI find that quote again, so
the sats sit at the mint as a PAID quote until something polls it.

**Workaround shipped:** copy — "Keep this open until the payment arrives", and on a polling
failure "If you already paid it, do not pay again". Nothing else is possible from the UI.

**Suggested:** make it the wallet implementation's job (it emits `quote` events already):
keep unexpired quotes from `mintQuote` and poll them in the background until ISSUED or
expired, plus `pendingMintQuotes(): Promise<readonly MintQuote[]>` so the Wallet screen can
show a "Waiting for 1 payment" row that reopens the invoice.

## 3. `Wallet.history` has no cursor

`history({ limit, mint })` returns the newest N and nothing older. The screen asks for 50 and
says "Showing your latest 50 transactions" when it gets 50.

**Suggested:** `history(opts?: { limit?; mint?; before?: UnixSeconds })` or a `Page<WalletHistoryEntry>`
with the same opaque cursor as `feed`.

## 4. No mint reachability / info

`MintChip` has a `status` (`ok | unreachable | unknown`), but v3 has no way to ask whether a
mint is up (NUT-06 `/v1/info`). The screen starts every mint at `unknown` and learns `ok` /
`unreachable` from the outcome of its own quotes in the session.

**Suggested (low priority):** `mintInfo(mint): Promise<{ reachable: boolean; name?: string; limits?: { minSats?: Sats; maxSats?: Sats } }>` —
the limits would also let the amount field say "this mint takes 1–500,000 sats" up front.

## 5. `Route` for `wallet` has no params (orchestrator note, not a core contract)

`Route` (`screens/shared/route.ts`, orchestrator-owned) is `{ name: 'wallet' }`. Watch's
"No balance at this mint → Top up" wants to land on the Wallet with the mint (and the shortfall)
chosen. **Workaround shipped:** a screen prop, `intent?: WalletIntent`
(`{ action: 'fund', mint?, amount? } | { action: 'withdraw', mint?, invoice? }`), which the
shell passes. If the orchestrator prefers, the same shape can move into the route:
`{ name: 'wallet'; fund?: { mint: MintUrl; amount?: number } }`.

## Mock observations (for whoever owns `packages/core/src/mocks/`)

- `MockWallet.mintQuote` returns `lnbc<amount>n1mockinvoicemockquote-<n>` — the hyphen can never
  occur in bech32. The screen's check on the **mint's** answer is prefix-only for that reason;
  user-pasted invoices get the stricter `[0-9a-z]` shape check.
- `MockWallet.melt` debits only `amount`, never the fee, and always returns `change = feeReserve`,
  so the "Lightning fee" line reads 0 sats in stories.
- `MockNetworkAdapter` wallet calls do not go through `delay()`, so `latencyMs` and
  `failWith: 'relay-down'` do not affect `adapter.wallet.*`. The screen's loading and relay-down
  states come from `me()`/`settings()`; stories wrap the wallet in a Proxy for wallet-level
  failures.
