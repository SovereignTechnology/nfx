#!/usr/bin/env bash
# The locked paths (docs/nfx/m2-plan.md; ADR 0008 §4). Money code is written only in the M2
# security stage, and sovtech reads every change to it. The pins in crates/ci/locked.sha256
# are the reviewed contents of:
#   - the locked paths themselves (stubs until the security stage);
#   - what decides how the money code is compiled and tested (nfx-pay's manifest, lib.rs,
#     contracts, adversary suite and tests; the pay/1 wire parser);
#   - this check and the CI that runs it.
# Anything that differs from the pins fails: an edited, added, removed, renamed or
# symlinked file (files are listed from git, by mode and content), a build.rs, or code
# pulled in from elsewhere with #[path] or include! anywhere under crates/.
#
# Limit: whoever can push can also re-pin. This makes money-code changes loud and
# reviewable; the control is sovtech's review of every change to the pins.
#
# The security stage runs with LOCKED_DIRS_UNLOCKED=1 (never in CI) and re-pins after
# sovtech has read the diff:  LOCKED_DIRS_UNLOCKED=1 crates/ci/check-locked.sh --pin
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
pins=crates/ci/locked.sha256
locked=(
  crates/nfx-pay/src/engine
  crates/nfx-pay/src/wallet
  crates/nfx-pay/src/protocol
  crates/nfx-node/src/pay
  crates/nfx-node/src/origin_pay.rs
)
guarded=(
  crates/nfx-pay/Cargo.toml
  crates/nfx-pay/src/lib.rs
  crates/nfx-pay/src/session.rs
  crates/nfx-pay/src/adversary.rs
  crates/nfx-pay/tests
  crates/nfx-proto/src/pay.rs
  crates/ci/check-locked.sh
  crates/ci/check.sh
  crates/ci/gitlab-ci.yml
)
must_be_absent=(crates/nfx-pay/build.rs)
paths=("${locked[@]}" "${guarded[@]}")

fail() { printf 'locked paths: %s\n' "$*" >&2; exit 1; }

if [ -n "${CI:-}" ] && { [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ] || [ "${1:-}" = --pin ]; }; then
  fail "unlocking and re-pinning are refused in CI"
fi
if [ "${1:-}" = --pin ] && [ "${LOCKED_DIRS_UNLOCKED:-0}" != 1 ]; then
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
}

for p in "${must_be_absent[@]}"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "$p must not exist"
done
if git grep -nE '#!?[[:space:]]*\[[[:space:]]*path\b|\binclude![[:space:]]*\(' -- crates \
  ':!crates/ci/check-locked.sh' >&2; then
  fail "#[path] or include! under crates/ can pull unpinned code into a pinned module"
fi

current=$(manifest)
if [ "${1:-}" = --pin ]; then
  printf '%s\n' "$current" > "$pins"
  echo "pinned $(wc -l < "$pins") guarded files in $pins"
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
echo "locked paths: $(wc -l < "$pins") guarded files match their pins"
