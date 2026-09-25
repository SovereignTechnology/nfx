#!/bin/bash -p
# -p: no BASH_ENV, and no shell functions imported from the environment. Run through its
# shebang (or `bash -p`) only: through plain `bash`, BASH_ENV runs first and could make it
# say anything, so it refuses.
if [[ $- != *p* ]]; then
  builtin echo "locked paths: run this as crates/ci/check-locked.sh, not through plain bash" >&2
  builtin exit 1
fi
if [[ -n $(builtin declare -F) ]]; then
  builtin echo "locked paths: shell functions are defined before the check runs" >&2
  builtin exit 1
fi
# The locked paths (docs/nfx/m2-plan.md; ADR 0008 §4). Money code is written only in the M2
# security stage, and sovtech reads every change to it.
#
#   check-locked.sh              the pinned files and the build environment. check.sh runs
#                                this first, before any unpinned code.
#   check-locked.sh --sources    the same, then every cached .crate against Cargo.lock (in
#                                CI, extracted sources are then deleted, so cargo re-extracts
#                                from verified archives). check.sh runs this before cargo.
#   check-locked.sh --facts      the same, then what nfx-pay is built from, read from cargo
#                                metadata without compiling anything (locked.py facts).
#   check-locked.sh --compiled   the same, then builds every target of nfx-pay and
#                                nfx-proto alone, checks what the compiler read for each
#                                (failing closed on a target without dep-info) and that the
#                                money tests ran, and checks the pinned files again
#                                (locked.py). The lock job runs --facts, then this;
#                                check.sh runs it last.
#   LOCKED_DIRS_UNLOCKED=1 check-locked.sh --pin
#                                the security stage, after sovtech has read the diff:
#                                re-pin both, the compiled facts first (their file is one
#                                of the pinned files). Never in CI.
#
# crates/ci/locked.sha256 pins, by git mode and content:
#   - the locked paths (stubs until the security stage);
#   - everything that decides how the money code is compiled and tested: all of
#     crates/nfx-pay (manifest, contracts, mock, suite, tests); the pay/1 parser, the
#     modules it rests on, nfx-proto's lib.rs and manifest, its vector tests, the vectors
#     and their reference reader; the workspace manifest's profile, patch, replace, lints,
#     resolver, members and package;
#   - this check, its helpers, the CI that runs them, and locked-compiled.txt.
# crates/ci/locked-compiled.txt pins the money crates' resolved dependency closure with
# its features (nfx-pay's and nfx-proto's, test dependencies included), the workspace
# crates that may depend on nfx-pay, the workspace's build scripts and proc-macros, and
# the toolchain.
#
# Anything else fails:
#   - an edited, added, removed, renamed or symlinked file (listed from git), before the
#     build and again after the tests;
#   - a Cargo config or toolchain file, tracked or not, anywhere cargo or rustup would
#     read one (crates/ and every directory above it, and CARGO_HOME);
#   - a CARGO_*, RUST* or RUSTC* variable outside the allow-list below (a target runner in
#     the environment can make `cargo test` run nothing and still pass), and any variable
#     whose name is not a plain identifier (an exported bash function, say); in CI, any
#     variable outside the allow-list at all;
#   - for any target of nfx-pay or nfx-proto: no dep-info, a compiled file that is
#     untracked, or one outside its own crate (nfx-pay's targets and nfx-proto's library;
#     nfx-proto's tests may read the tracked vectors). This catches #[path], include! and
#     every spelling of them in the money crates, on the host build CI tests;
#   - `nfx_pay` named in any Rust file outside nfx-pay and nfx-node's locked paths;
#   - a path package that is not a workspace member;
#   - the money tests not all running.
#
# CI is recognised by CI, GITLAB_CI or CI_JOB_ID, and the pinned gitlab-ci.yml runs this
# with CI=true and LOCKED_DIRS_UNLOCKED emptied, so a pipeline variable cannot unset CI.
#
# What it guarantees: the money code (every pinned file) and what it is built and tested
# with cannot change without a re-pin, and its tests ran in full. What it does not:
#   - code outside the money crates is out of scope. Another crate may compile a pinned
#     file (by #[path], on any target), but cannot change it, and money logic written
#     afresh anywhere is a change no lock can tell from other code; nfx-proto's other
#     modules and target-gated code are in that position too;
#   - whoever can push can also re-pin, and the CI configuration lives in the branch it
#     checks. This makes money-code changes loud and reviewable; the control is sovtech's
#     review of every change to the pins;
#   - the verdict is the CI lock job's (env -i, bash -p, no unpinned code before it). A
#     local run, or the check job's lock steps after unpinned code has run, is a second
#     look;
#   - pipeline variables and `[skip ci]` are the project's settings to close
#     (gitlab-ci.yml).
set -euo pipefail
shopt -s inherit_errexit   # a failure inside $(...) fails the script, not just the subshell
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
py="${PYTHON:-python3} -I -S"   # isolated, and no site: locked.py needs only the stdlib
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
  crates/nfx-proto/Cargo.toml
  crates/nfx-proto/src/lib.rs
  crates/nfx-proto/src/error.rs
  crates/nfx-proto/src/pay.rs
  crates/nfx-proto/src/canon.rs
  crates/nfx-proto/src/hex32.rs
  crates/nfx-proto/src/namespace.rs
  crates/nfx-proto/tests/pay1.rs
  spec/test-vectors/pay1.py
  spec/test-vectors/pay1.json
  crates/ci/check-locked.sh
  crates/ci/lock-job.sh
  crates/ci/locked.py
  crates/ci/check.sh
  crates/ci/gitlab-ci.yml
  crates/ci/locked-compiled.txt
)
must_be_absent=(crates/nfx-pay/build.rs)
paths=("${locked[@]}" "${guarded[@]}")
mode=${1:-}

