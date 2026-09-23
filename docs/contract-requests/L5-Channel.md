# Contract request — L5-Channel (against `CONTRACTS_VERSION = 3`)

**Status: a note, not a blocker.** The Channel screen ships against v3 with a screen prop as the
workaround (the same way L5-Home handled `followedTags`). Nothing here needs to land before merge.

## What is missing: an author-scoped seeder lookup (kind 10019)

build-plan §6.1 row **Channel**: _"Seeding N videos" indicator if the channel runs a seeder_,
backed by kind 10019. `NetworkAdapter` v3 has no way to ask "does pubkey X run a seeder, and for
how many videos?". What it does expose:

| Source | What it answers | Why it cannot drive the indicator on its own |
|---|---|---|
| `adapter.seeder.status()` / `onStatus` | the **local** node's seeder (`enabled`, `pubkey`, `videos`) | only ever describes your own node, so only your own channel |
| `VideoStats.seedersOnline` | how many seeders (any of them) announce one video's core | a popular video has seeders whoever made it, so it cannot tell whether the **channel** runs a seeder. In the mock every video reports ≥ 1, which would badge every channel, including fixture channels with `seeds: false` |
| `PricePolicy.creatorP2pk` ("from their kind 10019") | the creator's Cashu P2PK lock key | every creator who takes payouts has one; it says nothing about seeding |
| `FixtureChannel.seeds` (mocks) | the fixture's ground truth | not reachable through the adapter (only used for play-session peer lists) |

## Workaround shipped

- `ChannelProps.seedingVideos?: number`: the shell passes it when it knows (for example from its
  own kind-10019 lookup). Stories derive it from `FixtureChannel.seeds`.
- On your own channel (`me() === pubkey`) the screen uses `adapter.seeder.status()` and
  `onStatus` instead (live, authoritative), and ignores the prop.
- `VideoStats.seedersOnline` is shown honestly as **Availability** on the About tab ("Seeders
  online for N of M videos"), never as "this channel seeds".

## Suggested addition (v4, whenever convenient)

```ts
// NetworkAdapter
/** The channel's own seeder, from its kind-10019 announcement (+ swarm liveness if known). */
seederAnnouncement(pubkey: NostrPubkey): Promise<{
  readonly videos: number;          // videos the announcement covers
  readonly mints: readonly MintUrl[];
  readonly online?: boolean;        // seen in the swarm recently, when the adapter knows
} | null>;
```

The Channel screen would then call it in place of the `seedingVideos` prop (the prop can stay
as an override). `MockNetworkAdapter` can answer it from `FixtureChannel.seeds`.
