#!/usr/bin/env bash
# web/player/lib-tar.sh: build the NFX web player library and pack it as a reproducible tar,
# out-lib/nfx-web-lib-<commit, 12 hex>.tar, holding exactly (names sorted, C locale):
#
#   api.d.ts                  the library's public types (self-contained)
#   player.d.ts               the library's declarations (imports only ./api)
#   player.js                 the library: one minified ES module (hls.js and p2p-media-loader in it)
#   wasm/nfx_wasm_bg.wasm     nfx-proto's verifier; init() loads it from ./wasm/ by default
#
# The tar is written by lib-tar.mjs, not by a tar program, whose output depends on its version
# (GNU tar with the same flags gave other bytes on another host): plain ustar members, mode 0644,
# uid/gid 0, mtime 0, no directory entries. Paths in the WASM are remapped to /nfx and /cargo.
# So the same commit built with the same tools gives the same bytes on any host, and a consumer
# (nutflix-pear's packages/app-web/nfx-web.lock) can pin its sha256.
#
#   bash lib-tar.sh [--commit <40 hex>] [--expect <sha256>] [--no-build]
#
#   --commit    the nfx commit this tree is (needed when the source is not a git checkout, e.g.
#               a GitHub archive); in a checkout it is HEAD, and the tree must be clean
#   --expect    exit 1 unless the tar's sha256 is this
#   --no-build  pack what out/ and out-lib/ already hold (after `npm run build && npm run
#               build:lib` under the same conditions)
#
# Tools, checked before building, because another version gives other bytes: rustc 1.98.0 with
# the wasm32-unknown-unknown target (crates/Cargo.toml rust-version, CI's image), wasm-pack 0.15.1
# (CI's pin), wasm-bindgen on PATH at the version crates/Cargo.lock pins (so wasm-pack downloads
# nothing), esbuild and typescript from package-lock.json (run `npm ci` first), and node.
set -euo pipefail

RUST_VERSION=1.98.0
WASM_PACK_VERSION=0.15.1

die() { echo "lib-tar: $*" >&2; exit 1; }

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(cd "$here/../.." && pwd -P)
commit= expect= build=1
while [ $# -gt 0 ]; do
    case $1 in
        --commit) commit=${2:-}; shift 2 ;;
        --expect) expect=${2:-}; shift 2 ;;
        --no-build) build=0; shift ;;
        *) sed -n '2,25p' "$0" >&2; exit 2 ;;
    esac
done
export LC_ALL=C TZ=UTC

if [ -z "$commit" ]; then
    git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout: pass --commit"
    commit=$(git -C "$repo" rev-parse HEAD)
    [ -z "$(git -C "$repo" status --porcelain --untracked-files=normal -- web/player crates)" ] \
        || die "web/player or crates has uncommitted changes: the tar would not be $commit's"
fi
[[ $commit =~ ^[0-9a-f]{40}$ ]] || die "--commit must be 40 lowercase hex"
[ -z "$expect" ] || [[ $expect =~ ^[0-9a-f]{64}$ ]] || die "--expect must be 64 lowercase hex"

