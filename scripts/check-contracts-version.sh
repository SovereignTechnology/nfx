#!/usr/bin/env bash
# Execution plan §0 rule 1: contracts freeze before fan-out. Any diff under
# packages/core/src/contracts/ must bump CONTRACTS_VERSION, and only the orchestrator
# (CODEOWNERS) may author it. This script checks the bump; CODEOWNERS checks the author.
#
# Usage: scripts/check-contracts-version.sh [<base-ref>]   default base = origin/main
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-origin/main}"
git rev-parse --verify -q "$base" >/dev/null || { echo "no base ref $base, skipping"; exit 0; }

changed=$(git diff --name-only "$base"...HEAD -- packages/core/src/contracts/ | grep -v '/version.ts$' || true)
[[ -z "$changed" ]] && { echo "check-contracts-version: no contract changes"; exit 0; }

if git diff --quiet "$base"...HEAD -- packages/core/src/contracts/version.ts; then
  echo "check-contracts-version: FAIL — contracts changed without bumping CONTRACTS_VERSION:"
  echo "$changed" | sed 's/^/  /'
  exit 1
fi
echo "check-contracts-version: OK (contracts changed and version bumped)"
