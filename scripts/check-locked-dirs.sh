#!/usr/bin/env bash
# Enforces SECURITY.md §locked / execution plan §0 rule 3.
#
# Until Stage 2, the locked directories may contain ONLY:
#   - TypeScript files that consist of type/interface declarations and re-exports
#   - tests (__tests__/ or *.test.ts)
#   - README.md
# Anything else (runtime code) fails this check.
#
# Usage: scripts/check-locked-dirs.sh [--unlock]   (--unlock is set by Stage 2 via LOCKED_DIRS_UNLOCKED=1)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

LOCKED=(
  packages/core/src/payment
  packages/core/src/signer
  packages/core/src/pay-protocol
  packages/core/src/wallet/spend.ts
  packages/gateway/src/auth
)

if [[ "${LOCKED_DIRS_UNLOCKED:-0}" == "1" ]]; then
  echo "check-locked-dirs: LOCKED_DIRS_UNLOCKED=1 — Stage 2 in progress, skipping"
  exit 0
fi

fail=0
for path in "${LOCKED[@]}"; do
  [[ -e "$path" ]] || continue
  while IFS= read -r -d '' f; do
    case "$f" in
      */__tests__/*|*.test.ts|*/README.md) continue ;;
      *.ts) ;;
      *) echo "LOCKED: non-TypeScript file in locked path: $f"; fail=1; continue ;;
    esac
    # Strip comments and blank lines, then every remaining line must be a declaration-only construct.
    # Allowed line starts: import/export type, export interface/type/enum-less, re-exports, braces, members.
    if grep -nE '^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\b' "$f" \
        | grep -vE '^\s*[0-9]+:\s*(export\s+)?(declare\s+)' \
        | grep -vE "^\s*[0-9]+:\s*//" ; then
      echo "LOCKED: implementation found in $f (see lines above). Interfaces, types and tests only until Stage 2."
      fail=1
    fi
  done < <(find "$path" -type f -print0 2>/dev/null)
done

if [[ $fail -ne 0 ]]; then
  echo "check-locked-dirs: FAIL"
  exit 1
fi
echo "check-locked-dirs: OK"
