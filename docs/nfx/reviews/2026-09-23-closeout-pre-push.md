# Pre-push review — A0/A1 close-out (`a1/close-out`, 2026-09-23)

Scope: `main..a1/close-out`.
- The licensed-mode encryption binding: NFX-05/08/11, `generate.py`, `licensed.json`,
  and `nfx-proto`'s unique-name check and RustCrypto test.
- Spike S2 (`crates/spikes/s2-tauri`) and its report; the S4 report re-run on the
  pinned ffmpeg.
- The CI job rewritten for the shared runner.
- The status file, the repository's working notes (not published) and the ADR 0008 addendum.

Method: `differential-review` and `sharp-edges`.

## Checks

| Check | Result |
|---|---|
| `crates/ci/check.sh` | all green: vectors 12/12, test 13/13 native + 13/13 wasm32, clippy, fmt, deny |
| GitLab CI lint (`POST /projects/:id/ci/lint`) | valid, 0 errors, 0 warnings |
| libsodium vector vs RustCrypto `chacha20poly1305` | byte-identical `stored`; a wrong `aad` fails to decrypt |
| S2 after renaming its frontend dir to `ui/` | PASS via `run.sh` |
| Added ≥64-hex strings | 468: 463 lockfile checksums, 3 vector values, 2 documented pins (CI tool tarballs); 0 unexplained |
| Secrets | 0 hits. The only key material is the published throwaway `video_key` in `licensed.json`, under `secret_keys_DO_NOT_USE` like every vector key. |
| Scope | only `spec/`, `crates/`, `docs/nfx/`, ADR 0008 and the repository's working notes (not published) |

## Findings

| # | Where | Finding | Disposition |
|---|---|---|---|
| F1 | S2 frontend dir | The demo's root `.gitignore` ignores every `dist/`, which silently dropped the S2 test page from the commit. That root file is a mirrored demo path and must not be edited. | **Fixed:** frontend renamed to `ui/`. The page is tracked; the copied `hls.min.js` is ignored. |
| F2 | `crates/ci/gitlab-ci.yml` | CI turned out to run on a **shared runner**. My earlier claim that nothing would run without a registered runner was wrong. | **sovtech re-decided** (run it, kept light). The job now downloads `cargo-deny` 0.20.2 and `wasm-pack` 0.13.1 prebuilt and **sha256-checks them before install** (`sha256sum -c`, failing closed), so nothing is compiled on the runner. |
| F3 | same | `wasm-pack test` fetches its matching `wasm-bindgen` runner at run time, unpinned. | Recorded in the status file; a later pin can install `wasm-bindgen-cli` the same way. |
| F4 | same | The job does a read-only `git fetch` of the private demo repository `main`, using no credentials. | Accepted as part of sovtech's choice; documented in the job and the status file. |
| F5 | same, found by the first real pipeline | Debian bookworm's `nodejs` 18.20.4 crashes (V8 abort) running the wasm32 test binary. Every earlier step passed on the runner. Reproduced locally with official Node 18.20.4; 22.22.0 passes. | **Fixed after the push:** the CI installs official Node 22.22.0, sha256-checked against nodejs.org's `SHASUMS256.txt`. |

## Sharp edges in the encryption rule (NFX-08 §2)

- **`aad = video + "/" + name`, and names are unique** (enforced by `nfx-proto`, with
  vector `duplicate-file-name`). A player must decrypt with the `aad` of the entry it is
  playing. Deriving it from anything else, such as the URL, would re-open the swap the
  rule closes.
- **Random 24-byte nonces per file** are safe with XChaCha20 at any realistic file
  count per key. The key is per video.
- The construction is the IETF AEAD (ciphertext ‖ 16-byte tag), prefixed by the nonce.
  Both reference libraries agree on it byte for byte.

## Spike S2 code

- The `nfx://` handler serves only paths under the verified root. Names resolve through
  the hash list to validated sha256 values, so no user-controlled path reaches the
  filesystem. Every file's bytes are sha256-checked before they are served.
- `csp: null` and a stdout-writing `report` command are acceptable in a spike and must
  not be copied into the product shell.

Verdict: **no blocker.** Push is subject to sovtech's OK.
