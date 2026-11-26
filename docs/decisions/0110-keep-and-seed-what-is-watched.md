# 110. Keep and seed what is watched

Date: 2026-11-26

## Status

Decided by the maintainer (sovtech), 2026-11-26. It adds NFX-18 (Draft, optional), amends
NFX-12 §2 (Draft) in place with an optional `renditions` on the `hyperdht` endpoint, and amends
the L4 decision of the 2026-09-24 audit (`docs/nfx/status.md`, "seeding is opt-in"). No frozen
document changes. The number is taken by whichever of this record and a parallel one merges
first; the other renumbers.

## Context

- A video reaches its viewers through its creator's seeders and a few operators' `nfxd`. Its
  audience fetches it and serves none of it afterwards: the desktop viewer leaves a watched
  video's files in a cache it never serves again, and seeds one only while it runs if its user
  turned on "Share videos I watch"; the Pear app spools a play to a temp folder and deletes it;
  and a browser holds it in memory until the tab closes.
- The 2026-09-24 independent audit's L4 (desktop privacy) chose **seeding is opt-in**: a viewer
  that seeds announces its address and what it watched, so it should do so only when asked.
  Its protections were that a viewer announces nothing by default, and that a viewer that shares
  nothing needs no port, so the portmapper is off.
- NFX-03 §4 already lets a seeder hold some renditions of a video and announce exactly those, with
  a `chunks` count. Every transport can say which renditions an endpoint serves except HyperDHT:
  NFX-12 §2 has no field for it, and its §10 leaves partial seeders open.
- The maintainer's rule for every Nutflix app, 2026-11-26: what is in a user's watched or
  downloaded history is kept and seeded to viewers, **on by default**, with a notice saying what
  others can see and an off switch; a Download button; a free video watched for about a minute is
  finished in the background; a paid one is kept only as far as it was watched; browsers too.

## Decision

1. **NFX-18 states the rule as protocol, optional.** A keeping client keeps a video after a minimum
   play (60 s by default), or when its user downloads it; it finishes a played rendition only over
   free peers, never over HTTPS in the background (decision record 0109) and never by paying; it
   bounds keeping by a fetch budget and a storage cap and evicts only watched videos; it
   verifies every file before storing it, and on every read where its storage cannot be trusted.
2. **It announces only what it holds,** as NFX-03 §4's seeder of some renditions: tickets, swarms,
   rooms and HyperDHT `renditions` for held renditions only, and a `chunks` count.
3. **L4's protections stay and become rules:** no direct address that is not public in anything
   announced (`nfx-node`'s `NodeConfig::public_addrs_only`), no port mapping because of keeping,
   beacons under a seeder key that is never the user's identity key, and a serving identity that
   is not the fetching one.
4. **L4's default is reversed for apps that claim NFX-18:** a keeping client may keep and seed by
   default, provided it tells its user before it first announces, in words, that its IP address
   and the list of what it seeds are public, and offers one switch that stops all announcing at
   once. The default of each app is the app's own choice; the Nutflix apps turn it on.
5. **NFX-12 §2 gains `renditions`,** with the `https` endpoint's rule (NFX-03 §4): optional,
   absent means every rendition, present a non-empty array of distinct ids, none `meta`; a
   malformed one invalidates the beacon for a reader that implements it. New cases in
   `beacon-hyperdht.json`; the beacon schema checks it as it checks `https`'s.

## Consequences

- A video's reach grows with its audience: every viewer who watched a minute of a free video
  becomes a seeder of the rendition they watched, while their app runs.
- What a viewer keeps becomes public, under its seeder key, with its public IP address. This is
  the cost L4 refused by default and the maintainer now accepts, behind the notice and the switch.
  One key per user links the list together; one per video would hide it at the cost of a beacon
  each, and NFX-18 §9 leaves that open.
- Older readers of NFX-12 that do not know `renditions` read a partial HyperDHT seeder as holding
  every rendition, ask it for a file it lacks, are answered `missing` (NFX-12 §4) and move on.
- The desktop viewer (`crates/desktop`) changes in a later PR: "Share videos I watch" becomes on by
  default with the notice, kept videos seed again after a restart, the cap and eviction above, and
  `public_addrs_only` always. Its portmapper stays off. The Pear app and the browsers follow the
  same rules in their own repositories (nutflix-pear ADR, NFX-10's browser rules).
- `nfxd run` keeps publishing what it has (`public_addrs_only` off): an operator's seeder is not a
  viewer, and `--iroh-external` already narrows what it publishes.
