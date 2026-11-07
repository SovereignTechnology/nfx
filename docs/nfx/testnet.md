# The public testnet

`nfx:testnet:1` is the network [NFX-11](../../spec/nfx-11-registry.md) names for
interoperability testing. This page lists what is public on it, who runs it, and what the
operator can see. It was written on 2026-11-07 and is kept current as services come and go.
The [0.1.0 release notes](releases/v0.1.0.md), a point-in-time record, say there was no
public network at that release; this page is the current state.

## What is public

| Service | Address | State |
|---|---|---|
| iroh relay | `https://iroh.nutflix.xyz/` | Running. |
| Scoped Nostr relay (NFX-04) | `wss://relay.nutflix.xyz` | Planned. Not running yet; this page will list it when it exists. |

Until the scoped relay exists, run your own (`nfxd run --embed-relay …`) and point your peers
at it.

The iroh relay is n0's `iroh-relay` 1.2.0 with a publicly trusted certificate, so no
`--iroh-relay-ca` is needed. It listens on IPv4 only for now. QUIC address discovery is off,
so direct hole-punching is limited and many connections will be relayed.

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

What is kept:

- The relay process logs nothing about clients at warn level.
- The proxy in front of it does not write the relay's name to its shared access log.
- A connection refused for exceeding the per-address limit writes the client address to the
  proxy's error log.
- Daily byte totals are kept.
- Nothing is kept longer than the operator's 90-day ceiling.

## Limits

- 4 MiB/s per client, with a burst of 16 MiB.
- 8 simultaneous connections per client address, and 1000 in total.
- An aggregate bandwidth cap across all clients.
- No authentication and no SLA. This is a testnet: the relay can be down, and the network may
  be reset.
