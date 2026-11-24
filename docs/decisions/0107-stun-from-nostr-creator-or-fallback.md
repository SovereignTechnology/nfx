# 107. STUN servers from Nostr: the creator's, or the fallback

Date: 2026-11-24

## Status

Proposed 2026-11-24. Decided by the maintainer (sovtech). It amends NFX-10 §1, which is a
Draft, in place.

## Context

- NFX-10 §1 let a client use STUN servers named over Nostr. Those came from the `stun`
  endpoints of beacons (kind 20464) and from STUN service announcements (kind 33478). The
  client ranked them by how many distinct keys named each. A server named by a lone key was
  used when the client had no server of its own and nothing better was named.
- Keys are free. Two fresh keys could name one server and outrank every honest one, so every
  client of a video, or of a network, would ask a server of their choice. One fresh key was
  enough for a client with no server of its own. Counting keys proves nothing (a Sybil attack).
- A STUN server learns each client's IP address and when it asked. So whoever can add a
  server learns who watches. A server that lies about the mapping costs a candidate, but the
  address has already leaked.
- Two keys mean something for a video. The creator signs the manifest, so a viewer already
  trusts that key with what it plays. A seeder the client already signals with learns its
  address anyway, through ICE.

## Decision

1. **Its own servers first.** A client uses its own STUN servers first, each once, as before.
2. **Routinely, only the creator's.** Beside its own, a client uses only the servers in the
   `stun` endpoint of a live, verified beacon of the video signed by that video's creator.
   That is a beacon whose signer is the creator its `a` tag names, which is the author of the
   manifest. The address must be global unicast, so documentation blocks are refused. The port
   must be 1024 or above. A server that is the client's own is not counted twice. A client
   uses at most 4 STUN servers in all. Keys are not counted, and the rule for a server named by
   a lone key goes away.
3. **Any other server named over Nostr only through the fallback.** The fallback is unchanged
   in its tests. The server is in the `stun` endpoint of a seeder's live beacon. The client is
   already signaling with that seeder: the server's IP is among that peer's SDP candidates. The
   address is global unicast and the port is 1024 or above. The client takes one per seeder and
   at most 4 STUN servers in all. The fallback now also covers a client with no STUN server of
   its own. Its trigger stays "no server it asks returned a mapping". A client that asks no
   server has no mapping once gathering ends, so the fallback applies to it then.
4. **Announcements are a directory.** A kind-33478 announcement is never used automatically.
   It stays a valid event, with its validation, `nfxd stun --announce`,
   `--embed-relay-stun-ads` and the `stun-announcement.json` vectors. People and operators read
   announcements to choose STUN servers to configure. The mesh no longer subscribes to them,
   and the web player no longer reads them.
5. **Nothing changes on the wire.** Beacons, announcements and signaling keep their formats.
   Only the client's selection changes. `stun-select.json` pins the new rules, including
   strangers' beacons with 2 and 3 keys (not used), the creator's beacon (used), the creator's
   on a port below 1024 (refused), an announcement alone (never used), and the fallback with no
   server of its own (still refusing announcements and addresses it does not signal with).

## Consequences

- A new operator's server is no longer used automatically. It is used only if the creator
  names it in its beacon, or a seeder names it and the fallback reaches it. Announcing a
  server no longer brings clients to it.
- Announcements become a directory. Nothing in the mesh or the web player reads them, so a
  client never subscribes to kind 33478.
- A creator whose node signs its beacons with a key other than the creator key gets no routine
  use of its STUN servers. They are reached only through the fallback.
- A client's IP address goes only to its own STUN servers, to the servers the creator of the
  video it chose names, and, through the fallback, to a server at the address of a seeder it
  already signals with.
- A client with no STUN server of its own, the web player's default, now also falls back. When
  the creator names no server, the only STUN servers it asks are seeders' at the addresses of
  peers it already signals with.
- The web player's API changes: `Endpoints.stunNamed`, `StunNamed` and `rankNamed` are removed;
  `Endpoints.stunCreator` holds the creator's servers, and `selectStun(own, creator)` takes them.
  `StunFallback.own` may be empty. The API was not released.
