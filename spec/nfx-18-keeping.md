# NFX-18 — Keeping and seeding what is watched (optional)

**Status: Draft** · 2026-11-26 · depends on NFX-01, NFX-02, NFX-03, NFX-05, NFX-06, NFX-07,
NFX-10, NFX-12 · decision record 0110

A watcher that keeps the files it fetched for a video, and serves them, is one more seeder of that
video. A video's reach then grows with its audience instead of resting on its creator and a few
operators. This document says what such a client keeps and when, what it announces, and what it
owes its user. It adds no event kind and no message: a keeping client is an L3 seeder of the
renditions it holds (NFX-03 §4), over the transports it already speaks. The only wire addition it
relies on is the optional `renditions` of a `hyperdht` endpoint (NFX-12 §2).

No conformance level requires it. A client that implements it claims it beside a level
("L2 + NFX-18", NFX-11 §8).

## 1. Terms

- **Keeping client:** a watcher (L2) that implements this document.
- **Kept video:** a video of which the client holds at least the hash list and the meta files, and
  records why it holds them. A video is kept for one or more **reasons**:
  - `watched`: its user watched it (§2.1);
  - `downloaded`: its user asked to keep it (§2.2);
  - `published`: its user is its creator, or seeds it on purpose as an operator. This document
    changes nothing for it: it is listed so the rules below can rank it.
- **Held rendition:** a rendition of which the client holds and has verified every file that
  NFX-03 §4 names for a seeder of that rendition: the hash list, every playlist (the master's
  too), thumb and subtitle file, and every `init` and `segment` file of the rendition.
- **Filling:** a rendition the client is still fetching for keeping. It holds part of it.

## 2. What is kept

### 2.1 Watched

- A client MUST NOT keep a video for the reason `watched` when its user left it before a minimum
  amount of it was played. The minimum SHOULD be 60 s of media, and MUST NOT be less than 30 s.
  Files fetched for a shorter play are deleted when the play ends, as before, unless another
  reason (`downloaded`, `published`) keeps them.
- Past the minimum, the client keeps the files it fetched for the play and records the reason
  `watched`.
- **Finishing.** A client MAY then fetch the rest of the rendition it played, so that it becomes
  held. It MUST do so only from sources it does not pay (`free: true` beacons, an origin that
  asks no payment) and only from peers: it MUST NOT fetch over HTTPS in the background for
  keeping (decision record 0109), and an origin that is also a peer (an `nfxd` bridge) counts as
  a peer. It MUST NOT pay for finishing: money is spent only on what its user plays or asks to
  download. It fetches nothing for a rendition its user did not play.
- **A video its user paid for** (NFX-07, NFX-08) is kept, past the minimum, as far as it was
  played: the client fetches nothing more for keeping it. A shorter paid play is not kept for
  the reason `watched` either, but what was paid for MAY stay where the client already stores
  paid data instead of being deleted; it is then neither listed as kept nor announced.
- Finishing yields to playback: a client SHOULD run at most a few finishing fetches at once and
  pause them while its user plays something.

### 2.2 Downloaded

- A client MAY offer its user to keep a rendition of a video: it fetches every file of that
  rendition and records the reason `downloaded`. Paying for it, where the video's seeders
  charge, is the user's choice, made when asking.
- A browser keeps a downloaded video in its own storage; it does not save a file. A client says
  which it does.

### 2.3 Licensed videos

