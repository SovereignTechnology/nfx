#!/usr/bin/env bash
# web/player/e2e-nat/run.sh: nfx #71 phase 3, browsers behind NATs, with signaling ONLY through
# a stock Nostr relay (strfry) and STUN ONLY from a public nfxd (`nfxd --stun`). No tracker and
# no TURN anywhere. CI only, as root (.github/workflows/nfx-nat-browsers.yml runs it with sudo):
# it makes network namespaces and nftables routers, and never runs on a developer's machine.
#
# The topology and the routers are ported from nutflix-pear's iroh NAT matrix
# (spikes/iroh/nat/run.sh), itself lifted from this repository's spike S5′
# (crates/spikes/s5-hyperdht/nat/run.sh); the public segment is TEST-NET-3:
#
#   nfxpub  203.0.113.1/24 on a bridge: the "internet". strfry (its own default strfry.conf:
#           127.0.0.1:7777, only its database and open-files limit changed) behind TLS on
#           :7443 (the driver's front, as a relay is deployed), and one nfxd: the origin
#           (:8080) and STUN (udp :3478) for a small generated video it seeds
#   nfxra   router A: 203.0.113.11 up, 192.168.10.1 down
#   nfxrb   router B: 203.0.113.12 up, 192.168.20.1 down
#   nfxha   192.168.10.2 behind A: browser A (headless Chromium), the seeder
#   nfxhb   192.168.20.2 behind B: browser B, the viewer
#
# A "consistent" router masquerades keeping the source port (endpoint-independent mapping);
# a "symmetric" one masquerades fully-random. Unsolicited inbound is dropped, with no ICMP
# back. The routers have no default route: nothing leaves the runner.
#
# Each router counts what it forwards between its LAN and the internet (table nfxmeter,
# after its own filter, so only what it delivers): peer_* is UDP to or from the other
# router's public address (the direct path), relay_* the wss relay, stun_* nfxd's STUN,
# origin_* nfxd's origin, other_* anything else. peer_refused counts UDP from the other
# router that it dropped as unsolicited: punch attempts that died at the NAT.
#
# The cells (e2e-nat/driver.ts judges each, one fresh network, relay and nfxd per cell):
#   consistent-consistent  punch     B plays from A with the origin cut at router B; direct
#                                    bytes, srflx ↔ srflx, only signaling and STUN from the
#                                    public side
#   symmetric-symmetric    no-punch  every peer connection ends unconnected within
#                                    FAIL_BOUND_MS; B plays on from the origin
#   consistent-symmetric   record    whatever happens; B plays on
#   browser-nfxd-behind-nat          PLACEHOLDER (phase 2 of #71: nfxd's full ICE agent)
#
# The fail bound (FAIL_BOUND_MS, 30 s): the library gives a punch that cannot work at most its
# ICE gathering (5 s, DEFAULT_ICE_GATHERING_TIMEOUT_MS in src/signal-nostr.ts) before the offer
# goes out, the answerer's own gathering (5 s) and the relay round trip before the answer is
# back, then 15 s (DEFAULT_CONNECTION_TIMEOUT_MS) for ICE, DTLS and the data channel; an
# answerer waits 15 + 5 s from its start. 5 + 5 + 15 = 25 s, and 5 s for the relay round trip
# and a loaded CI runner.
#
# Usage (root): STRFRY=<strfry> STRFRY_CONF=<its strfry.conf> bash e2e-nat/run.sh, after
# `npm run build` and `cargo build -p nfxd -p nfx-media --bins` (NFXD, NFX_PACKAGE override
# the debug binaries). Results: $OUT (default e2e-nat/results): nat-browsers.jsonl, one line per
# cell; results.md, the table; per cell <cell>.json, <cell>-diag.json and the processes' logs.
# Exit 1 if a judged cell failed.
#
# The driver calls back for the routers: `run.sh meter a|b` prints a router's counters as JSON,
# `run.sh cut b` cuts router B's path to the origin.
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
player=$(cd "$here/.." && pwd)
repo=$(cd "$player/../.." && pwd)

