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
- It tries sources in this order:
  1. those named by **the creator's own beacon**: one whose signer (`pubkey`) is the creator named
     in its `a`, however it arrived. The `a` tag alone proves nothing, since every beacon for the
     video carries it;
  2. those named by seeders heard broadcast, ranked as NFX-03 §5;
  3. those named only by the pool, in random order, each origin URL once however many keys name it.
- It tries **at most 3** pool sources, each for **at most 8 s** to serve a hash list that verifies,
  and drops a pool attempt as soon as a creator-signed or broadcast source is known. A failure never
  ends the viewer's wait.
- A viewer SHOULD settle on a starting source within 700 ms of the first tell and within 2.5 s of
  the ask, and SHOULD keep collecting beacons afterwards.

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
- **Sybil answers.** An attacker who sees an ask can answer from many keys. For beacons that arrive
  **in tells**, §4.1 keeps that from displacing seeders heard by broadcast, from steering rendition
  and origin rankings, and from naming anything but an `https` origin. **This draft does not yet bound
  ordinary beacons published from fresh keys in response to an ask** (§8). A pool origin can still
  be tried, so if no creator-signed or broadcast source is known yet, **the viewer may contact an
  attacker's origin, which learns its IP address and the video**. All payloads still verify (NFX-05).
  The 8 s bound covers only the hash list; delivery after it is §8's.
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

**Before any viewer implements this:**

- A viewer MUST keep a burst of fresh keys that publish ordinary beacons from crowding out the
  seeders it already knows. The pool of §4.1 covers only beacons that arrive in tells; the rule for
  broadcast keys is not yet specified.
- A viewer MUST be able to leave a source that verifies and then stops delivering, and move to
  another, with a bound on how long that takes. This is not yet specified.

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
