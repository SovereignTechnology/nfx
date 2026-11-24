# NFX-17 — Seeder lookup (kind 20465)

**Status: Draft (optional; no milestone gates on it)** · 2026-11-22 · depends on NFX-01, NFX-03,
NFX-04 · decided in ADR 0105 and issue #113

A viewer cannot start a video until it knows who seeds it. Beacons (NFX-03) tell it, but they are
ephemeral: a relay holds none for a newcomer, so a viewer waits for the next one a seeder sends.
This document lets a viewer **ask**, and lets each seeder **tell** it at once, by sending a signed
beacon directly to the viewer who asked.

Nothing here replaces beacons. A seeder keeps announcing, and a viewer keeps listening; a lookup
only shortens the first wait. An implementation that ignores this document stays conformant to
NFX-03 and interoperates with one that follows it.

## 1. Events

Kind **20465**, in the ephemeral range: a relay forwards it to live subscribers. Some stock relays
also keep ephemeral events briefly, so nothing here relies on their absence (§6). The `t` tag says
which of two types an event is.

### 1.1 Ask

```
pubkey:     a fresh random key (§4)
created_at: now
kind:       20465
tags:
  ["n", "<namespace>"]                                    # NFX-01 §3
  ["a", "38504:<creator-pubkey>:<namespace>:<video-id>"]  # the manifest being looked up
  ["t", "ask"]
  ["expiration", "<created_at + at most 60>"]             # NIP-40
content:    ""
```

### 1.2 Tell

```
pubkey:     the seeder's beacon key
created_at: now
kind:       20465
tags:
  ["n", "<namespace>"]
  ["a", "<the ask's a>"]
  ["t", "tell"]
  ["p", "<the ask's pubkey>"]
  ["expiration", "<the embedded beacon's expiration>"]
content:    the seeder's signed kind-20464 beacon for that `a`, as compact JSON: no whitespace,
            exactly the members id, pubkey, created_at, kind, tags, content, sig, in that order
```

The embedded beacon is an ordinary NFX-03 beacon. **A seeder MUST NOT add `p`, or anything else
NFX-03 §1 does not allow, to a beacon**: the routing is the wrapper's. A tell is not a beacon
publish, so the beacon floor of NFX-04 §2 does not apply to it.

A tell is not encrypted, on purpose. It carries a beacon of the kind the seeder broadcasts to
anyone subscribed, and a relay must be able to read it to check it.

## 2. Reading

A reader MUST reject an event of kind 20465 unless all of these hold:

1. Its id and NIP-01 signature verify, and `pubkey` is 64 lowercase hex.
2. `n`, `a`, `t` and `expiration` each appear exactly once. `a` addresses a kind-38504 manifest
   and names the same network as `n`.
3. `created_at` is at most 60 s before `now` and at most 30 s after it, `expiration > created_at`
   and `now < expiration`. `expiration` is a canonical decimal integer.
4. For an **ask**: no `p` tag, empty content, and `expiration − created_at ≤ 60`.
5. For a **tell**:
   - `p` appears exactly once and is 64 lowercase hex;
   - the content is at most 16384 bytes, parses as an event of kind 20464 with NIP-01's member types
     (`created_at` and `kind` integers, `tags` an array of arrays of strings, the rest strings), and
     is byte for byte the compact form of §1.2 of that event;
   - the embedded event's `pubkey` equals the tell's `pubkey`;
   - its `a` equals the tell's `a`;
   - it passes every NFX-03 check at `now`;
   - its `expiration` equals the tell's;
   - its `created_at` is not after the tell's. Without this, a beacon dated up to NFX-03's 15
     minutes ahead would hold a place in a viewer's table for that long.

A reader MUST ignore, without error, a `t` value it does not know, and tags it does not know
(NFX-01 §4). A viewer drops a tell whose `p` is not the key it asked with, or whose `a` is not the
video it asked about. The seeder it counts is the beacon's signer, never the throwaway ask key. A
tell earns no trust of its own: a beacon is a hint, however it arrives (NFX-03 §7), and §4 says how
a viewer holds one that arrived this way.

## 3. Seeder

A seeder that answers lookups:

- Subscribes with `{"kinds":[20465],"#n":[<ns>],"#t":["ask"],"#a":[<its videos>],"since":<now − 60>}`,
  on the relays it publishes beacons to and on any general relay it is configured with (§5),
  splitting long lists across filters within the relay's limits (NFX-04 §2).