PUB_IP=203.0.113.1
RA_IP=203.0.113.11
RB_IP=203.0.113.12
ORIGIN_PORT=8080
STUN_PORT=3478
RELAY_TLS_PORT=7443
STRFRY_PORT=7777 # strfry.conf's own default, on the public namespace's loopback
NAMESPACES="nfxpub nfxra nfxrb nfxha nfxhb"
FAIL_BOUND_MS=${FAIL_BOUND_MS:-30000}

# --- routers ------------------------------------------------------------------------------------
router() { # a|b consistent|symmetric
  local r=$1 flags=""
  case $2 in
    consistent) ;;
    symmetric) flags="fully-random" ;;
    *) echo "router: $2?" >&2; return 1 ;;
  esac
  ip netns exec "nfxr$r" nft -f - <<EOF
flush ruleset
table ip nat {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "up-$r" masquerade $flags
  }
}
table inet filter {
  # A real NAT answers nothing unsolicited: drop it, so no ICMP unreachable goes back.
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "up-$r" ct state new drop
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "down-$r" oifname "up-$r" accept
  }
}
EOF
}

# The byte meter, beside the NAT tables. "delivered" runs after the router's own forward
# chain, so it sees only what the router passed; "refused" sees unsolicited UDP from the other
# router before the router's input chain drops it.
meter_install() { # a|b
  local r=$1 peer
  if [ "$r" = a ]; then peer=$RB_IP; else peer=$RA_IP; fi
  ip netns exec "nfxr$r" nft -f - <<EOF
table inet nfxmeter {
  counter peer_in {}
  counter peer_out {}
  counter relay_in {}
  counter relay_out {}
  counter stun_in {}
  counter stun_out {}
  counter origin_in {}
  counter origin_out {}
  counter other_in {}
  counter other_out {}
  counter peer_refused {}
  chain delivered {
    type filter hook forward priority filter + 10; policy accept;
    iifname "up-$r" ip saddr $peer meta l4proto udp counter name peer_in accept
    oifname "up-$r" ip daddr $peer meta l4proto udp counter name peer_out accept
    iifname "up-$r" ip saddr $PUB_IP tcp sport $RELAY_TLS_PORT counter name relay_in accept
    oifname "up-$r" ip daddr $PUB_IP tcp dport $RELAY_TLS_PORT counter name relay_out accept
    iifname "up-$r" ip saddr $PUB_IP udp sport $STUN_PORT counter name stun_in accept
    oifname "up-$r" ip daddr $PUB_IP udp dport $STUN_PORT counter name stun_out accept
    iifname "up-$r" ip saddr $PUB_IP tcp sport $ORIGIN_PORT counter name origin_in accept
    oifname "up-$r" ip daddr $PUB_IP tcp dport $ORIGIN_PORT counter name origin_out accept
    iifname "up-$r" counter name other_in
    oifname "up-$r" counter name other_out
  }
  chain refused {
    type filter hook input priority filter - 10; policy accept;
    iifname "up-$r" ip saddr $peer meta l4proto udp ct state new counter name peer_refused
  }
}
EOF
}

# A router's counters as {"name": bytes}, the cut's included once it is there.
meter_read() { # a|b
  local r=$1
  {
    ip netns exec "nfxr$r" nft -j list counters table inet nfxmeter
    ip netns exec "nfxr$r" nft -j list counters table inet nfxcut 2> /dev/null || true
  } | python3 -I -c 'import json,sys
c={}
for line in sys.stdin:
    if not line.strip(): continue
    for o in json.loads(line).get("nftables",[]):
        k=o.get("counter")
        if k: c[k["name"]]=k.get("bytes",0)
print(json.dumps(c))'
}

# Router B refuses B's path to the origin: B's packets to it get a reset, and whatever the
# origin still sends is dropped, so even a response in flight stops. Before the meter (which
# then sees none of it); the cut's own counters record B's attempts.
cut_origin() { # b
  ip netns exec "nfxr$1" nft -f - <<EOF
table inet nfxcut {
  counter origin_cut_out {}
  counter origin_cut_in {}
  chain forward {
    type filter hook forward priority filter - 20; policy accept;
    iifname "down-$1" ip daddr $PUB_IP tcp dport $ORIGIN_PORT counter name origin_cut_out reject with tcp reset
    iifname "up-$1" ip saddr $PUB_IP tcp sport $ORIGIN_PORT counter name origin_cut_in drop
  }
}
EOF
}

