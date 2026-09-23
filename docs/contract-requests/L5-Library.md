# Contract request — L5-Library (against `CONTRACTS_VERSION = 3`)

Nothing here blocks the lane: every item is worked around inside v3 and documented in
The lane report (not published). Listed so the orchestrator can decide whether a later version
should carry them.

## 1. `Route` — deep link to an open playlist (orchestrator-owned `screens/shared/route.ts`)

```ts
| {
    readonly name: 'library';
    readonly tab?: 'history' | 'watch-later' | 'playlists' | 'liked';
    readonly playlist?: string; // NIP-51 `d` tag of the open playlist
  }
```

**Why:** opening a playlist is a navigation in YouTube terms (it has its own URL, Back closes
it). With v3 the Library keeps the open playlist in local state, so the browser Back button
and a copied link cannot reach it.

**Workaround in place:** `LibraryProps.playlistId?: string` opens that playlist on mount (and
follows prop changes); a shell that wants deep links passes it. Once `Route` carries
`playlist`, the screen would call `navigate({ name: 'library', tab: 'playlists', playlist })`
on open and `navigate({ name: 'library', tab: 'playlists' })` on "All playlists" — a
two-line change.

## 2. `NetworkAdapter.library` — clarifications / small additions (nice to have)

- **`playlists(author?)` with no argument** — the screen assumes it means "the signed-in
  viewer's own playlists, private ones decrypted" (the mock returns every playlist, all of
  which are the viewer's). Please state it in the contract comment; the Channel screen passes
  an `author`.
- **Privacy of Watch later / Liked** — `watchLater()` and `liked()` return bare manifests, so
  the screen cannot show a private indicator for them (it shows one only for `Playlist`).
  The screen's copy assumes likes are public NIP-25 reactions (kind 7) and History is a
  private, encrypted NIP-51 list (build-plan §6.2 "private history"). If either is wrong the
  copy is one line each (`TAB_HINT` in `Library.tsx`).
- **History management** (YouTube has "remove from history" and "clear all"): a
  `removeHistory(videoId)` / `clearHistory()` pair would let the screen add those controls.
  Not requested for v3; no UI was built for them.
