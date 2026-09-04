#!/usr/bin/env bash
# Build-plan §7: "explicit list of native modules reviewed on every bump." (threat T12)
#
# Walks node_modules (nested included) for anything carrying native code — binding.gyp,
# prebuilds/, *.node, *.bare, `addon`/`gypfile` flags, or an os/cpu/libc-restricted
# platform package — and compares it against docs/native-modules.txt, the reviewed
# inventory. Detection and the dependency-chain lookup live in
# scripts/native-module-inventory.mjs; this wrapper owns the review workflow.
#
# Usage: scripts/native-module-inventory.sh            # print current inventory
#        scripts/native-module-inventory.sh --check    # exit 1 if it differs from the reviewed list
#        scripts/native-module-inventory.sh --accept   # overwrite the reviewed list (after review!)
#
# The inventory is platform-specific: npm installs the optional per-platform binding
# packages for the host it runs on (and, because package-lock.json records no `libc`
# field, BOTH the gnu and musl variants on linux-x64). The reviewed list therefore carries
# a `# platform:` header. `--check` on a different platform prints a warning and exits 0
# unless NATIVE_INVENTORY_STRICT=1 — CI (node:22-bookworm, linux-x64) is the gate that
# counts, and it matches the platform the list was reviewed on.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
reviewed=docs/native-modules.txt
helper=scripts/native-module-inventory.mjs

platform="$(node -p 'process.platform + "-" + process.arch')"

inventory() {
  [[ -d node_modules ]] || return 0
  node "$helper" --root .
}

case "${1:-}" in
  --check)
    [[ -f "$reviewed" ]] || { echo "native-module-inventory: no $reviewed yet; run --accept after reviewing"; exit 1; }
    reviewed_platform="$(sed -n 's/^# platform:[[:space:]]*//p' "$reviewed" | head -1)"
    if [[ -n "$reviewed_platform" && "$reviewed_platform" != "$platform" ]]; then
      echo "native-module-inventory: WARNING — reviewed list is for $reviewed_platform, this host is $platform;"
      echo "  per-platform binding packages differ, so the comparison is not meaningful here."
      if [[ "${NATIVE_INVENTORY_STRICT:-0}" == "1" ]]; then
        echo "native-module-inventory: FAIL (NATIVE_INVENTORY_STRICT=1)"; exit 1
      fi
      echo "native-module-inventory: SKIPPED (set NATIVE_INVENTORY_STRICT=1 to fail instead)"
      exit 0
    fi
    if diff -u <(grep -vE '^\s*(#|$)' "$reviewed") <(inventory); then
      echo "native-module-inventory: OK ($(inventory | wc -l) native packages match $reviewed)"
    else
      echo "native-module-inventory: FAIL — installed native modules differ from the reviewed list ($reviewed)."
      echo "  Review every added/changed line (read the package: prebuilds only? install scripts? who pulls it?),"
      echo "  record the review in docs/lanes/<lane>.md, then run: scripts/native-module-inventory.sh --accept"
      exit 1
    fi ;;
  --accept)
    {
      echo "# Reviewed native-module inventory (build-plan §7, threat T12)."
      echo "# Regenerate with: scripts/native-module-inventory.sh --accept   (only AFTER reading every new line)"
      echo "# Verify with:     scripts/native-module-inventory.sh --check    (part of npm run ci and CI)"
      echo "# Columns: name@version | install path | native markers | lifecycle install scripts | scope | shortest dependency chain from a workspace package"
      echo "# Every line has been read by a human on the stated version; the review notes live in docs/lanes/L9.md."
      echo "# platform: $platform"
      inventory
    } > "$reviewed"
    cat "$reviewed" ;;
  '') inventory ;;
  *) echo "usage: $0 [--check|--accept]"; exit 2 ;;
esac