A licensed video (NFX-08) is kept as the ciphertext the client fetched, for its own replay. The
client announces it only where NFX-08 lets it seed that video (its escrow mint, NFX-03 §4, or as
the manifest's `free_seeder`, NFX-02). This document changes nothing else for licensed videos.

### 2.4 Bounds

- **A fetch budget.** Keeping turns plays into downloads, so a client MUST bound what it starts
  to keep: a number of new videos and a number of bytes fetched for keeping, per hour. The
  reference values are 20 videos and 16 GiB an hour. A play that would go over the budget is
  kept as far as it was played and not finished.
- **A storage cap.** A client keeps within a cap its user can see and change. At the cap it
  removes kept videos whose only reason is `watched`, least recently played first, never one
  that is playing. It MUST NOT remove a `downloaded` or `published` video on its own: it stops
  keeping new ones and says so.

## 3. Integrity and storage

- Every file is verified as NFX-05 §4 requires (`sha256(bytes) == files[i].sha256`, the hash
  list against the manifest's `root`) before it is stored.
- A client stores kept files by their sha256 under the hash list root they belong to, never by a
  name a peer or a transport chose.
- A client that cannot rely on its storage keeping bytes intact (a browser's storage, which
  other code of the same site can write) MUST verify a file's sha256 again each time it reads
  it from storage, before it serves or plays it. A file that fails is deleted and fetched again
  as any missing file is.
- A held rendition is recorded before it is announced, and a rendition is announced only once it
  is held (§4). A crash while filling leaves a filling rendition, which is resumed or removed,
  never announced.

## 4. Announcing

- **Only what is held.** A keeping client seeds as NFX-03 §4 says a seeder of some renditions
  does: its `iroh` endpoint carries tickets for its held renditions and `meta` only; it joins
  the web swarms (NFX-10 §2) and mesh rooms (NFX-10 §6) of its held renditions only; its
  `hyperdht` endpoint names them in `renditions` (NFX-12 §2); and its `chunks` is the count of
  hash-list entries it holds unless it holds every rendition. Files of a filling rendition, or of a paid
  video kept as far as it was played, MAY be served to a peer that asks for a file by its
  sha256 (NFX-10 §6, NFX-12 §4) and are never announced.
- **No private address.** A keeping client MUST NOT publish a direct address that is not public
  in anything it announces: no private, shared (CGNAT), loopback, link-local or unique-local
  address, in the IPv4 or the IPv6 space, in an `iroh` endpoint's `addrs` or tickets or in any
  other endpoint. Its user's home network is not the world's business. (A connected peer still
  learns its candidates, as on every transport.)
- **No port opened for it.** A keeping client MUST NOT ask its local gateway to open a port
  (UPnP, PCP, NAT-PMP) because it keeps videos. Its user MAY allow that in a setting of its own.
- **Its own keys.** A keeping client MUST NOT sign beacons with its user's identity key: it uses
  a seeder key used for nothing else (one per user, or one per video, §7). It MUST NOT serve kept
  videos under the transport identity it fetches with (NFX-12 §1 already requires this for
  HyperDHT; it holds for iroh too): a watcher's endpoint id is used to watch, and a seeder's to
  serve.
- **Paid or free.** A keeping client with no mint announces `free: true` with `price_hint` 0. One
  with a mint MAY charge, as any seeder does (NFX-07).
- **How many at once.** A client MAY announce only some of its kept videos at a time. It SHOULD
  rank them `published`, then `downloaded`, then `watched` by most recent play, and SHOULD bound
  how many it beacons and how many swarms and rooms it joins. A kept video it does not announce
  right now stays kept, and its user can see that it waits.
- **Stopping.** Turning seeding off stops every announcement at once (beacons expire within
  their TTL, NFX-03 §1) and leaves every room and swarm. The files stay and still play.

## 5. Browsers

A page can keep and serve only while one of its tabs is open, in storage the browser may clear,
and readable by every page of its origin. On top of §§2–4:

- It stores kept files in the browser's own storage for its origin, bounded by its cap and by
  what the browser grants.
- It serves only through the mesh (NFX-10 §2, §6), never by HTTP.
- **One session key per kept video it seeds** (NFX-10 §6.4 gives each page session one key for
  every room). A page that seeded every kept video under one key would let anyone in its rooms
  list everything it keeps.
- At most one tab of an origin seeds at a time.

NFX-10 is to carry the browser rules in a section of its own; until then, this section states them.

## 6. The user

What a client keeps is part of its user's privacy, so this document sets a floor:

- **Before it first announces, a keeping client MUST tell its user**, in words, that it seeds
  what they watch and download; that while it does, its IP address and the list of videos it
  seeds are public; and where to turn it off. Whether keeping is on before the user answers is
  the client's choice; this document requires the notice either way.
- **One switch stops it.** A keeping client MUST offer a single setting that stops all
  announcing at once (§4), whatever the reasons.
- **The user sees what is kept**, with its reason and state (filling, held, waiting to be
  announced, failed), and can remove any of it. Removing a video from what was watched removes
  the copy kept for that reason, unless another reason keeps it.
- **History stays private.** A client's record of what its user watched is not part of NFX. It
  MUST NOT be published in the clear. A client that syncs it through Nostr encrypts it to its
  user (NIP-44) and keeps it in a list of its own, never mixed into a list other clients rewrite.

## 7. Privacy and security

- **What becomes public.** A keeping client that beacons announces each kept video it beacons
  about once a minute, under its seeder key, with its public addresses. Anyone reading the
  network's relays can list what that key keeps, and so what its user watched for a minute or
  more. One key per video hides the list behind many keys, at the cost of many beacons and the
  same IP address on all of them; this document leaves the choice to the client (§9).
- **Relays see rooms.** A page that seeds joins the mesh rooms of its kept videos, so the relays
  it signals through see which rooms its IP address is in for as long as it is open.
- **What a page keeps, its site can read.** Whoever controls the origin serving the page, or a
  gateway in front of it, can read the page's kept videos and history.
- **People seed what they watch,** on a network where anyone can publish. A client SHOULD let its
  user remove a kept video in one step and MAY decline to keep videos its user has hidden or
  reported.
- **Nothing is trusted that was kept.** A kept file is served only after verification (§3); a
  keeping client can withhold, never poison, as any seeder.
- **Keeping cannot be steered.** What a client keeps follows from what its user played or asked
  for, never from a beacon, a peer or a playlist. The budget (§2.4) bounds what an autoplaying
  page can make it fetch.

## 8. Conformance

A client claims "NFX-18" beside a level (NFX-11 §8) when it:

1. keeps nothing for the reason `watched` from a play shorter than §2.1's minimum, finishes only
   free renditions over peers, and pays only for what its user plays or asks to download (§2.1,
   §2.2);
2. bounds keeping by a budget and a cap, and evicts only `watched` videos (§2.4);
3. verifies every file before storing, and on every read where §3 requires it (§3);
4. announces held renditions only, with no private address, no port mapping of its own, and keys
   of its own (§4), and passes the `renditions` cases of `beacon-hyperdht.json` if it emits a
   `hyperdht` endpoint;
5. in a browser, follows §5; and
6. tells its user and offers the switch of §6.

## 9. Open issues

- **One seeder key or one per video** (§7). One key makes the list of what a user keeps public
  under one name; one per video costs a beacon and a key each, and the same address still links
  them. The reference clients use one key per user on desktop and one session key per kept video
  in browsers.
- **Upload limits.** Nothing here bounds how much a keeping client uploads. A client SHOULD let
  its user cap it.
- **Kept videos beyond the beacon bound** (§4) are reachable only by a peer already in their
  swarm. NFX-17 could answer a lookup for them with a beacon signed on demand, within its answer
  budgets.
- **Browsers clear storage** on their own terms (eviction under pressure, a limit on site data
  for sites not visited recently). A browser client cannot promise to keep anything.

## Changelog

- Draft 2026-11-26 — initial (decision record 0110).
