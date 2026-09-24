#!/usr/bin/env bash
# The locked paths (docs/nfx/m2-plan.md; ADR 0008 §4). Money code is written only in the M2
# security stage, and sovtech reads every change to it.
#
#   check-locked.sh              the pinned files. check.sh runs this first, before any
#                                unpinned code.
#   check-locked.sh --compiled   the same, then (after the build) what the compiler read
#                                and what nfx-pay is built from (locked.py). check.sh runs
#                                this last.
#   LOCKED_DIRS_UNLOCKED=1 check-locked.sh --pin
#                                the security stage, after sovtech has read the diff:
#                                re-pin both. Never in CI.
#
# crates/ci/locked.sha256 pins, by git mode and content:
#   - the locked paths (stubs until the security stage);
#   - everything that decides how the money code is compiled and tested: all of
#     crates/nfx-pay (manifest, contracts, mock, suite, tests), the pay/1 parser and the
#     modules it rests on, the workspace manifest's profile/patch/replace/lints sections;
#   - this check, its helper and the CI that runs them.
# crates/ci/locked-compiled.txt pins nfx-pay's resolved dependency closure, the workspace
# crates that may depend on it, and the workspace's build scripts and proc-macros.
#
# Anything else fails:
#   - an edited, added, removed, renamed or symlinked file (listed from git);
#   - tracked Cargo configuration or toolchain files;
#   - a Cargo config in CARGO_HOME under CI;
#   - `#[path]` or `include!` anywhere under crates/;
#   - nfx-pay compiling a file that is not its own tracked one;
#   - nfx-node's library compiling a file from outside crates/nfx-node;
#   - `nfx_pay` named outside nfx-pay and nfx-node's locked paths.
#
# Limits: whoever can push can also re-pin, and the CI configuration lives in the branch
# it checks. This makes money-code changes loud and reviewable; the control is sovtech's
# review of every change to the pins. Unpinned code that CI runs (generators, other
# crates' build steps) could in principle alter files between the two checks; its own
# diff is where that would show.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
py=${PYTHON:-python3}
pins=crates/ci/locked.sha256
locked=(
  crates/nfx-pay/src/engine
  crates/nfx-pay/src/wallet
  crates/nfx-pay/src/protocol
  crates/nfx-node/src/pay
  crates/nfx-node/src/origin_pay.rs
)
guarded=(
  crates/nfx-pay
  crates/nfx-proto/src/pay.rs
  crates/nfx-proto/src/canon.rs
  crates/nfx-proto/src/hex32.rs
  crates/nfx-proto/src/namespace.rs
  crates/ci/check-locked.sh
  crates/ci/locked.py
  crates/ci/check.sh
  crates/ci/gitlab-ci.yml
)
must_be_absent=(crates/nfx-pay/build.rs)
paths=("${locked[@]}" "${guarded[@]}")
mode=${1:-}

fail() { printf 'locked paths: %s\n' "$*" >&2; exit 1; }

case $mode in
  '' | --pin | --compiled) ;;
  *) fail "usage: check-locked.sh [--compiled | --pin]" ;;
esac
if [ -n "${CI:-}" ] && { [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ] || [ "$mode" = --pin ]; }; then
  fail "unlocking and re-pinning are refused in CI"
fi
if [ "$mode" = --pin ] && [ "${LOCKED_DIRS_UNLOCKED:-0}" != 1 ]; then
  fail "--pin needs LOCKED_DIRS_UNLOCKED=1 (the security stage, after sovtech's review)"
fi

# Every file under the paths, from git (NUL-separated, so no name can split a line).
manifest() {
  local untracked
  untracked=$(git ls-files -o -z -- "${paths[@]}" | tr '\0' '\n')
  [ -z "$untracked" ] || fail "untracked files in guarded paths: $untracked"
  git ls-files -s -z -- "${paths[@]}" | while IFS= read -r -d '' entry; do
    mode=${entry%% *}
    path=${entry#*$'\t'}
    case $path in
      *[![:print:]]* | *' '*) fail "a guarded path has a space or unprintable name: ${path@Q}" ;;
    esac
    if [ "$mode" = 120000 ]; then
      fail "symlink in a guarded path: $path"
    fi
    [ -f "$path" ] && [ ! -L "$path" ] || fail "missing or not a regular file: $path"
    printf '%s %s %s\n' "$mode" "$(sha256sum < "$path" | cut -d' ' -f1)" "$path"
  done
  "$py" crates/ci/locked.py manifest
}

for p in "${must_be_absent[@]}"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "$p must not exist"
done
config=$(git ls-files -z | tr '\0' '\n' | grep -E '(^|/)\.cargo(-home)?/|(^|/)rust-toolchain(\.toml)?$' || true)
[ -z "$config" ] || fail "tracked Cargo configuration or toolchain files: $config"
if [ -n "${CI:-}" ]; then
  for f in "${CARGO_HOME:-$HOME/.cargo}"/config "${CARGO_HOME:-$HOME/.cargo}"/config.toml; do
    [ ! -e "$f" ] || fail "a Cargo config in CARGO_HOME under CI: $f"
  done
fi
if git grep -nE '#!?[[:space:]]*\[[[:space:]]*path\b|\binclude![[:space:]]*[({[]' -- crates \
  ':!crates/ci/check-locked.sh' >&2; then
  fail "#[path] or include! under crates/ can pull unpinned code into a pinned module"
fi

current=$(manifest)
if [ "$mode" = --pin ]; then
  printf '%s\n' "$current" > "$pins"
  echo "pinned $(wc -l < "$pins") guarded files and sections in $pins"
  "$py" crates/ci/locked.py compiled --pin
  exit 0
fi
if [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ]; then
  echo "locked paths: UNLOCKED (the M2 security stage); re-pin after review"
  exit 0
fi
if [ "$current" != "$(cat "$pins")" ]; then
  echo "locked paths: guarded files differ from their pins:" >&2
  diff <(cat "$pins") <(printf '%s\n' "$current") >&2 || true
  exit 1
fi
echo "locked paths: $(wc -l < "$pins") guarded files and sections match their pins"
if [ "$mode" = --compiled ]; then
  "$py" crates/ci/locked.py compiled
fi