fail() { printf 'locked paths: %s\n' "$*" >&2; exit 1; }

case $mode in
  '' | --pin | --sources | --facts | --compiled) ;;
  *) fail "usage: check-locked.sh [--sources | --facts | --compiled | --pin]" ;;
esac
in_ci=${CI:-}${GITLAB_CI:-}${CI_JOB_ID:-}
if [ -n "$in_ci" ] && { [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ] || [ "$mode" = --pin ]; }; then
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
  git ls-files -s -z -- "${paths[@]}" | while IFS= builtin read -r -d '' entry; do
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
  $py crates/ci/locked.py manifest
}

for p in "${must_be_absent[@]}"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "$p must not exist"
done

# The build environment: nothing may redirect what cargo runs or compiles. In CI the lock
# job runs under `env -i` (gitlab-ci.yml), and every variable must be on the list below.
allowed='CARGO_HOME CARGO_TERM_COLOR CARGO_BUILD_JOBS CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG CARGO_INCREMENTAL CARGO_DENY_VERSION CARGO_DENY_SHA256 RUSTUP_HOME RUST_VERSION'
ci_allowed="$allowed PATH HOME CI CI_COMMIT_SHA PYTHON PWD OLDPWD SHLVL _ LOCKED_DIRS_UNLOCKED"
# Names from `env -0`, so no value can forge a line. A name that is not a plain
# identifier (BASH_FUNC_git%%, an exported function standing in for a command) fails.
while IFS= builtin read -r -d '' entry; do
  name=${entry%%=*}
  [[ $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "a variable that is not a plain name is set: ${name@Q}"
  if [ -n "$in_ci" ]; then
    case " $ci_allowed " in
      *" $name "*) ;;
      *) fail "in CI, a variable outside the allow-list is set: $name" ;;
    esac
  elif [[ $name =~ ^(__)?(CARGO|RUST) ]]; then
    case " $allowed " in
      *" $name "*) ;;
      *) fail "a build variable outside the allow-list is set: $name" ;;
    esac
  fi
done < <(/usr/bin/env -0)
if [ -n "$in_ci" ] && [ -n "${LOCKED_DIRS_UNLOCKED:-}" ]; then
  fail "LOCKED_DIRS_UNLOCKED is set in CI"
fi
dir=$PWD/crates
while :; do
  for f in "$dir/.cargo/config" "$dir/.cargo/config.toml" "$dir/rust-toolchain" "$dir/rust-toolchain.toml"; do
    [ ! -e "$f" ] && [ ! -L "$f" ] || fail "a Cargo config or toolchain file where cargo reads one: $f"
  done
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
config=$(git ls-files -z | tr '\0' '\n' | grep -E '(^|/)\.cargo(-home)?/|(^|/)rust-toolchain(\.toml)?$' || true)
[ -z "$config" ] || fail "tracked Cargo configuration or toolchain files: $config"
home=${CARGO_HOME:-$HOME/.cargo}
for f in "$home"/config "$home"/config.toml; do
  [ ! -e "$f" ] && [ ! -L "$f" ] || fail "a Cargo config in CARGO_HOME: $f"
done

if [ "$mode" = --pin ]; then
  $py crates/ci/locked.py compiled --pin
  manifest > "$pins"
  echo "pinned $(wc -l < "$pins") guarded files and sections in $pins"
  exit 0
fi
current=$(manifest)
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
case $mode in
  --sources)
    $py crates/ci/locked.py sources
    if [ -n "$in_ci" ]; then
      rm -rf "${home:?}/registry/src"
      echo "locked paths: extracted sources removed; cargo re-extracts from verified archives"
    fi
    ;;
  --facts) $py crates/ci/locked.py facts ;;
  --compiled)
    $py crates/ci/locked.py compiled
    # The tests ran code: the pinned files must still be the pinned files.
    [ "$(manifest)" = "$(cat "$pins")" ] || fail "guarded files changed during the build or the tests"
    echo "locked paths: the guarded files still match their pins"
    ;;
esac
