#!/usr/bin/env bash
# Creates an isolated git worktree for a lane with its path allowlist pre-written.
# Execution plan §0 rule 2: one lane = one worktree = one package directory.
#
# Usage: scripts/new-lane-worktree.sh <LANE_ID> <allowed-path> [<allowed-path>...]
# Example: scripts/new-lane-worktree.sh L2 packages/seeder/
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
lane="${1:?lane id}"; shift
[[ $# -ge 1 ]] || { echo "need at least one allowed path"; exit 1; }
dir=".worktrees/$lane"
branch="lane/$lane"
git worktree add -b "$branch" "$dir" main
{
  echo "lane: $lane"
  for p in "$@"; do echo "allow: $p"; done
  echo "allow: docs/lanes/$lane.md"
  echo "allow: docs/contract-requests/$lane.md"
} > "$dir/.lane"
(cd "$dir" && bash scripts/install-hooks.sh)
echo "worktree $dir on branch $branch; allowlist:"
cat "$dir/.lane"
