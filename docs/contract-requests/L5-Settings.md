# Contract change request — lane L5-Settings

Issued against `CONTRACTS_VERSION = 3`. Nothing in the lane is blocked: each item below is
worked around inside `packages/ui/src/screens/Settings/` with a screen prop or a documented
convention, and the workaround is named so v4 can remove it.

## 1. A way to change signer (the main ask)

**Gap.** `NetworkAdapter` has `signer(): Promise<SignerStatus>` and nothing that connects,
switches or disconnects a signer. build-plan §6.1 puts "Signer (NIP-07/46/local)" on the
Settings screen, and the `signer-not-detected` empty state tells people to "Connect signer".

**v3 workaround.** `SettingsProps.onChangeSigner?: (kind) => void | Promise<void>`. The shell
owns the whole flow. Without the prop the signer-type radios are shown read-only with the copy
"Your signer is chosen when you sign in to the app. Switching it from Settings is not
available in this version." When the prop returns a promise, the screen calls
`adapter.signer()` again after it settles.

**Proposed v4 surface** (names are a suggestion; the shape is the point):

```ts
export type SignerConnectRequest =
  | { readonly kind: 'nip07' }
  // bunker:// or nostrconnect:// URI. The adapter parses and validates it, and any secret
  // in it stays in the worker/main process.
  | { readonly kind: 'nip46'; readonly uri: string }
  // The passphrase / nsec prompt is owned by the core side (secure prompt), never by the
  // screen. The UI only says which flow it wants.
  | { readonly kind: 'local'; readonly flow: 'unlock' | 'import' | 'generate' };

interface NetworkAdapter {
  // …
  connectSigner(req: SignerConnectRequest): Promise<SignerStatus>;
  disconnectSigner(): Promise<void>; // = sign out; `lock()` for local, forget for 07/46
  lockSigner(): Promise<void>;       // "Lock now" button for a local key
  onSigner(cb: (s: SignerStatus) => void): Unsubscribe; // lock / unlock / remote drop
}
```

Requirements the screen depends on:

- **No key material crosses the contract in either direction.** For `local`, the UI must not
  pass an nsec or a passphrase as a string argument. The adapter opens its own prompt. This
  follows signer.ts: "Nothing else in the codebase may hold an nsec".
- `connectSigner` resolves to the new `SignerStatus`, or rejects with a human message the
  screen can show (for example "bunker did not answer", "extension refused").
- `onSigner` lets Settings and the header react to a remote signer dropping or a local key
  auto-locking, without polling.
- A NIP-46 `SignerStatus.detail` should keep carrying relay + remote pubkey, which the
  screen already shows under "Details".

## 2. `updateSettings` cannot clear `autoTopUp`

**Gap.** `Settings.autoTopUp` is optional and `updateSettings(patch: Partial<Settings>)` is a
merge. Under `exactOptionalPropertyTypes` a patch cannot contain `autoTopUp: undefined`, and a
JSON/IPC transport would drop that key anyway. So once auto top-up is set it can never be
switched off.

**v3 workaround.** "Off" is written as `{ belowSats: 0, fromMint }` and read back the same way
(`autoTopUpEnabled()` in `model.ts`). A balance is never below 0 sats, so a zero threshold
never fires.

**Proposed v4:** accept `null` as "remove":

```ts
export type SettingsPatch = { readonly [K in keyof Settings]?: Settings[K] | null };
updateSettings(patch: SettingsPatch): Promise<Settings>;
```

or make the field `autoTopUp: { … } | null` (not optional) on `Settings`.

## 3. Which of the two seeding switches is the source of truth?

**Gap.** `Settings.seeding.enabled` (via `updateSettings`) and `seeder.setEnabled(on)` both
exist. In the mock, `setEnabled` writes `settings.seeding.enabled` and notifies `onStatus`,
but `updateSettings({ seeding })` does neither: it does not notify, and it does not
start or stop anything.

**v3 choice.** The on/off switch calls `seeder.setEnabled(on)` because it acts on the live
seeder and pushes `onStatus`. The disk cap goes through
`updateSettings({ seeding: { enabled, diskCapBytes } })`.

**Proposed v4:** document that `seeder.setEnabled` persists `Settings.seeding.enabled`, and
that `updateSettings({ seeding })` applies the cap to the running seeder (evicting to fit, or
refusing if eviction is not supported). Alternatively, drop `enabled` from
`Settings.seeding` so there is one switch.

## 4. Nice to have (not requested for v4 unless cheap)

- `onSettings(cb: (s: Settings) => void): Unsubscribe`. The shell then applies `theme` (and
  passes `hoverPreview` to Home) from the adapter, without needing the screen's
  `onSettingsChange` prop. This matters if two windows or tabs share one settings store.
- Relay health, `relayStatus(): Promise<readonly { url: RelayUrl; connected: boolean;
  lastError?: string }[]>`, so the relays table can show a reachability dot like
  `MintChip`'s. Today there is no per-relay signal, so the table shows none.
- Mint reachability, so `MintChip status` can be `ok` / `unreachable` instead of `unknown`.
