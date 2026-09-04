#!/usr/bin/env bash
# Build-plan §7 / threat T13: reproducible web build → tree hash → unsigned Nostr event.
#
# Builds a workspace package from a clean, lockfile-only install, hashes its dist tree with
# scripts/reproducible-build.mjs and writes the JSON report (tree hash + per-file hashes +
# unsigned event template) under artifacts/. With --twice it builds a second time from
# scratch and fails if the two hashes differ — that is the reproducibility test.
#
# Usage: scripts/reproducible-web-build.sh [options]
#   --pkg <name>       workspace package to build (default @sovit/app-web)
#   --dist <dir>       dist directory to hash (default packages/app-web/dist)
#   --out <file>       report path (default artifacts/web-build/<commit>.json)
#   --no-install       skip `npm ci --ignore-scripts` (use the existing node_modules)
#   --twice            build twice from scratch and require identical hashes
#   --                 remaining args go to reproducible-build.mjs (--kind, --d, --url, …)
#
# Determinism knobs: SOURCE_DATE_EPOCH is pinned to the commit time so any tool that
# honours it (and the event's created_at) is stable across rebuilds. Nothing here signs.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

pkg=@sovit/app-web
dist=packages/app-web/dist
out=""
install=1
twice=0
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pkg) pkg="$2"; shift 2 ;;
    --dist) dist="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --no-install) install=0; shift ;;
    --twice) twice=1; shift ;;
    --) shift; extra=("$@"); break ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

commit=$(git rev-parse HEAD)
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct HEAD)
[[ -n "$out" ]] || out="artifacts/web-build/${commit}.json"
pkgdir=$(node -p "require('./package-lock.json').packages['node_modules/$pkg']?.resolved ?? ''")
[[ -n "$pkgdir" ]] || { echo "reproducible-web-build: $pkg is not a workspace package in package-lock.json" >&2; exit 2; }

if [[ $install -eq 1 ]]; then
  echo "reproducible-web-build: npm ci --ignore-scripts (lockfile-only)"
  npm ci --ignore-scripts
fi

build_once() {
  # A clean build: drop the output AND tsc's incremental state — `tsc -b` trusts the
  # tsbuildinfo and will happily emit nothing into a freshly deleted dist/.
  rm -rf "$dist"
  find "$pkgdir" -maxdepth 1 -name '*.tsbuildinfo' -delete
  npm run build -w "$pkg"
  [[ -d "$dist" ]] || {
    echo "reproducible-web-build: $pkg produced no $dist — nothing to hash (packages/app-web has no build output until L7 lands)" >&2
    exit 3
  }
}

build_once
node scripts/reproducible-build.mjs "$dist" --out "$out" --pkg "$pkgdir" --commit "$commit" "${extra[@]}"
hash1=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).treeHash" "$out")

if [[ $twice -eq 1 ]]; then
  echo "reproducible-web-build: rebuilding from scratch to verify determinism"
  build_once
  hash2=$(node scripts/reproducible-build.mjs "$dist" --commit "$commit" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).treeHash")
  if [[ "$hash1" != "$hash2" ]]; then
    echo "reproducible-web-build: FAIL — build is NOT reproducible: $hash1 != $hash2" >&2
    exit 1
  fi
  echo "reproducible-web-build: OK — two clean builds hash identically"
fi

echo "reproducible-web-build: tree sha256 $hash1"
echo "reproducible-web-build: report + unsigned event template at $out (sign offline with the org key; never here)"
