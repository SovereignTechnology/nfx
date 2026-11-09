#!/usr/bin/env bash
# web/player/e2e-strfry.sh <dir>: build the stock Nostr relay e2e-nostr.ts signals through:
# strfry 1.1.3 (released 2026-09-04) at the commit its tag names, with the submodule commits
# that tree records, built with its own Makefile, as nutflix-pear's spike-iroh.yml and
# web-site.yml pin it. It prints the two variables e2e-nostr.ts reads:
#
#   eval "$(bash e2e-strfry.sh /var/tmp/strfry)"; npm run e2e:nostr
#
# strfry's own default strfry.conf is used as it is; e2e-nostr.ts changes only its database
# path, port and open-files limit. Needs git, a C++ toolchain and strfry's libraries (Debian:
# g++ make pkg-config libtool libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev
# libsecp256k1-dev libzstd-dev) and the network, once.
set -euo pipefail
STRFRY_SHA=16c00df04e264f4d68db5e10a48127f015c7824b
dir=${1:?usage: bash e2e-strfry.sh <dir>}
src="$dir/strfry-$STRFRY_SHA"
if [ ! -x "$src/strfry" ]; then
    rm -rf "$src" && mkdir -p "$src"
    git -C "$src" init -q
    git -C "$src" fetch -q --depth 1 https://github.com/hoytech/strfry.git "$STRFRY_SHA"
    git -C "$src" checkout -q --detach FETCH_HEAD
    [ "$(git -C "$src" rev-parse HEAD)" = "$STRFRY_SHA" ] || { echo "e2e-strfry: not $STRFRY_SHA" >&2; exit 1; }
    git -C "$src" submodule -q update --init --recursive --depth 1
    make -C "$src" setup-golpe >&2
    # strfry's translation units take up to ~2 GiB each to compile: one job per 2 GiB free.
    jobs=$(awk '/MemAvailable/ {print int($2 / 2097152)}' /proc/meminfo)
    [ "$jobs" -ge 1 ] || jobs=1
    [ "$jobs" -le "$(nproc)" ] || jobs=$(nproc)
    make -C "$src" -j"$jobs" >&2
fi
echo "export STRFRY='$src/strfry' STRFRY_CONF='$src/strfry.conf'"
