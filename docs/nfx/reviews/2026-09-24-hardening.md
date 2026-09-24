# Review: M1 hardening — creator allow-list, gossip in `nfxd`, `Verified<T>`, NIP-42 (2026-09-24)

Scope (on top of `8c2e704`, the desktop viewer):
- `nfx-node::relay`: an optional creator allow-list (`ScopedRelay::with_creators`);
- `nfx-node::node`, `::gossip`, `::origin`: gossip bootstrap by address,
  `Node::trusted` and `Node::learn_addr`, and relay-only nodes kept out of gossip;
- `nfxd::daemon` and `main`: swarms joined per video (announce `here`, `bye` on
  deletion, learn seeders), `--gossip-peer ID@ADDR`, `--allow-creator`;
- `nfx-proto::Verified<T>`, returned by every verifier and required by
  `Origin::hold` and `SwarmPull::learn` (sharp edge S4 of the A2 audit);
- NIP-42, investigated and not implemented (below).

Method: `differential-review` (gossip adds a new untrusted input path, from swarm
members to the pull table) and `sharp-edges` (new flags and a changed public API).

## Findings

| # | Finding | Severity | Resolution |
|---|---|---|---|
| G1 | **iroh-gossip installs its own address lookup, fed by the addresses swarm members advertise, unfiltered, and iroh dials any relay URL it is given** (`RelayActor::active_relay_handle` starts a connection for an unknown URL). A swarm member could therefore point a node at a relay host of its choosing. For a `--relay-only` node that defeats the mode: the chosen relay learns the IP address the mode exists to hide. | Medium | **Fixed.** A relay-only node never gossips: `join_swarm` refuses, the gossip ALPN is not routed, `nfxd` refuses `--gossip-peer` with `--relay-only`, and its learner never starts. Test: `iroh_node` asserts the refusal. |
| G2 | Bootstrap peers came from beacon tickets as bare endpoint ids. Under `presets::Minimal` (no discovery) an id alone cannot be dialled, so a seeder configured with a peer never joined (the new daemon test failed this way). | Functional | **Fixed.** Bootstrap uses `EndpointAddr`s. Each is filtered by `Node::trusted`, the same rule as `Node::dial` (direct IPs, none on a relay-only node, plus this network's relays), then stored in the node's address book. A peer with nothing usable left is skipped. Test: a foreign-relay lure is emptied and `learn_addr` refuses it. |
| G3 | A `--gossip-peer` with no usable address would be dropped silently at every join. | Low | **Fixed.** Refused at start ("no direct address, and no relay among --iroh-relay"). `ID@ADDR` is parsed strictly, and repeats of an id merge. `nfxd run` prints its own `gossip peer:` lines. Tests: config refusals plus a parser unit test. |
| G4 | `--allow-creator` without `--embed-relay` restricted nothing. | Low | **Fixed.** Refused at start. Test added. |
| G5 | A gossip `here` becomes a pull source. | Reviewed | The envelope is verified first (BIP-340, topic video, ±15 min, 4 KiB cap before parsing). It lapses `EVICT_AFTER` (240 s) after `created_at`. `learn` applies the ticket↔node rule and the per-video source cap. The node's own pubkey is skipped. Bytes are verified on fetch, and a liar is forgotten. So a lying member costs time, not bytes, exactly as a lying beacon does. |
| G5b | **Gossip has no relay budget.** A member can announce under any number of fresh keys at no cost. That could fill a video's 16-source table and evict the seeders heard from relays, whose beacons NFX-04 §2 rate-limits. The pull path would then spend its attempts on sources that never answer. | Medium | **Fixed.** Sources remember where they were heard. Gossip-heard sources are evicted first and never displace a relay-heard one, and a relay beacon for a gossip-heard seeder promotes it. Test: `gossip_never_displaces_a_source_heard_from_a_relay` floods 20 identities and checks the full-table and promotion cases. |
| G6 | An envelope names the video, not the creator. `presence_for(a)` binds it to the manifest being watched. | Accepted | A seeder of another creator's same-named video can appear as a source for ours. Its bytes fail our manifest's hash list, so it is poisoned and forgotten. Documented on `presence_for`. |
| G7 | On a normal node, members' advertised direct addresses and relays are dialled. | Accepted (upstream) | A P2P node already shows its IP to the peers it connects to. A member can also make the node send QUIC handshakes to an arbitrary `ip:port`, a small reflection. This is iroh-gossip's design and cannot be filtered from outside it. Relay-only nodes are excluded (G1). |

Carried forward:
- **A swarm is joined once, from the peers known at that moment.** Peers learned later
  are not added (`GossipSender::join_peers` would add them). If every bootstrap peer
  leaves, the node sits alone in the topic. Discovery then falls back to Nostr beacons,
  which keep working, so this costs speed, not correctness.

## `Verified<T>` (closes S4)

- `Manifest::from_event`, `Beacon::from_event` and `Envelope::verify` return
  `Verified<T>`. Its constructor is `pub(crate)`, so nothing outside `nfx-proto` can make
  one. It has no `Deserialize`: parsing proves nothing.
- `Origin::hold(&Verified<Manifest>)` and `SwarmPull::learn(&Verified<Beacon>)`
  can no longer be fed hand-built values. `Relays::manifests`, `sign_manifest`,
  `BeaconWatch::next` and `Daemon::watch` hand the proof on.
- `Deref` keeps field reads unchanged. `into_inner` gives the plain value back, and
  drops the proof with it; tests that mutate a manifest use it and re-sign.
- The origin and pull tests now sign real events: seeders are real keys, and the
  "stale" beacon is verified while fresh and learned after it lapsed.

## NIP-42: not implemented (blocked on nostr-sdk)

NFX-04 §1 says scoped relays SHOULD require NIP-42 for publishing. nostr-sdk 0.45's
`LocalRelay` checks the AUTH event's `relay` tag against `ws://<bind address>`. Behind
our hyper front, and behind any TLS proxy, clients authenticate to the public URL, so
AUTH could never succeed. Doing it ourselves would need the per-connection challenge,
and `LocalRelay` owns the connection loop. **It stays a conformant SHOULD omission.**
The creator allow-list covers the practical need: an operator can refuse everyone but
named creators. Revisit when nostr-sdk lets the relay URL be configured.

## Checks

- `crates/ci/check.sh`: vectors, schemas, the add-only check, fmt, clippy
  `-D warnings`, every test, `cargo deny`, and the WASM vectors.
- `nfxd` tests, including `a_viewer_learns_a_seeder_it_can_only_hear_through_gossip`.
  In that test, seeder B speaks only to its own relay, and the viewer learns B through
  A's swarm. Before the G2 fix it failed after 76 s; it now passes in about 17 s.
- Desktop workspace: clippy `-D warnings`, and `./e2e.sh`.
  - The first re-run failed before any app code ran. The compositor socket was named
    `nfx-desktop-e2e` on every run, and an earlier run had left that socket behind.
    The script took it for a live display, and GTK could not start.
  - Each run now uses its own display name, removes it on exit, and stops if the
    compositor never appears.

Verdict: **no blocker.**

## Correction (2026-09-24, after the independent audit)

An independent audit of these commits found what this self-review missed. Its record,
with resolutions, is [`2026-09-24-independent-audit.md`](2026-09-24-independent-audit.md).
Three claims above were wrong or only half true:
- **G1 was only partly fixed.** Keeping relay-only nodes out of gossip did not stop the
  problem on normal nodes. A swarm member can attach any relay URL to *any* endpoint id,
  an honest seeder's included, so even a filtered `Node::dial` contacts it: a blind SSRF
  (audit M1). **Gossip is now opt-in** (`--gossip`).
- **G5b fixed eviction only.** Gossip sources were still tried before a relay source on
  cooldown, and future-dated presences outlived `EVICT_AFTER` (audit M2).
- **`Verified<T>` did not stop `learn()` from taking a gossip presence** (audit L1).
  Presences are now their own type.

The audit also found a High this review missed entirely: a stuck gossip broadcast
silently stopped relay beacons (H1).
