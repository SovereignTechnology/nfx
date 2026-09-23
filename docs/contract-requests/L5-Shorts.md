# Contract request — L5-Shorts (against `CONTRACTS_VERSION = 3`)

**Not blocking.** The Shorts screen works within v3 with the workaround below; this records a
gap so it can be decided before the real adapters (L6/L7) implement `react`.

## `NetworkAdapter` has no way to take a like back

`react(videoId, reaction)` publishes a NIP-25 kind 7 with content `+`, `-` or an emoji. To
*remove* a like, NIP-25 expects the viewer to delete their own kind 7 (NIP-09 kind 5), not to
publish a `-` — a `-` is a **dislike**, which the creator's stats read as a negative reaction.

The Shorts screen (like the Watch lane, for consistency) toggles a like off with
`react(videoId, '-')`, because that is what v3 offers and it is what `MockNetworkAdapter` treats
as "unliked". On a real relay that turns every un-like into a dislike.

### Proposed (v4)

```ts
/** Retracts the viewer's own reaction to `videoId` (NIP-09 deletion of their kind 7). */
unreact(videoId: NostrEventId): Promise<void>;
```

`library.liked()` already answers "did I like this?", so nothing else is needed. When it
exists, the one call site in `packages/ui/src/screens/Shorts/Shorts.tsx` (`toggleLike`) and
the matching one in Watch switch from `react(id, '-')` to `unreact(id)`.
