# nfx status — the resume point for this repository

**This file, not the demo's `docs/status.md` or the session handoffs (not published), is where work here
resumes.** Those describe the Pear demo, a read-only mirror in this repository.

Updated 2026-09-24 · `main` = `f781f37` · plan: ADR 0008 + `spec/` · Phase A and M1 complete · NFX-02..06 Frozen (M1)

## Where things stand

**Phases A0, A1 and A2 are complete** (ADR 0008 §5). Every A2 piece, the Rust M1 data
plane, is built and tested: `nfx-media`, `nfx-node` (iroh, Nostr,
the pull-through origin, the scoped relay), `nfxd` and the test player. **The Phase A exit
run passed on 2026-09-24** between host-b and laptop, over a real iroh relay and over a
direct path, played in a real browser ([`phase-a-exit.md`](phase-a-exit.md)).
**Phase A is complete.**

- **`nfx-media` (A2, 2026-09-23):**
  - the demo's L8 planning (probe, ladder, argv, storyboard) ported to Rust, with
    L8's own unit expectations ported alongside (20 cases);
  - an ISO-BMFF reader that takes CODECS from `avcC`/`esds` (5 cases, including every
    truncation of a valid init);
  - a packager and the `nfx-package` CLI: CMAF tail, content addressing, and a
    self-check with `nfx-proto` before returning. The input is pinned to ffmpeg's
    `file:` protocol, and segment names from ffmpeg's playlist are validated.
  - Its output verifies with `nfx-verify-store` and plays, seeks and switches in
    Chromium, Firefox and WebKit. The real-ffmpeg test passes on both the system
    ffmpeg 6.1.1 and the pinned n8.1.2.
  - Finding: x264's fastest presets signal Constrained Baseline even when High is
    requested. NFX-05 §1 now says "High or a subset", with CODECS read from the stream.
- **`nfx-node` layer 1 (A2, 2026-09-23):**
  - a swappable `ContentStore` (NFX `FsStore`, sha256-named, verified on every read and
    write);
  - `Node`: an iroh endpoint with iroh-blobs as transport only. Store files are
    imported by reference, and per-rendition collections take their membership from
    each rendition's playlist.
  - `fetch` re-anchors every member to sha256 by position; a lying peer is
    `NodeError::Poisoned` and nothing it sent is stored;
  - signed gossip presence (`nfx/gossip/1`).
  - Integration test (3/3 runs, ~7 s): a self-hosted relay and a relay-only fetcher.
    The lying seeder is caught at `720p member 2`, and the gossip envelope carrying real
    tickets verifies.
  - Spec: NFX-06 §2's `meta` collection now also carries thumb and subtitle files,
    which otherwise rode no iroh collection.
  - `cargo deny` with iroh's tree: CDLA-Permissive-2.0 and Unlicense are allowed; MPL-2.0
    is excepted for `attohttpc` only; two "unmaintained" proc-macro notices
    (`paste`, `proc-macro-error`) are ignored by ID with reasons.
- **`nfx-node` layer 2, manifests and beacons over Nostr (A2, 2026-09-23):**
  - `nfx-proto` gained the publisher side: `Manifest::tags()` and `beacon::tags()`.
    Both reproduce the vectors' tags exactly, so a vector re-signs byte for byte.
  - `nfx-node::nostr` on nostr-sdk 0.45:
    - signing goes through any nostr-sdk async signer (a local key now, NIP-46 later),
      and every event is parsed back through `nfx-proto` before it is sent;
    - `Relays::manifests` returns the current revision per address (NIP-01), dropping
      whatever fails NFX-02 or falls outside the query, whichever relay sent it;
    - `watch_beacons` keeps a live table: newest per (seeder, manifest), expired
      entries pruned, capped at 4096 with the soonest-to-expire evicted;
    - `announce` publishes with TTL 120.
  - Integration test against nostr-sdk's in-process relay (4/4 runs, ~0.5 s): a
    revision replaces its predecessor, a creator-signed manifest with no `root` is
    dropped, an older beacon is skipped, and a newer one is delivered.
  - `cargo deny`: CC0-1.0 is allowed (rust-bitcoin via nostr, and CDK later).
