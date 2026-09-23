# Contract change request — lane L5-Search (Search screen)

Issued against `CONTRACTS_VERSION = 3`. Nothing in the lane is blocked: every request below
has a working screen-side workaround, listed with it. Ordered by how much the screen would
gain.

## 1. Filters in the search route (orchestrator-owned `screens/shared/route.ts`)

**Where:** `Route` in `packages/ui/src/screens/shared/route.ts` — not a core contract, but
frozen for L5 lanes all the same.

**Why:** the task asks for filter state to be "reflected by navigating to an updated Search
route rather than hidden local state, if the Route shape allows". It does not:
`{ name: 'search'; q: string }` has nowhere to put upload date, duration, tags or creator, so
a filtered search cannot be deep-linked, bookmarked or restored by Back.

**Proposed shape** (exactly the screen's own `SearchFilterState`, minus the defaults):

```ts
  | {
      readonly name: 'search';
      readonly q: string;
      readonly filters?: {
        readonly uploaded?: 'hour' | 'day' | 'week' | 'month' | 'year';
        readonly duration?: 'short' | 'medium' | 'long';
        readonly tags?: readonly string[];
        readonly author?: NostrPubkey;
      };
    }
```

**Workaround in place:** `Search` takes `filters?: Partial<SearchFilterState>` (followed by
content, so a shell may pass a fresh object every render) and `onFiltersChange?(state)`,
called on every filter change the viewer makes. A shell can mirror those into its URL today.
Once the route carries them, the screen's filter setter becomes one
`navigate({ name: 'search', q, filters })` call and the shell passes `route.filters` back as
the `filters` prop — no other change. `normalizeSearchFilters` already sanitises input from
a URL (unknown preset ids → "any", tags lower-cased, de-duplicated, capped at 10).

## 2. Channel results from search

**Where:** `NetworkAdapter` in `packages/core/src/contracts/network-adapter.ts`.

**Why:** §6.1 "Search" and the task ask for channel results "where the contract returns
them". `search()` returns `Page<VideoManifest>` only, so a channel that matches the query
but has no matching video is invisible, and there is no subscriber count to show.

**Proposed addition** (NIP-50 `search` over kind 0, plus the local index of followed
channels, like video search per §2.2):

```ts
  searchChannels(q: { readonly text: string; readonly cursor?: string }): Promise<Page<Profile>>;
```

**Workaround in place:** the screen derives channel results from the authors of the video
hits: an author whose display name or handle has a word starting with the query (or whose
NIP-05 name starts with it; two characters minimum) is shown on top as a `ChannelRow` with
Subscribe (at most two). It is honest — it never invents a channel — but it can only find
channels that also have a matching video.

## 3. (Optional) Cancellation and page size for `search`

**Why:** a superseded search is currently _ignored_ (sequence number + effect cleanup; a
stale answer never reaches the screen — tested), but the relay subscription behind it keeps
running until it finishes. An `AbortSignal` would let the adapter send `CLOSE` for a NIP-50
`REQ` the viewer has already typed past. Separately, `FeedQuery` has `limit` and `search`
does not; the mock pages at 10.

**Proposed:**

```ts
  search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
    readonly limit?: number;
  }, opts?: { readonly signal?: AbortSignal }): Promise<Page<VideoManifest>>;
```

**Workaround in place:** none needed for correctness; the screen already drops stale
responses and would pass the signal as soon as the parameter exists.
