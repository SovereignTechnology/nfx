#!/usr/bin/env bash
# Build-plan §7: "explicit list of native modules reviewed on every bump."
# Walks node_modules for anything with a binding.gyp, prebuilds/ or *.node and compares
# against docs/native-modules.txt (the reviewed inventory).
#
# Usage: scripts/native-module-inventory.sh            # print current inventory
#        scripts/native-module-inventory.sh --check    # exit 1 if it differs from the reviewed list
#        scripts/native-module-inventory.sh --accept   # overwrite the reviewed list (after review!)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
reviewed=docs/native-modules.txt

inventory() {
  [[ -d node_modules ]] || return 0
  {
    find node_modules -name binding.gyp -not -path '*/test/*' -printf '%h\n'
    find node_modules -type d -name prebuilds -printf '%h\n'
    find node_modules -name '*.node' -printf '%h\n'
  } 2>/dev/null \
    | sed -E 's#^node_modules/##; s#/(prebuilds|build|lib|.*\.node)$##' \
    | awk -F/ '{ if ($1 ~ /^@/) print $1"/"$2; else print $1 }' \
    | sort -u \
    | while read -r m; do
        v=$(node -p "require('./node_modules/$m/package.json').version" 2>/dev/null || echo '?')
        echo "$m@$v"
      done
}

case "${1:-}" in
  --check)
    [[ -f "$reviewed" ]] || { echo "no $reviewed yet; run --accept after reviewing"; exit 1; }
    if diff <(inventory) <(grep -vE '^\s*(#|$)' "$reviewed" | sort -u); then
      echo "native-module-inventory: OK"
    else
      echo "native-module-inventory: FAIL — inventory differs from reviewed list ($reviewed)"
      exit 1
    fi ;;
  --accept)
    { echo "# Reviewed native-module inventory (build-plan §7). Regenerate with scripts/native-module-inventory.sh --accept"; echo "# Every line here has been read by a human on the stated version."; inventory; } > "$reviewed"
    cat "$reviewed" ;;
  *) inventory ;;
esac
