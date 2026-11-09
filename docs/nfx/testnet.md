# The public testnet

`nfx:testnet:1` is the network [NFX-11](../../spec/nfx-11-registry.md) names for
interoperability testing. This page lists what is public on it, who runs it, and what the
operator can see. It was written on 2026-11-07 and is kept current as services come and go.
The [0.1.0](releases/v0.1.0.md) and [0.1.1](releases/v0.1.1.md) release notes, point-in-time records, say there was no
public network at that release; this page is the current state.

## What is public

| Service | Address | State |
|---|---|---|
| iroh relay | `https://iroh.nutflix.xyz/` | Running. |
| Scoped Nostr relay (NFX-04) | `wss://relay.nutflix.xyz` | Running. Admits only NFX-04 events for `nfx:testnet:1`. |

The iroh relay is n0's `iroh-relay` 1.2.0 with a publicly trusted certificate, so no
`--iroh-relay-ca` is needed. It listens on IPv4 only for now. QUIC address discovery is off,
so direct hole-punching is limited and many connections will be relayed.

## Using the scoped relay

`wss://relay.nutflix.xyz` is the NFX-04 reference relay (`nfxd`'s embedded scoped relay) and
nothing else: it takes manifests (kind 38504), availability beacons (kind 20464, never stored)
and valid deletions (kind 5) for `nfx:testnet:1`, and answers `blocked: out of scope` to every
other event. In the nutflix-pear desktop app, add it under Settings > NFX network > scoped
relays; with `nfxd`, pass `--relay wss://relay.nutflix.xyz`.

- Stored manifests live in the relay's memory (at most 20,000 events). A restart forgets them,
  so publishers must republish, and should also mirror manifests to general public relays
  (NFX-04 section 4).
- It does not implement NIP-42 authentication (a SHOULD in NFX-04), and its NIP-11 document
  carries no operator fields; this page is where the operator is named.

Nothing on the network depends on this relay. A goal of NFX and nutflix is to work with
ordinary Nostr relays: manifests and beacons are standard events that general public relays
carry unchanged, and connection signaling for peers behind NAT (issue #30) is being designed
the same way, with no relay plugins or custom relay software in the required path. This relay
is a filter and a convenience.

## Using the iroh relay

Using it is opt-in; nothing points at it by default.

```sh
nfxd run --iroh-relay https://iroh.nutflix.xyz/ …              # use it, and still go direct when possible
nfxd run --iroh-relay https://iroh.nutflix.xyz/ --relay-only … # send every byte through it
```

`--relay-only` needs at least one `--iroh-relay` and cannot be combined with `--gossip`. In the
nutflix-pear desktop app, add the URL under Settings > NFX network > iroh relays.

## Who runs it

SovTech (Sovereign Technology), under the Nostr identity
`npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx`, the key that signs the
project's release notices. Send abuse reports and questions to that npub, as a Nostr mention or
a direct message.

## What the operator can see and keeps

An iroh relay forwards encrypted packets addressed by endpoint id. Each endpoint
authenticates itself with its id inside QUIC TLS, iroh verifies blobs by BLAKE3, and `nfxd`
checks every file against the signed sha256 hash list (NFX-05). So the relay:

- **cannot** read or alter the video, and cannot impersonate a peer;
- **can** see which endpoint ids connect, when, how many bytes they move, and each client's
  network address at connection time.

The scoped Nostr relay carries events that are public by design (manifests and beacons name
videos and the endpoints that seed them), and its operator also sees which videos a client
subscribes to and the client's network address at connection time.

What is kept, for both relays:

- The relay processes log nothing about clients. The scoped relay's front end logs only
  certificate management, and never receives the client's address.
- The proxy in front of them does not write either relay's name to its shared access log.
- A connection refused for exceeding the per-address limit writes the client address to the
  proxy's error log.
- Daily byte totals are kept.
- Nothing is kept longer than the operator's 90-day ceiling.

## Limits

iroh relay:
- 4 MiB/s per client, with a burst of 16 MiB.
- 8 simultaneous connections per client address, and 1000 in total.
- An aggregate bandwidth cap across all clients.

Scoped Nostr relay:
- The NFX-04 baselines: one beacon per 20 s per (pubkey, address), 12 manifest publishes or
  deletions per pubkey per hour, 20 subscriptions per connection, 64 KiB per manifest and 16 KiB
  per beacon.
- 16 simultaneous connections per client address, and 1000 in total.
- An aggregate bandwidth cap across all clients.

Neither has authentication or an SLA. This is a testnet: either can be down, and the network
may be reset.

## Known issue: Quad9

Quad9's filtering resolver (`9.9.9.9`) answers `nutflix.xyz` with NXDOMAIN (extended error 17,
"Filtered") as of 2026-11-07, so clients that resolve through it cannot reach either relay.
Quad9's unfiltered resolver (`9.9.9.10`) and other public resolvers resolve the names normally.
