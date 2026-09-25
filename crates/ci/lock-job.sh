#!/usr/bin/env bash
# The lock's verdict as its own CI job (gitlab-ci.yml `lock`). It runs no unpinned
# repository code: only this script, check-locked.sh and locked.py (all pinned), cargo, and
# the pinned money crates' own tests. gitlab-ci.yml runs it under `env -i` with literal
# paths, so no pipeline or project variable reaches it. The `check` job runs everything
# else.
set -euo pipefail
shopt -s inherit_errexit
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
crates/ci/check-locked.sh
crates/ci/check-locked.sh --sources
(cd crates && cargo fetch --locked)
crates/ci/check-locked.sh --compiled
echo "lock job: passed"
