# Pre-push review — spec decisions after A1 (`spec/decisions-2026-09-23`, 2026-09-23)

Scope: `main..spec/decisions-2026-09-23`, 30 files:
- NFX-03/05/06/07/08/09/10/11 and the spec README;
- the beacon schema, `generate.py` and the regenerated vectors;
- `nfx-proto` (namespace, beacon, hashlist, voucher, tests);
- the S3 mesh page;
- ADR 0008 addendum, the spike pages and the status file.

Method: `differential-review` (money path treated as HIGH) and `sharp-edges`.

## Checks

| Check | Result |
|---|---|
| `crates/ci/check.sh` | all green: vectors 11/11, test 12/12 native + 12/12 wasm32, clippy, fmt, deny (new deps `sha1` 0.11, `base64` 0.23 accepted) |
| New invalid vectors | each rejected for its stated rule (`paying-without-mints`, `paying-empty-mints`, `duplicate-rendition-playlist`; `video-mismatch` unchanged) |
| Tracker infohash vs p2p-media-loader 4.0.0 `computeInfoHash` | **9/9 identical** (every swarm ID in `derived.json`) |
| S3 mesh re-run with the normative stream→rendition mapping (playlist content name) | 4/4 PASS |
| Carry rule on net-of-fee amounts (Python, 20 000 random runs incl. `below-fee` skips) | telescoping holds; seeders ≥ exact share |
| Schema vs vectors | valid pass; paying beacons without mints fail; a free beacon may omit mints |
| Added ≥64-hex strings | 32: 31 vector content + 1 `Cargo.lock` checksum; 0 unexplained |
| Secrets sweep / scope | 0 hits; only add-only paths plus ADR 0008 |

## Adversarial pass on the new payment text (NFX-08/09)

| Attack | Result |
|---|---|
| Squat a victim's root at the mint | Blocked. Escrow is keyed by `a` and needs NIP-98 by the creator in `a`. An impostor can escrow only under its own address. |
| Resell a bought key under one's own manifest | Possible, as it always was: key sharing is physics (NFX-08 §1). The impostor's listing is separate and pays the impostor, not the victim. Unchanged posture. |
| Use a leaked voucher | Blocked. The license request must be NIP-98-signed by the voucher's `seeder`. |
| Replay a captured NIP-98 header with a different body | **Found and fixed in this change:** NIP-98's `payload` tag is optional upstream, so the header was not bound to the body. NFX-09 §2 now requires `payload` on every authenticated call. |
| Pay a seeder with tokens from a self-run mint | Blocked. `accepts_mints` and `quote.mints` are required, non-empty and binding. |
| Mint learns or steals the seeder's payout | Blocked. The seeder supplies blank outputs, and signatures come back with DLEQ. The creator's accrual is still minted by the mint but P2PK-locked to `cashu_key`. |
| Redeem dust so the fee exceeds the value | Rejected (`below-fee`) before anything commits. Seeders batch. |
| `key_price` at or below the input fee | **Found and specified:** the creator accrues nothing, and creators SHOULD price above the fee. |
| Poison or hijack a web swarm via its sha1 name | No gain. The infohash only names a meeting place, and every segment is still sha256-validated. |

## Sharp edges in the `nfx-proto` API

- `Voucher::verify` now requires the presenter. There is still no public signature-only
  check, so forgetting either the manifest or the presenter binding is impossible.
- `HashList::rendition_for_playlist` is the only mapping helper, and it cannot fall back
  to bitrate or resolution.
- A paying beacon without mints fails to parse at all, rather than parsing as "any".

Verdict: **no blocker.** Push is subject to sovtech's OK.
