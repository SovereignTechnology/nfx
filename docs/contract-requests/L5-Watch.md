# Contract requests — lane L5-Watch (against `CONTRACTS_VERSION = 3`)

None of these blocks the lane: each is worked around in v3 as described. They are listed in
order of how much they would improve the Watch screen. The orchestrator decides whether any
goes into v4.

## 1. Resolve `nostr:` references to profiles

**Need.** Build-plan §6.3: "nostr: links resolved to profile chips". L4's `Markdown` hands the
screen a `NostrRef` (`{ uri, entity, bech32 }`) through `renderNostr`, but
`NetworkAdapter.profile(pubkey)` takes a **hex** pubkey. Turning `npub1…`/`nprofile1…` into
hex means bech32 decoding, which the UI must not do (it imports nothing from core at runtime
beyond the adapter, and has no nostr library).

**Workaround in v3.** Descriptions and comments render L4's neutral text chip for every
`nostr:` reference.

**Proposal.** Either widen `profile(pubkeyOrBech32: NostrPubkey | string)` to accept
`npub`/`nprofile`, or add

```ts
resolveNostr(bech32: string): Promise<
  | { readonly kind: 'profile'; readonly pubkey: NostrPubkey; readonly profile: Profile | null }
  | { readonly kind: 'event'; readonly id: NostrEventId }
  | null
>;
```

so the screen can render a `ProfileAvatar` + name chip that navigates to the channel.

## 2. Per-video resume position

**Need.** §6.2 "Resume from NIP-51 private history". `library.history(cursor?)` is paged
(newest first), and there is no lookup by video.

**Workaround in v3.** Watch reads the first page only; a video last watched more than one page
ago starts at 0.

**Proposal.** `library.progress(videoId: NostrEventId): Promise<number | null>` (seconds), or a
`videoId` filter on `history`.

## 3. Throughput for an "Auto" rendition

**Need.** §6.2 "Auto mode picks by throughput, not by sats". `PlaySession` reports spend and
peers but no throughput, so the UI cannot implement or even label an Auto mode honestly.

**Workaround in v3.** No Auto entry: the viewer sees and picks an explicit rendition, and its
price is the one shown (`quoteFor` → `play(id, label)`).

**Proposal.** `PlaySession.onThroughput(cb: (bytesPerSec: number) => void): Unsubscribe`, or an
adapter-side `'auto'` label whose session reports the rendition it actually streams — with the
rule that the UI must show the price of each switch *before* it happens (today's
`switchRendition` contract already says "the UI shows the price difference first").

## 4. Playlist context on the watch route (Route, not a contract)

`Route.watch` is `{ videoId, t? }`, so a playlist link (Library → Watch) cannot survive a
reload. Watch takes a `playlist` prop instead. Suggest `list?: { readonly author: NostrPubkey;
readonly id: string }` on the `watch` route (a NIP-51 `d` tag is only unique per author), with
the shell resolving it through `library.playlists(author)`.

## 5. Session liveness (nice to have)

The mini-player handshake passes a live `PlaySession` between Watch and the shell. Neither side
can ask whether a session was already closed (e.g. the shell dismissed its mini-player just as
the viewer expanded it). A `readonly closed: boolean` (or `onClose(cb)`) on `PlaySession` would
let the adopter refuse a dead session instead of showing a player that never advances.
