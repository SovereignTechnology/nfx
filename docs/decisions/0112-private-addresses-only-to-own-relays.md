# 112. Private addresses only to relays on the seeder's own networks

Date: 2026-11-26

## Status

Accepted 2026-11-26 by the maintainer (sovtech). Issue #132. It amends NFX-03 §4, which is frozen, in place:
a publisher rule only, so readers are unchanged and `specver` is not bumped (see NFX-03's
changelog). The money lock is not involved.

## Context

- A beacon's `iroh` endpoint names where the seeder can be dialled: `addrs`, and the direct
  addresses inside each ticket (NFX-06 §2). nfxd took them from iroh, which lists every
  interface address it binds on: LAN, VPN and tailnet addresses included.
- Only `--iroh-external` narrowed that (to public addresses and the external ones), and only an
  operator who can forward a port can set it. A seeder behind a home NAT with no forwarded port
  therefore sent its home and VPN addresses to every relay it announces on, public relays
  included, where anyone reading beacons for its videos learns the layout of its networks.
- The same seeder still has a use for those addresses: a viewer on its LAN or tailnet that reads
  the seeder's own relay (`--embed-relay` on a tailnet address, say) dials it directly, with no
  iroh relay, and keeps working when the network's iroh relays are down. Dropping them
  everywhere (`public_addrs_only`, nfx #128, the viewer's rule in NFX-18) would end that.
- Test networks run every relay on loopback or a private address and need every address.

## Decision

1. **Two audiences.** A relay is on the seeder's own networks when the connection to it reached
   an address of the seeder's host or of a network it is on directly: loopback, private
   (RFC 1918), shared (100.64.0.0/10, which carrier NATs and tailnets use), link-local or
   unique-local (fc00::/7), an IPv4-mapped address read as IPv4 (`nfx_node::node::is_local`).
   Every other relay, and anything the node cannot class, is public.
2. **What each hears.** A relay reached at a public address hears an `iroh` endpoint with only
   the iroh relay, public direct addresses (`nfx_node::node::is_public`) and the operator's
   external addresses, in `addrs` and in every ticket. A relay on the seeder's own networks hears
   every address, as before. When the two differ, the seeder signs two beacons, each sent only
   to its own audience. With `--iroh-external` set, both are the public one, as before.
3. **By the address reached, not the name.** The class is read from each relay connection's
   socket (`nfx_node::relay_class::ClassifyingTransport`), never from the URL's host name: a
   MagicDNS or LAN name can resolve to a private address, and any name to a public one. A relay
   with no live connection, reached through a proxy, or with live connections of both classes
   is public, and so is nfxd's embedded relay when it listens on every interface (`0.0.0.0` or
   `[::]`): the node reaches it at loopback, but anyone who can reach the host reads it. A beacon for the seeder's own networks is also marked so that no connection to a
   public address carries it, even one that reconnected there after the beacon was routed.
4. **Everything else for the world.** A lookup answer (NFX-17) embeds, and re-signs from, the
   public beacon: its answers go to every relay. A gossip envelope (NFX-06 §4) reaches every
   member of a video's swarm, whoever that is, so it carries the public beacon too.
5. **What stays.** iroh's own NAT traversal still tells a peer that is already connected all of
   its candidates, and the mesh endpoint's ICE candidates go, encrypted, to the peers it
   signals with (NFX-10 §6). Those reach a peer, not a relay's readers. nfxd's `gossip peer:`
   lines on stderr still list every address, for the operator.

## Consequences

- A seeder behind a NAT names nothing of its LAN, VPN or tailnet on public relays, with no flag.
  A viewer on its own network still reads the full beacon from a relay there.
- Each beacon period costs a second signature and event where a seeder has both audiences.
- A relay that looks private but is published to the internet (an embedded relay on loopback
  behind a TLS proxy, a private address behind a DNAT, a `ws://127.0.0.1` port in front of a
  tunnel, a resolver handing out private stand-in addresses for a VPN or a proxy) hears the
  private addresses. An operator with such a relay runs `nfxd run --public-addrs-only`
  (`public_addrs_only`), which leaves them out of every beacon.
- nfx-node makes its own relay connections now (`ClassifyingTransport`): the same TCP dialer,
  TLS and websocket handshake as nostr-sdk's default transport, through crates already in the
  lock, so `Cargo.lock` changes only in nfx-node's dependency list. The `User-Agent` stays
  nostr-sdk's, and a test fails when an upgrade changes it.
- Other implementations (nutflix-pear, its iroh helper) follow the same rule in their own
  repositories.