- Answers only an ask that passes §2, and only for a video it is announcing.
- Addresses the tell to **the ask's signer**, never to a key named in a tag. Answering any other key
  would turn a seeder into a reflector.
- **Bounds its own work.** It verifies at most 32 asks per second per relay connection and drops the
  rest unverified. It checks that its overall and per-video budgets have room before verifying, and
  charges them only after. It keeps per-asker state only for an ask it answered, in a capped map.
- **Treats each relay separately.** It remembers an ask by (id, relay) for at least 120 s. It answers
  on every relay the ask arrives on within 10 s of the first arrival, reusing one signed tell and
  charging its budget once, so one relay that swallows tells cannot silence it on the others.
- Embeds its **newest periodic beacon**. It signs a new one only if the newest has under 30 s to
  live, which keeps a tell useful to a viewer whose clock differs from the seeder's by up to 30 s.
- On an empty budget simply does not answer. The periodic beacon covers it.

| Budget | Value |
|---|---|
| per (asker, video) | 2 tells per 10 s (the viewer's re-ask, §4) |
| per video | burst 8, then 1 per s |
| per seeder, overall | burst 32, then 4 per s |

A seeder following this document SHOULD use a beacon lifetime of **60 s, re-sent every 30 s**, as
NFX-03 §§1 and 3 already allow. A seeder that stops is then forgotten within a minute.

## 4. Viewer

A viewer that asks:

- MUST offer a way to turn asking off. With it off, it publishes nothing and waits for beacons.
- Asks **when the user presses Play**, not when a video's page opens. An ask is a public signal
  (§6), and a viewer that is only browsing has nothing to ask.
- Uses a **fresh random key per video per session**, held in memory and never reused. It MUST NOT
  sign an ask with a key that identifies the user.
- Publishes each ask to **at most 3** of the relays it reads beacons from.
- First opens its beacon subscription and
  `{"kinds":[20465],"#n":[<ns>],"#p":[<that key>],"#t":["tell"],"#a":[<a>],"since":<now − 60>}`. It publishes
  the ask once they are live (end of stored events, or after 1 s), because a relay delivers a tell
  only to a subscriber already there.
- Asks **at most twice per wait**: once, then in a new event with the same key after 3 s if no
  beacon has been heard at all. It closes the tell subscription 10 s after the last ask.
- Reads a relay's refusal by its prefix. `blocked:` means the relay does not carry the kind: skip it
  for the session. `rate-limited:` concerns that one event and says nothing about the next.
- **Never stops listening for beacons.** Old seeders do not answer, and a seeder may be out of
  budget, so the beacon wait of NFX-03 §5 remains the fallback. A limit on tells MUST NOT end or
  starve the beacon subscription.

### 4.1 Holding what a tell says

Keys are free, so anyone who sees an ask can answer it from many keys. A viewer therefore keeps what
it learned only from tells apart from what it heard broadcast:

- It processes **at most 64 tell events per ask on each relay**, counting before verification, then
  closes that relay's tell subscription. One relay's flood does not end the others'.
- It holds seeders heard only through tells in a **separate pool of at most 16 keys per video**.
  A pool entry MUST NOT displace, or take a slot from, a seeder heard as a broadcast beacon. A key
  later heard broadcast leaves the pool.
- A pool entry adds **no weight** to the counts NFX-03 §5 ranks renditions and origins by.
- It uses **only a pool entry's `https` endpoints**. Trackers, STUN servers, iroh and HyperDHT
  endpoints named only by the pool MUST NOT be used: each would learn the viewer's address.
- Pool entries are **open** sources, ordered and capped by §4.2 and fetched from by §4.3. A viewer
  drops a pool attempt as soon as a source in tier 1 or 2 of §4.2 is known.
- A viewer SHOULD settle on a starting source within 700 ms of the first tell and within 2.5 s of
  the ask, and SHOULD keep collecting beacons afterwards.

### 4.2 Choosing sources

Keys are free, and an ask tells anyone watching which video is starting. So a viewer learns nothing
it can trust from a beacon's key, from when the beacon arrived, from which relay carried it, or from
how many keys name an origin. It orders sources by what it can check instead.

A **source** is an origin URL of an `https` endpoint (NFX-05 §6). Its **host** is the URL's scheme,
host and port. A source takes the highest tier of any key that names it. It may be asked for any
rendition a key of that tier claims for it, and its **firm claim** is what all those keys claim in
common. Peers (NFX-10) are not sources here; §4.3 says how their bytes are treated.

A viewer tries sources in these tiers, in this order:

1. sources named by **the creator's own beacon**: one whose signer (`pubkey`) is the creator named
   in its `a`, however it arrived. The `a` tag alone proves nothing, since every beacon for the video
   carries it;
2. sources named by keys with a positive trusted score (NFX-16 §4), highest score first;
3. **open** sources: every other source named by a beacon, heard broadcast or through the pool
   (§4.1). First come those whose host has delivered a file at real-time speed or faster in this
   session (§4.3), in the order they first did. The rest follow in random order, one source per host
   at a time. How many keys name a source adds nothing;
4. sources the caller configured outside beacons, such as a page's own origin, as **a last resort**.

It bounds what open sources can do:

- It holds at most **64 keys per video**, and at most **16 first heard on any one relay**. The
  creator's beacon, keys with a positive trusted score, and the first key to name a host that has
  delivered a file are **protected**. A new key from a relay at its quota replaces a random
  unprotected key first heard on that relay. When the whole table is full, a new key from a relay
  under its quota replaces a random unprotected key first heard on the relay that holds the most
  keys. If there is no such key, the new key is dropped.
- It asks at most **3 open hosts for one file**. In one session it asks at most **6 open hosts** it
  has not asked before, then **one more every 30 s**, preferring hosts first heard on a relay it has
  not yet taken one from. Tier 4, when there is one, is tried before any host past the first 6.
- It uses only the `https` endpoints of pool entries (§4.1). STUN servers follow NFX-10 §1, which
  uses routinely only the one named by the creator's own beacon, so keys answering an ask cannot
  choose a viewer's STUN server.
- It SHOULD open its beacon subscription when the video's page opens, without publishing anything,
  so that beacons heard before Play are already in hand.

### 4.3 Fetching from several sources

A source that serves a hash list that verifies has proved only that it holds the hash list. It may
then send nothing, send slowly, or send bytes that do not verify. Every file is named by its hash and
has the same name at every source (NFX-05 §3), so any other source can supply it.

A **media file** holds media time; the hash list, playlists and init segments do not. A media file's
**rate** is its size from the hash list divided by the media time it holds, and a request for it
runs at **real-time speed** when its body arrives at least that fast. The viewer's **link rate** is
the fastest any one of its requests has received over 4 s in the last 60 s; it is unknown until a
request has run for 4 s. The **floor** is 1 Mbit/s, or a quarter of the link rate when that is lower.
A viewer:

- keeps the sources of §4.2 for the whole session, and adds those it hears of while it plays. It
  holds at most **32 open sources** at a time. One whose beacons have expired stays usable until a
  newer one needs its place, and the least recently used goes first. Sources in tiers 1, 2 and 4 are
  never dropped for room;
- fetches each file from one source at a time, in §4.2's order. It starts with the source that
  delivered the previous file only if that one delivered at real-time speed;
- MUST **assemble each file from one source's bytes only**. A retry at another source starts the
  file again from its first byte;
- **gives up** on a request when:
  - no byte has arrived for 4 s; or
  - over the last 4 s its body has arrived slower than the floor; requests in flight to one host
    count together; or
  - it is to an open source, it is for a media file, the media buffered ahead of playback is under
    4 s, and it has run longer than 4 s or twice the media time the file holds, whichever is longer;
- **hedges**: a request that has run for 2 s is joined by a request for the same file from another
  source when it has had no byte for 2 s, or when the media buffered ahead of playback is under 4 s
  and the request is slower than half its fair share of the link rate (the link rate divided by the
  requests in flight), or the link rate is unknown, and, for a media
  file, also slower than the file's rate. A further hedge waits 2 s more. At most **3 sources** fetch
  one file at once, and **the third is the best tier 1, 2 or 4 source** when there is one. The
  viewer keeps the first copy that verifies and abandons the rest;
- moves to another source after each outcome below, and stops on what it says:

  | Outcome at a source | What follows |
  |---|---|
  | Bytes that do not verify | The source is **stopped for the session** (NFX-05 §4) |
  | A network error, or an HTTP error other than the next row | A **strike** |
  | `404` for a rendition outside the source's firm claim | Nothing: the viewer goes on to another source that claims it |
  | A give-up (no bytes, or too slow) | An open source moves behind tier 4 and every open source that has not given up; any other source to the end of its tier |

- stops a source that has **2 strikes in its last 6 requests**. A source stopped once may be used
  again after **30 s**, in its tier's place. One stopped twice is never used again ahead of a source
  not yet asked. One that sent bytes that do not verify is never used again in the session;
- when every source has failed a file, waits for a new source or for 10 s, whichever comes first,
  then starts again with the sources stopped by strikes eligible;
- sends **no `Referer`** to any source (`referrerPolicy: no-referrer`);
- assembles a file that comes from a peer from that peer's bytes only, and drops a peer that sends
  bytes that do not verify. Peers are bounded by the peer limits of NFX-10, not by §4.2.

So a source that stops sending costs at most 4 s per file. One that sends slowly costs nothing while
the buffer lasts; once it runs low, an open source gets at most 4 s, or twice the file's media time,
and a hedge starts after 2 s. Because the third source fetching a file is the best tier 1, 2 or 4
source, a creator's beacon, a rated key or a configured source is asked for any file that two other
sources have struggled with for 4 s while the buffer is low. Open hosts cost at most 3 attempts per file. A session contacts
at most 6 open hosts before a configured source is tried, and then at most one more every 30 s. With
no creator's beacon, no rated key and no configured source, a determined attacker can hold off an
honest open source for as long as it keeps answering asks from fresh keys (§6). These rules apply to every viewer, whether it
asks or not.

## 5. Relays

**Which relays.** Any relay that carries ephemeral events (NIP-01) carries lookups unchanged, and a
viewer and a seeder need one relay in common. This document intends lookups to work on general
relays: NFX-03 §7 is there to keep *continuous* beacon volume, which grows with the swarm, off them,
and a tell is sent only in reply to an ask and within the budgets of §3. But a tell does embed a
beacon, and NFX-04 §4 says "beacons NEVER to public relays", so that text must be clarified before a
conformant seeder answers on one (§8).

A **scoped relay** (NFX-04) refuses kind 20465 unless it lists 20465 in its NIP-11 `nfx.kinds`.
Frozen NFX-04 §1 does not yet allow one to: that takes an in-place amendment, recorded as an
exception like #96 and #104, and no scoped relay may list the kind before it lands. One that lists
it:

- handles it as an ephemeral: forward to live subscribers, never persist, never return it to a
  later `REQ`;
- admits only events that pass §2, whose `n` it serves, and whose manifest's creator its allow-list
  admits (NFX-04 §8), and refuses every other kind-20465 event as out of scope, including a `t` it
  does not know;
- **before it has verified an event**, applies only size and shape checks and limits keyed on the
  connection or address. It charges a limit keyed on a `pubkey`, `p` or `a` **only after full
  verification**, the embedded beacon included: those values are unauthenticated until then, and
  charging them would let an unsigned event spend someone else's budget;
- drops an event id it has **already verified and carried** in the last 120 s without charging
  anything, so a replay cannot spend a viewer's or seeder's budget, and an unverified event cannot
  poison the cache;
- applies these limits:

| Rule | Limit |
|---|---|
| Ask size | ≤ 1 KiB of event JSON |
| Asks per (`pubkey`, `a`) | ≤ 2 per 10 s |
| Asks per `a` | ≤ 30 per 10 s |
| Tell size | ≤ 36 KiB of event JSON |
| Tells per (`pubkey`, `p`, `a`) | ≤ 2 per 10 s |
| Tells per `pubkey` | ≤ 160 per 30 s |
| Lookup events per connection | ≤ 96 per 10 s |

There is deliberately **no limit per (`p`, `a`)**: fresh keys could fill it and lock honest seeders
out of a viewer. The viewer's own budget (§4.1) bounds what it processes.

A relay MAY refuse a tell that answers no ask it carried in the last 60 s. A relay run as several
instances without shared state MUST NOT, since the ask may have reached another instance.

## 6. Privacy and security

- **An ask is a new public signal.** Before this document a viewer that does not share published
  nothing, and only the relay it subscribed through knew which video it looked up. Now anyone can
  subscribe to kind 20465 and read a **live, network-wide log of which videos are being started and
  when**. An ask carries no identity. A relay still sees the client's IP address, as it does for any
  subscription, and a stock relay may keep asks until they expire.
- **Linking.** A fresh key per video keeps two asks from being linked by key. They can still be
  linked by timing, by IP address at a relay, by the particular set of relays the same ask appears
  on, and by a consistently skewed clock (arrival time against `created_at`).
- **A tell exposes a seeder a little more than a beacon does.** Its content is a beacon, but anyone
  can now ask and time the answer through each relay: an on-demand check that a seeder is live, and
  of its latency, where an observer once had to wait for the next beacon.
- **Reflection.** An honest seeder's tell goes only to a key that proved itself by signing the ask,
  so nobody can aim its answers at a third party's key. Anyone can still address their own tells to
  any key, which is what §4.1 bounds.
- **Sybil answers.** An attacker who sees an ask can answer from many keys, in tells or as ordinary
  beacons, and a relay can add keys of its own to what it returns. §4.1 keeps tell-only keys to
  `https` origins. §4.2 orders sources by the creator's signature, ratings and verified delivery,
  never by key count, timing or relay, and caps how many open hosts a viewer contacts. §4.3 bounds
  what a source that stops delivering costs. None of this tells an honest open source from a
  dishonest one. **A viewer may contact up to 6 attackers' hosts in a session, and one more every
  30 s after that.** With no creator's beacon, no rated key and no configured source, an attacker who
  keeps answering asks from fresh keys can delay playback for as long as it keeps going. All payloads
  still verify (NFX-05). A creator's beacon, a rated key or a configured source bounds that delay, since
  one of them is asked for any file two other sources struggle with (§4.3).
- **What a source learns.** Any source a viewer fetches from learns its IP address, the video, the
  rendition (and so a bandwidth class), and from the timing of requests the play position, pauses,
  seeks and when the viewer gives up. A browser also sends the embedding page's origin (`Origin`) on
  a cross-origin request. A viewer sends no `Referer` (§4.3).
- **Amplification.** One ask of about 0.5 KiB typically draws a tell of about 2.2 KiB from each
  seeder of a video, and at worst about 33 KiB (a 16 KiB beacon, its JSON escaped), about 65 times the
  ask, on each relay the ask reached. Each seeder's budgets (§3) bound what it sends. A scoped relay
  also limits asks per video and tells per key.
- **Denial of the fast path.** Asks from fresh keys can exhaust a video's budget, and tells can
  exhaust a viewer's. The viewer then waits for the periodic beacon, as if it had not asked: at most
  30 s from a seeder at the lifetime §3 recommends, 60 s from one still at a 120 s lifetime. NIP-13
  proof of work may be added later without breaking readers, since they ignore tags they do not know.
- **Replay.** A replayed tell carries a beacon that expires by itself, and a reader keeps only a
  seeder's newest beacon (NFX-03 §2). A scoped relay drops a repeated event id. A seeder drops a
  repeated ask on the same relay; it deliberately answers the same ask once on each other relay (§3).

## 7. Vectors

`spec/test-vectors/lookup.json` holds an ask and a tell that reproduce byte for byte from their
throwaway keys, and events exactly on each limit that MUST be accepted. `lookup-invalid.json` holds
the events a reader MUST reject, each breaking one rule, and a type it MUST ignore. An implementation
checks both.

## 8. Open issues

**Before any freeze:**


- Registering kind 20465 in `nostr-protocol/registry-of-kinds`. It was unclaimed in the NIPs table
  and that registry on 2026-11-22.
- The NFX-04 amendment that lets a scoped relay carry the kind, and a clarification of NFX-03 §7 and
  NFX-04 §4 for tells on general relays (§5).
- Vectors for embedded events with the wrong JSON types, for readers in languages that parse loosely.
- Which general relays viewers and seeders should share, so that a lookup works without a scoped
  relay.
- Whether a node holding a live beacon may forward it for a seeder that does not answer. Version 1
  allows only the beacon's own signer.
- Whether asks need proof of work in practice.
- Whether stock relays keep ephemeral events, and for how long, in the default configurations of
  the relays this project tests against.

## Changelog

- Draft 2026-11-22 — initial (issue #113, ADR 0105), revised the same day after an adversarial
  review: a separate pool for tell-only seeders, limits charged only after verification, a beacon
  may not be dated after its tell, one spelling for the embedded beacon.
- Draft 2026-11-24 — §4.2 (choosing sources) and §4.3 (fetching from several sources) close the two
  requirements §8 held open before any viewer implements this, after a review found that ordering
  by arrival time, fixed deadlines and failures in a row could each be gamed.
