#!/bin/bash -p
# Every master-plan check (ADR 0008), in the order CI runs them. Run from anywhere:
#   crates/ci/check.sh
# Env: PYTHON (needs coincurve; default python3), NFX_SKIP_WASM=1 to skip the wasm run,
# NFX_FFMPEG and NFX_FFPROBE (the ffmpeg and ffprobe nfx-media's packaging test runs;
# default: the ones on PATH; with no ffmpeg that test is skipped). The lock's steps are
# handed PYTHON and, if set, PATH, HOME, CARGO_HOME, RUSTUP_HOME, CI (which puts the lock
# in its CI mode) and LOCKED_DIRS_UNLOCKED (1 unlocks: the lock then compares nothing with
# its pins and builds nothing; refused in CI), CARGO_PROFILE_DEV_DEBUG,
# CARGO_PROFILE_TEST_DEBUG and CARGO_INCREMENTAL (the lock allows them by name; they change
# what the build costs, not what it compiles or runs), and LOCKED_BUILD_JOBS, a job count
# that reaches the lock as CARGO_BUILD_JOBS (allowed the same way), and no other variable
# (crates/ci/check-locked.sh).
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$repo"
py=${PYTHON:-python3}
step() { printf '\n== %s\n' "$*"; }
# The lock's steps run as the lock job runs them: under `env -i`, with only the variables
# the lock's allow-list names. The job's own (the CI host's GITHUB_* or CI_*, the tool pins,
# a coloured cargo) are none of its business, and in CI mode it refuses any it does not know.
locked() {
  local keep=() v
  for v in PATH HOME CI CARGO_HOME RUSTUP_HOME LOCKED_DIRS_UNLOCKED \
           CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG CARGO_INCREMENTAL; do
    [ -z "${!v+x}" ] || keep+=("$v=${!v}")
  done
  # The jobs of the lock's builds, set apart from cargo's own for the checks above them.
  if [ -n "${LOCKED_BUILD_JOBS:-}" ]; then
    [[ $LOCKED_BUILD_JOBS =~ ^[1-9][0-9]?$ ]] || { echo "check.sh: LOCKED_BUILD_JOBS is not a job count: ${LOCKED_BUILD_JOBS@Q}" >&2; exit 1; }
    keep+=("CARGO_BUILD_JOBS=$LOCKED_BUILD_JOBS")
  fi
  /usr/bin/env -i "${keep[@]}" PYTHON="$py" /bin/bash -p crates/ci/check-locked.sh "$@"
}

# First, before any unpinned code runs.
step "locked paths: money code only as reviewed (docs/nfx/m2-plan.md)"
locked

step "spec: test vectors regenerate byte for byte"
"$py" spec/test-vectors/generate.py --verify
step "spec: JSON schemas agree with the vectors"
"$py" spec/schemas/check.py

step "locked paths: cached crates match Cargo.lock, then fetch"
locked --sources
(cd crates && cargo fetch --locked)

cd crates
step "cargo fmt --check"
cargo fmt --all --check
step "cargo clippy -D warnings"
cargo clippy --workspace --all-targets --locked -- -D warnings
step "cargo test"
cargo test --workspace --locked
if command -v "${NFX_FFMPEG:-ffmpeg}" >/dev/null 2>&1; then
  step "nfx-media: package a real clip with ffmpeg"
  cargo test -p nfx-media --locked --test package_ffmpeg -- --ignored
else
  step "nfx-media ffmpeg test: SKIPPED (no ffmpeg on PATH; set NFX_FFMPEG/NFX_FFPROBE)"
fi
step "cargo deny check"
cargo deny check
if [ "${NFX_SKIP_WASM:-0}" != 1 ]; then
  step "wasm32: nfx-proto and pay/1 vectors under node"
  wasm-pack test --node nfx-proto
  wasm-pack test --node nfx-pay-wire
  step "wasm32: nfx-wasm bindings under node"
  wasm-pack test --node nfx-wasm
fi
# Last, after everything else has run: the files again, then what was compiled.
step "locked paths: unchanged, and nfx-pay built only from pinned files and dependencies"
(cd .. && locked --compiled)
printf '\nall checks passed\n'