case ${1:-} in
  meter) [[ ${2:-} =~ ^[ab]$ ]] || { echo "run.sh meter a|b" >&2; exit 2; }; meter_read "$2"; exit ;;
  cut) [ "${2:-}" = b ] || { echo "run.sh cut b" >&2; exit 2; }; cut_origin b; exit ;;
  "") ;;
  *) echo "usage: run.sh | run.sh meter a|b | run.sh cut b" >&2; exit 2 ;;
esac

# --- the run --------------------------------------------------------------------------------
[ "$(id -u)" = 0 ] || { echo "run.sh: root only (network namespaces, nftables)" >&2; exit 2; }
NFXD=${NFXD:-$repo/crates/target/debug/nfxd}
NFX_PACKAGE=${NFX_PACKAGE:-$repo/crates/target/debug/nfx-package}
STRFRY=${STRFRY:?the strfry binary (e2e-strfry.sh prints it)}
STRFRY_CONF=${STRFRY_CONF:?strfry.conf from the same strfry checkout (its defaults)}
TSX=${TSX:-$player/node_modules/.bin/tsx}
FFMPEG=${FFMPEG:-ffmpeg}
out=${OUT:-$here/results}
work=${WORK:-$(mktemp -d)}
for b in "$NFXD" "$NFX_PACKAGE" "$STRFRY" "$TSX"; do [ -x "$b" ] || { echo "run.sh: $b is not executable" >&2; exit 2; }; done
for c in ip nft openssl python3 node "$FFMPEG"; do command -v "$c" > /dev/null || { echo "run.sh: no $c" >&2; exit 2; }; done
[ -f "$player/out/player.js" ] && [ -f "$player/out/wasm/nfx_wasm_bg.wasm" ] || { echo "run.sh: run npm run build first" >&2; exit 2; }
mkdir -p "$out" "$work"
: > "$out/nat-browsers.jsonl"

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2> /dev/null || true; done
  sleep 0.5
  for p in "${pids[@]}"; do kill -KILL -- "-$p" 2> /dev/null || true; done
  for n in $NAMESPACES; do ip netns del "$n" 2> /dev/null || true; done
}
trap cleanup EXIT

# start NAME NETNS CMD...: in its own session (so its whole group can be stopped), output to
# $out/NAME.{out,err}; its pid is the last entry of pids.
start() {
  local name=$1 ns=$2
  shift 2
  setsid ip netns exec "$ns" "$@" > "$out/$name.out" 2> "$out/$name.err" &
  pids+=($!)
}
stop() { # pid
  kill -TERM -- "-$1" 2> /dev/null || true
  for _ in $(seq 1 50); do kill -0 "$1" 2> /dev/null || return 0; sleep 0.1; done
  kill -KILL -- "-$1" 2> /dev/null || true
}
wait_for() { # file pattern seconds
  for _ in $(seq 1 $(($3 * 10))); do grep -qE "$2" "$1" 2> /dev/null && return 0; sleep 0.1; done
  return 1
}
wait_port() { # netns ip port seconds
  for _ in $(seq 1 $(($4 * 10))); do
    ip netns exec "$1" bash -c "exec 3<>/dev/tcp/$2/$3" 2> /dev/null && return 0
    sleep 0.1
  done
  return 1
}
json() { python3 -I -c "$1" "${@:2}"; }

topology() { # mode-a mode-b
  local n r up lan
  for n in $NAMESPACES; do ip netns del "$n" 2> /dev/null || true; done
  for n in $NAMESPACES; do
    ip netns add "$n"
    ip -n "$n" link set lo up
  done
  ip -n nfxpub link add br0 type bridge
  ip -n nfxpub addr add "$PUB_IP/24" dev br0
  ip -n nfxpub link set br0 up
  for r in a b; do
    if [ "$r" = a ]; then up=$RA_IP lan=192.168.10; else up=$RB_IP lan=192.168.20; fi
    ip link add "up-$r" netns "nfxr$r" type veth peer name "pub-$r" netns nfxpub
    ip -n nfxpub link set "pub-$r" master br0 up
    ip -n "nfxr$r" addr add "$up/24" dev "up-$r"
    ip -n "nfxr$r" link set "up-$r" up
    ip link add "down-$r" netns "nfxr$r" type veth peer name eth0 netns "nfxh$r"
    ip -n "nfxr$r" addr add "$lan.1/24" dev "down-$r"
    ip -n "nfxr$r" link set "down-$r" up
    ip -n "nfxh$r" addr add "$lan.2/24" dev eth0
    ip -n "nfxh$r" link set eth0 up
    ip -n "nfxh$r" route add default via "$lan.1"
    ip netns exec "nfxr$r" sysctl -qw net.ipv4.ip_forward=1
    ip netns exec "nfxr$r" sysctl -qw net.ipv4.conf.all.rp_filter=0
  done
  router a "$1"
  router b "$2"
  meter_install a
  meter_install b
}