cd "$here"
if [ "$build" = 1 ]; then
    lock_bindgen=$(awk '/^name = "wasm-bindgen"$/ {getline; gsub(/[^0-9.]/, ""); print; exit}' "$repo/crates/Cargo.lock")
    lock_esbuild=$(node -p "require('./package-lock.json').packages['node_modules/esbuild'].version")
    lock_tsc=$(node -p "require('./package-lock.json').packages['node_modules/typescript'].version")
    have() { "$@" 2>/dev/null | head -1 || true; }
    [[ $(have rustc -V) == "rustc $RUST_VERSION "* ]] || die "rustc is '$(have rustc -V)', not $RUST_VERSION"
    rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown || die "no wasm32-unknown-unknown target"
    [ "$(have wasm-pack -V)" = "wasm-pack $WASM_PACK_VERSION" ] || die "wasm-pack is '$(have wasm-pack -V)', not $WASM_PACK_VERSION"
    [ "$(have wasm-bindgen -V)" = "wasm-bindgen $lock_bindgen" ] || die "wasm-bindgen on PATH is '$(have wasm-bindgen -V)', not $lock_bindgen (crates/Cargo.lock)"
    [ "$(have ./node_modules/.bin/esbuild --version)" = "$lock_esbuild" ] || die "esbuild is not $lock_esbuild: run npm ci"
    [ "$(have ./node_modules/.bin/tsc -v)" = "Version $lock_tsc" ] || die "typescript is not $lock_tsc: run npm ci"

    # No checkout or home path may reach the WASM: the same mapping as the nfxweb site build.
    cargo_home=${CARGO_HOME:-$HOME/.cargo}
    export RUSTFLAGS="--remap-path-prefix=$repo=/nfx --remap-path-prefix=$cargo_home=/cargo"
    export CARGO_INCREMENTAL=0
    WASM_PACK_CACHE=$(mktemp -d)
    export WASM_PACK_CACHE
    trap 'rm -rf "$WASM_PACK_CACHE"' EXIT
    rm -rf out-lib
    npm run --silent wasm
    npm run --silent build:lib
    [ -z "$(find "$WASM_PACK_CACHE" -mindepth 1 -maxdepth 1 -print -quit)" ] \
        || die "wasm-pack downloaded a tool instead of using wasm-bindgen $lock_bindgen from PATH"
fi

files=(api.d.ts player.d.ts player.js wasm/nfx_wasm_bg.wasm)
stage=$(mktemp -d)
trap 'rm -rf "$stage" "${WASM_PACK_CACHE:-}"' EXIT
mkdir -p "$stage/wasm"
install -m 0644 out-lib/player.js "$stage/player.js"
install -m 0644 out-lib/types/lib.d.ts "$stage/player.d.ts"
install -m 0644 out-lib/types/api.d.ts "$stage/api.d.ts"
install -m 0644 out/wasm/nfx_wasm_bg.wasm "$stage/wasm/nfx_wasm_bg.wasm"
# The declarations must stand alone: player.d.ts imports only ./api, api.d.ts nothing.
imports=$(grep -hoE "(from|import\() *['\"][^'\"]+['\"]" "$stage/player.d.ts" | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" | sort -u)
[ "$imports" = "./api" ] || die "player.d.ts imports more than ./api: $(echo $imports)"
! grep -qE "(from|import\() *['\"]" "$stage/api.d.ts" || die "api.d.ts imports something"
[ "$(printf '%s\n' "${files[@]}" | sort)" = "$(printf '%s\n' "${files[@]}")" ] || die "file list not sorted"

name="nfx-web-lib-${commit:0:12}.tar"
node lib-tar.mjs "out-lib/$name" "$stage" "${files[@]}"
[ "$(tar -tf "out-lib/$name")" = "$(printf '%s\n' "${files[@]}")" ] || die "the tar holds more or other than its four files"
for f in "${files[@]}"; do
    cmp -s <(tar -xOf "out-lib/$name" "$f") "$stage/$f" || die "$f reads back from the tar differently"
done
sha=$(sha256sum < "out-lib/$name" | cut -d' ' -f1)
(cd out-lib && echo "$sha  $name" > "$name.sha256")
for f in "${files[@]}"; do
    echo "NFX_WEB_LIB_FILE $(sha256sum < "$stage/$f" | cut -d' ' -f1) $(stat -c %s "$stage/$f") $f"
done
echo "NFX_WEB_LIB_COMMIT=$commit"
if [ "$build" = 1 ]; then
    echo "NFX_WEB_LIB_TOOLS=$(rustc -V | cut -d' ' -f1-2), $(wasm-pack -V), $(wasm-bindgen -V), esbuild $lock_esbuild, typescript $lock_tsc, node $(node -v)"
fi
echo "NFX_WEB_LIB_TAR=$here/out-lib/$name"
echo "NFX_WEB_LIB_TAR_BYTES=$(stat -c %s "out-lib/$name")"
echo "NFX_WEB_LIB_TAR_SHA256=$sha"
if [ -n "$expect" ] && [ "$sha" != "$expect" ]; then die "sha256 $sha is not the expected $expect"; fi
