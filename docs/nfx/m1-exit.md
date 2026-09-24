# M1 exit run: the free end-to-end slice across two hosts (2026-09-24)

**PASS.** A creator on **laptop** published a video. **host-b** seeded it and ran the
network's services: scoped relay, origin, tracker and bridge. On laptop, the **desktop
viewer** played it over iroh, once with sharing off and once with sharing on. **A real
browser** found it by manifest address over Nostr and played it. Its origin was cut
off after 3 s, and it played on over WebRTC from host-b's bridge. M1 is "a free
end-to-end slice on testnet" (ADR 0008 §5): this run exercises all of it, built from
`main` = `f781f37`. Hosts: host-b and laptop, as for the Phase A exit run.

## Topology

| | host-b (`100.64.0.2`) | laptop (`100.64.0.1`) |
|---|---|---|
| Role | seeder, scoped relay, origin, tracker, bridge | creator, desktop viewer, browser |
| Processes | one `nfxd run --seed <a> --embed-relay :7447 --origin :3473 --embed-tracker :7448 --bridge :7449`, on host-b, as a transient `systemd-run --user` unit (`MemoryMax=1G`, `CPUQuota=200%`), with host-b's own throwaway seeder key | `nfxd publish` (throwaway creator key); the release desktop app in a private headless GNOME Shell; headless Chromium in a fresh context, with the test player served on loopback |

- The browser reached host-b's plain-`ws` tracker through a local port forward, because
  the player accepts `ws:` only on loopback.
- The WebRTC path went straight to the bridge's UDP candidate over the tailnet. The
  bridge runs ICE lite, so it only answered the browser's checks.
- **Content:** a 30 s ffmpeg test pattern, packaged on laptop into 720p and 360p
  CMAF: 36 files plus the hash list, 13 MB. Video `nfx:testnet:1:m1-exit-20260924`,
  root `1d1146b7…`.
- **Binaries:** release builds on laptop, copied to host-b with sha256 checked there.
  Nothing was built on host-b.

## Sequence and evidence

1. **Publish.** `nfxd publish` on laptop sent the signed open manifest to host-b's
   scoped relay. host-b's node went `Resolving` → `Seeding`, and never logged
   `Unannounced`.
2. **Desktop viewer, sharing off (the default).**
   - The app watched the address over host-b's relay, learned host-b from a verified
     beacon, and played both levels (360p, 720p) past 3 s over iroh.
   - It ended in `serving`: never fetched whole, never announced.
   - `RESULT PASS`.
3. **Desktop viewer, sharing on.** The same, and then it fetched the whole video and
   seeded it: `seeding`, so its beacon was accepted by host-b's relay. `RESULT PASS`.
4. **Browser.**
   - It resolved the manifest by address over host-b's relay (title "M1 exit run",
     root `1d1146b7…`), and joined the NFX-10 swarms
     `nfx/1/web/nfx:testnet:1:m1-exit-20260924/{720p,360p}` on host-b's tracker.
   - It played through a gate in front of host-b's origin.
   - **At 3.0 s the gate began refusing every segment.** Playback went on to 18.0 s
     with **2.9 MB over WebRTC from host-b's bridge**, its only peer, against 0.43 MB
     over HTTP before the cut. The gate served 2 segments.
   - 0 segments rejected, no errors: every byte, from HTTP or WebRTC, passed the WASM
     verifier.
   - `BROWSER PASS`.
5. **Cost on host-b.** The node peaked at 14.4 MB of memory and used 0.74 s of CPU.

## What this does not cover

- **NAT traversal:** the tailnet gave direct paths. Relay-only iroh was shown in the
  Phase A run; WebRTC across real home NATs, with STUN or TURN, is not exercised.
- **TLS:** the relay, origin and tracker ran plain HTTP/WS on tailnet addresses. A
  public deployment puts TLS in front, and for the tracker that proxy must set
  `X-Forwarded-For`.
- **Browser-to-browser trading:** covered by `web/player/e2e-mesh.ts` on one host
  (with a tampering peer), not across hosts here.
- **Paid delivery:** that is M2.

## Cleanup

- **host-b:** the unit is stopped, ports 7447, 7448, 7449 and 3473 are closed, and
  a scratch directory (binary, store, throwaway seeder key) is removed.
- **laptop:** the port forward is stopped. The throwaway creator key, the package and the
  app data dirs were kept in a scratch directory.
