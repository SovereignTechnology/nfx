#!/bin/bash -p
# The lock's verdict as its own CI job (.github/workflows/ci.yml `lock`). It runs no
# unpinned repository code: only this script, check-locked.sh and locked.py (all pinned),
# cargo, and the money crates' own build and tests, whose every input is pinned. ci.yml
# (pinned too) runs it under `env -i` with literal paths, as the dormant gitlab-ci.yml
# does, so no variable of the runner or the project reaches it. The `check` job runs
# everything else.
#
# Order: the tree is the commit and holds nothing untracked; the pinned files and the
# environment; the cached archives; then what the money crates are built from, read from
# cargo metadata before anything is compiled; then the build and the money tests; then the
# pinned files again.
set -euo pipefail
shopt -s inherit_errexit
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
fail() { printf 'lock job: %s\n' "$*" >&2; exit 1; }
# The tree is exactly the commit the pipeline is for, whatever the runner was told.
[ -n "${CI_COMMIT_SHA:-}" ] || fail "CI_COMMIT_SHA is not set"
[ "$(git rev-parse HEAD)" = "$CI_COMMIT_SHA" ] || fail "HEAD is not $CI_COMMIT_SHA"
git diff --quiet HEAD -- || fail "tracked files differ from $CI_COMMIT_SHA"
# And it holds nothing git does not track: a build directory or anything else a CI cache
# could carry into a fresh clone is refused, so the verdict rests only on tracked files.
# ci.yml's lock job restores no cache. The one exception is the registry cache and index a
# job restores (gitlab-ci.yml's does, under a shared key); cargo has not run yet, so
# registry/src and the rest are not there to allow. Renames and staged paths (any status
# but ?? and !!) cannot appear after the diff check above; if one does, it fails here.
while IFS= read -r -d '' entry; do
  status=${entry:0:2} path=${entry:3}
  case $status in
    '??' | '!!')
      case $path in
        .cargo-home/registry/cache/* | .cargo-home/registry/index/*) ;;
        *) fail "an untracked or ignored path is in the checkout: $path" ;;
      esac ;;
    *) fail "the working tree is not exactly $CI_COMMIT_SHA: ${entry@Q}" ;;
  esac
done < <(git status --porcelain=v1 -z --ignored --untracked-files=all)
crates/ci/check-locked.sh
crates/ci/check-locked.sh --sources
(cd crates && cargo fetch --locked)
crates/ci/check-locked.sh --facts
crates/ci/check-locked.sh --compiled
echo "lock job: passed"
