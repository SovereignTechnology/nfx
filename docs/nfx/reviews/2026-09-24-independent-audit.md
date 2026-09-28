# Independent security audit: `6a92cfe..b676753` (branch `desktop/app`, 2026-09-24)

- **Auditor:** a fresh agent that had not seen the author's reviews until its own
  findings were written. The lesson of the A2 audit was that such a pass catches what
  self-reviews miss, and it did so again.
- **Commits:** `4372a51` (desktop app, `Daemon::watch`) and `b676753` (gossip in
  nfxd, creator allow-list, `Verified<T>`).
- **Method:** `differential-review` and `sharp-edges`: risk triage per file, a deep read
  of the HIGH-risk files, and a trace into the pinned upstream crates (iroh 1.2.0,
  iroh-gossip 0.101.0, iroh-relay 1.2.0, iroh-blobs 0.103.0, tauri 2.11.6).
- **Experiments:** six, all local on 127.0.0.1, with relays and the portmapper off. The
  repo's tests and the desktop app were not run by the auditor.

**The common root:** the High finding and M1–M3 all trace back to one new default. Every
node that is not relay-only joined gossip for every video.

The resolution column was added by the author after the audit. The fixes are in the
commit that adds this record, and each has a test.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| H1 | **A stuck gossip broadcast silently stops relay beacons and deletion checks.** `announcer.announce().await` ran before the relay beacon, in the same `select!` arm, with no timeout. iroh-gossip's frame cap (4096) is below NFX's envelope cap plus framing, so an envelope of about 4058 to 4096 bytes passes NFX but kills the neighbour's send loop, and `broadcast()` then blocks from about the 129th call (E5, run). Six renditions × 10 addresses is 4074 bytes (E3). The seeder drops off relays within 120 s while the state still says `Seeding`. A neighbour that stops reading is a remote trigger (by reading). | High | **Fixed.** The relay beacon goes out first. Every gossip send runs under a 1 s timeout. An envelope over `MAX_ENVELOPE_BYTES - 64` is never broadcast. Gossip is now opt-in (M1). |
| M1 | **Gossip peer data bypasses `Node::trusted`.** iroh-gossip installs its own lookup on the shared endpoint and adds every advertised address unfiltered. Any member can attach any relay URL to any endpoint id, an honest seeder's included, and a filtered `dial` then contacts it: 8 × `GET /relay` in 3 s to an unlisted URL (E6, run). That is a blind SSRF from every gossiping node. | Medium | **Fixed by making gossip opt-in** (`--gossip`, `Config::gossip`, default off), with the risk stated on the flag and in `Node::join_swarm`. The proper fix needs a separate endpoint with relay transport off, or an upstream filter hook, and is carried forward. |
| M2 | **Gossip sources were tried before relay sources whenever the relay source was on cooldown, and future-dated presences stuck.** A presence dated 15 min ahead lived 1139 s (E2), and eviction favoured it over honest ones. Fresh-key stallers could hold the per-video pull for 60 s each. | Medium | **Fixed.** `live()` orders relay-heard before gossip-heard sources within each cooldown bucket. A presence's `created_at` is capped at the time it was heard. Gossip-only sources are capped at 8 of the 16. |
| M3 | **iroh-gossip keeps peer data for any id named in `Shuffle`/`ForwardJoin` and never prunes it:** memory that a member can grow about one for one with the bytes it sends (by reading). | Medium | **Contained by the opt-in (M1). Upstream issue carried forward.** |
| M4 | **`Daemon::watch` could break an address for the rest of the session.** With no relay connected at the first watch, the state stuck at `Resolving` and later watches skipped the beacon watch. If the first watch timed out, a later successful one never fetched or seeded the video. | Medium | **Fixed.** Watch state and helpers are recorded only after the beacon watch starts, and the full fetch starts on the first successful watch. |
| L1 | **`presence_for` minted a `Verified<Beacon>` from an unchecked `&str`, and `learn()` accepted it**, so gossip could be ranked as a relay source (E1, run). | Low | **Fixed.** `presence_for` takes `&Verified<Manifest>` and returns `Verified<Presence>`, a distinct type that only `learn_gossip` accepts. |
| L2 | **Joined once, possibly through attacker endpoints.** A relay-only first seeder left gossip dead for that video. Bootstrap after a fetch included gossip-heard (attacker) tickets, and `learn_addr` kept their IPs. | Low | **Partly fixed.** Bootstrap uses relay-heard sources only. Joining once is carried forward (already recorded). |
| L3 | **Desktop settings restart.** A pending 150 s watch held the daemon lock, freezing `nfx://` and status. `shutdown` skipped `node.shutdown()` while the node was shared, so the new node hit `DatabaseAlreadyOpen`. The old node stopped before the new settings were checked. | Low | **Fixed.** The daemon is held as `Arc` and the lock is released before awaiting a watch. `Daemon::shutdown` closes the router and the blobs store even while the node is shared. Settings are validated before the old node stops. |
| L4 | **Desktop privacy.** Every watched video is announced publicly, signed with the persistent `node.key`, with every local IP. iroh's portmapper asks the router to open ports. | Low | **Decision for sovtech** (seeding opt-in? private addresses? portmapper?). Recorded in the status file. |
| I1 | `nfx://` is a local origin with IPC in Tauri. The test-only commands `done` and `report` existed in production builds. | Info | **Fixed.** A navigation guard keeps the window on the app's own pages, and `done`/`report` refuse outside test mode. |
| I2 | `hls.min.js` was copied in without a digest check. | Info | **Fixed.** `run.sh` and `e2e.sh` check its sha256 against a pin. |
| I3 | `with_creators` validated nothing: uppercase or empty input silently blocked everyone. `NodeConfig.lookup` bypasses the filter and was written to by `learn_addr`. | Info | **Fixed.** `with_creators` returns an error for bad or empty input. The configured lookup is documented as operator-trusted, and `learn_addr` writes to a separate book. |
| I4 | `bye` was ignored. | Info | **Fixed.** A `bye` forgets that seeder's gossip-heard source. |
| I5 | The allow-list doc overclaimed against fresh-key floods, and no test covered deletions by unlisted creators. | Info | **Fixed.** The doc was corrected and the test added. |

