# nfx status — the resume point for this repository

**This file, not the demo's `docs/status.md` or the session handoffs (not published), is where work here
resumes.** Those describe the Pear demo, a read-only mirror in this repository.

Updated 2026-09-23 · branch `main` · plan: ADR 0008 + `spec/` · A0 + A1 closed · A2 in progress

## Where things stand

**Phases A0 and A1 are complete. A2, the Rust M1 data plane, is in progress**
(ADR 0008 §5): every A2 piece is built and tested on this machine: `nfx-media`, `nfx-node`
(iroh, Nostr, the pull-through origin, the scoped relay), `nfxd` and the test player.
Still to come is the Phase A exit run across hosts, which needs sovtech's OK.

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
   - ~~`nfxd`~~ done (gossip is not wired into it yet: Nostr beacons carry discovery);
   - ~~a scoped relay~~ done (`nfx-node::relay`, for `nfxd` to embed or run alone);
   - ~~a test player page~~ done (`web/player/`);
   - **the Phase A exit run: multi-host** (seeder, fetcher and origin on different
     machines over a real iroh relay). It needs sovtech's OK for which hosts.
2. ~~**`nfx-proto` WASM bindings**~~ done (`crates/nfx-wasm`; the test player uses
   them). Still open: resolving a manifest by `a` tag over Nostr in the browser.
3. Carried risk: the iroh-blobs 0.103 README still says "not production quality". The
   containment plan is in the S1 page.
4. Optional: add the schema check (`jsonschema`) to `check.sh`.

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
