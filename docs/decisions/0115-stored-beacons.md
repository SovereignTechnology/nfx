# 115. Stored beacons: a newcomer finds seeders with one query

Date: 2026-11-27

## Status

Proposed 2026-11-27. **The maintainer chose option A the same day** ("Decisions" below):
stored beacons, with ask/tell withdrawn, adopted once the measurements meet the adoption criteria
in "What relays do that this cannot assume". Until then no spec text changes, and this record
stays Proposed.

It reopens decision record 0105, which chose seeder lookup (NFX-17, kind 20465) and rejected
stored beacons for one reason: NFX-03 §2 and NFX-04 §7, then frozen, said beacons are never
persisted. The maintainer has since decided (2026-11-27, recorded in its own change) that frozen
documents may change until nfx 0.10.0, so that reason is gone and this record weighs the design
on its merits.

This record changes no spec text, artifact, schema, vector or code. The sections "Spec
consequences" and "Code consequences" list what accepting it would change. The relay behaviour
it depends on is only partly known: "What relays do today" says what was read, and "What relays
do that this cannot assume" what must be measured first. The number is taken by whichever of
this record and a parallel one merges first; the other renumbers.

## Decisions (the maintainer, 2026-11-27)

1. **Design: A**, adopted once the measurements pass.
2. **NFX-17 meanwhile: left as it is, with the answerer on.** nfx 0.1.4 is being re-cut from
   the merge of #134 (nutflix #148), not from 226fd79, which will not be tagged. So 0.1.4
   carries the lookup code (4b6095c) and decision record 0111. The nfxd it ships answers asks
   by default (`--no-lookup` turns that off), and no change flips the default. **The withdrawal
   therefore retires a released behaviour**, not unreleased code:
   - readers stop asking first (the web player's `ask` option, pear). They lose nothing, since
     a stored record answers the same question without a publish;
   - a later nfxd release stops answering, and its embedded relay stops admitting kind 20465
     (`--embed-relay-lookup`). Its release notes say so;
   - 0.1.4 nodes keep answering until their operators upgrade. New readers never ask, so this
     only costs those nodes their ask subscriptions, within NFX-17 §3's budgets;
   - NFX-11 keeps 20465 registered as withdrawn until 0.10.0, so the kind is not reused.
3. **Lifetime 600 s, republished every 300 s** (Proposal §3).
4. **nutflix-pear:** merge #166, hold #167, split #168. Its beacon half merges and its
   answering half is held ("The pending nutflix-pear pull requests").
5. **M3 is approved as written:** a throwaway key, namespace `nfx:lab-stored-beacons:1`, at most
   about 600 events per relay, stopping at the first refusal, on the eight relays listed.
6. **Records for videos kept only because they were watched** (NFX-18): scoped relays, plus
   general relays whose NIP-11 `supported_nips` lists 40.
7. **Kind 20464:** as Migration step 6. Sending it becomes optional one release after every
   reference reader reads 30464; readers keep reading it until 0.10.0.

## Context

### The wait

A viewer cannot start until it knows a seeder. Beacons (kind 20464) are ephemeral, so a relay
holds none for a newcomer, and the viewer waits for the next one a seeder sends. Measured
2026-11-22 in headless Chromium, 21 runs, from the click to the first frame (decision record
0105):

| Case | Click to first frame |
|---|---|
| Play pressed at once | 45-55 s, of which 42-52 s is waiting for a beacon |
| A beacon already heard | 3.4-5.1 s |

At the 60 s lifetime NFX-17 §3 recommends, re-sent every 30 s, the wait is 0-30 s. It is the
rest of the seeder's period, so the wait and the write rate are tied: halving the wait doubles
every seeder's writes on every relay.

### What a stored beacon changes

An addressable event is kept by the relay, the newest per (kind, `pubkey`, `d`). If a beacon is
addressable and carries a NIP-40 `expiration`, the relay holds each seeder's current beacon
until it expires, and a newcomer's `REQ` returns it at once, before end of stored events.
**Discovery latency no longer depends on the cadence.** It is one round trip to a relay that
holds the record, and a page can make that query when the video's page opens, publishing
nothing. The cadence then sets only the write rate and how long a dead seeder stays listed, so
it can be slow. Kind 33478 (NFX-10 §1, NFX-04 §1 as amended 2026-11-19) already works this way:
addressable, with an `expiration` at most 24 h on, kept by the relay until then.

If stored beacons find seeders at once, the ask (NFX-17 §1.1) has nothing left to do, and with
it goes the live public log of which videos are being started (NFX-17 §6). Decision record 0111
also lists stored beacons among its alternatives, together with tells: "without periodic beacons
there, an ask flood or a client that never asks finds nothing". That argument is about tells
alone. A stored beacon is the periodic beacon, so it does not apply.

### What relays do today (read on 2026-11-27, nothing published)

- **NIP-11 documents** of 11 relays (`Accept: application/nostr+json`):
  - `relay.damus.io`, `relay.primal.net`, `nos.lol`, `nostr.mom`, `offchain.pub` and
    `relay.nostr.net` run strfry and list NIP-40 and NIP-09. `max_limit` is 500, except 100 on
    `relay.nostr.net`.
  - `relay.ditto.pub` (ditto-relay 2.5.2) lists NIP-40; `max_limit` 1000, `default_limit` 100,
    `created_at` at most 900 s ahead.
  - `nostr.wine` lists NIP-40 but requires payment and restricts writes. `nostr.land` requires
    payment and lists no NIPs.
  - `relay.snort.social` (memlay 0.2.0) lists NIPs 1, 9 and 11, not 40.
  - `relay.nutflix.xyz` (nfx-node 0.1.3) lists NIP-40 and `nfx.kinds` 38504, 20464, 5, 25050.
  - `relay.nostr.band` did not answer.
- **strfry's source** (hoytech/strfry master 4cd3cf6, 2026-09-04):
  - On write, it rejects an event whose `expiration` has passed, and an ephemeral event more
    than 60 s old.
  - It **stores ephemeral events** and deletes them once they are older than
    `ephemeralEventsLifetimeSeconds`, 300 by default.
  - A cron job deletes expired events every 9 s. The read path does not check `expiration`,
    so a `REQ` can return an expired event for up to about 9 s.
  - Its defaults allow events up to 64 KiB, 2000 tags and 1024-byte tag values, return at most
    500 events per filter, and allow 3 tag filters per filter.
- **One-shot `REQ`s, no publish:**
  - For kind 24133 (NIP-46, ephemeral), limit 50: `relay.primal.net` returned 50 events aged
    5-45 s, and `nos.lol` 17 aged 11-250 s. `relay.damus.io`, `nostr.mom`, `relay.ditto.pub` and
    `relay.snort.social` returned none: either they keep no ephemeral events or none were there.
  - For kind 20464: none, on any of these relays. No released seeder sends beacons to general
    relays yet; 0111 first ships in the re-cut nfx 0.1.4.
  - For kind 30464, the kind proposed below: none, on the 8 public relays above.

So some general relays already hand recent ephemeral beacons to a new `REQ`, and others do not.
Nothing can rely on that. A stored kind makes it the rule.

## Proposal

### 1. Kind 30464

An addressable kind (30000-39999) with the last four digits of 20464, the ephemeral beacon.
Checked on 2026-11-27: not in the NIPs kind table (`nostr-protocol/nips` README at bec0fc8,
2026-11-16), not in `nostr-protocol/registry-of-kinds` (`schema.yaml` at 204f47c, 2026-11-02),
and no issue or pull request in either repository names it. The nearest claims are 30402 and
30403 (NIP-99), and an open registry pull request for 30404. 30465 is free too. It would be
registered with 38504 and 20464 (NFX-11 §1).

### 2. Shape

```
kind:       30464
pubkey:     the seeder's beacon key (NFX-03 §1)
created_at: now
tags:
  ["d", "38504:<creator-pubkey>:<namespace>:<video-id>"]  # equal to the a tag
  ["n", "<namespace>"]                                    # NFX-01 §3
  ["a", "38504:<creator-pubkey>:<namespace>:<video-id>"]  # the manifest this serves
  ["expiration", "<created_at + L>"]                      # NIP-40; L in [60, 900] s
content:    NFX-03 §4, unchanged (schemas/beacon-content.schema.json)
```

- **`d` equals `a`**, so a relay holds one record per (seeder key, video).
  `<namespace>:<video-id>` alone, the form NFX-01 §2 gives a manifest's `d`, would let two
  creators' videos with the same id overwrite each other in one seeder's record.
- **`a` stays**, so one filter on `#n` and `#a` covers both kinds and NFX-03's checks apply
  unchanged. The `d` tag adds about 110 bytes: the 1,472-byte vector beacon (`beacon.json`)
  becomes 1,581.
- Each tag appears exactly once. `["t", "nfx"]` stays optional, and readers ignore tags they do
  not know (NFX-01 §4).
- **The content is a beacon's**, byte for byte the same rules: endpoints, renditions, `chunks`,
  `stun`, prices and mints. Nothing else in NFX changes meaning.

### 3. Lifetime and cadence

Proposed: **L = 600 s, republished every 300 s**, and at once when the content changes
(an endpoint, an address or ticket, `chunks`, a price or a mint), within NFX-04 §2's floor of one
per 20 s per (key, video).

How the numbers follow:

- **At most 900 s.** A reader keeps NFX-03 §1's rule that `created_at` is within 15 minutes of
  now. Any record with L ≤ 900 then passes it for its whole life, with no new freshness rule.
  L = 600 leaves 300 s for a reader whose clock is ahead.
- **At least about 400 s.** Decision record 0111 gives a seeder 20 beacons a minute on each
  general relay, and a desktop seeder announcing what its user keeps (NFX-18) sends up to 64
  videos a round. 64 × 60 / R ≤ 20 gives R ≥ 192 s, so L ≥ 384 s. At L = 600 a seeder with 64
  videos uses 12.8 of the 20, and one with 100 uses all of it.
- **Half life.** Republishing at L/2 keeps a record live through one lost write, as NFX-03 §3
  does for kind 20464.
- **Staleness.** After a crash a record outlives its seeder by up to L, 450 s on average (the
  last write was 0-300 s before). After a clean stop, by up to 60 s (§4).

Writes a minute, per seeder, on each relay:

| Videos | 20464 every 30 s, scoped relay | 20464 on a general relay, 0111's share | 30464 every 300 s |
|---|---|---|---|
| 1 | 2 | 2 | 0.2 |
| 10 | 20 | 20 | 2 |
| 64 | 128 | 20; each video is announced every 192 s and live 60 s of it (31 %) | 12.8 |
| 100 | 200 | 20; live 20 % of the time | 20 |

At about 2 KB an event, a seeder with 64 videos writes about 26 KB a minute to a relay as stored
beacons, and about 250 KB as ephemeral beacons on a scoped relay.

**Storage.** One record per (seeder, video) for at most 600 s: about 130 KB per seeder with 64
videos. Each republish replaces one event; strfry inserts the new one and deletes the old one in
the same write. A relay that keeps ephemeral events for 300 s, as strfry does by default, holds
10 copies of each kind-20464 beacon sent every 30 s, so on such a relay a stored beacon costs
about a tenth of the space and a tenth of the writes.

Other values considered:

- **L = 300 s:** 25.6 writes a minute for 64 videos, over 0111's beacon share.
- **L = 900 s:** 8.5 writes a minute and up to 15 minutes of staleness. It leaves no margin for
  clock error under the 15-minute rule.

### 4. Stopping

- On a clean stop a seeder replaces each record with one whose L is 60 s, with the same content.
  Readers, and relays that implement NIP-40, drop it within 60 s, as today. A relay without
  NIP-40 keeps returning the expired record, and readers drop it.
- **This is best effort.** On a general relay the replacements come out of the 20-a-minute
  share, so a desktop app that quits with 64 videos replaces at most as many as the rest of its
  share allows, 20 at the very most. The others lapse within 600 s, as all of them do after a
  crash.
- **No NIP-09 deletion.** A kind-5 request is a regular event, and NIP-09 asks relays to keep it,
  so every stop would leave a permanent public record that a key seeded a video until a given
  time. A scoped relay admits only NFX-02 §6 deletions today. NFX-03 §2's reasoning still holds:
  a short lapse is cheaper than a tombstone.

### 5. Readers

1. When the video's page opens, without publishing anything, a reader subscribes on every relay
   it reads beacons from, scoped and general (0111), with:
   - `{"kinds":[30464,20464],"#n":[ns],"#a":[a],"since":<now − 900>}`
   - `{"kinds":[30464,20464],"#n":[ns],"#a":[a],"authors":[<creator>, <keys with a positive
     NFX-16 score, up to 15>]}`

   It keeps both open after end of stored events: a relay forwards new stored events to live
   subscribers, as it does ephemeral ones.
   - `since` stops a relay that never purges from returning old records ahead of live ones,
     since a live record always has `created_at` after now − 900.
   - The `authors` filter stops fresh keys from pushing the creator's record past a relay's
     result limit. Relays return the newest first, 500 at most on strfry and 100 on some others.
2. It checks a kind-30464 event as NFX-03 §5 step 2 checks a beacon, and also requires exactly
   one `d`, equal to `a`, and L in [60, 900].
3. **It checks `now < expiration` itself.** A relay may not purge: strfry deletes expired events
   only every 9 s and does not filter them on read, and a relay without NIP-40 returns them
   indefinitely.
4. It considers each seeder's newest live beacon of either kind (NFX-03 §2). When a seeder's
   newest 20464 expires, its live 30464 still counts.
5. Its table and source order stay as they are: 64 keys per video and 16 first heard per relay
   (NFX-03 §5 step 4, NFX-17 §4.2), and the tiers and fetching rules of NFX-17 §§4.2-4.3, which
   apply to every viewer whether it asks or not.

### 6. Address classes (decision record 0114)

The rule applies per relay, unchanged. A relay reached at a public address gets the public
record. A relay on the seeder's own networks gets the full record, dated a second later. Both
have the same `d`, so each relay holds one record per (seeder, video), of its own class, and a
reader of both kinds of relay keeps the full one, which is newer. One thing grows with the
lifetime: a full record that someone copies from a private relay to a public one stays there for
up to 600 s, where a beacon stays 60 s. That copy was possible before; it now lasts ten times
longer.

### 7. Scoped relays

NFX-04 would let a scoped relay carry kind 30464, as it lets one carry kind 33478 since its
2026-11-19 amendment. One that does:

- admits a record only if it passes a reader's checks when it arrives, names a network the relay
  serves, and is for a video its creator allow-list admits (NFX-04 §8);
- keeps the newest per (`pubkey`, `d`) until its `expiration`, never returns it after (NIP-40),
  and drops it from its store;
- applies these limits:
  - the beacon floor, one per 20 s per (`pubkey`, `a`), counted per kind;
  - 16 KiB;
  - **at most 64 held per `a`.** Past that, a new key replaces a random held record not signed
    by the video's creator, and the creator's own is always admitted;
  - a cap on held records overall, separate from manifests, so that records never crowd
    manifests out of the store;
- lists 30464 in its NIP-11 `nfx.kinds`. The role `availability` already covers it.
- **keeps records in memory only.** NFX-04 §7's "only kind 38504 is ever persisted" stays, and
  decision record 0106 does not extend to them. After a relay restart, a seeder republishes every
  record when it reconnects, which on a scoped relay only the floor limits.

Why replace rather than refuse when full, as kind 33478 does: refusing would let 64 fresh keys
hold every slot for a video for 10 minutes at 6.4 writes a minute, and lock out every honest
seeder that comes later.

## Comparison with ephemeral beacons and NFX-17

| | Ephemeral beacons + NFX-17 ask/tell | Stored beacons (30464) |
|---|---|---|
| A newcomer's wait | an ask and a tell after Play, settled within 2.5 s, from seeders that answer; 0-30 s for the rest | one `REQ` round trip; can be made at page open |
| Writes per seeder per relay, 64 videos | 128 a minute scoped; 20 a minute general, plus tells up to 15 | 12.8 a minute |
| Standing subscriptions | every seeder: asks, on each relay it announces on; every viewer: beacons and tells | every viewer: beacons |
| Storage on a relay | none by NIP-01; strfry keeps each ephemeral event 300 s | one record per (seeder, video), up to 600 s; longer on a relay without NIP-40 |
| What a viewer reveals | a signed public ask on up to 3 relays, readable by anyone subscribed | a `REQ`, seen by the relay only, as today's beacon `REQ` |
| What a seeder reveals | its beacons, live; tells on demand | its records, to anyone, at any time |
| Fresh-key floods | answers to an ask, timed by the ask | standing records, any time, 6.4 writes a minute per video per relay |
| A dead seeder listed for | up to 60 s | up to 600 s; 60 s after a clean stop |
| Relays that help | any that forwards ephemeral events, where seeders listen; scoped ones that list 20465 | any that stores addressable events; scoped ones that list 30464 |
| Old seeders | not helped | not helped |

**Latency.** Neither path has been measured end to end. A stored record should give about the
3.4-5.1 s measured with a beacon already heard, plus one round trip if the query is made at Play,
and nothing extra if it is made at page open. Ask/tell adds the ask and the tell, which NFX-17
§4.1 aims to settle within 2.5 s (a SHOULD), and it can start only at Play, since an ask is
public. It helps only with seeders that answer: an old seeder, or one out of budget, is found at
its next beacon, 0-30 s later.

**Relay load.** Stored beacons cut the write rate on every relay by a factor of 10 at the
proposed cadence, and they make NFX-17's asks, tells, the seeders' standing ask subscriptions and
the tells' share of each general relay unnecessary. What they add is storage that turns over: one
small record per (seeder, video), replaced every 5 minutes. A relay that stores ephemeral events
for 300 s holds ten times more for the same seeders' kind-20464 beacons.

**Privacy.**

- *Viewers.* An ask is a signed public event on up to 3 relays. Anyone subscribed reads which
  video is starting and when, live. On relays that keep ephemeral events, as two did above, an
  ask can also be fetched for about 5 minutes afterwards. A `REQ` for stored beacons is the query
  a viewer already sends for kind 20464 (NFX-04 §5, "Live availability"). Only the relay sees it,
  with the viewer's IP address, as today, and it signs nothing.
- *Seeders.* A record can be read at any time, for example with `authors` set to a seeder's key.
  Today anyone subscribed learns the same within 30 s, so the change is mostly that it no longer
  needs a standing listener. It matters more where records outlive their expiry. A relay that
  ignores NIP-40 can keep the last record of each (seeder, video) indefinitely: a list of what
  one key seeded, with its public addresses and when. For a client that keeps and seeds what its
  user watched (NFX-18 §7), that list is part of a watch history. Indexers that copy stored events
  into their own archives may do the same, and are less likely to copy ephemeral ones. This is
  not verified for any particular indexer.

**Abuse.**

- *Fresh-key floods.* Keys are free in both designs.
  - With stored beacons, holding 64 slots for one video on one relay costs 64 records per 600 s,
    6.4 writes a minute, at any time.
  - With ephemeral beacons it costs about 64 a minute to stay in a listening viewer's table. But
    each ask tells the attacker exactly when to spend them, and a tell flood needs only 64 events
    per ask per relay (NFX-17 §4.1). Review N1 of 0105 is this case.
  - The reader's bounds are the same in both: 64 keys per video, 16 first heard per relay, the
    creator's beacon never displaced, and sources tried by tier, never by count or arrival
    (NFX-17 §4.2). Ask/tell adds a pool of 16 for keys heard only through tells, which may name
    only `https` origins (NFX-17 §4.1). Stored records need no pool: no record is aimed at a
    viewer who has just said what it is starting.
  - The `authors` filter means a flood cannot hide the creator's or a rated key's record. As
    today, nothing tells an honest open seeder from a dishonest one (NFX-17 §6).
- *Storage spam.* On a general relay anyone can store records for any video, and only the
  relay's own limits bound them. Each lives at most 900 s, unless the relay ignores NIP-40. On a
  scoped relay the per-video cap and the overall cap bound them, and an allow-list confines them
  to admitted creators' videos.

**Stale seeders and failover.** A dead seeder stays listed up to 600 s after a crash. Every
viewer already fetches with failover (NFX-17 §4.3): a source that sends nothing is given up
after 4 s, another source is asked after 2 s, and an open source that gave up moves behind the
configured last resort. So a stale record costs a viewer at most about 4 s, once per dead source
it reaches, and an upgraded seeder that restarts replaces its own stale record at once.

**Which relays help.** Every general relay that follows NIP-01 stores addressable events, so
stored beacons work there with no change to the relay, provided it accepts the size and rate
(see "What relays do that this cannot assume"). Ask/tell also works on general relays, but only
where seeders keep an ask subscription open. A scoped relay helps with either design only after
NFX-04 lists the kind; until then it refuses kind 30464 (`blocked: out of scope`), and viewers
there see kind 20464 as today.

## What relays do that this cannot assume

Known from reading only: strfry's handling of ephemeral events, expiry and replacement (above);
which relays list NIP-40. Not known:

1. whether general relays accept kind 30464 at 1.6-16 KiB, with a 100-byte `d` full of colons;
2. whether they replace it (newest per `pubkey` and `d`), or keep every version;
3. how long they return an expired record, and whether ones that list NIP-40 purge at all;
4. whether they rate-limit replaceable writes, at what rate, and with which `OK` prefix;
5. whether the relays with no NIP-40 (memlay, NFDB) evict, and when;
6. whether indexers archive stored events regardless of `expiration`.

**Measurement plan.** Nothing below publishes to a public relay without the maintainer's go
for M3.

- **M1, lab, in a VM, no public relay.** Run strfry at its default configuration (release 1.1.3
  and master 4cd3cf6), nfx-node's relay with a prototype admission, and one other implementation
  (nostr-rs-relay or a khatru-based relay). For each, check:
  - a 30464 record with `d` = `a` is stored, a newer one replaces it, and an older one is
    refused;
  - an expired record is refused on write; measure how long one is returned after it expires,
    and when it is purged;
  - with 10,000 records for one `a` from fresh keys, the `authors` filter still returns the
    creator's record; time to end of stored events;
  - a 16 KiB record is accepted;
  - a kind-20464 beacon: whether a later `REQ` returns it, and up to what age.
- **M2, public relays, read only.** The NIP-11 survey and the one-shot `REQ`s above, done
  2026-11-27. Repeat them for the default relay lists of every reference client before deciding.
- **M3, public relays, writes; needs the maintainer's go.** Use a throwaway key and a namespace no
  client reads (`nfx:lab-stored-beacons:1`, NFX-01 §2's custom form). Run it on the two
  general relays the Nutflix apps read by default (`relay.primal.net`, `relay.ditto.pub`) and on
  `relay.damus.io`, `nos.lol`, `nostr.mom`, `offchain.pub`, `relay.nostr.net` and
  `relay.snort.social`. Two of these have refused or rate-limited the project's own address
  before (decision record 0111), so their results say little about other users:
  - one record with L = 120 s, republished once: accepted? returned? replaced? Then a `REQ`
    every 5 s from 100 s to 240 s, to see how long it is returned after expiry;
  - the rate of a seeder with 64 videos, 12.8 writes a minute for 30 minutes, then 20 a minute
    for 10 minutes: every refusal and its prefix;
  - one 16 KiB record.

  Stop on a relay at its first `blocked:` or `rate-limited:`. That is at most about 600 events per
  relay. Delete nothing: the records lapse.
- **M4, browsers, in a VM, the 2026-11-22 setup, 21 runs.** A seeder that publishes both kinds to
  a lab strfry and to the scoped relay. Measure Play pressed at once, with the query made at Play
  and with it made at page open. Target: the 3.4-5.1 s of "a beacon already heard", plus at most
  1 s.
- **M5, stale.** Kill a seeder without a stop, leave its record, and keep a second seeder live.
  Measure the time to the first frame for a viewer that meets the dead record first. Target: at
  most 4 s more than M4.

**Adoption criteria.**

- The two default general relays accept and replace kind 30464 at M3's rates with no refusal.
- Each returns an expired record for no more than 60 s; readers drop it either way.
- M4 and M5 meet their targets in 21 of 21 runs.

If M3 fails on the default relays, stored beacons still help on scoped relays, and option B or C
(below) comes back.

## Spec consequences

Listed, not edited:

- **NFX-01 §2.** Item 2 gives addressable NFX events the `d` form `<namespace>:<video-id>`. It
  must say that this is the manifest's form, and that a stored beacon's `d` is the `a` value. The
  namespace still agrees; kind 33478 is already outside the item.
- **NFX-03.**
  - A new section defines kind 30464: its shape, `d` = `a`, L in [60, 900], 600 recommended,
    republished at L/2 and on a change of content, the stop by an L = 60 replacement, and the
    reader's rules of §5 of this record.
  - §2 "ephemerality is the retention policy" becomes per kind.
  - §5 step 1 queries both kinds, with `since` and the creator's `authors` filter, and step 2 adds
    the expiry check the reader makes itself.
  - §7's share counts stored beacons as beacons.
  - Kind 20464 stays: readers keep reading it, and seeders keep sending it on scoped relays until
    the migration below ends.
- **NFX-04.**
  - §1: a MAY for kind 30464 as §7 of this record describes, with the creator allow-list applied.
  - §2: rows for it: the floor counted per kind, 16 KiB, 64 per `a` with random replacement of
    keys other than the creator's, and an overall cap.
  - §3: `nfx.kinds` lists 30464.
  - §5: the "Live availability" query.
  - §7: an embedded relay keeps records in memory only; only kind 38504 is persisted, as 0106
    has it.
  - §8: persistence of stored beacons is not guaranteed.
- **NFX-11 §1.** A row for 30464 (addressable, NFX-03, stored beacon), submitted to
  `registry-of-kinds` with 38504 and 20464. 20465 is not submitted while NFX-17 is parked.
- **NFX-10 §1.** "A live, verified beacon … signed by its creator" includes a kind-30464 record,
  for the creator's STUN servers and for the fallback. A creator republishes on a change of
  content, so a changed STUN server is not held for 10 minutes.
- **NFX-17.**
  - *Recommended: park it now, and withdraw ask and tell once M1-M5 pass.* Parking means its
    status says it is held pending this record, and nothing new implements §§1-3, 4.1 or 5.
  - §§4.2-4.3 (choosing sources, fetching from several) apply to every viewer and are the
    failover rules. They move to NFX-03 §5, or a document of their own, before the rest is
    withdrawn.
  - Keeping ask/tell as an optional fallback (option B) would leave the public signal, the seeder
    subscriptions and review N1's attack surface in place for a path that fires only when no
    relay holds a record.
- **NFX-18.**
  - §4: at L = 600 a seeder announces up to 100 videos within one general relay's beacon share,
    so 64 a round fit, and §9's "kept videos beyond the beacon bound" mostly goes away.
  - §7: records can be read at any time and may outlive their expiry on relays without NIP-40.
    A keeping client SHOULD send the records of videos kept as `watched` only to scoped relays,
    and to general relays whose NIP-11 lists NIP-40.
- **Decision record 0111's share.** Stored beacons count as beacons, 20 a minute. On general
  relays they replace kind 20464 rather than adding to it. If ask/tell is withdrawn, the tells'
  10-15 a minute is freed. The total stays at 30 a minute, as headroom.

## Code consequences

A sketch only.

- **nfx-proto.**
  - `KIND_STORED_BEACON` = 30464.
  - `Beacon::from_event` accepts either kind, with the lifetime range of each ([60, 120] and
    [60, 900]) and, for 30464, `d` = `a`.
  - `beacon::tags` gains the `d` tag.
  - New vectors `beacon-stored.json` and `beacon-stored-invalid.json`. The content schema is
    unchanged.
  - `lookup.rs` stays until NFX-17 is withdrawn, then goes.
- **nfx-node, relay.**
  - `MayAdmit.stored_beacons`, with admission modelled on kind 33478's (`admit_stun`): the
    newest-per-key table, the 64-per-`a` cap with random replacement, purge on admission and a
    sweep, nothing expired returned.
  - Its own cap, so that `MAX_STORED_EVENTS` stays the manifests'.
  - The NIP-11 kinds.
  - No `relay_store` change.
- **nfx-node, seeder.**
  - `Relays::announce` signs and sends a 30464 record every 300 s and on a change of content,
    beside the 20464 beacon on scoped relays and instead of it on general ones.
  - `RelayShare` counts records as beacons.
  - A relay that reconnects gets every record again.
  - A stop sends the L = 60 replacements the share allows.
  - 0114's two classes reuse the existing per-class signing.
  - `BeaconWatch` and `SwarmPull` read both kinds.
  - `lookup.rs` (`Answerer`) and the relay's `seeder_lookup` are left as they are while parked.
- **nfxd.**
  - `--embed-relay-stored-beacons` for the embedded relay, off by default like the other MAYs.
  - **The lookup answerer stays on by default** (the maintainer, 2026-11-27): a node with a key
    answers asks unless `--no-lookup` is given (`crates/nfxd/src/main.rs`), and the re-cut
    0.1.4 ships it. The withdrawal turns it off in a later release ("Decisions", item 2).
- **Web player.**
  - `watchEndpoints` (`web/player/src/resolve.ts`) subscribes to both kinds, with `since` and the
    creator's `authors` filter, from page open.
  - The WASM `verifyBeacon` accepts 30464.
  - The book is unchanged.
  - The `ask` option, off by default, and the demo page's `?ask=1` are deprecated, then removed.
- **nutflix-pear.**
  - *Core:* the beacon parser accepts 30464, and the vendored vectors are updated.
  - *Web:* follows the player through its `nfx-web.lock` pin.
  - *Desktop:* `beacons.ts` publishes 30464 every 300 s and on a change, through the round and
    content seams of nutflix-pear #168, up to 64 videos a round.

## Migration and interop

1. **Now.** Decide. Park NFX-17's remaining implementation work. Run M1 and M2.
2. **First release with stored beacons** (nfx 0.1.5 or 0.1.6, with the matching Nutflix apps):
   - Readers read both kinds.
   - Seeders send both kinds on scoped relays: 20464 every 30 s for old readers, 30464 every
     300 s.
   - On general relays, the re-cut 0.1.4 can already send 20464 under 0111's share, so its
     readers may depend on it there. **Open, for the stored-beacon text:** keep 20464 there
     too, with both kinds inside the share's 20 beacons a minute, or send only 30464 and let
     0.1.4 readers fall back to scoped relays' beacons. Either way a live subscriber gets each
     new record as it is sent.
3. **Old readers** (nfx before this change, nutflix-pear desktop 0.1.4 and earlier, pinned web
   builds and nsites) keep reading kind 20464 on scoped relays and see no difference.
4. **Old seeders** send only 20464 on scoped relays. New readers read it, and wait for it, as
   today.
5. **What new readers query:** one filter for both kinds, plus the creator's `authors` filter
   (§5).
6. **When 20464 can be dropped.**
   - Sending it becomes a MAY one release after every reference reader reads 30464, and pinned
     web builds and nsites have been re-pinned.
   - Readers keep reading it, which costs nothing, until nfx 0.10.0. The documents are refrozen
     there, and that is when to decide whether 20464 stays as a deprecated kind or goes.
   - The gossip envelope of NFX-06 §4 carries beacon content, not a kind-20464 event, so it is
     not affected.

## Options

- **A. Stored beacons, and withdraw ask/tell.** One discovery path, no public log of starts, a
  tenth of the writes, works on stock relays.
  - Costs: storage that turns over on relays; a dead seeder listed up to 10 minutes after a
    crash; seeders' records readable at any time, and durable on relays without NIP-40.
  - It depends on M3. The NFX-17 code already on nfx main (wire format, seeder answerer, relay
    admission, player `ask`) is removed.
- **B. Stored beacons, with ask/tell kept as an optional fallback.**
  - It covers a relay that refuses kind 30464 but forwards kind 20465, which is unlikely, and
    kept videos beyond a seeder's bound, which at 100 a general relay is rare.
  - It keeps the public signal for whoever asks, the seeders' standing ask subscriptions on every
    relay they read, review N1's attack surface, the relay limits of NFX-17 §5, and two paths to
    test. If chosen, a viewer should ask only when no relay returned a live record within a
    second or so, which reverses NFX-17's "asking on by default".
- **C. Keep today's design** (0105): ephemeral beacons every 30 s, and ask/tell.
  - Already written, and merged on nfx main.
  - Costs: the public log of starts; a fast start only from seeders that answer; seeders hold
    ask subscriptions everywhere; on general relays, seeders with more than 10 videos announce
    each only part of the time (31 % at 64).

## Recommendation

**A, gated on the measurements.**

- Park NFX-17 now. Turn nfxd's answerer off by default before 0.1.5, and hold the unreleased
  pear lookup work. (The maintainer chose to leave the answerer on: "Decisions", item 2.)
- Write the stored-beacon text as Draft, with its vectors.
- Run M1 and M4 in the lab, repeat M2 (read only), and run M3 on the maintainer's go.
- Withdraw ask/tell when the adoption criteria are met. Move NFX-17 §§4.2-4.3 to NFX-03 §5
  first.

Why A:

- A stored record gives every reader every live seeder at once, from page open, with nothing
  published. That is the property ask/tell was built to approximate.
- It costs less on every relay.
- It works on stock relays that already store addressable events.
- It needs no new trust: the content is the beacon's, checked the same way.

Its real costs are seeder-side: records readable at any time, durable on relays without NIP-40.
They are bounded by L, by sending NFX-18 `watched` records only to relays that list NIP-40, and
by NFX-18 §9's open choice of one seeder key per video.

If M3 shows that the default general relays refuse or throttle kind 30464, the choice is between
B and C again, with stored beacons kept on scoped relays either way.

## The pending nutflix-pear pull requests

While this record is pending:

- **#166 (interop CI on nfx 0.1.4): merge.** It changes only which nfx commit the interop
  workflows test against, and nothing about lookup.
- **#167 (core: the NFX-17 wire format, ask and tell, with the shared vectors): do not merge
  yet.** It is about 630 lines of code, 550 of tests and 2,100 of vendored vectors. Nothing in the
  app uses it until a viewer asks, and under A it is dead code that would then be removed. Under
  B it merges later unchanged. Holding it costs a later merge of main, nothing else.
- **#168 (desktop: answers asks; beacons every 30 s; seams for keep-and-seed): do not merge as it
  is. Split it.**
  - *The answering half:* `lookup-answers.ts` (about 690 lines), its tests, and the
    `nfxLookupAnswers` adapter option, on by default. Merged, it ships in the next desktop
    release as a public answering surface: every installed app would hold an ask subscription on
    its user's read relays and answer, until each user updates after a withdrawal. It also
    depends on #167.
  - *The beacon half is wanted either way:*
    - the 60 s lifetime re-sent every 30 s (the desktop sends 120 s every 60 s today) halves
      the worst wait for every reader of its kind-20464 beacons, and stays during the migration;
    - the round and content seams (`roundVideos`, `beaconContent`, `signBeaconEvent`,
      `onBeacon`, `relayPaused`) are what a stored-beacon publisher and NFX-18 build on;
    - `address-class.ts` can check, before anything goes to a public relay, that it names no
      private address (decision record 0114, NFX-18 §4).
  - Put the beacon half in its own pull request against main and merge that.

## Consequences if accepted

- A newcomer's wait for a seeder no longer depends on any seeder's cadence, for seeders that send
  stored beacons and relays that store them. Old seeders still make viewers wait for their next
  beacon.
- Viewers publish nothing to find seeders, so NFX-17 §6's live log of starts is not created.
- Seeders write about a tenth as often, and relays store one small record per (seeder, video)
  that turns over every 5 minutes.
- A seeder's records can be read at any time and can outlive their expiry on relays that ignore
  NIP-40. Keeping clients limit where they send them.
- A dead seeder stays listed for up to 10 minutes after a crash; failover bounds the cost to a
  viewer at about 4 s per dead source.
- NFX-01, -03, -04, -10, -11, -17 and -18 change as listed, nfx-node's relay gains a MAY of its
  own (`MayAdmit.stored_beacons`), and ask/tell code written for 0.1.5 is retired before it
  ships.
