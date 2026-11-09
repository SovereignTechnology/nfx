# NFX-16 — Seeder ratings (kind 7368, scope `nfx.seeder`)

**Status: Draft (optional; no milestone gates on it)** · 2026-11-04 · depends on NFX-01, NFX-03,
and NFX-07 §3 for identities · decided in ADR 0104 §2 and §6.3–§6.4

A watcher may publish what it thought of a seeder, and read what the people it follows thought.
That lets it prefer seeders that served them honestly and fast. Ratings choose seeders; they never
price watchers. They change no payment rule (NFX-07). They do nothing against sybil watchers
either, since only a rating's author is checked, never the watcher a seeder served (ADR 0104).
**Publishing is off by default** (§3.1), because a rating tells the world which seeders its author
used.

The event is not new. It is the `rating` record of mmalmi's `nostr-social-memory`, a kind 7368
fact op of `nostr-identity`. nostr-vpn rates its paid exits with the same record under scope
`vpn.exit`, and the scope keeps the two apart. This document restates every field NFX uses and
pins them with vectors (§7), so an upstream change cannot change NFX silently. The reference
versions are `nostr-social-memory` 0.1.1 over `nostr-identity` 0.1.5 (both MIT).

## 1. Event shape

| Field | Value |
|---|---|
| `kind` | **7368** (regular; `nostr-identity`'s fact op kind) |
| `pubkey` | the rater: the watcher's Nostr identity (§3.1) |
| `content` | the empty string |
| `created_at` | when the event was signed (§3.3) |

Tags, in this order. It is the order `nostr-social-memory` 0.1.1's builder emits for these facts,
followed by `n` and `expiration`:

```
["i", "<record id>", "subject"]          # a fresh UUID per event, canonical lowercase text
["i", "<rater>"], ["i", "<subject>"], ["i", "nfx.seeder"]   # index tags, sorted
["p", "<rater>"], ["p", "<subject>"]     # index tags, sorted
["created_at", "<unix seconds>"]
["max_rating", "100"]
["min_rating", "-100"]
["rater", "<rater pubkey>"]
["rating", "<integer -100..100>"]
["reason", "measured" | "user"]
["schema", "1"]
["scope", "nfx.seeder"]
["subject", "<seeder pubkey>"]
["type", "rating"]
["n", "<namespace>"]                     # NFX-01 §3
["expiration", "<created_at + 2592000>"] # NIP-40: 30 days
```

The facts:

| Fact | Value |
|---|---|
| `rater` | 64 lowercase hex; MUST equal the event's `pubkey` |
| `subject` | the seeder's long-term identity (NFX-07 §3), the key its beacons are signed with (NFX-03 §1), as 64 lowercase hex; MUST differ from `rater` |
| `rating` | a canonical decimal integer (no `+`, no leading zero, no `-0`) from −100 to 100. Positive is good, negative is bad, and `0` withdraws the author's earlier rating (§4) |
| `min_rating`, `max_rating` | exactly `-100` and `100` |
| `scope` | exactly `nfx.seeder` |
| `type`, `schema` | exactly `rating` and `1` |
| `created_at` | unix seconds as a canonical decimal integer; the publisher sets it equal to the event's `created_at` |
| `reason` | `measured` (computed from the watcher's own measurements, §3.2) or `user` (a person's vote). Publishers MUST set one of the two. Readers treat it as informative and MUST NOT reject an event for its value or its absence |

A seeder that announces no long-term identity (a WebRTC-mesh seeder, NFX-07 §3) has nothing to
rate.

**Validity.** A reader MUST reject an event unless all of the following hold:
- `kind` is 7368, `content` is empty, and the `id` and signature verify (NIP-01);
- it has exactly one `n` tag, naming the namespace being read. The tag is required as NFX-01 §3
  requires it of every NFX event, although kind 7368 is defined elsewhere;
- it has exactly one `expiration` tag, with a decimal integer;
- it has exactly one `["i", <uuid>, "subject"]` tag, holding a canonical lowercase UUID;
- it has no `d` and no `e` tag;
- each of `type`, `schema`, `scope`, `rater`, `subject`, `rating`, `min_rating`, `max_rating` and
  `created_at` appears exactly once, with exactly one value, as the table above says.

Readers ignore other tags, including the other `i` and `p` index tags and any other fact.
`test-vectors/ratings-invalid.json` lists cases that MUST each be rejected.

**What never goes in.** `nostr-social-memory`'s optional facts are never published:
`sample_count`, `window_start`, `window_end`, `evidence` and `tag`. Neither is a video, a file, an
amount, a mint, an endpoint, an address or a session. Each would tell more about what the author
watched, and when (§5).

## 2. Where ratings live

- **General relays only.** A publisher sends ratings to its author's NIP-65 write relays
  (kind 10002), or else to its configured relays. Ratings never go to scoped relays: NFX-04 §1
  rejects every kind but its own, and ratings are slow-moving public facts, like the follow lists
  they are read with.
- **Reading.** A reader asks each author's NIP-65 write relays for
  `{"kinds": [7368], "authors": [<admitted authors>], "#n": ["<namespace>"], "since": <now − 30 days>}`.
  It falls back to its own relays.
  - It SHOULD NOT add `#p`, since that would tell relays which seeders it is considering.
  - It SHOULD keep what it reads locally and refresh at most hourly, not at every video start.

## 3. Publishing (watcher)

### 3.1 Off by default

- Publishing MUST be off until the user turns it on. When it is turned on, the watcher tells the
  user what a rating reveals (§5).
- A rating is signed with the user's Nostr identity, the one other people follow. That key is
  never something a seeder sees: the watcher's identity toward a seeder is a transport identity
  (NFX-07 §3), a different key, and it stays one.
- Reading needs no publishing. A watcher with publishing off still reads and scores ratings
  (§4), and still uses its own measurements.

### 3.2 What a score means

- **`measured`.** The watcher's software computes it from its own record of that seeder over the
  sessions since its last rating of it. This document fixes the range and the meaning of the sign;
  the magnitude is the implementation's.
  - **Upward:** files the seeder's beacon claimed were served when asked, each quote and `ack`
    came as NFX-07 §2–§3 require, and throughput kept playback ahead.
  - **Downward:** the seeder refused a file its beacon claimed, stalled until the watcher failed
    over, or left a payment without an `ack`.
  - **Not counted:** a `mint-unavailable` answer. The mint caused it, not the seeder.
  - **Negative scores:** publish one only when another seeder of the same video served the
    watcher well in the same session. Otherwise the fault may be the watcher's own network.
- **`user`.** A person's explicit vote. It is allowed only for a seeder that delivered the
  watcher at least one verified file (NFX-05 §4).

### 3.3 When

- **At most one rating per (rater, subject) per 24 h**, and only after a session with that seeder
  has ended.
- **Publish at a uniformly random moment from 1 h to 24 h after the session ended.** If the
  watcher is not running then, publish at its next start, never earlier.
- **Each seeder gets its own independent random moment**, even when several served one session.
- **`created_at` is the moment of signing**, and `expiration` is `created_at` plus 2,592,000 s
  (30 days).
- **Republishing keeps a rating alive.** Without new sessions, a rating lapses after 30 days.
  Republishing an unchanged opinion is allowed only after a new session with that seeder.
- **Withdrawing.** To withdraw a rating, publish `0`.

## 4. Reading and scoring (watcher)

**Who counts.**
- The **admitted authors** are the user's own identity, the authors on its latest kind 3 follow
  list, and any trusted authors configured locally. Anyone on its latest kind 10000 mute list is
  then removed.
- Follows of follows are never admitted: one followed account could otherwise mint unlimited
  identities a step away.
- Ratings never change the follow graph.

**Scoring.** For one namespace at time `now`:

1. **Drop invalid events** (§1), including those that name another namespace.
2. **Ignore an event when any of these holds:**
   - its author is not admitted;
   - its `created_at` fact, or the event's `created_at`, is more than 15 minutes after `now`;
   - its `created_at` fact is more than 30 days before `now`;
   - its `expiration` is at or before `now`.
3. **Keep the newest rating per (author, subject):** the greater `created_at` fact. On a tie, the
   lexicographically greater lowercase event id wins.
4. **Drop kept ratings of `0`.** They are withdrawals, and add nothing to the mean.
5. **Score each subject:** the sum of its kept ratings divided by their count, truncated toward
   zero. Report the count too.

`test-vectors/ratings-scoring.json` gives one reader's inputs and the scores it MUST compute.

**Choosing seeders** (SHOULD). Among the beacons a watcher may use for a video (NFX-03 §5),
rank by:
1. **health:** a seeder that failed the watcher in this session, or whose endpoints did not
   answer, ranks last whatever its score;
2. **the user's own `user` vote:** positive first, negative last;
3. **the watcher's own measurements** of that seeder;
4. **the trusted score:** higher first, and an unrated seeder counts as 0;
5. **lower `price_hint`**;
6. **the newer beacon.**

A score never rescues a seeder that is failing now.

`nfxd run --rating-root` (2026-11-05) ranks by 1 and 4 and keeps its own tie-breaks: a seeder on
cooldown after a failure last, a seeder heard only over gossip after one from a relay's beacon,
then the trusted score, then the order learned. Ranks 2, 3 and 5 wait for publishing and paid
seeding.

**Seeders.** A seeder MUST NOT use ratings, or any watcher's Nostr identity, to set a watcher's
credit or `window` (ADR 0104 §6.4). It cannot see that identity anyway, and must not ask for it.

## 5. Privacy and security

- **A rating is public.** It says "this npub used that seeder, at about this time". A seeder
  that logs which transport identity fetched which files, and when, could match a rating's time
  against that log and learn what the npub watched.
  - Hence: off by default, the random delay of §3.3, at most one rating a day per seeder, and no
    detail in the event.
  - **What remains:** a seeder with few watchers in a day can still guess. A user who minds
    leaves publishing off.
- **Reading is quieter.** A reader's REQ shows relays whose ratings it reads, which its follow
  list already shows. Without `#p`, it does not show which seeders it is considering.
  - **What remains:** asking for its own follow and mute lists ties the reader's network
    address to its key at those relays, as any Nostr client fetching its own lists does. A
    reader who minds uses relays it trusts, or leaves reading off (it is off unless the user
    names a key).
- **Sybil seeders cannot boost themselves.** Ratings by authors who are not admitted never
  count, and a rater cannot rate itself. A followed account that turns hostile can still skew
  scores, and the user's remedy is to mute it.
- **Sybil watchers are untouched.** NFX-07's caps and, later, NFX-15's channels address them;
  ratings do not.
- **A seeder that changes identity loses its score.** That is harmless, since unrated counts as 0.
- **Ratings move no money**, and nothing in NFX-07 reads them.

## 6. Compatibility with `nostr-social-memory` and nostr-vpn

- **Same record, different scope.** nostr-vpn's readers require scope `vpn.exit` and skip NFX
  ratings; NFX readers require `nfx.seeder` and skip nostr-vpn's.
- **The `n` and `expiration` tags do not disturb the library.** `nostr-identity`'s parser skips
  single-letter tags it does not know, such as `n`. It keeps `expiration` as an extra fact, which
  the rating record ignores.
- **The cross-check.** On 2026-11-04 a one-off program ran `nostr-social-memory` 0.1.1's
  `rating_from_event` over every vector (§7), over `nostr-identity` 0.1.5 and `nostr-sdk`
  0.44.1, in a Kata VM. It read each valid rating, and the fifteen scoring events, with the same
  fields as NFX-16, and with nothing in the optional facts.
- **NFX-16 is stricter than the library on purpose.** The library accepts 12 of the 23 invalid
  cases: a missing or doubled `n`, no `expiration`, another scope, a rater that is not the
  signer, a self-rating, a bech32 subject, a `+80` or `080` rating, another range, an `e` link,
  and an uppercase UUID. It rejects the other 11, as NFX-16 does. nostr-vpn's own reader adds
  the rater-is-signer check.
- **If upstream changes the record** (a schema 2), NFX-16 stays on schema 1 until this document
  is revised.

## 7. Vectors

| File | Content |
|---|---|
| `test-vectors/ratings.json` | valid ratings: a `measured` +80 of the beacon vector's seeder, a `user` −60 and a withdrawal; `reads_as` is what a reader takes from each |
| `test-vectors/ratings-invalid.json` | events every reader MUST reject (§1) |
| `test-vectors/ratings-scoring.json` | §4: a root, follows, trusted authors, mutes, `now` and fifteen events, with each event's verdict and the scores |

The source is `test-vectors/ratings.py`, called by `generate.py`. It holds the reference reader
and scorer, and every verdict in the files is checked against them when they are generated.

`nfx-proto`'s `rating` module (Rust) is a second reader and scorer. It reads all three files as
the reference does, every verdict and score included, natively and on `wasm32`
(`crates/nfx-proto/tests/ratings.rs`).

## 8. Open issues (before any freeze)

- **Kind 7368 is `nostr-identity`'s, not ours.** It is not yet in
  `nostr-protocol/registry-of-kinds`. NFX-11 §1 lists it as profiled, like 30166.
- **No weight for distance.** Follows of follows count for nothing. A second ring at a lower
  weight would add reach and sybil risk together; decide only on evidence.
- **nutflix-pear's legacy seeder selection** (its T10) could read the same events, but only for
  seeders that announce a Nostr key. Decide with nutflix-pear.

## Changelog

- Draft 2026-11-04 — initial (ADR 0104 §2, §6.3, §6.4). The record and its tag order are
  `nostr-social-memory` 0.1.1's, plus `n` and `expiration`. Publishing is off by default, with a
  random 1–24 h delay and at most one rating per seeder a day. Scores come only from the user,
  its follows and trusted authors, minus mutes.
- Draft 2026-11-05 — a second implementation, no normative change: `nfx-proto`'s Rust reader
  and scorer match every vector, and `nfxd` orders the seeders it pulls from by trusted score
  (§4, ranks 1 and 4). §5 names what reading still reveals: the reader's address, to the
  relays it reads its own lists from.
