#!/usr/bin/env bash
# The desktop viewer end to end, in a private headless GNOME Shell (nothing appears on
# the user's screen):
#   ffmpeg clip → nfx-package → nfxd seeder with an embedded scoped relay; the app in test
#   mode watches the address before the manifest exists, the manifest is published, the app
#   learns the seeder from a verified beacon, plays over nfx:// with bytes fetched over iroh
#   and verified, and ends up seeding the video itself.
# Every process started here runs in its own session and only those are killed. The work
# dir (throwaway keys included) is removed on exit. Prints RESULT PASS|FAIL.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
crates=$(cd "$here/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/nfx-desktop-e2e-XXXXXX")
# A display name of this run's own: a fixed one would find the socket a killed compositor
# left behind, and the app would dial a dead display.
display="nfx-desktop-e2e-${work##*-}"
runtime=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
chmod 700 "$work"
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
  rm -rf "$work"
  rm -f "$runtime/$display" "$runtime/$display.lock"
}
trap cleanup EXIT

wait_for() { # file pattern seconds
  for _ in $(seq 1 $(( $3 * 5 ))); do grep -qE "$2" "$1" 2>/dev/null && return 0; sleep 0.2; done
  echo "timed out waiting for /$2/ in $1:" >&2; cat "$1" >&2 || true; return 1
}

cargo build --release --locked --manifest-path "$crates/Cargo.toml" -p nfxd -p nfx-media --bins -j 4
bin=$crates/target/release
cp "$crates/../web/player/node_modules/hls.js/dist/hls.min.js" "$here/ui/hls.min.js"
(cd "$here" && nice -n 10 cargo build --release --locked -j 4)

ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 12 -c:v libx264 -preset ultrafast \
  -pix_fmt yuv420p -c:a aac "$work/clip.mp4"
"$bin/nfx-package" "$work/clip.mp4" --video nfx:testnet:1:desktop-e2e-clip --out "$work/pkg" \
  --max-height 720 --preset veryfast > /dev/null
pub=$("$bin/nfxd" key new "$work/creator.key" | head -1)
a="38504:$pub:nfx:testnet:1:desktop-e2e-clip"

# The seeder, with the scoped relay the app will use.
setsid "$bin/nfxd" run --key "$work/creator.key" --store "$work/pkg/store" --seed "$a" \
  --embed-relay 127.0.0.1:0 2> "$work/seeder.log" &
pids+=($!)
wait_for "$work/seeder.log" 'embedded relay: ws://' 30
relay=$(grep -oE 'ws://[0-9.:]+' "$work/seeder.log" | head -1)

# The app, in its own headless compositor.
test_json=$(printf '{"a":"%s","relays":["%s"]}' "$a" "$relay")
setsid dbus-run-session -- bash -c '
  gnome-shell --wayland --no-x11 --headless --virtual-monitor 1280x720 \
    --wayland-display "$4" >/dev/null 2>&1 &
  for _ in $(seq 1 100); do [ -S "$XDG_RUNTIME_DIR/$4" ] && break; sleep 0.2; done
  [ -S "$XDG_RUNTIME_DIR/$4" ] || { echo "the headless compositor never started"; exit 1; }
  WAYLAND_DISPLAY="$4" GDK_BACKEND=wayland NFX_DESKTOP_TEST="$1" \
    NFX_DESKTOP_DATA="$2" "$3"
  echo "EXIT $?"
' _ "$test_json" "$work/app" "$here/target/release/nfx-desktop" "$display" > "$work/app.log" 2>&1 &
pids+=($!)

# Publish once the app is watching, so it sees the seeder's first beacon.
wait_for "$work/app.log" '"step":"watching"' 90
"$bin/nfxd" publish --key "$work/creator.key" --relay "$relay" --package "$work/pkg" \
  --title "Desktop e2e" > /dev/null 2>&1

wait_for "$work/app.log" '^EXIT ' 240 || true
grep -E '^\{|^RESULT' "$work/app.log" || true
if grep -q '^RESULT PASS' "$work/app.log"; then echo "desktop e2e: PASS"; else echo "desktop e2e: FAIL"; exit 1; fi
