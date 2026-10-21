#!/usr/bin/env bash
# Spike S5': the NAT matrix, in network namespaces. CI only, as root
# (.github/workflows/spike-s5.yml runs it with sudo), never on a developer's machine.
#
#   s5pub  10.200.0.1/24 (bridge): a 5-node HyperDHT testnet and a Node blind relay
#   s5ra   router A: 10.200.0.11 up, 192.168.10.1 down, nft masquerade
#   s5rb   router B: 10.200.0.12 up, 192.168.20.1 down, nft masquerade
#   s5ha   host A 192.168.10.2 behind A, the server
#   s5hb   host B 192.168.20.2 behind B, the client
#
# A "consistent" router masquerades keeping the source port (endpoint-independent
# mapping); a "symmetric" one masquerades fully-random (a new port per destination).
# Unsolicited inbound traffic is dropped by each router's forward chain.
#
# Scenarios, each with all four server/client pairings of rust and node:
#   consistent-consistent  must connect directly (holepunched)
#   symmetric-symmetric    must fail without a relay, and connect through the blind relay
#                          when the server names it (relayThrough / relay_through)
#   consistent-symmetric   informative: hyperdht's random punching; recorded, not judged
# Results: $OUT/nat.jsonl. Exit 1 if a judged check failed.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=${OUT:-$here/results}
mkdir -p "$out"
: > "$out/nat.jsonl"
BYTES=${BYTES_NAT:-8388608}
BOOT=10.200.0.1:49737
RELAY_IP=10.200.0.1
NOOUT='{"ok":false,"error":"no output"}'
NODE=${NODE:-$(command -v node)}
RUST=$here/target/release/s5-hyperdht

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  for n in s5pub s5ra s5rb s5ha s5hb; do ip netns del "$n" 2>/dev/null || true; done
}
trap cleanup EXIT

peer() { # netns impl args...
  local ns=$1 impl=$2
  shift 2
  case $impl in
    rust) ip netns exec "$ns" "$RUST" "$@" ;;
    node) ip netns exec "$ns" "$NODE" "$here/node/peer.js" "$@" ;;
  esac
}
start() { # name netns impl args...  (prints the ready line)
  local name=$1
  shift
  peer "$@" > "$out/$name.out" 2> "$out/$name.err" &
  pids+=($!)
  for _ in $(seq 1 600); do
    [ -s "$out/$name.out" ] && { head -1 "$out/$name.out"; return 0; }
    sleep 0.1
  done
  echo "{\"ok\":false,\"error\":\"$name: no ready line in 60 s\"}"
}
field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], ""))' "$1" "$2"; }

failed=0
record() { # check-name judged(yes|no) expect(ok|fail) json
  local got
  got=$(field "$4" ok)
  python3 -c 'import json,sys; d=json.loads(sys.argv[4]); d.update(check=sys.argv[1], judged=sys.argv[2]=="yes", expect=sys.argv[3]); print(json.dumps(d))' \
    "$1" "$2" "$3" "$4" >> "$out/nat.jsonl"
  local pass=no
  { [ "$3" = ok ] && [ "$got" = True ]; } || { [ "$3" = fail ] && [ "$got" != True ]; } && pass=yes
  if [ "$pass" = yes ]; then echo "PASS $1"
  elif [ "$2" = yes ]; then echo "FAIL $1: $4"; failed=1
  else echo "INFO $1: $4"
  fi
}

router() { # a|b consistent|symmetric
  local r=$1 flags=""
  [ "$2" = symmetric ] && flags="fully-random"
  ip netns exec "s5r$r" nft -f - <<EOF
flush ruleset
table ip nat {
  chain post {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "up-$r" masquerade $flags
  }
}
table inet filter {
  chain fwd {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "down-$r" oifname "up-$r" accept
  }
}
EOF
}

topology() { # mode-a mode-b
  cleanup
  pids=()
  for n in s5pub s5ra s5rb s5ha s5hb; do
    ip netns add "$n"
    ip -n "$n" link set lo up
  done
  ip -n s5pub link add br0 type bridge
  ip -n s5pub addr add 10.200.0.1/24 dev br0
  ip -n s5pub link set br0 up
  local r up lan
  for r in a b; do
    [ "$r" = a ] && { up=10.200.0.11; lan=192.168.10; } || { up=10.200.0.12; lan=192.168.20; }
    ip link add "up-$r" netns "s5r$r" type veth peer name "pub-$r" netns s5pub
    ip -n s5pub link set "pub-$r" master br0 up
    ip -n "s5r$r" addr add "$up/24" dev "up-$r"
    ip -n "s5r$r" link set "up-$r" up
    ip link add "down-$r" netns "s5r$r" type veth peer name eth0 netns "s5h$r"
    ip -n "s5r$r" addr add "$lan.1/24" dev "down-$r"
    ip -n "s5r$r" link set "down-$r" up
    ip -n "s5h$r" addr add "$lan.2/24" dev eth0
    ip -n "s5h$r" link set eth0 up
    ip -n "s5h$r" route add default via "$lan.1"
    ip netns exec "s5r$r" sysctl -qw net.ipv4.ip_forward=1
  done
  router a "$1"
  router b "$2"
  start "testnet-$1-$2" s5pub node testnet --host 10.200.0.1 --port 49737 --size 5 >/dev/null
  RELAY=$(field "$(start "relay-$1-$2" s5pub node relay --bootstrap "$BOOT" --seed s5-relay)" relay)
}

pairings() { # scenario judged expect [--relay]
  local scenario=$1 judged=$2 expect=$3 relay_flag=() server client name ready res
  [ "${4:-}" = --relay ] && relay_flag=(--relay "$RELAY")
  for server in node rust; do
    for client in node rust; do
      name="$scenario-$client-from-$server${4:+-relayed}"
      ready=$(start "serve-$name" s5ha "$server" serve --bootstrap "$BOOT" --seed "server-$name" \
        --bytes "$BYTES" "${relay_flag[@]}")
      # Both peers bound their own runs (node 90 s; rust 60 s to connect, 120 s to finish).
      res=$(peer s5hb "$client" fetch --bootstrap "$BOOT" --seed "client-$name" \
        --peer "$(field "$ready" peer)" --sha "$(field "$ready" sha)" --bytes "$BYTES" \
        2>> "$out/$name.err" || true)
      res=${res:-$NOOUT}
      # Record which path the connection took: through the relay, or straight to router A.
      res=$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); h=d.get("remote_host") or ""; d["path"]="relay" if h.startswith(sys.argv[2]) else ("direct" if h else "unknown"); print(json.dumps(d))' "$res" "$RELAY_IP")
      record "$name" "$judged" "$expect" "$res"
      kill "${pids[-1]}" 2>/dev/null || true
      unset 'pids[-1]'
    done
  done
}

topology consistent consistent
pairings consistent-consistent yes ok

topology symmetric symmetric
pairings symmetric-symmetric yes fail
pairings symmetric-symmetric yes ok --relay

topology consistent symmetric
pairings consistent-symmetric no ok

exit "$failed"