- **`nfx-node` layer 3, the NFX-05 §6 origin (A2, 2026-09-23):**
  - `Origin` serves the §6 routes over the content store on hyper (HTTP/1.1; TLS
    belongs to the CDN or proxy in front):
    - hits carry `immutable`, and every error carries `no-store`;
    - every response carries CORS `*`, `nosniff`, and a sandboxing CSP;
    - thumb MIME types come from an allow-list, so a creator cannot make the origin
      serve HTML.
  - It serves only files listed in hash lists it verified against a manifest's `root`
    (not an open proxy), and every body is re-verified on read.
  - Pull-through (§6.2):
    - `SwarmPull` fetches misses over iroh from tickets in verified beacons, which
      lapse when their beacon expires;
    - a seeder caught lying is forgotten;
    - concurrent misses on one video share one pull;
    - a failed pull is a generic 502 `no-store`.
  - Tests (3/3 runs, ~7 s):
    - routes, headers and refusals, including a store file that rotted on disk
      (500, never served) and a `text/html` thumb (served as octet-stream);
    - pull-through over a relay-only node: the lying seeder is tried first, caught
      and forgotten, and four concurrent misses are served verified bytes over real
      HTTP.
- **`nfx-node` layer 4, the NFX-04 scoped relay (A2, 2026-09-23):**
  - `ScopedRelay` is nostr-sdk's relay behind hyper:
    - WebSocket upgrades go to the relay, and `Accept: application/nostr+json` gets the
      §3 NIP-11 document (`nfx.networks`, kinds, roles; NIPs 1, 11 and 40).
    - §1 admission runs full `nfx-proto` verification. Anything else is `blocked: out of
      scope`, including a foreign `n`.
    - §2 limits: one beacon per (pubkey, `a`) per 20 s; 12 manifests per pubkey per
      hour; 20 subscriptions per connection; 256 values per filter tag list; 64 KiB
      and 16 KiB size caps.
    - Beacons are forwarded, never stored; stored events are capped at 20,000.
  - The test checks each refusal's reason prefix, not just that it failed.
- **`nfxd`, the headless node (A2, 2026-09-23):**
  - `nfxd key new|show` writes a 0600 key file (never overwrites; refuses a key readable
    by group or others) and prints only public keys.
  - `nfxd publish` turns an `nfx-package` output into an open, free manifest: duration
    summed from the playlist, and the thumb with its MIME.
  - `nfxd run`:
    - `--seed`, `--fetch` and `--pull` take manifest `a` tags;
    - `--origin` serves the pull-through origin, with `--https-url` announcing it as an
      `https` endpoint;
    - `--embed-relay` runs the scoped relay, which the host uses through the same door.
  - A fetched video is seeded afterwards, since a free M1 peer gives back what it
    watched.
  - End-to-end test (3/3 runs, ~9 s): a fetcher with an origin and an embedded relay,
    and a seeder that knows only that relay. The fetcher learns the seeder from a
    verified beacon, fetches over iroh, serves the video over HTTP and becomes a
    second seeder.
- **The test player, `web/player/` (A2, 2026-09-23):**
  - hls.js behind a loader wrapper that fetches every playlist, init and segment as
    bytes and checks its sha256 (WebCrypto) before hls.js sees it:
    - the hash list must hash to `root`;
    - every URL must be a content name listed there, or the master convenience URL;
    - there is no `onProgress`, so no partial unverified data reaches hls.js;
    - a mismatch is a load error, never data.
  - Verification is `nfx-proto` itself, compiled to WASM (`crates/nfx-wasm`), so it needs
    no WebCrypto and works from an insecure context. With `&video=<d>&segs=<n>` the hash
    list is also bound to the manifest.
  - `npm run e2e` (PASS on every run, loopback only):
    - an ffmpeg clip goes through `nfx-package`, then `nfxd key new`, `nfxd run` (seed,
      embedded relay, origin) and `nfxd publish`;
    - headless Chromium in a fresh context plays it: 360p and 720p levels, 7 files
      verified, 0 rejected, 2 s played;
    - from an insecure context (`http://player.test`, mapped to loopback; no
      `crypto.subtle`), it plays with 7 files verified by WASM;
    - against a lying proxy that flips a byte in every segment, the player rejects
      them and never plays.
