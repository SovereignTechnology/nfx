#!/usr/bin/env bash
# Build and start the NFX desktop viewer. hls.js is copied from web/player's pinned
# dependency (run `npm ci` there once). Needs a display.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp "$here/../../web/player/node_modules/hls.js/dist/hls.min.js" "$here/ui/hls.min.js"
# The page runs this script with IPC access: only the pinned hls.js 1.7.3 build is used.
hls_sha256=a12e7ee1cd64a69dcdb314157e45dafcba705bfb0b1440b7935cb265d374423e
echo "$hls_sha256  $here/ui/hls.min.js" | sha256sum -c --quiet - \
  || { echo "hls.min.js is not the pinned hls.js 1.7.3 build" >&2; rm -f "$here/ui/hls.min.js"; exit 1; }
(cd "$here" && nice -n 10 cargo build --release --locked -j 4)
exec "$here/target/release/nfx-desktop"
