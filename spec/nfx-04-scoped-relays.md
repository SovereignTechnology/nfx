# NFX-04 — Scoped relay profile

**Status: Frozen (M1)** · 2026-09-24, amended in place 2026-11-18 and 2026-11-19 (§§1–3,
exceptions to the freeze rule: see the changelog) · depends on NFX-01/02/03, and NFX-10 §§1, 6
for the amendments

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
- MAY accept kind **25050** mesh signaling (NFX-10 §6) carrying exactly one `i` tag,
  `nfx-mesh/1`. One that does handles it as an ephemeral (forward to live subscribers,
  never persist, never return it to a later `REQ`), admits it only if it passes the checks
  NFX-10 §6.5 makes in steps 1–3 and 5 (shape, freshness, the NIP-01 signature and the
  room proof), with the event's own `P` as the room, and refuses every other kind-25050
  event (another protocol's, or another type) as out of scope. §6.5's room match and step
  4 do not apply: a relay has no session. **Kind 25050 cannot be scoped to a network:** it
  carries no `n` tag, and its room key hides which network, video and rendition a room is
  (NFX-10 §6.1). A relay can check a signaling event's kind, tags, shape, freshness, size,
  rate and room proof; it cannot tell which application or network sent it, and a creator
  allow-list (§8) does not apply to it;
- MAY accept kind **33478** STUN service announcements (NFX-10 §1) at least one of whose
  `n` tags is in `N…`. One that does admits one only if it passes a reader's checks of
  NFX-10 §1 when it arrives (the NIP-01 signature; exactly one `d`, an `ip:port` in
  canonical form that is global unicast; 1 to 8 distinct `n`; exactly one `expiration`,
  after `created_at` and at most 24 h after it; empty content), within the §2 limits; keeps
  it, as an addressable event (the newest per `pubkey` and `d`), at most until its
  `expiration`, never returning it after (NIP-40); and refuses one that names none of its
  namespaces as out of scope. A creator allow-list (§8) does not apply to it: an
  announcement names no video;
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
| Mesh signaling, when admitted (§1) | presence (`connect`, `disconnect`) ≤ 1 per 10 s per (`pubkey`, `P`, `t`); offers and answers ≤ 64 per 30 s per `pubkey`; ≤ 36 KiB hard. Freshness is NFX-10 §6.5's (60 s back, 30 s ahead), not the row above |
| STUN service announcements, when admitted (§1) | ≤ 12 per hour per `pubkey`; ≤ 2 KiB hard; ≤ 1024 held at once while live, a new one (not one that replaces a held one) refused while full; `created_at` as the row above |

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

A relay that admits mesh signaling (§1) adds `25050` to `kinds` and `"signaling"` to
`roles`. A page or node that wants a scoped relay for signaling reads this document; one
that does not list 25050 refuses it. A relay that admits STUN service announcements (§1)
adds `33478` to `kinds` and `"stun"` to `roles`; one that does not list 33478 refuses them.

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
- **Frozen at M1, 2026-09-24** (sovtech). From here on, a behaviour change needs a
  `specver` bump (NFX-01 §4); only clarifications that change no behaviour are edited in
  place. Record: `docs/nfx/freeze-m1-candidate.md`.
- **Amended in place 2026-11-18, an exception to the freeze rule (the maintainer's
  decision, sovtech, 2026-11-18).** §1: a scoped relay MAY carry kind-25050 mesh signaling (`i` =
  `nfx-mesh/1`, NFX-10 §6) as an ephemeral, after NFX-10 §6.5's checks that need no
  session (the room proof included); every other kind-25050 event stays out of scope, and
  the amendment states that kind 25050 cannot be scoped to a network. §2: its rate limits
  and size. §3: such a relay lists 25050 and the role `signaling`. Why in place and not a
  `specver` bump: the change is additive and a MAY. No artifact changes; a relay that does
  not admit 25050 is exactly as conformant as before; no reader of NFX-02, -03 or -05
  changes behaviour; and clients keep naming general relays for signaling (NFX-10 §6),
  since most scoped relays refuse it. A bump would have re-derived every room key (the
  namespace is in the swarm ID, NFX-10 §2) and republished every manifest, for no reader's
  benefit. The decision and the alternatives considered (a version bump; a separate
  signaling URL on the same relay) are in issue #96.
- **Amended in place 2026-11-19, a second exception to the freeze rule (the maintainer's
  decision, sovtech, 2026-11-19).** §1: a scoped relay MAY carry kind-33478 STUN service
  announcements (NFX-10 §1) for its namespaces: an announcement must pass a reader's checks
  when it arrives (a global unicast server, an `expiration` at most 24 h on) and name one of
  the relay's namespaces; it is kept as an addressable event until it expires (NIP-40), and
  a creator allow-list does not apply to it. §2: at most 12 per hour per key, 2 KiB, and
  1024 held at once. §3: such a relay lists 33478 and the role `stun`. Why in place and not
  a `specver` bump, as for #96: the change is additive and a MAY; no artifact changes; a
  relay that does not admit 33478 is exactly as conformant as before; no reader of NFX-02,
  -03 or -05 changes behaviour; and clients read announcements from general relays too. A
  bump would have re-derived every room key and republished every manifest, for no
  reader's benefit. Unlike kind 25050, an announcement carries `n`, so the relay scopes it
  to its networks as it does a beacon. The decision and the alternatives considered (a
  version bump; reading announcements from general relays only) are in issue #104.