# strfry's own default strfry.conf with only the database and the open-files limit changed
# (as e2e-nostr.ts); it fails unless each was found once and the defaults bind 127.0.0.1:7777.
strfry_conf() { # dir
  local conf=$1/strfry.conf
  sed -e "s|^db = \"\./strfry-db/\"\$|db = \"$1/strfry-db/\"|" \
    -e 's|^\( *\)nofiles = [0-9][0-9]*$|\1nofiles = 0|' "$STRFRY_CONF" > "$conf"
  [ "$(grep -cxF "db = \"$1/strfry-db/\"" "$conf")" = 1 ] &&
    [ "$(grep -cE '^ *nofiles = 0$' "$conf")" = 1 ] &&
    [ "$(grep -cE '^ *bind = "127\.0\.0\.1"$' "$conf")" = 1 ] &&
    [ "$(grep -cE "^ *port = $STRFRY_PORT\$" "$conf")" = 1 ] ||
    { echo "strfry.conf: db or nofiles not found once, or not bound to 127.0.0.1:$STRFRY_PORT" >&2; return 1; }
}

# The public side of a cell: a fresh strfry and a fresh nfxd seeding the video (origin and
# STUN on the public address; an embedded relay on loopback, only to publish the manifest it
# seeds, never given to a page). Sets A_ADDR.
public_up() { # dir name
  local d=$1 name=$2 pubkey nodeRelay
  mkdir -p "$d/strfry-db"
  strfry_conf "$d" || return 1
  start "$name-strfry" nfxpub "$STRFRY" --config="$d/strfry.conf" relay
  wait_port nfxpub 127.0.0.1 "$STRFRY_PORT" 30 || { echo "strfry is not listening" >&2; return 1; }
  pubkey=$("$NFXD" key new "$d/node.key" | head -1)
  A_ADDR="38504:$pubkey:$VIDEO"
  cp -r "$work/pkg/store" "$d/store"
  start "$name-nfxd" nfxpub "$NFXD" run --key "$d/node.key" --store "$d/store" --state "$d/state" \
    --seed "$A_ADDR" --embed-relay 127.0.0.1:0 --origin "$PUB_IP:$ORIGIN_PORT" --stun "$PUB_IP:$STUN_PORT"
  wait_for "$out/$name-nfxd.err" 'embedded relay: ws://' 30 || { echo "nfxd: no embedded relay" >&2; return 1; }
  wait_for "$out/$name-nfxd.err" "stun: udp $PUB_IP:$STUN_PORT" 30 || { echo "nfxd: no STUN on $PUB_IP:$STUN_PORT" >&2; return 1; }
  if grep -q 'embedded tracker' "$out/$name-nfxd.err"; then echo "nfxd started a tracker" >&2; return 1; fi
  nodeRelay=$(grep -oE 'embedded relay: ws://[^ ]+' "$out/$name-nfxd.err" | head -1 | cut -d' ' -f3)
  ip netns exec nfxpub "$NFXD" publish --key "$d/node.key" --relay "$nodeRelay" --package "$work/pkg" \
    --title "NAT browsers" > /dev/null 2>> "$out/$name-publish.err" || { echo "nfxd publish failed" >&2; return 1; }
  wait_for "$out/$name-nfxd.err" "$A_ADDR: Seeding" 60 || { echo "nfxd never seeding" >&2; return 1; }
  wait_port nfxpub "$PUB_IP" "$ORIGIN_PORT" 10 || { echo "no origin on $PUB_IP:$ORIGIN_PORT" >&2; return 1; }
}

