#!/usr/bin/env bash
# The lock's verdict as its own CI job (gitlab-ci.yml `lock`). It runs no unpinned
# repository code: only this script, check-locked.sh and locked.py (all pinned), cargo,
# and the money crates' own build and tests, whose every input is pinned. gitlab-ci.yml
# runs it under `env -i` with literal paths, so no pipeline or project variable reaches it.
# The `check` job runs everything else.
#
# Order: the pinned files and the environment; the cached archives; then what nfx-pay is
# built from, read from cargo metadata before anything is compiled; then the build and the
# money tests; then the pinned files again.
set -euo pipefail
shopt -s inherit_errexit
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
fail() { printf 'lock job: %s\n' "$*" >&2; exit 1; }
# The tree is exactly the commit the pipeline is for, whatever the runner was told.
[ -n "${CI_COMMIT_SHA:-}" ] || fail "CI_COMMIT_SHA is not set"
[ "$(git rev-parse HEAD)" = "$CI_COMMIT_SHA" ] || fail "HEAD is not $CI_COMMIT_SHA"
git diff --quiet HEAD -- || fail "tracked files differ from $CI_COMMIT_SHA"
crates/ci/check-locked.sh
crates/ci/check-locked.sh --sources
(cd crates && cargo fetch --locked)
crates/ci/check-locked.sh --facts
crates/ci/check-locked.sh --compiled
echo "lock job: passed"
