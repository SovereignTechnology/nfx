# NFX-04 — Scoped relay profile

**Status: Draft (target freeze: M1)** · depends on NFX-01/02/03

A "scoped relay" is a bog-standard NIP-01 relay with a deliberately narrow admission
policy. Nothing in this document invents wire mechanics; it is a *profile* — an
operator can satisfy it with a stock relay plus config.

## 1. Admission

A scoped relay for namespace(s) `N…`:

- MUST accept kind **38504** manifests (NFX-02) whose `n` tag ∈ `N…`;
- MUST accept kind **20464** beacons (NFX-03) whose `n` tag ∈ `N…`, handling them as
  ephemerals per NIP-01 (forward to live subscribers, never persist);
- MUST accept kind **5** deletion requests that are valid for NFX (NFX-02 §6) and whose
  every address is in a namespace it serves. It MUST apply them to stored manifests
  (NIP-09) and store them, so that later readers see the deletion;
- MUST implement **NIP-40** and prune expired beacons;
- MUST reject every other kind with `OK false "blocked: out of scope"` and SHOULD do
  the same for in-scope kinds whose `n` tag is absent/foreign;
- SHOULD support NIP-42 authentication for publishing; MAY leave reads open.

## 2. Rate limits (normative baselines)

| Rule | Limit |
|---|---|
| Beacon publishes | ≤ 1 per 20 s per (`pubkey`,`a`; relaxed to 1/15 s if NIP-42-authed) |
| Manifest publishes and deletions | ≤ 12/hour per pubkey, together (catches loops; humans publish ≤ a few/day) |
| `REQ` per connection | ≤ 20 concurrent subscriptions |
| Filter cardinality | `#a` / `#n` lists ≤ 256 entries |
| Event size | manifests ≤ 64 KiB hard; beacons ≤ 16 KiB hard |
| `created_at` | ≤ now + 15 min (reject later ones: a far-future revision outranks, and in a capped store outlives, every real one) |

The 20 s beacon floor leaves slack under NFX-03's republish rule (TTL 60 → republish
at 30 s). Being scoped is the rate limiter that makes beacon traffic viable: the relay
never carries general-purpose nostr load.

## 3. Capability advertisement (NIP-11)

The relay's NIP-11 document MUST list `"supported_nips"` including `11` and `40`
(plus `42` when auth is on), and MUST carry:

```json
"nfx": {
  "networks": ["nfx:mainnet:1"],
  "kinds": [38504, 20464, 5],
  "roles": ["catalog", "availability"]
}
```

## 4. Serving the catalog side

Manifests are low-churn and also belong on the open web of relays: publishers SHOULD
mirror kind 38504 to a handful of general public relays. Catalog reads SHOULD go to
public relays first, scoped relays as fallback; beacons NEVER to public relays
(NFX-03 §7).

## 5. Client query patterns (normative)

| Want | Filter |
|---|---|
| One manifest | `{"kinds":[38504],"#d":[d],"authors":[creator]}` + local `n` check |
| Network catalog browse | `{"kinds":[38504],"#n":[ns],"limit":N}` (+ `#t` refinements) |
| Live availability | `{"kinds":[20464],"#n":[ns],"#a":[a-tags…]}` |
| Find scoped relays | `{"kinds":[30166],"#n":[ns]}` on public relays / NIP-66 monitors |

## 6. Operator self-announcement (federation)

To join the set a network recognizes:

1. Run a relay conforming to §§1–3.
2. Publish a **NIP-66 kind 30166** relay announcement (`d` = `ws(s)://url`) with
   `["n", "<namespace>"]` added per served namespace, from a persistent operator key.
3. Clients and other relays pick it up via the §5 query; no seed-list edit exists.

A seed list MAY ship with clients purely for bootstrapping step 2's discovery.

## 7. Embedded scoped relay

A seeder node MAY embed a scoped relay in the same process (the reference headless
node `nfxd` does; ADR 0008), so that a network can bootstrap with no outside relay at
all:

- An embedded relay is a scoped relay in every respect. It MUST satisfy §§1–3
  (admission, NIP-40, rate limits, NIP-11) and MUST NOT exempt its host's own events
  from any of them. Beacons stay ephemeral; only kind 38504 is ever persisted.
- It MAY listen privately (loopback, a LAN or a tailnet) and then SHOULD NOT announce
  itself. When it is publicly reachable it announces per §6 like any other operator.
- Its host still publishes beacons to the network's other scoped relays (NFX-03 §3):
  an embedded relay adds a relay, it never becomes the only place a seeder speaks.
- Nothing about embedding is visible on the wire; clients cannot and need not tell an
  embedded relay from a standalone one.

## 8. Non-goals

Content moderation policy (operators choose independently), persistence guarantees
(ephemerals are volatile by design), inter-relay sync (scoped relays don't replicate;
redundancy comes from many operators).

## Changelog

- Draft 2026-09-16 — initial. Replaces the design note's "kind-38502-style private
  announcements" with NIP-66 so existing relay monitors see the set for free.
- Draft 2026-09-16 (review fix): beacon publish floor 30 s → 20 s so TTL-60 republish
  (30 s) has slack.
- Draft 2026-09-23 — wire token `nfx` (NIP-11 key `"nfx"`, ADR 0008 §2). New §7:
  a seeder node MAY embed a scoped relay (plan amendment 8); former §7 is §8.
- Draft 2026-09-23 (A2 pre-push audit): §2 `created_at` future bound.
- Draft 2026-09-24 (M1 freeze candidate): §1 admits NFX deletions (kind 5, NFX-02 §6)
  and applies them; §2 counts them with manifest publishes; §3 lists kind 5.
