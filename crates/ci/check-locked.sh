#!/usr/bin/env bash
# The locked paths (docs/nfx/m2-plan.md; ADR 0008 §4): money code is written only in the
# M2 security stage, and sovtech reads every change to it. Until that stage these paths
# hold only the stubs pinned in crates/ci/locked.sha256; afterwards the pins are the
# reviewed contents. Either way, anything that differs from the pins fails here: an
# edited, added or removed file.
#
# The security stage runs with LOCKED_DIRS_UNLOCKED=1 and re-pins when sovtech has
# reviewed the diff:  crates/ci/check-locked.sh --pin
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
pins=crates/ci/locked.sha256
paths=(
  crates/nfx-pay/src/engine
  crates/nfx-pay/src/wallet
  crates/nfx-pay/src/protocol
  crates/nfx-node/src/pay
  crates/nfx-node/src/origin_pay.rs
)
files() { for p in "${paths[@]}"; do [ -e "$p" ] && find "$p" -type f; done | LC_ALL=C sort; }

if [ "${1:-}" = --pin ]; then
  files | xargs sha256sum > "$pins"
  echo "pinned $(wc -l < "$pins") locked files in $pins"
  exit 0
fi
if [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ]; then
  echo "locked paths: UNLOCKED (the M2 security stage); re-pin after review"
  exit 0
fi
found=$(files)
pinned=$(sed -E 's/^[0-9a-f]{64}  //' "$pins" | LC_ALL=C sort)
if [ "$found" != "$pinned" ]; then
  echo "locked paths: the files differ from the pins" >&2
  diff <(printf '%s\n' "$pinned") <(printf '%s\n' "$found") >&2 || true
  exit 1
fi
if ! sha256sum --quiet -c "$pins"; then
  echo "locked paths: a pinned file changed" >&2
  exit 1
fi
echo "locked paths: $(wc -l < "$pins") files match their pins"
