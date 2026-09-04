#!/usr/bin/env bash
# Installs the repo's pre-commit hook into .git/hooks (or the worktree's hook dir).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
hookdir="$(git rev-parse --git-path hooks)"
mkdir -p "$hookdir"
cp scripts/pre-commit "$hookdir/pre-commit"
chmod +x "$hookdir/pre-commit"
echo "installed $hookdir/pre-commit"