failed=0
# record LINE: append a cell's result and print its verdict.
record() {
  local line=$1 verdict
  echo "$line" >> "$out/nat-browsers.jsonl"
  verdict=$(json 'import json,sys; d=json.loads(sys.argv[1]); print("SKIP" if d.get("skipped") else "PASS" if d.get("passed") else "FAIL" if d.get("judged") else "INFO")' "$line")
  echo "$verdict ${line:0:2000}"
  [ "$verdict" != FAIL ] || failed=1
}

cell() { # NAME MODE-A MODE-B EXPECT
  local name=$1 d="$work/$1" rc=0 i mark=${#pids[@]}
  mkdir -p "$d"
  echo "== $name: router A $2, router B $3, expect $4"
  topology "$2" "$3"
  for i in a b; do ip netns exec "nfxr$i" nft list ruleset > "$out/$name-router-$i.nft"; done
  if ! public_up "$d" "$name" 2> "$out/$name-harness.err"; then
    record "$(json 'import json,sys; print(json.dumps({"cell":sys.argv[1],"judged":True,"passed":False,"problems":["harness: "+open(sys.argv[2]).read().strip()[-400:]]}))' "$name" "$out/$name-harness.err")"
  else
    rm -f "$out/$name.json"
    timeout -k 10 900 ip netns exec nfxpub env \
      NAT_CELL="$name" NAT_EXPECT="$4" NAT_A="$2" NAT_B="$3" NAT_PUB_IP="$PUB_IP" \
      NAT_ROUTER_A_IP="$RA_IP" NAT_ROUTER_B_IP="$RB_IP" NAT_NS_A=nfxha NAT_NS_B=nfxhb \
      NAT_ORIGIN_PORT="$ORIGIN_PORT" NAT_STUN_PORT="$STUN_PORT" NAT_RELAY_TLS_PORT="$RELAY_TLS_PORT" \
      NAT_STRFRY_PORT="$STRFRY_PORT" NAT_ROOT="$ROOT" NAT_CTL="$here/run.sh" NAT_OUT="$out" \
      NAT_FAIL_BOUND_MS="$FAIL_BOUND_MS" NAT_TLS_KEY="$work/tls/relay.key" NAT_TLS_CERT="$work/tls/relay.crt" \
      NAT_TLS_SPKI="$SPKI" "$TSX" "$here/driver.ts" > "$out/$name-driver.out" 2> "$out/$name-driver.err" || rc=$?
    if [ -s "$out/$name.json" ]; then
      record "$(json 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$out/$name.json")"
    else
      record "$(json 'import json,sys; print(json.dumps({"cell":sys.argv[1],"judged":True,"passed":False,"problems":["harness: the driver exited %s with no result: %s" % (sys.argv[2], open(sys.argv[3]).read()[-600:])]}))' "$name" "$rc" "$out/$name-driver.err")"
    fi
  fi
  for ((i = ${#pids[@]} - 1; i >= mark; i--)); do stop "${pids[$i]}"; unset "pids[$i]"; done
  pids=("${pids[@]}")
}

# The cell phase 2 of #71 adds: a browser and an nfxd, each behind a consistent NAT, exchanging
# segments in both directions, signaled over the same relay. It needs nfxd's full ICE agent
# (str0m with its own candidates from the portmapper or STUN, and the Nostr signaler); today
# nfxd speaks WebRTC only as an ICE-lite bridge on a public address. Recorded as skipped, never
# as a pass, until then.
cell_browser_nfxd_placeholder() {
  local why="PLACEHOLDER: phase 2 of #71 (nfxd's full ICE agent with Nostr signaling) is not built; nfxd answers browsers only as a public ICE-lite bridge"
  record "$(json 'import json,sys; print(json.dumps({"cell":"browser-nfxd-behind-nat","nat_a":"consistent","nat_b":"consistent","expect":"punch, both directions","skipped":True,"judged":False,"reason":sys.argv[1]}))' "$why")"
  echo "::notice title=NAT browsers: browser-nfxd-behind-nat skipped::$why"
}

# --- the content: one clip, packaged once ---------------------------------------------------
VIDEO="nfx:testnet:1:nat-browsers"
"$FFMPEG" -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 60 -c:v libx264 -preset ultrafast \
  -pix_fmt yuv420p -c:a aac "$work/clip.mp4"
"$NFX_PACKAGE" "$work/clip.mp4" --video "$VIDEO" --out "$work/pkg" --max-height 720 --preset veryfast > "$out/package.json"
ROOT=$(json 'import json,sys; print(json.load(open(sys.argv[1]))["root"])' "$work/pkg/nfx.json")

# --- the relay's TLS: a CI-only CA and a certificate for the public address; browsers pin
# the certificate's key (--ignore-certificate-errors-spki-list), nothing else -------------
t=$work/tls
mkdir -p "$t"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -subj "/CN=nfx NAT browsers CI CA" -keyout "$t/ca.key" -out "$t/ca.crt" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2> /dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$PUB_IP" \
  -keyout "$t/relay.key" -out "$t/relay.csr" 2> /dev/null
printf 'subjectAltName=IP:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n' \
  "$PUB_IP" > "$t/ext.cnf"
openssl x509 -req -in "$t/relay.csr" -CA "$t/ca.crt" -CAkey "$t/ca.key" -CAcreateserial \
  -days 2 -extfile "$t/ext.cnf" -out "$t/relay.crt" 2> /dev/null
SPKI=$(openssl x509 -in "$t/relay.crt" -pubkey -noout | openssl pkey -pubin -outform der |
  openssl dgst -sha256 -binary | base64)
echo "content: root $ROOT; relay key sha256/$SPKI"

cell consistent-consistent consistent consistent punch
cell symmetric-symmetric symmetric symmetric no-punch
cell consistent-symmetric consistent symmetric record
cell_browser_nfxd_placeholder

# --- the table --------------------------------------------------------------------------------
json 'import json,sys
rows=[("cell","NAT A / NAT B","expect","outcome","UDP A→B: delivered (refused)","UDP B→A: delivered (refused)","to connect / to fail","B selected pair","verdict")]
notes=[]
for line in open(sys.argv[1]):
    d=json.loads(line)
    if d.get("skipped"):
        rows.append((d["cell"],"%s / %s"%(d.get("nat_a"),d.get("nat_b")),d.get("expect","-"),"-","-","-","-","-","SKIP (placeholder)"))
        notes.append("%s: %s"%(d["cell"],d.get("reason","")))
        continue
    t="-"
    if d.get("connect_ms") is not None: t="connected in %d ms"%d["connect_ms"]
    elif d.get("fail_ms") is not None: t="failed in %d ms (%s)"%(d["fail_ms"],d.get("library_reason") or d.get("fail_reason") or "?")
    pair="-"
    for p in d.get("pairs_b") or []:
        c=lambda x:"%s %s"%(x.get("type"),x.get("address")) if x else "?"
        pair="%s ↔ %s"%(c(p.get("local")),c(p.get("remote")))
        break
    verdict="PASS" if d.get("passed") else ("FAIL" if d.get("judged") else "info")
    u=lambda k:"%s (%s)"%(d[k]["delivered"],d[k]["refused"]) if d.get(k) else "-"
    rows.append((d["cell"],"%s / %s"%(d.get("nat_a","?"),d.get("nat_b","?")),d.get("expect","?"),str(d.get("outcome","-")),
                 u("udp_a_to_b"),u("udp_b_to_a"),t,pair,verdict))
    for p in d.get("problems") or []: notes.append("%s: %s"%(d["cell"],p))
print("| "+" | ".join(rows[0])+" |")
print("|"+"---|"*len(rows[0]))
for r in rows[1:]: print("| "+" | ".join(x.replace("|","/") for x in r)+" |")
print()
print("UDP A→B / B→A: bytes between the public addresses of the two routers while B played, as the"
      +" receiving router counted them: delivered into its LAN, or (in brackets) refused as unsolicited."
      +" Fail bound for a punch that cannot work: %s ms from the peer connection to its end."%sys.argv[2])
if notes:
    print()
    for n in notes: print("- "+n.replace("|","/")[:600])' "$out/nat-browsers.jsonl" "$FAIL_BOUND_MS" | tee "$out/results.md"
exit "$failed"
