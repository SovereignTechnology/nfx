#!/usr/bin/env bash
# Execution plan §0 rule 6: "Vendored docs, not memory." Refresh at the start of each stage.
#
# Pulls the upstream specs and READMEs every lane must read into docs/vendor/, and writes
# docs/vendor/MANIFEST.txt with source URL + sha256 + fetch date per file so drift is
# visible in git. Package READMEs are taken from the exact npm version pinned in
# docs/vendor/versions.txt (so the vendored doc matches what `npm ci` installs).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
out=docs/vendor
mkdir -p "$out"
manifest="$out/MANIFEST.txt"
: > "$manifest.tmp"
date=$(date -u +%Y-%m-%d)

fetch() { # <dest> <url>
  local dest="$1" url="$2"
  if curl -fsSL --retry 3 -o "$out/$dest" "$url"; then
    printf '%s\t%s\t%s\t%s\n' "$dest" "$(sha256sum "$out/$dest" | cut -c1-16)" "$date" "$url" >> "$manifest.tmp"
  else
    echo "WARN: failed $url" >&2
    printf '%s\tFAILED\t%s\t%s\n' "$dest" "$date" "$url" >> "$manifest.tmp"
  fi
}

# npm package README at a pinned version (source of truth for the API we call)
npmdoc() { # <pkg> <version> <dest>
  local pkg="$1" ver="$2" dest="$3" tmp
  tmp=$(mktemp -d)
  if curl -fsSL "$(npm view "$pkg@$ver" dist.tarball)" | tar xz -C "$tmp" 2>/dev/null && [[ -f "$tmp/package/README.md" ]]; then
    { echo "<!-- vendored from npm $pkg@$ver on $date -->"; cat "$tmp/package/README.md"; } > "$out/$dest"
    printf '%s\t%s\t%s\tnpm:%s@%s\n' "$dest" "$(sha256sum "$out/$dest" | cut -c1-16)" "$date" "$pkg" "$ver" >> "$manifest.tmp"
  else
    echo "WARN: no README for $pkg@$ver" >&2
    printf '%s\tFAILED\t%s\tnpm:%s@%s\n' "$dest" "$date" "$pkg" "$ver" >> "$manifest.tmp"
  fi
  rm -rf "$tmp"
}

# ---- Pear docs (live site content is on the `published` branch, as .mdx) -------------
PEAR=https://raw.githubusercontent.com/holepunchto/pear-docs/published
PC=$PEAR/content
fetch pear-stream-stored-video.md "$PC/how-to/stream-and-share-media/stream-stored-video-in-a-peer-to-peer-app.mdx"
fetch pear-store-and-serve-large-media-with-hyperblobs.md "$PC/how-to/stream-and-share-media/store-and-serve-large-media-with-hyperblobs.mdx"
fetch pear-stream-live-camera.md "$PC/how-to/stream-and-share-media/stream-a-live-camera-in-a-peer-to-peer-app.mdx"
fetch pear-desktop-architecture.md "$PC/explanation/pear-desktop-architecture.mdx"
fetch pear-workers.md "$PC/explanation/workers.mdx"
fetch pear-start-from-hello-pear-electron.md "$PC/getting-started/from-a-template/start-from-hello-pear-electron.mdx"
fetch pear-modules.md "$PC/reference/modules/pear-modules.mdx"
fetch bare-modules.md "$PC/reference/modules/bare-modules.mdx"
fetch bare-subprocess-reference.md "$PC/reference/bare/modules/bare-subprocess.mdx"
fetch pear-ref-hypercore.md "$PC/reference/building-blocks/hypercore.mdx"
fetch pear-ref-hyperswarm.md "$PC/reference/building-blocks/hyperswarm.mdx"
fetch pear-ref-corestore.md "$PC/reference/helpers/corestore.mdx"
fetch pear-ref-protomux.md "$PC/reference/helpers/protomux.mdx"
fetch pear-ref-compact-encoding.md "$PC/reference/helpers/compact-encoding.mdx"
# Example code the guides refer to
mkdir -p "$out/examples/hyperblobs-writer" "$out/examples/hyperblobs-reader" "$out/examples/hello-pear-electron/renderer" "$out/examples/hello-pear-electron/workers"
EX=$PEAR/examples
fetch examples/hyperblobs-writer/index.js "$EX/how-to/stream-and-share-media/store-and-serve-large-media-with-hyperblobs/writer-app/index.js"
fetch examples/hyperblobs-writer/package.json "$EX/how-to/stream-and-share-media/store-and-serve-large-media-with-hyperblobs/writer-app/package.json"
fetch examples/hyperblobs-reader/index.js "$EX/how-to/stream-and-share-media/store-and-serve-large-media-with-hyperblobs/reader-app/index.js"
fetch examples/hyperblobs-reader/package.json "$EX/how-to/stream-and-share-media/store-and-serve-large-media-with-hyperblobs/reader-app/package.json"
fetch examples/hello-pear-electron/README.md "$EX/getting-started/hello-pear-electron/README.md"
fetch examples/hello-pear-electron/renderer/app.js "$EX/getting-started/hello-pear-electron/renderer/app.js"
fetch examples/hello-pear-electron/workers/main.js "$EX/getting-started/hello-pear-electron/workers/main.js"
# The stream-stored-video reference app (pear-video-stream) lives on the `preview` branch.
VS=https://raw.githubusercontent.com/holepunchto/pear-docs/preview/examples/how-to/stream-and-share-media/video-stream
mkdir -p "$out/examples/video-stream/electron" "$out/examples/video-stream/workers" "$out/examples/video-stream/renderer"
for f in README.md package.json pear.json schema.js electron/main.js electron/preload.js renderer/app.js renderer/index.html workers/index.js workers/main.js workers/video-room.js workers/worker-task.js; do
  fetch "examples/video-stream/$f" "$VS/$f"
done

# ---- Hypercore stack (pinned versions from versions.txt) --------------------------
while IFS='=' read -r pkg ver; do
  [[ -z "$pkg" || "$pkg" == \#* ]] && continue
  npmdoc "$pkg" "$ver" "$(echo "$pkg" | tr '@/' '__' | sed 's/^_//').md"
done < "$out/versions.txt"

# ---- Blossom BUDs -----------------------------------------------------------------
BUD=https://raw.githubusercontent.com/hzrd149/blossom/master/buds
for n in 01 02 03 04 06 09; do fetch "BUD-$n.md" "$BUD/$n.md"; done

# ---- NIPs -------------------------------------------------------------------------
NIP=https://raw.githubusercontent.com/nostr-protocol/nips/master
for n in 01 05 07 22 25 44 46 50 51 56 60 61 65 71 92; do fetch "NIP-$n.md" "$NIP/$n.md"; done

# ---- NUTs -------------------------------------------------------------------------
NUT=https://raw.githubusercontent.com/cashubtc/nuts/main
for n in 00 03 04 05 10 11 12; do fetch "NUT-$n.md" "$NUT/$n.md"; done

{
  echo "# docs/vendor manifest — generated by scripts/vendor-docs.sh; do not edit"
  echo "# file	sha256[:16]	fetched	source"
  sort "$manifest.tmp"
} > "$manifest"
rm -f "$manifest.tmp"
echo "vendored $(grep -vc '^#' "$manifest") docs; $(grep -c FAILED "$manifest" || true) failed"
