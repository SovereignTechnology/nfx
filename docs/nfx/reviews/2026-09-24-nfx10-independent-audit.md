# Independent audit: the NFX-10 mesh branch (`6f979e8..72c877a`, 2026-09-24)

- **Auditor:** a fresh agent that did not read the author's review
  ([`2026-09-24-nfx10-m1.md`](2026-09-24-nfx10-m1.md)) until its findings were written.
- **Method:** `differential-review` and `sharp-edges`, by reading the code end to end. It
  covered the branch and the upstream code it relies on: str0m 0.23.1, `is` 0.11 (ICE),
  sctp-proto, and p2p-media-loader 4.0.0. **Nothing was run by the auditor.**

**Headline:** no High finding, and **no path by which unverified bytes reach hls.js**. The
findings are availability issues, several of them cheap to trigger. The resolutions were
added by the author, and are on `desktop/seed-opt-in` with tests.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| M1 | One peer could open data channels in a loop. Each open re-ran `store.has` for every segment on the bridge's single task, and queued an announcement that is never trimmed, so memory grew without limit. | Medium | **Fixed.** Only the first channel is bound; later opens are ignored. `loaded` is computed per swarm, not per open. Queued bytes are capped at 16 MiB per peer, and the peer is dropped over it. |
| M2 | One IP could hold all 64 bridge slots, and an opened connection never expired. | Medium | **Fixed.** Idle connections expire after 60 s without a request. At most 16 per swarm. A full pool evicts the oldest unopened connection before refusing. A per-IP quota is not possible before ICE, because browsers present mDNS names. |
| M3 | The bridge was a full ICE agent, so an offer listing internal addresses (`127.0.0.1`, `10.x`, `169.254.169.254`) made it send STUN there: about 1,000 packets per offer. | Medium | **Fixed.** The bridge runs in **ICE lite** mode: it never sends checks, it only answers them at its one host candidate. The mesh e2e passes with it. |
| M4 | The per-address cap did nothing behind the same-host TLS proxy that `--tracker-url` requires, because loopback is exempt. IPv6 was counted per address. | Medium | **Fixed.** From loopback, the tracker counts clients by the proxy's last `X-Forwarded-For` entry, and each client may hold at most 8 sockets. IPv6 is counted per /64 in every server that uses `ConnLimits` (origin, relay, tracker). The proxy must set `X-Forwarded-For`. |
| M5 | Every request re-read and re-hashed a whole segment on the single bridge task; the per-peer budget still allowed about 1,280 reads per second across 64 peers. | Medium | **Fixed.** A 64 MiB cache of verified segment bytes, shared by all peers and zero-copy into the send queue, plus a global request budget (400 burst, 200/s; over it, `Absent`). A per-peer budget remains. |
| L1 | A client that stopped reading blocked its socket loop inside `send`, so its ping and silence checks never ran. | Low | **Fixed.** Every send has a 10 s timeout, which closes the socket. |
| L2 | Refusing a `peer_id` that was "in use" locked an honest browser out for about 2 minutes after every network change. | Low | **Fixed.** The newest socket takes the id over. The node's own bridge is never displaced by a network client. |
| L3 | The bridge ignored a failed announce, and could be shut out by a full swarm or a stolen id while beacons still advertised it. | Low | **Fixed.** The announce reply is checked and retried every 10 s. The bridge bypasses the swarm-full cap, and its id cannot be taken. |
| L4 | Deleting a video never withdrew its swarms in `--pull` mode. | Low | **Fixed.** Pulled videos are checked for deletion like seeded ones, and their swarms are withdrawn. The origin still serves them; that gap predates this branch and is carried. |
| L5 | For pulled and watched videos the bridge served nothing: one missing playlist failed the whole list, and the announcement was never refreshed. | Low | **Fixed.** Renditions whose playlist is missing are skipped. Incomplete swarms are rechecked every 10 s, and their peers get a fresh announcement as segments arrive. |
| I1 | The playlist index counted every non-`#` line, where hls.js counts the URIs after `#EXTINF`; byte-range playlists would be misnumbered. | Info | **Fixed.** Only `#EXTINF` URIs are numbered, and byte-range or live playlists are not bridged. Unit test. |
| I2 | More than 255 256-blocks of held ids made the announcement unencodable, which dropped every peer. | Info | **Fixed.** Announcements are cut at 255 blocks. Unit test. |
| I3 | A panic ended the bridge silently while beacons still advertised it. | Info | **Fixed.** The `webrtc` endpoint is announced only while the bridge task runs. |
| I4 | `Tracker::forget` left the swarm in its sockets' joined sets, so it counted toward the 16-swarm limit until the socket closed. | Info | **Carried.** Harmless: it is freed when the socket closes. |
| I5 | Dropped connections never sent their close. | Info | **Fixed.** Output is drained after `disconnect()`. |
| I6 | The e2e fixture bundle landed in `out/`, which the player's dev server serves. | Info | **Fixed.** It is built to `out-e2e/` (git-ignored), and only the e2e serves it. |

## Checked and found sound (auditor)

- Relayed tracker messages are rebuilt from validated fields, so there is no injection.
  Every announce, answers and `stopped` included, is checked for admission.
- The p2pml codec has no panic paths: slicing is checked, Ints are at most 7 bytes with
  no sign bit, and reassembly is capped at 1 MiB. Framing matches the reference, and so do
  `s`/`b`, cancellation, and new-request-cancels.
- The str0m usage drains after every mutation, and a refused write is not duplicated.
  `accepts()` routing cannot be spoofed by an SDP. Only binary messages are sent.
- In the browser:
  - playlists and inits stay on the verifying loader;
  - both validators run on the fully reassembled bytes;
  - byte ranges are refused;
  - the test knobs do not touch validation;
  - tracker URLs are sanitised;
  - unmapped streams get random swarm ids.
