# 110. No single relay or host is required

Date: 2026-11-26

## Status

Accepted 2026-11-26. Decided by the maintainer (sovtech). It amends NFX-03 §5 and §7 and
NFX-04 §4 and §7, which are frozen, in place as exceptions to the freeze rule (see their
changelogs): the maintainer's decision of 2026-11-26 is that the spec is not locked yet.

## Context

- On 2026-11-26, from 07:08 to 07:52 UTC, one host was unreachable from a home network. It
  runs the testnet's only scoped relay, its only HTTPS origin for browsers, its only STUN
  server for browsers, and the only seeder a browser could connect to. The host itself stayed
  up; the path to it did not.
- During those 45 minutes a browser that loaded the web client from elsewhere (an nsite on
  public Blossom servers) listed no video and found no seeder:
  - NFX-04 §4 said beacons go NEVER to public relays, and NFX-03 §7 said beacon volume must
    not be bridged onto them. So seeders announced only on the scoped relay, and clients
    read beacons only there.
  - Manifests were published to the scoped relay and to one general relay that refused
    them. The general relays the web client reads held one stale manifest from 11-07.
  - A relay that is unreachable answers nothing, so the page read it as an empty network.
- Seeding and signaling did not need the host: the other seeder was up, and kind-25050
  signaling already ran over general relays (NFX-10 §6).
- The concern behind the old rule stands: a busy network at TTL 60 sends O(swarm) beacons a
  minute, and a public relay rate-limits or bans a key or address that floods it. It is a
  reason to bound each seeder's share of each relay, not to keep beacons off general relays.

## Decision

1. **Seeders announce on general relays too, within a bound** (NFX-03 §7). On each general
   relay, per seeder key: at most 30 events a minute, beacons at most 20 (10 videos at full
   cadence, rotated above that), NFX-17 tells 10 reserved and up to 15. Beacons and tells
   cannot push each other out. A `rate-limited:` or `blocked:` answer stops sends to that
   relay, backing off from 1 minute up to 30.
2. **Clients read scoped and general relays together and merge** (NFX-03 §5, NFX-04 §4), for
   the catalog and for beacons, and say "no relay answered" rather than "no videos".
3. **Manifests go to the relays clients read by default**, not only to the scoped relay.
4. **A seeder whose scoped relays are all one operator's, or on one host, also speaks on
   general relays** (NFX-04 §7).
5. **Each further single point is removed in its own change.**
   - STUN: a list of servers (the seeders', public ones, the operator's), not one.
   - The HTTPS origin: start-up files move onto WebRTC peers, so a browser needs no origin.
   - Relay connections that drop are reopened, in the clients and the player library.
   - One test plays a video with the operator's host unreachable from the start.

## Consequences

- A network keeps its catalog and its availability while any one relay or host is down.
- General relays see more NFX traffic: today about 4 beacons a minute per relay from each
  seeder of 2 videos, and at most 30 events a minute per seeder whatever its catalog.
- Beacons on general relays are unfiltered: anyone can publish one for any video. They were
  never trusted (NFX-03 §5, NFX-05 verifies every byte); a client bounds how many keys it
  keeps per video.
- No artifact, schema or test vector changes. A seeder or client that keeps to scoped relays
  behaves as before and stays conformant; it just inherits their availability.

## Alternatives considered

- **More scoped relays, run by more operators.** Still right (NFX-04 §6 and §8), and it
  removes the single host. It is slow to arrive, and it leaves a network with one operator,
  the usual case at the start, exactly as fragile.
- **Stored (addressable) beacons, or answers only on request (NFX-17 tells).** Tells already
  go to general relays from nfx 0.1.5. Without periodic beacons there, an ask flood or a
  client that never asks finds nothing, so the periodic beacon stays and the tells share its
  bound.
- **A `specver` bump.** It would have re-derived every room key and republished every
  manifest. No reader of NFX-02, -03 or -05 changes behaviour, so it buys nothing.
