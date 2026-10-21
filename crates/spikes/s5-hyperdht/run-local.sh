#!/usr/bin/env bash
# Spike S5': the local interop matrix, on a loopback HyperDHT testnet. CI only
# (.github/workflows/spike-s5.yml), never on a developer's machine.
#
# Every pairing of the Rust peer (peeroxide-dht) and the Node peer (hyperdht 6.34) fetches a
# 64 MiB file over NFX-12 files/1 with a pay/1 exchange beside it, then:
#   - firewall: a server that admits no key refuses the client;
#   - liveness: a 1 s keepalive keeps an idle connection past a 3 s server timeout, and no
#     keepalive lets the timeout close it.
# Results: $OUT/local.jsonl, one JSON line per check. Exit 1 if any check failed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${OUT:-$here/results}
mkdir -p "$out"
: > "$out/local.jsonl"
BYTES=${BYTES:-67108864}
BOOT=127.0.0.1:49737
NOOUT='{"ok":false,"error":"no output"}'

peer() { # impl role args...
  local impl=$1
  shift
  case $impl in
    rust) "$here/target/release/s5-hyperdht" "$@" ;;
    node) node "$here/node/peer.js" "$@" ;;
  esac
}

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# Start a long-running role in the background, in this shell (never inside $(…), whose subshell
# would keep the pid to itself), and wait for its ready line; ready NAME prints that line.
start() { # name impl role args...
  local name=$1
  shift
  peer "$@" > "$out/$name.out" 2> "$out/$name.err" &
  pids+=($!)
  for _ in $(seq 1 600); do
    [ -s "$out/$name.out" ] && return 0
    sleep 0.1
  done
  echo "{\"role\":\"$name\",\"ok\":false,\"error\":\"no ready line in 60 s\"}" > "$out/$name.out"
}
ready() { head -1 "$out/$1.out"; }
stop() { kill "${pids[-1]}" 2>/dev/null || true; wait "${pids[-1]}" 2>/dev/null || true; unset 'pids[-1]'; }
field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$1" "$2"; }

failed=0
record() { # check-name json
  local ok
  ok=$(field "$2" ok)
  python3 -c 'import json,sys; d=json.loads(sys.argv[2]); d["check"]=sys.argv[1]; print(json.dumps(d))' "$1" "$2" >> "$out/local.jsonl"
  if [ "$ok" = True ]; then echo "PASS $1"; else echo "FAIL $1: $2"; failed=1; fi
}

start testnet node testnet --host 127.0.0.1 --port 49737 --size 3

for server in node rust; do
  for client in node rust; do
    name="fetch-$client-from-$server"
    start "serve-$name" "$server" serve --host 127.0.0.1 --bootstrap "$BOOT" --seed "server-$name" --bytes "$BYTES"
    ready=$(ready "serve-$name")
    res=$(peer "$client" fetch --host 127.0.0.1 --bootstrap "$BOOT" --seed "client-$name" \
      --peer "$(field "$ready" peer)" --sha "$(field "$ready" sha)" --bytes "$BYTES" 2>> "$out/$name.err" || true)
    record "$name" "${res:-$NOOUT}"
    stop

    name="refused-$client-by-$server"
    start "serve-$name" "$server" serve --host 127.0.0.1 --bootstrap "$BOOT" --seed "server-$name" --bytes 1024 \
      --allow 0000000000000000000000000000000000000000000000000000000000000000
    ready=$(ready "serve-$name")
    res=$(peer "$client" fetch --host 127.0.0.1 --bootstrap "$BOOT" --seed "client-$name" --expect-refused \
      --peer "$(field "$ready" peer)" --sha "$(field "$ready" sha)" --bytes 1024 2>> "$out/$name.err" || true)
    record "$name" "${res:-$NOOUT}"
    stop

    name="keepalive-$client-to-$server"
    start "serve-$name" "$server" serve --host 127.0.0.1 --bootstrap "$BOOT" --seed "server-$name" --bytes 1024 --timeout-ms 3000
    ready=$(ready "serve-$name")
    res=$(peer "$client" fetch --host 127.0.0.1 --bootstrap "$BOOT" --seed "client-$name" --keepalive-ms 1000 --idle-ms 6000 \
      --peer "$(field "$ready" peer)" --sha "$(field "$ready" sha)" --bytes 1024 2>> "$out/$name.err" || true)
    record "$name" "${res:-$NOOUT}"
    stop

    name="timeout-$client-at-$server"
    start "serve-$name" "$server" serve --host 127.0.0.1 --bootstrap "$BOOT" --seed "server-$name" --bytes 1024 --timeout-ms 3000
    ready=$(ready "serve-$name")
    res=$(peer "$client" fetch --host 127.0.0.1 --bootstrap "$BOOT" --seed "client-$name" --keepalive-ms 0 --idle-ms 9000 --expect-closed \
      --peer "$(field "$ready" peer)" --sha "$(field "$ready" sha)" --bytes 1024 2>> "$out/$name.err" || true)
    record "$name" "${res:-$NOOUT}"
    stop
  done
done

exit "$failed"
