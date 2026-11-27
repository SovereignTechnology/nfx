# 105. Seeder lookup: viewers ask, seeders answer at once

Date: 2026-11-22

Reopened by decision record 0115 (proposed, 2026-11-27).

## Status

Accepted 2026-11-22 by the maintainer (sovtech). Issue #113. The wire format is draft NFX-17.

This change touches no frozen document. NFX-03 stays as it is. For a scoped relay to carry the kind,
NFX-04 needs a third in-place MAY, recorded in its own issue as an exception like #96 and #104, after
#107 lands. The money lock is not involved.

## Context

A viewer cannot start until it hears a seeder's beacon (kind 20464). Beacons are ephemeral, so
relays keep none for a newcomer, and a seeder sends one every 60 s. The wait is whatever is left of
the seeder's cycle when the viewer presses Play.

Measured 2026-11-22 in headless Chromium, 21 runs against three page hosts, from the click to the
first frame:

| Case | Click to first frame |
|---|---|
| Play pressed at once | 45-55 s, of which 42-52 s is waiting for a beacon |
| A beacon already heard | 3.4-5.1 s |
| The same with WebRTC blocked | 3.7-5.1 s (one 14.7 s outlier) |

The runs followed each other and fell into step with the beacon, which is why the wait clusters near
45 s. In use it is anywhere from 0 to 60 s. WebRTC is not the delay: the first frame arrives over
HTTPS with at most 2 KB received over WebRTC, and the mesh joins afterwards.

Requirements:

- no start from a fixed server, and anyone able to run the seeder and the relay;
- ordinary Nostr relays must be enough: an ephemeral kind, standard tags, no relay plugin;
- old seeders and old viewers keep working.

## Decision

1. **A viewer asks, and each seeder answers it directly.** One new ephemeral kind, 20465, with two
   types (`ask`, `tell`). A tell's content is the seeder's complete signed beacon, so the viewer
   runs its existing NFX-03 check and trusts nothing new.
2. **Periodic beacons stay**, with a lifetime of 60 s, re-sent every 30 s. NFX-03 already allows it
   (`TTL ∈ [60,120]`, republish at TTL/2).
3. **Asking is on by default, with an off switch.** An ask is signed by a throwaway key, one per
   video per session.
4. **No encryption on this path.** A tell carries a beacon of the kind the seeder broadcasts, and a
   relay must be able to read it to check it. NIP-17 would also ask relays to store what must not persist.

## Alternatives

| Design | Result | Why not |
|---|---|---|
| A shorter lifetime alone | wait 0-30 s | not instant |
| Answer by re-publishing the beacon | most answers refused; waits up to 20 s | NFX-04 §2's floor of one beacon per 20 s per (seeder, video), measured at arrival |
| Stored (addressable) beacons | instant | breaks "never persist" (NFX-03 §2, NFX-04 §7) |
| The relay replays live beacons to a new `REQ` | instant on our relay only | stock relays gain nothing; NFX-04 says forward only |
| Mesh presence, which already answers newcomers | finds mesh seeders only | rooms need the hash list, which a viewer gets from a source it has already found |
| Start from a built-in origin | instant | a fixed server in the path |

## Review

An adversarial review of the first draft (2026-11-22) found no forgery, and that the binding of a tell
to its beacon holds. It did find that one public ask let an attacker answer from 64 fresh keys, fill the
viewer's first-come seeder table and the relay's per-viewer limit, take the top origin ranks and defeat
the beacon fallback. The design changed because of it (NFX-17 §§2-6):

- Seeders heard only through tells go in a **separate pool of 16**. They cannot displace a seeder heard
  by broadcast, add weight to rankings, or name a STUN server.
- Sources are tried in the order: the manifest creator's own beacon, broadcast seeders, then the pool.
- A relay charges identity-keyed limits **only after full verification**, and the limit per viewer and
  video is gone, because fresh keys could fill it.
- A beacon may not be dated after its tell, and an embedded beacon has one exact spelling.
- A seeder bounds its verification work, and answers per relay so that one relay cannot swallow it.

A second pass found what is still open. NFX-17 §8 lists two requirements that **must be specified before
any viewer implements this**: bounding fresh keys that publish ordinary beacons, and leaving a source that
verifies and then stops delivering. NFX-17 §6 states the rest: before any creator-signed or broadcast source
is known, a viewer may contact an attacker's origin, which learns its address and the video.

## Consequences

- Cold start drops to about the time measured with a beacon already in hand, for videos whose
  seeders answer.
- **An ask is a new public signal:** anyone can read a live, network-wide log of which videos are being
  started and when, with no identity attached (NFX-17 §6). Viewers can turn it off.
- A scoped relay must opt in (a third recorded exception to the NFX-04 freeze). Until then asks
  through it are refused, and viewers wait for the periodic beacon as today.
- A 60 s lifetime halves clock tolerance and doubles periodic beacon traffic, so the scoped relay's
  per-connection event budget rises with it.
- Seeders hold a new standing subscription and spend a bounded number of signatures on tells.
- Old seeders never answer, so a viewer's full beacon wait cannot shrink until they are gone.
