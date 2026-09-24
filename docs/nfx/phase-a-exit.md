# Phase A exit run: two hosts, a real iroh relay, a real browser (2026-09-24)

**PASS.** A video seeded on **host-b** was discovered, fetched and verified on **laptop**, served by laptop's origin, and played in a real browser. It worked through
a real iroh relay with direct transport ruled out, and again over a direct path with no
relay configured. Hosts chosen by sovtech.

## Topology

| | host-b (`100.64.0.2`) | laptop (`100.64.0.1`) |
|---|---|---|
| Role | seeder, scoped relay, iroh relay | creator, fetcher, origin, player |
| Processes | `iroh-relay` 1.2.0 (stock binary, HTTP, `http_bind_addr = 100.64.0.2:3340`, QUIC discovery and metrics off); `nfxd run --seed <a> --embed-relay 100.64.0.2:7447 --iroh-relay http://100.64.0.2:3340` | `nfxd publish` (creator key); `nfxd run --fetch <a> --relay ws://100.64.0.2:7447 --iroh-relay http://100.64.0.2:3340 --relay-only --origin 100.64.0.1:3472`; the test player page on `:3471` |
| How run | transient `systemd-run --user` units with `MemoryMax`; nothing was built there and every process was stopped by name | the same |


- **Content:** a 20 s ffmpeg test pattern, packaged by `nfx-package` on laptop into
  720p and 360p CMAF renditions. That is 26 files plus the hash list, 6.4 MB, video
  `nfx:testnet:1:exit-run-20260924`, root `74b22012…`.
- **Binaries:** release builds from `main` plus the `--relay-only` flag, copied to host-b
  with sha256 checked on both ends.

## Sequence and evidence

1. **The scoped relay answered across the tailnet.** host-b's NIP-11 document
   (`nfx.networks = ["nfx:testnet:1"]`, kinds 38504/20464), and the iroh relay with
   HTTP 200.
2. **Publish:** `nfxd publish` on laptop sent the signed open manifest to host-b's relay.
   The seeder went `Resolving` → `Seeding` and announced.
3. **Relay-only fetch:**
   - laptop's fetcher learned the seeder from a verified beacon and went
     `Resolving` → `Fetching` → `Seeding`.
   - It had no IP transport at all (`--relay-only`), so every byte crossed host-b's
     iroh relay. During the run the relay held connections from both nodes.
   - Result: 27/27 files, every sha256 equal to its name, and the store byte-identical
     to the source.
4. **Browser:**
   - headless Chromium, fresh context, loaded the player page from
     `http://100.64.0.1:3471` (an insecure context, so no WebCrypto and the WASM
     verifier did the checking);
   - it played from laptop's origin, with the hash list bound to the manifest's
     `video` and `segs`;
   - result: both levels (360p, 720p), playback past 8 s, 13 files verified, 0
     rejected, no errors.
5. **Direct fetch:** a second fetcher on laptop with no iroh relay configured, so
   direct over the tailnet or nothing. It reached `Seeding` with 27/27 files,
   byte-identical.
6. **Beacons:** both fetchers ended in `Seeding`, not `Unannounced`, so host-b's scoped
   relay accepted their beacons: three seeders, one video.

## What this does not cover

- **NAT traversal and hole punching.** The tailnet gave the two hosts a direct path.
  The relay-only run covers the case where no direct path exists; hole punching
  between two real NATs is unexercised.
- **TLS.** The iroh relay and scoped relay ran plain HTTP/WS on tailnet addresses. A
  public deployment puts TLS in front, as the origin and relay docs say.
- **A CDN in front of the origin, and HTTPS endpoints in beacons.** The browser read
  laptop's origin directly.
- **Paid delivery.** That is M2.

## Cleanup

- **host-b:** both units were stopped, ports 3340 and 7447 closed, and a scratch directory
  removed (it held the throwaway seeder key, the binaries and the test clip).
- **laptop:** the direct fetcher was stopped. The origin and the page server were left running. The throwaway keys were kept in a scratch directory.
