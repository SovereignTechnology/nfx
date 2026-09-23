#!/usr/bin/env bash
# Spike S2 runner: puts hls.js into the frontend, builds, and runs the app against an NFX
# store (a dir of <sha256> files with ../nfx.json beside it, as S4's packager writes).
# Needs a display: WAYLAND_DISPLAY / DISPLAY. Prints JSON lines, then RESULT PASS|FAIL.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
store=${1:?usage: run.sh <store-dir>}
cp "$here/../../../web/spikes/s4-cmaf/node_modules/hls.js/dist/hls.min.js" "$here/ui/hls.min.js"
(cd "$here" && nice -n 10 cargo build --release -j 4)
NFX_STORE=$(cd "$store" && pwd) timeout 120 "$here/target/release/s2-tauri"
