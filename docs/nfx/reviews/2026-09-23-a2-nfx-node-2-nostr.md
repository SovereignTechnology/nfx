# Pre-push review: A2 `nfx-node` layer 2, Nostr (`a2/nfx-node`, 2026-09-23)

Scope:
- `crates/nfx-node/src/nostr.rs` and `tests/nostr_relays.rs`;
- `nfx-proto`'s `Manifest::tags()` and `beacon::tags()`, with their vector tests;
- the CC0-1.0 addition to `deny.toml`.

Method: `differential-review` (untrusted relay input) and `sharp-edges`.

## Adversarial pass

| Attack | Result |
|---|---|
| A relay ignores the filter and returns other kinds, namespaces, authors or videos | Every event goes through `Manifest::from_event` or `Beacon::from_event`, then is re-checked against the query (`ManifestQuery::admits`, the watched `a` set). The filter is only a bandwidth hint. |
| A creator-signed manifest that fails NFX-02 | It is dropped. Tested: a kind-38504 event with no `root`, stored by the relay, never reaches the caller. |
| An older revision served as current | Per address, the highest `created_at` wins, and ties go to the lowest id (NIP-01). Tested with two revisions. |
| Beacon replay or reordering | Only a strictly newer `created_at` per (seeder, manifest) is delivered (NFX-03 §2). Tested: an older beacon is skipped and a newer one delivered. Expired beacons fail `Beacon::from_event` against the clock at receipt. |
| A beacon flood from freshly minted keys | Each beacon must verify. The table is capped at `MAX_LIVE_BEACONS` (4096): expired entries go first, then the soonest-to-expire. Unit tested at cap 2. Beacons are hints, so the flood can crowd out others but cannot poison (NFX-03 §7). |
| An empty watch list | Refused. Relays disagree on whether `#a: []` matches everything or nothing. |
| Publishing something readers reject | `sign_manifest` and `sign_beacon` parse their own output back through `nfx-proto`. A manifest must round-trip to itself, and a TTL outside [60,120] is refused before signing. |
| A flood of fetched events | `fetch_events` is bounded by nostr-sdk's 10,000-event buffer and the caller's timeout. |

## Sharp edges carried forward

- **Relay URL schemes are not restricted.** `ws://` leaks which videos a client is
  interested in to the network path. Nothing in NFX-03 or NFX-04 says `wss://`. Decide
  when `nfxd` gains its relay configuration: either `wss://` except on loopback, or a
  spec line.
- **A future-dated revision wins until the creator publishes a later one.** Only the
  creator's key can produce one, so this is a self-inflicted foot-gun, not an attack.
  NFX-02 has no skew rule for manifests.
- **`BeaconWatch::next` stops at the first beacon that is new.** Callers that want only
  a count should use `live(now)`. Beacons that arrive while nobody polls are buffered
  by nostr-sdk's broadcast channel, and dropped if the caller lags. They are hints, and
  the seeder republishes at TTL/2.

## Supply chain

nostr-sdk 0.45.4 (MIT) with default features: `ring` and `rustls` with webpki roots,
the same backends iroh already uses. It brings rust-bitcoin's hashing crates, which are
CC0-1.0; CC0-1.0 is now allowed, as Unlicense already was. `cargo deny` is green.

Verdict: **no blocker.** The push waits for sovtech's OK.