- **Pre-push audit of all A2 work (2026-09-23), in
  [`reviews/2026-09-23-a2-pre-push.md`](reviews/2026-09-23-a2-pre-push.md):**
  - Method: `differential-review`, with an independent adversarial reviewer, plus
    `sharp-edges`.
  - 3 HIGH, 4 MEDIUM and 5 LOW findings, 3 plausible ones and 3 sharp edges, all fixed
    with tests:
    - fetching is bounded by the hash list;
    - stalling seeders go on cooldown;
    - the origin and relay cap connections;
    - the relay refuses far-future events;
    - the origin refuses query strings;
    - ffmpeg inputs are limited to local files and known video demuxers;
    - every playlist `URI` attribute is checked.
  - Spec amendments: NFX-02 §4, NFX-04 §2, NFX-05 §3 and NFX-06 §2, and one new vector
    (`duplicate-uri-attribute`).
- **CI after A2 (2026-09-23):** the first pipeline to build iroh and nostr-sdk
  on the shared runner, stalled for 30 min linking ~15 debug test binaries of ~450 MB each,
  so it was cancelled. CI now builds without debug info and with 2 jobs (sovtech's
  choice), about 94 MB per binary, and still runs every test.
- **The desktop viewer, `crates/desktop` (M1, 2026-09-24):**
  - A Tauri 2 window around `nfxd`'s `Daemon`, which gained an internal origin with no
    listener and a runtime `watch`.
  - `watch` works like a viewer: it resolves the manifest, learns seeders from verified
    beacons and holds the video on the origin.
  - The page plays through `nfx://` while misses are pulled over iroh and re-hashed; the
    app then fetches the whole video and seeds it.
  - The key is created at first run (mode 0600, never printed). The CSP allows only the
    app's own scripts.
  - Its own Cargo workspace (like spike S2), outside CI: clippy is clean, and
    `cargo deny` passes with a desktop policy (MPL-2.0 per crate for Servo's CSS
    parsers, `unic-*` unmaintained notices ignored by ID).
  - `./e2e.sh` (PASS) runs in a private headless GNOME Shell:
    - it packages a clip and starts an `nfxd` seeder with an embedded relay;
    - the app watches before the manifest exists;
    - once the manifest is published, the app plays 360p and 720p past 3 s and ends up
      seeding the video.
- **M1 hardening (2026-09-24,
  [`reviews/2026-09-24-hardening.md`](reviews/2026-09-24-hardening.md)):**
  - **Independent audit, then fixes (2026-09-24,
    [`reviews/2026-09-24-independent-audit.md`](reviews/2026-09-24-independent-audit.md)).**
    A fresh agent found 1 High, 4 Medium and 4 Low findings in the desktop and hardening
    commits. All are fixed except L4 below; the fixes and their tests are in the audit
    record. **Gossip is now opt-in (`--gossip`)**, because iroh-gossip lets any swarm
    member steer the endpoint (a blind SSRF).
    - **L4 (desktop privacy), decided by sovtech: seeding is opt-in.** The desktop app
      has a "Share videos I watch" setting, off by default. Without it, a watched video
      is only served to the window and never announced, and the portmapper is off
      (`Config::seed_watched`, `Config::no_portmapper`). The desktop e2e runs both
      ways.
  - **Gossip in `nfxd` (NFX-06 §4), opt-in.** With `--gossip`, every seeded or watched
    video joins its swarm.
    Seeders announce a signed `here` every 60 s and a `bye` on deletion, and every node
    learns seeders from verified `here`s.
    - Bootstrap uses full endpoint addresses, from relay-heard beacon tickets and
      `--gossip-peer ID@ADDR` (printed by `nfxd run --gossip`), filtered like
      `Node::dial`.
    - **A relay-only node never gossips.** iroh-gossip feeds members' advertised
      addresses to the endpoint unfiltered, and iroh dials any relay URL, so a member
      could otherwise learn the node's IP.
    - Gossip-heard sources rank below relay beacons: evicted first, never displacing
      one. A swarm member can announce under unlimited fresh keys.
    - Test: a viewer learns a seeder that speaks only to a relay the viewer never
      sees.
  - **Creator allow-list** for scoped relays (`--allow-creator`, needs
    `--embed-relay`). Only the listed creators' manifests and deletions, and beacons
    for their videos, are admitted.
  - **`Verified<T>`** (closes S4 of the A2 audit). Every `nfx-proto` verifier returns
    it, and `Origin::hold` and `SwarmPull::learn` require it. The tests now sign real
    events.
  - **NIP-42 is blocked** on nostr-sdk. Its `LocalRelay` matches AUTH against
    `ws://<bind address>`, which never matches behind our front or a TLS proxy. It
    stays a conformant SHOULD omission; the allow-list covers the practical need.
