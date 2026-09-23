# Pre-push review — first push of the private GitLab project (2026-09-23)

Scope: everything `main` carries that the private demo repository does not. That is commit `8f3b9bd`
(NFX suite + ADR 0006: 20 files, +1717, docs/JSON/one Python script) plus the clean
merge `468fe1e` of demo `main` (`0e35347`, already in the demo repository).

Method: `differential-review` (triage + secrets + script surface), then `sharp-edges`
over the spec's wire formats and money path. Codebase class: SMALL (20 files), no
executable code except `spec/test-vectors/generate.py`.

## Differential review

| Check | Result |
|---|---|
| Merge is not an evil merge | `patch-id(8f3b9bd) == patch-id(diff demo/main..HEAD)` — MATCH |
| Mirrored demo paths untouched | `git diff demo/main -- packages docs/plan docs/lanes docs/handoff docs/status.md scripts` empty |
| Hex strings in the diff | 19 distinct ≥64-hex strings; **19/19** are vector fields (hashes, pubkeys, ids, sigs, published throwaway secrets); 0 unexplained |
| Published vector secrets | each equals `sha256("nfx-test-vector/<role>")` for creator/seeder/cashu — throwaway by construction, as NFX-11 §7 says |
| Credentials / internal hosts | no `nsec1`, `cashuA/B` tokens, private-key PEM, tailnet/LAN addresses, passwords or API keys |
| `generate.py` surface | no subprocess/network/eval; writes exactly three fixed filenames next to itself |

Verdict: **no blocker for pushing.** Risk class LOW (documentation + deterministic
vector generator).

## Sharp edges in the spec as frozen at `8f3b9bd`

These are design footguns an implementer would fall into. None is a vulnerability
in pushed code (nothing implements NFX yet); they feed the A0 amendments.

| # | Sev | Where | Sharp edge | Disposition |
|---|---|---|---|---|
| SE1 | Critical | NFX-08 §4, NFX-09 §2 | Licensed chunk proofs are plain bearer tokens of the escrow mint; a seeder does an ordinary NUT-03 swap, skips `/v1/nfx/redeem`, keeps 100%. | **Amendment 3** (P2PK-lock to mint `redeem_pubkey`) |
| SE2 | High | NFX-09 §2 | `seeder = ceil(amount × bps / 10000)` per redeem call. A seeder redeeming 1-sat proofs one call at a time gets `ceil(bps/10000) = 1` every time → creator share 0 at **any** split < 10000. Same defect the demo found (its ADR 0005 erratum / ADR 0007). | **Amendment 3b** (mint-side carry per `(root, seeder)`) |
| SE3 | High | NFX-08 §3, NFX-09 §2 | Escrow/license/redeem are keyed by bare `root`. Roots are public; anyone can publish their own manifest naming a victim's root + the same mint and escrow first (squat → victim's escrow `409`), and redeem's "manifest's `split`/`cashu_key`" is ambiguous when two manifests name one root. | Proposed amendment P1 — key mint state by manifest address `38504:<pubkey>:<d>` (or `(author, root)`). **Not applied; needs sovtech.** |
| SE4 | Medium | NFX-08 §5, NFX-09 §2 | The voucher path of `license` is unauthenticated: the `seeder` field is not bound to the presenter, so a leaked voucher is a bearer credential for the key. | Proposed amendment P2 — require NIP-98 by the voucher's `seeder` key. **Not applied.** |
| SE5 | Medium | NFX-03 §4, NFX-07 §3 | `accepts_mints` empty/absent = "any": a seeder that takes it literally swaps at a watcher-chosen URL (attacker mint → worthless ecash; outbound request to attacker host). | Proposed amendment P3 — absent means "see `quote.mints`", and `quote.mints` MUST be non-empty. **Not applied.** |
| SE6 | Medium | NFX-06 §4, NFX-08 §5 | `canon` under-specified for strings and numbers: Python's default `ensure_ascii=True`, JS UTF-16 key order and float formatting all diverge from Rust `serde_json`. Signatures break on the first non-ASCII string. No canon/voucher/gossip test vector exists to catch it. | **Applied in A0** as a clarification (exact escaping, integers only, reject floats/duplicate keys) + new vectors |
| SE7 | Medium | NFX-01 §3, NFX-02 §4 | Multiplicity of `n` (and of single-valued manifest tags such as `root`, `d`) is unstated. An event carrying two `n` tags matches both a mainnet and a testnet REQ; two `root` tags make "the" anchor implementation-defined. | **Applied in A0**: exactly one `n` (NFX-01 re-freeze, clarification) and at-most-once single-valued tags (NFX-02, Draft) |
| SE8 | Low | NFX-08 §2 | No AEAD associated data: ciphertext is not bound to its file position. Mitigated today by the sha256 anchor per file. | Note only (revisit at M3) |
| SE9 | Low | NFX-08/09 | Who bears NUT-02 input fees on `license` payment and on `redeem` is unspecified; the exact-amount rule makes this observable. | Open question for M3 |

Coverage limits: spec text only; no implementation exists to exercise. NFX-10's
browser payment text is being rewritten in A0 (amendment 5) and was not probed
further.
