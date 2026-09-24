# Pre-push review: A2 `nfx-node` layer 4, the scoped relay (`a2/nfx-node`, 2026-09-23)

Scope:
- `crates/nfx-node/src/relay.rs` and `tests/scoped_relay.rs`;
- `from_nostr` is now `pub(crate)`;
- new direct dependencies, already in the tree through nostr-sdk: `tungstenite`
  (handshake only, for `derive_accept_key`) and `nostr-memory`.

Method: `differential-review` (a public-facing relay) and `sharp-edges`.

## Adversarial pass

| Attack | Result |
|---|---|
| Use the relay for general nostr traffic | Only kinds 38504 and 20464 whose `n` tag is served are admitted, and each must pass full `nfx-proto` verification. Tested: kind 1 and a foreign namespace give `blocked: out of scope`, and a manifest that fails NFX-02 gives `invalid:`. |
| Beacon spam | One beacon per (pubkey, `a`) per 20 s; the per-connection rate is 1,200 events a minute. Tested: an immediate second beacon gives `rate-limited:`. |
| Manifest loops | 12 per pubkey per hour. Tested: the 13th gives `rate-limited:`. |
| Beacons persisted | Kind 20464 is ephemeral: forwarded live, never saved. Tested with a fresh REQ after the beacon, which returns nothing. Expired events are refused on write and skipped on read (nostr-sdk, NIP-40). |
| Wide or many subscriptions | 20 REQs per connection. Any tag list over 256 values is refused by the query policy (unit tested). |
| Oversized events | 64 KiB relay-wide; beacons 16 KiB in admission. |
| Memory growth | Rate-limit maps are swept above 10,000 keys. Stored events are capped at 20,000, and the oldest are evicted first. |
| WebSocket handshake abuse | Only `GET` with `Connection: upgrade`, `Upgrade: websocket`, version 13 and a key is upgraded. The accept key comes from tungstenite. Headers must arrive within 10 s. Connections are capped by nostr-sdk's `max_connections`. |
| The host exempting itself | The host publishes through the same socket and policy as everyone else (§7). |

## Sharp edges carried forward

- **Per-pubkey limits do not stop Sybils.** Keys are free, so a flood of valid manifests
  from fresh keys can churn the 20,000-event store and evict real manifests. That is
  bounded by the per-connection rate and connection cap, not prevented. Mitigations
  are §1's NIP-42 (a SHOULD, not yet implemented), an operator allow-list of creator
  keys, or proof of work. Manifests are mirrored to public relays too (§4), so the
  scoped relay is not the catalog's only copy.
- **NIP-42 is not implemented.** §1 says SHOULD, and the relaxed 1/15 s authenticated
  beacon floor therefore does not apply.
- **In-memory only.** A restart forgets stored manifests. Persistence (LMDB) is a later
  `nfxd` option.
- **No self-announcement (§6).** Publishing kind 30166 is `nfxd`'s job, and only for a
  publicly reachable relay.

Verdict: **no blocker.** The push waits for sovtech's OK.

**Erratum (pre-push audit, same day):** connections were *not* capped by nostr-sdk's `max_connections`; it was never set. Fixed; see `2026-09-23-a2-pre-push.md` #3.