- **The browser resolves videos by manifest address (2026-09-24):**
  - `?a=<address>&relay=<ws(s)>` makes the player query the relays for the manifest
    (NFX-04 §5 filter).
  - The current revision is picked by nfx-proto in WASM, with the NFX-02 §4 rules and
    the 15-minute future horizon; it supplies `root`, `video` and `segs`.
  - Beacons for that address are then watched (NFX-03 §5). Each verified `https`
    endpoint is an origin candidate, with an optional `&origin=` hint.
  - Origins are hints only: every byte is still checked against the signed anchor.
  - Beacon-named origins are reduced to `https://host[/prefix]` (no query, fragment or
    credentials) and capped at 8, so a hostile beacon cannot steer viewers' requests
    to arbitrary URLs.
  - `nfx-wasm` gained `parseATag` and the manifest `id`. Its master-playlist check now
    also accepts an origin under a path prefix, like NFX-03's
    `https://seed.example/nfx`, which previously failed every check.
  - The player e2e adds three runs, all PASS:
    - by address with an origin hint;
    - by address alone, with the origin found through a verified beacon's `https`
      endpoint (a self-signed TLS proxy in front of nfxd, `--https-url`);
    - an address nobody published, which fails with "no valid manifest".
  - `npm run unit` checks the origin sanitiser (8 cases).
- **`nfx-wasm`, `nfx-proto` for browsers (2026-09-23):**
  - It exports `verifyManifest`, `verifyBeacon`, `sha256Hex` and `VerifiedHashList`
    (constructed from a manifest's `video` and `segs`, or `fromRoot`, with `check` and
    `expected` per request path, and the playlist content-name rule).
  - JS numbers must be safe integers, and structured results are JSON.
  - The logic is tested natively. The bindings run under Node in `check.sh`
    (`wasm-pack test --node nfx-wasm`), so CI covers them.
  - `npm run typecheck` is strict and clean. Neither runs in CI: they need Chromium,
    ffmpeg and a cargo build.

- **Repository:** the private GitLab project. Every push
  was a fast-forward of `main` with sovtech's OK. The demo history, the spec commit
  `8f3b9bd` and a merge of demo `main` `0e35347` are all in `main`.
- **ADR numbering** is coordinated with the demo session. 0006 and 0008 are this
  repository's; the demo recorded both in its own `docs/status.md` and uses 0009 onward.
