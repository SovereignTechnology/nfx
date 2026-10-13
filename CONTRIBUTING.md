# Contributing to NFX

Thanks for taking an interest. NFX is a Nostr-identified, peer-seeded video network. This
repository holds the specification (`spec/`), the Rust reference implementation
(`crates/`) and a browser test player (`web/player/`). Start with the
[README](README.md) and [`spec/README.md`](spec/README.md);
[`docs/nfx/status.md`](docs/nfx/status.md) records what is built and what comes next.

## Ground rules

- By contributing you agree your work is licensed under **AGPL-3.0-or-later**, the same
  licence as the project, except for specification text in `spec/`, which is CC0
  (`spec/README.md`). There is no CLA and copyright stays with you.
- Be civil. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Never commit secrets: API tokens, private keys, `.env` files, credentials of any kind.
  `.gitignore` blocks the common cases, but it is not a safety net you should rely on.

## Where changes go

New work goes in `spec/`, `crates/`, `web/` and `docs/nfx/`, plus decision records in
`docs/decisions/` and the root documents. `packages/` and `scripts/` (and the demo's
planning documents) are a read-only mirror of the v0 demo, which is built in a separate
repository. They are not edited here (ADR 0008 §3); the add-only check in
`crates/ci/check.sh` catches an edit to them.

## Workflow

1. Open an issue first for anything non-trivial, so design discussion happens before the
   code exists.
2. Spec first. A wire change is an edit to the document in `spec/` plus a regenerated
   test vector, and only then code (see below).
3. Branch off `main` and keep commits focused so the history stays readable.
4. Run `crates/ci/check.sh` before you push (see below).
5. Open a pull request against `main`. Explain *why*, not just *what*; the diff already
   shows what changed.
6. CI must pass and the change must be approved in review. Then it merges.

## Spec first

- `spec/test-vectors/generate.py` is the source of truth for the test vectors. After a
  spec change, regenerate them and check the result is byte-exact:

  ```sh
  python3 spec/test-vectors/generate.py            # regenerate
  python3 spec/test-vectors/generate.py --verify   # byte-exact re-check
  ```

- The JSON schemas in `spec/schemas/` must keep agreeing with the vectors
  (`python3 spec/schemas/check.py`).
- Frozen documents change only by a `specver` bump (NFX-01 §4). Typos and clarifications
  that change no behaviour may be fixed in place, with a line in the document's
  changelog; the status model is in [`spec/README.md`](spec/README.md). Documents marked
  Draft may change in place.

## Checks

Run everything CI runs with one command:

```sh
PYTHON=path/to/venv/bin/python crates/ci/check.sh
```

CI runs this same script. In order, it:

1. recomputes the spec test vectors and compares them with the files on disk;
2. checks the JSON schemas against the vectors;
3. runs the add-only check on the mirrored demo paths (skipped when there is no
   `demo/main` ref to compare with);
4. runs `cargo fmt --check`, `cargo clippy` with warnings denied, and `cargo test`;
5. packages a real clip with ffmpeg, only if `ffmpeg` is on `PATH`
   (`NFX_FFMPEG` and `NFX_FFPROBE` point at other binaries);
6. runs `cargo deny check`;
7. runs the `nfx-proto` and `nfx-wasm` tests for `wasm32` under Node
   (`NFX_SKIP_WASM=1` skips this step).

It needs:

- a Python 3 virtual environment with `coincurve`, `PyNaCl`, `blake3` and `jsonschema`,
  passed as `PYTHON`;
- a Rust toolchain at least as new as `rust-version` in `crates/Cargo.toml`, with
  `clippy`, `rustfmt` and the `wasm32-unknown-unknown` target;
- `cargo-deny` for the `cargo deny check` step, which always runs;
- `wasm-pack` and Node (use the version pinned in `crates/ci/gitlab-ci.yml`) for the
  `wasm32` step, unless you skip it with `NFX_SKIP_WASM=1`.

The versions CI uses are pinned in `crates/ci/gitlab-ci.yml`. A clean test build is
heavy; CI sets `CARGO_BUILD_JOBS=2` and `CARGO_PROFILE_TEST_DEBUG=0` to keep it light,
and you can do the same.

## Code rules

- **No hand-written crypto.** Use libraries (RustCrypto, iroh, nostr-sdk, libsodium);
  never implement hashing, signatures, key derivation or encryption yourself.
- **`nfx-proto` is pure:** no I/O, no clock (callers pass `now`) and no RNG, so the same
  code builds and verifies natively and under `wasm32`.
- The workspace forbids `unsafe` code (`unsafe_code = "forbid"`).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <short imperative summary>

<optional body explaining motivation and context>
```

Types used in this repository: `feat`, `fix`, `docs`, `spec` (changes under `spec/`),
`spike` (spike code and results), `test`, `refactor`, `build`, `ci`, `chore` and
`merge` (merge commits). The scope is a crate or area, for example `nfxd`, `nfx-proto`,
`crates` or `web`, and may be omitted. A real subject from the history:
`spec: freeze NFX-02..06 at M1 (2026-09-24)`.

Subject line: imperative mood, no trailing full stop, ideally under 72 characters.

Do **not** add `Co-Authored-By` trailers or tool-attribution lines.

## Architectural decisions

Anything that constrains the project long-term (a transport, a datastore, a protocol
rule) gets a short record in `docs/decisions/NNNN-title.md` covering the context, the
decision and the consequences, in the format of
[ADR 0001](docs/decisions/0001-record-architecture-decisions.md). Accepted records are
not edited; a decision that no longer holds is marked superseded by a new record. The
demo repository numbers its own records too (0001 to 0005, 0007 and 0009 onward; 0006
and 0008 are this repository's, see ADR 0008), so agree the number of a new record in
the issue before you use it.

## Reporting a security issue

Do not open a public issue for a vulnerability. Email <git@sovit.xyz> with details and
reproduction steps, and allow reasonable time for a fix before disclosing. See
[SECURITY.md](SECURITY.md).
