#!/usr/bin/env bash
# Build and start the NFX desktop viewer. hls.js is copied from web/player's pinned
# dependency (run `npm ci` there once). Needs a display.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cp "$here/../../web/player/node_modules/hls.js/dist/hls.min.js" "$here/ui/hls.min.js"
(cd "$here" && nice -n 10 cargo build --release --locked -j 4)
exec "$here/target/release/nfx-desktop"