- **A1 spikes: all four PASS.** One page each in [`spikes/`](spikes/):
  - **S1 iroh:** 7/7 on 4 runs, including a relay-down control.
  - **S2 Tauri:** plays, seeks and switches renditions over `nfx://` on WebKitGTK,
    3/3 runs. Linux needs gst-libav (or plugins-bad's `openh264dec`) for H.264.
  - **S3 web mesh:** 4/4 on 3 runs. P2P bytes flow through our own tracker, and a
    tampered segment is rejected.
  - **S4 CMAF:** the demo's L8 ladder works with only the container tail swapped. It
    plays in Chromium, Firefox and WebKit, and it was re-run on the demo's pinned
    ffmpeg n8.1.2.
- **Spec decisions:** sovtech accepted every recommendation after A1: 2a/2b and
  3.1–3.5, then the encryption binding. They are recorded in the ADR 0008 addendum.
  **No open spec issues remain.**
- **Housekeeping (2026-09-23):**
  - the S4 preview server is stopped;
  - the merged branches `a0/setup`, `a1/s1-iroh` and `spec/decisions-2026-09-23` are
    deleted;
  - GitLab CI is enabled with config path `crates/ci/gitlab-ci.yml`. It runs on the
    instance's shared runner, with prebuilt, sha256-pinned `cargo-deny`
    and `wasm-pack` so nothing is compiled on the runner (sovtech's choice).

## Done in A0

1. **Repository.** a local clone was cloned with `--no-local` from
   `spec/nfx-suite-m0`. Remotes: `origin` = the private GitLab project; `demo` = the private demo repository,
   fetch-only, tracking `main` only. Demo `main` is merged, so the
   mirror is current as of `0e35347`.
2. **The repository's working notes (not published)** and this file. Both state the read-only mirror rule and that
   the demo handoff is not the resume point.
3. **CI.**
   - `crates/ci/check.sh` runs every check: vectors, add-only, fmt, clippy
     `-D warnings`, test, deny, and wasm.
   - `crates/ci/gitlab-ci.yml` is dormant; see "Not verified".
4. **ADR 0008** (`docs/decisions/0008-multi-network-master-plan.md`).
   - ADR 0006 is amended: the demo is described in the present tense, plus a token note.
5. **Spec amendments 1–9** from the plan, plus the implementation-driven fixes listed
   in ADR 0008 §6. Highlights:
   - the wire token is `nfx` and NFX-01 is re-frozen at M0;
   - licensed chunk proofs are P2PK-locked to the mint's `redeem_pubkey`;
   - a mint-side **carry** closes a second split bypass (per-proof redemption zeroed
     the creator; see the carry rule in NFX-09 §2);
   - `key_price` accrues to `cashu_key`;
   - NFX-10 gets the paid-mesh text, and NFX-12 is new;
   - NFX-05 §6 adds caching, the pull-through origin and the new
     `/<root>/<sha256>.<ext>` path;
   - NFX-04 §7 allows an embedded relay;
   - NFX-11 pins iroh 1.x and adds `canon` §9.
6. **Test vectors.** 11 files, all regenerated by `generate.py`:
   - valid: manifest, open manifest, beacon (all 4 endpoint types), hash list;
   - invalid corpora: 33 manifests, 11 beacons, 9 hash lists, 2 playlists;
   - canon: 14 cases;
   - voucher, gossip envelope, derived identifiers.
7. **`nfx-proto`** (`crates/nfx-proto`).
   - Covers namespaces, the `n` tag, kind-38504 parse/verify, beacons, hash lists and
     playlists, canon JSON, vouchers, gossip envelopes, and the topics and infohash.
   - It reproduces every signed vector **byte for byte**: event ids and signatures,
     beacon content, hash-list bytes to root, canon texts, digests and signatures.
     Every invalid case is rejected for its stated reason.
   - 12 test groups pass **natively and on `wasm32`** under Node (`wasm-pack test --node`).

## Verification (2026-09-23, on laptop)

| Check | Result |
|---|---|
| `generate.py --verify` | 11/11 OK |
| `cargo test --workspace` | 12/12 |
| `wasm-pack test --node nfx-proto` | 12/12 |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean |
| `cargo deny check` | advisories, bans, licenses, sources ok |
| `git diff demo/main...HEAD -- packages docs/plan docs/lanes docs/handoff docs/status.md scripts` | empty |
| JSON schemas vs vectors (jsonschema, one-off) | valid vectors pass; the schema-level invalid cases fail |
| carry rule (Python property test, 20 000 random runs, one-off) | creator gets exactly `floor(T·c/10000)`; seeders ≥ exact share |

## Next

1. **A2 — the Rust M1 data plane**, per ADR 0008 §5:
   - ~~`nfx-media`~~ done;
   - `nfx-node`: ~~store trait, iroh seed/fetch, gossip, Nostr manifests and
     beacons, the pull-through origin~~ done; the per-member window gate comes with
     M2;
   - ~~`nfxd`~~ done, with gossip since 2026-09-24;
   - ~~a scoped relay~~ done (`nfx-node::relay`, for `nfxd` to embed or run alone);
   - ~~a test player page~~ done (`web/player/`);
   - ~~the desktop viewer~~ done (`crates/desktop/`, Tauri 2, `./e2e.sh`);
   - ~~**the Phase A exit run: multi-host**~~ PASS 2026-09-24, host-b ↔ laptop
     ([`phase-a-exit.md`](phase-a-exit.md)).
2. ~~**`nfx-proto` WASM bindings**~~ done (`crates/nfx-wasm`; the test player uses
   them). ~~Resolving a manifest by `a` tag over Nostr in the browser~~ done
   (2026-09-24): see below.
3. ~~**M1 spec freeze**~~ **done 2026-09-24:** NFX-02 to 06 are Frozen (M1)
   ([`freeze-m1-candidate.md`](freeze-m1-candidate.md)). A behaviour change now needs a
   `specver` bump.
   - Real iroh tickets are pinned byte for byte, schemas are checked in CI, and the gossip
     size limit is enforced.
   - Deletion is decided (targeted NIP-09 deletions admitted) and implemented end to end.
   - Freezing is sovtech's call.
4. Carried risk: the iroh-blobs 0.103 README still says "not production quality". The
   containment plan is in the S1 page.
5. ~~Add the schema check (`jsonschema`) to `check.sh`~~ done (`spec/schemas/check.py`).
6. ~~M1 hardening carry-forwards~~ done 2026-09-24: gossip in `nfxd`, the creator
   allow-list and `Verified<T>`. NIP-42 is blocked upstream (see above).
7. ~~The WebRTC browser mesh (NFX-10)~~ **built 2026-09-24**
   ([`nfx-10-m1-plan.md`](nfx-10-m1-plan.md)).
   - The independent audit found no High issue and no unverified-bytes path. Its 5
     Medium and 5 Low findings are fixed
     ([`reviews/2026-09-24-nfx10-independent-audit.md`](reviews/2026-09-24-nfx10-independent-audit.md)).
   - sovtech approved the push.
   - A tracker behind a same-host TLS proxy needs that proxy to set
     `X-Forwarded-For`.
   - The player joins with `&tracker=`, and every segment from a peer or HTTP is
     verified by WASM.
   - `nfxd --embed-tracker` admits only the swarms of videos it holds.
   - `nfxd --bridge` is a Rust WebRTC peer (str0m) that serves browsers from the
     verified store.
   - `e2e-mesh.ts` passes 3/3. NFX-10 stays Draft (freeze at M4).

8. ~~**The M1 exit run**~~ **PASS 2026-09-24**, host-b ↔ laptop
   ([`m1-exit.md`](m1-exit.md)).
   - A creator published, and host-b seeded with its relay, origin, tracker and bridge.
   - The desktop app played over iroh with sharing off (served only) and on (seeded).
   - A browser resolved the video by address and played on over WebRTC from host-b's
     bridge after its origin was cut.
   - **M1, the free end-to-end slice, is complete.**
9. **Next: M2, paid delivery (open mode) on every transport** (ADR 0008 §5). This is
   money code: `nfx-wallet`, pay/1 (NFX-07), the mint extension (NFX-09) and the web
   wallet. It gets the locked-directory rule and its own security stage (ADR 0008 §4).
   Plan and decisions: [`m2-plan.md`](m2-plan.md). sovtech chose the demo's staging, and a
   persistent testnet mint.
   - **M2.0 is built and reworked seven times** on branch `m2/contracts`, not yet
     pushed. It holds the pay/1 wire and vectors, the session contracts, the mock, and
     the adversary suite. Seven independent audits found 19, 30, 28, 20, 19, 22 and 23 gaps;
     the resolutions are recorded in each audit's file, and the next audit checks them
     ([first](reviews/2026-09-24-m2.0-independent-audit.md),
     [second](reviews/2026-09-24-m2.0-second-audit.md),
     [third](reviews/2026-09-24-m2.0-third-audit.md),
     [fourth](reviews/2026-09-24-m2.0-fourth-audit.md),
     [fifth](reviews/2026-09-24-m2.0-fifth-audit.md),
     [sixth](reviews/2026-09-24-m2.0-sixth-audit.md),
     [seventh](reviews/2026-09-24-m2.0-seventh-audit.md)). **sovtech's bar for the push
     is zero findings** (re-confirmed after the sixth). The lock's guarantee is now
     stated in `crates/ci/check-locked.sh`: the money crates' files and build inputs, and
     every target of theirs, failing closed; other crates are out of scope. With sovtech's OK, the minimum role for GitLab pipeline variables on
     the private GitLab project is *no one* since 2026-09-24 (fifth audit, #13).
     - A refused watcher pays ahead, so free identities cannot lock out paying ones.
     - A lying seeder gets at most one payment.
     - An unsettled payment survives a dropped connection.
     - **NFX-07 changed shape.**
       - The seeder swaps before it acks.
       - Bounds and bans are seeder-wide, and the global cap is a rate (`debt_ttl`).
       - `quote` carries the account's position, so a watcher can resume.
       - HTTPS origins take one payment per request.
     - The suite has 62 scenarios and catches each of 174 planted defects.
     - The lock pins all of nfx-pay and what builds it, and refuses build-environment
       tricks. After the build it verifies what every target of nfx-pay and nfx-proto
       compiled (failing closed on a target without dep-info), and that the money tests
       all ran. Code in other crates is out of its scope, as the check itself states.
   - **Next:**
     - an eighth independent audit, until one reports nothing;
     - sovtech's OK to push M2.0;
     - sovtech's go-ahead for the testnet mint, whose deployment is proposed in
       [`m2-plan.md`](m2-plan.md);
     - then M2.1, the serial security session.

## Not verified / known gaps

- **GitLab CI's first real run failed only its last step.** Vectors,
  add-only, fmt, clippy, test and deny all passed on the shared runner. The WASM tests
  crashed Node: Debian bookworm's `nodejs` 18.20.4 aborts in V8 on the wasm32 test
  binary. This was reproduced locally with official Node 18.20.4, while 22.22.0 passes.
  The fix pins the official Node 22.22.0 build (sha256 from nodejs.org `SHASUMS256.txt`).
  **Pipeline then passed every step in 95 s.** CI is green on the shared runner.
  The job also does a read-only fetch of the private demo repository `main` for the
  add-only check. `wasm-pack test` downloads its matching `wasm-bindgen` runner at run
  time, unpinned.
- **Not tested on this host:** mpv (not installed), Safari (needs macOS/iOS; WebKit
  passed as the closest proxy), macOS WKWebView and Windows WebView2 (S2 covered
  Linux only).
- **The canon rule was cross-checked Python ↔ Rust only.** The JavaScript note (sort by
  code point, not UTF-16) is untested until the web client exists. The WASM build is
  the intended single implementation for browsers.
- **iroh tickets in `beacon.json` are placeholders.** Ticket encodings pin at the M1
  freeze (S1).
- **NFX-12's Hypercore stack pin** (hypercore 11, hyperdrive 13, hyperswarm 4,
  protomux 3) comes from the demo seeder's `package.json`, plus hyperdrive 13 inferred
  as the matching series. It is unverified until spike S5.
- **p2p-media-loader v4 fork points** (NFX-10 §3.2) are mapped from the 4.0.0 source
  (S3) but not yet built.
- **k256's deterministic signing** (`PrehashSigner`, zero `aux_rand`) is used for
  vectors and tests. User keys belong in a proper signer (nostr-sdk / NIP-46) in
  `nfx-node`.
