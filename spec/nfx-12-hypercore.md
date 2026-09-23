# NFX-12 — Hypercore transport profile (optional)

**Status: Draft (target freeze: later, no milestone gates on it)** · depends on NFX-01/03/05/07

An optional transport that carries the same NFX-05 files over the Holepunch stack
(Hypercore, Hyperswarm, Protomux). It lets a Hypercore-based peer — for example a
sidecar built from an existing Hyperblobs seeder — join an NFX network. It is a
non-breaking addition under NFX-01 §4: a new beacon endpoint type that readers who do
not implement it skip (NFX-03 §4).

**No conformance level requires this profile, and it requires no particular runtime.**
Node, Bare or anything else that speaks the Hypercore protocol can implement it. Pear
is not involved.

## 1. Storage: one Hyperdrive per seeder per video

A seeder stores a video's files in a **Hyperdrive**. That is a Hyperbee file index
plus a Hyperblobs content core, written only by this seeder:

- each NFX-05 file (hash list, playlists, inits, segments, thumbs, subtitles) is the
  drive entry `/<sha256-hex>`, whose bytes are exactly the file's bytes;
- the drive holds nothing else.

The drive key is a transport identity only, like an iroh NodeId (NFX-06 §1). The
long-term identity is the nostr key that signs the beacon advertising the drive.

## 2. Beacon endpoint

```json
{ "t": "hyper", "drive": "<64-hex Hyperdrive key>" }
```

It is added to `endpoints` in NFX-03 beacon content, beside any `iroh`/`https`
endpoints. `drive` is the 32-byte drive key in lowercase hex.

## 3. Discovery: a per-video Hyperswarm topic

```
topic = sha256( utf8( "nfx/1/hyper/" + namespace + "/" + video-id ) )    (32 bytes)
```

Seeders join the topic as server and client, and watchers as client. The namespace
is inside the topic, so mainnet, testnet and every custom network form disjoint
swarms (NFX-01). On a connection, peers replicate the drives whose keys they learned
from beacons. A drive key learned any other way MUST NOT be trusted for payment
decisions.

## 4. Integrity: re-anchor to sha256

Hypercore's signed Merkle trees prove that bytes came from the drive's writer. That
is transport integrity only, the role BLAKE3 plays for iroh (NFX-05 §4). A lying
seeder can put any bytes under any path. Every file fetched over this profile MUST
therefore be verified as `sha256(bytes) == files[i].sha256` (NFX-05 §4) before use
or storage. The hash list itself is fetched as `/<root-hex>` and verified against the
manifest `root`.

## 5. Payments: pay/1 over Protomux

Payments use the NFX-07 §2 messages unchanged, on a Protomux channel on the same
Hyperswarm connection:

- protocol name `nfx/pay/1`, channel id = `utf8(<namespace>:<video-id>)`;
- one pay/1 JSON message per Protomux message (UTF-8, no trailing newline), ≤ 32 KiB;
- the unit is one NFX-05 file, as in the web mesh (NFX-10 §3.2); `window` per the
  seeder's `quote`, default 8; licensed videos add the proof lock of NFX-08 §4.

## 6. Pinned series

Pinned in NFX-11 §4, currently the series the reference Hyperblobs seeder uses:
`hypercore` 11, `hyperdrive` 13, `hyperswarm` 4, `protomux` 3.

## 7. Open issues (before any freeze)

- **Upload gating.** Hypercore replication serves blocks on request. Enforcing
  `window` means refusing individual block requests for a session that is behind on
  pay/1. The available replication hooks, and whether gating needs a patched
  `hypercore`, are to be settled by the sidecar spike (S5 in ADR 0008).
- **Runtime of the sidecar**: Bare or a Node single-executable build (spike S5).
- **Partial drives.** How a partial seeder (NFX-03 `chunks` ≠ `"all"`) advertises which
  entries it holds, beyond the entry list the drive already exposes.

## Changelog

- Draft 2026-09-23 — initial (plan amendment 6, ADR 0008).