## Checked and found sound (auditor)

- `Verified::new` is `pub(crate)` and has no `Deserialize`. Every verifier checks fully
  before wrapping.
- The allow-list checks the signer for kinds 38504 and 5, and the `a` creator for 20464.
- Deletions must be non-empty and name the author's own addresses.
- `manifests()` applies `query.admits`.
- The canon parser inherits serde_json's depth limit of 128.
- Origin paths are strict hex, and playlists follow the content-name rule, so there is no
  traversal, and verified playlists cannot reach `http://nfx.localhost`.
- The page uses `textContent` only, and remote origins get no IPC.

## Experiments (auditor, localhost only)

- **E1:** a `Verified<Beacon>` with a forged creator, for which `serves` returned true.
- **E2:** a future-dated presence with expiration 1139 s after now.
- **E3:** envelope size by renditions × direct addresses: 3×15 = 3604; 4×15 = 4214
  (rejected); 6×10 = 4074; 6×15 = 5434 (rejected).
- **E4:** a fresh-key presence whose tickets named `169.254.169.254`, `10.0.0.1:6379` and
  `127.0.0.1:22` was accepted.
- **E5:** 400/400 broadcasts delivered as a control. After one 4060-byte broadcast the
  peer received nothing, and broadcasts blocked from #129 on.
- **E6:** an IP-only connect with a lookup entry for an unlisted relay produced 8 ×
  `GET /relay` to it in 3 s.

## Coverage limits (auditor)

- H1's remote triggers and all of M3 are by reading, not run.
- M2 and M4 are by reading.
- The desktop app was not launched by the auditor.
