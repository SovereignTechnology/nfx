#!/usr/bin/env bash
# Every master-plan check (ADR 0008), in the order CI runs them. Run from anywhere:
#   crates/ci/check.sh
# Env: PYTHON (needs coincurve; default python3), NFX_SKIP_WASM=1 to skip the wasm run.
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$repo"
py=${PYTHON:-python3}
step() { printf '\n== %s\n' "$*"; }

step "spec: test vectors regenerate byte for byte"
"$py" spec/test-vectors/generate.py --verify

step "add-only: mirrored demo paths unchanged on this side since the last demo merge"
if git rev-parse -q --verify refs/remotes/demo/main >/dev/null; then
  changed=$(git diff --name-only demo/main...HEAD -- \
    packages docs/plan docs/lanes docs/handoff docs/status.md scripts)
  if [ -n "$changed" ]; then
    printf 'mirrored demo paths were edited here:\n%s\n' "$changed" >&2
    exit 1
  fi
  echo "ok"
else
  echo "skipped: no demo/main ref (no demo-base tag)"
fi

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
  step "wasm32: nfx-proto vectors under node"
  wasm-pack test --node nfx-proto
fi
printf '\nall checks passed\n'
