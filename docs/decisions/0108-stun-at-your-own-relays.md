# 108. STUN at your own relays

Date: 2026-11-24

## Status

Proposed 2026-11-24. Decided by the maintainer (sovtech). It amends NFX-10 §1, which is a
Draft, in place, and NFX-04 §3, which is frozen, in place as a third exception to the freeze
rule (see NFX-04's changelog).

## Context

- Since decision record 0107, a client asks its own STUN servers and those the video's
  creator names, and reaches a seeder's only through the fallback. A client with no server of
  its own, the web player's default, asks none at all when the creator names none, and then
  gathers no server-reflexive candidate until the fallback kicks in.
- A STUN server learns each client's IP address and when it gathers. That is why 0107 lets
  only keys the client already trusts, or peers it already signals with, add a server.
- A relay the client signals through (NFX-10 §6) already sees the client's IP address on its
  WebSocket, and when it is online. A STUN server on that relay's own host learns one thing
  more: the UDP port the client's NAT maps it to.
- The client chooses its relays. A relay's NIP-11 document already says what it carries
  (`nfx.kinds`, NFX-04 §3), so it can say whether its host answers STUN, and on which port.
- `nfxd` already runs both: an embedded scoped relay that can carry kind 25050
  (`--embed-relay`, `--embed-relay-mesh`) and a STUN server (`--stun`).

## Decision

1. **A relay may say its host answers STUN.** NFX-04 §3's `nfx` object MAY carry
   `stun_port`, an integer from 1024 to 65535: the UDP port on which the host named in the
   relay's URL answers STUN Binding requests. Nothing checks it: the operator says so.
   `nfxd --embed-relay-stun-port <port>` says so for the embedded relay; it needs
   `--embed-relay`, and nfxd does not check that anything answers there.
2. **A client asks it for the relays it signals through.** For each relay it sends and reads
   kind-25050 events on, in the order it is configured with them, a client SHOULD use
   `stun:<host of the relay URL>:<stun_port>` if the relay's NIP-11 `nfx.kinds` lists 25050
   and its `stun_port` is valid. The host is taken as it is; the URL's port and path are the
   relay's. A host that is an IP address must be global unicast, and `localhost` and names
   under `.localhost` name no server. A native client resolves any other name and asks only
   if every address is global unicast. A browser cannot check, and need not: it has already
   connected to that name.
3. **Not behind a proxy.** A client that hides its address from a relay through a proxy, a
   VPN or Tor SHOULD NOT use that relay's STUN server: the request would go around the proxy.
   A page cannot detect this.
4. **Its place in the selection.** Own servers, then the relays', then the creator's, then
   the fallback's. At most 4 in all, each `stun:` URL once, so a relay's server that is also
   one of the client's own is asked once, as its own. No key counting: the client chose the
   relay. `relay-stun.json` pins the rule; `stun-select.json` is unchanged.
5. **Never waited for.** A client reads each relay's document at most once a session and
   never delays playback for it. In the web player, the documents are read when the Nostr
   signaler starts, beside the relay sockets, at most 3 s and 64 KiB each; a connection takes
   the relays' servers known when it is made, so a late document counts from the next
   connection, while the session has asked fewer than 4 servers.

## Consequences

- Only relays run by an nfx operator offer it. General relays (primal, ditto and the like)
  have no `nfx` object, so a client asks them nothing, and their NIP-11 documents cost one
  bounded GET per session each.
- The relay's operator learns, beside the client's IP address, its UDP port mapping and when
  it gathers. That is the whole cost to privacy: a client's address goes only to its own
  servers, relays it already connects to, the creator of the video it chose, and a seeder it
  already signals with.
- A client behind a proxy, a VPN or Tor must turn this off, and a page cannot tell. The web
  player leaves it off unless a page asks (`NostrSignaling.relayStun`); the test page turns
  it on with `&signal=nostr` and off with `&relayStun=0`.
- DNS is the operator's. The STUN server is wherever the relay's name resolves, which for a
  relay behind a CDN or a TLS proxy is that proxy's host, not the relay's. An operator names
  `stun_port` only where that host answers STUN. A false `stun_port` costs a client a slot of
  its 4 and up to the gathering timeout (5 s), never a wrong candidate it would act on.
- The web player's API changes: `selectStun(own, relays, creator)` takes a third list,
  `Endpoints.stunServers` is `selectStun([], [], stunCreator)`, and `NostrSignaling.relayStun`,
  `fetchRelayInfo`, `parseRelayInfo`, `relayStunUrl` and the types `RelayStun`, `RelayInfo`,
  `RelayNfx` and `RelayInfoOptions` are new. The fallback's API is unchanged. A page under a
  Content-Security-Policy must allow `connect-src` to its relays' `https:` URLs for it.
- Native clients do not use it yet. nfxd's mesh endpoint would need to read NIP-11 over
  HTTPS, and nfx-node has no TLS client of its own: that needs new dependencies of nfx-node
  (and so a `Cargo.lock` change), which this decision leaves for later. nfxd's relay side,
  which names the port, is done.
