#!/usr/bin/env bash
# Empirical check of the systemd hardening set against the JS runtime — build-plan §7:
# "test MemoryDenyWriteExecute against the JS engine's JIT".
#
# Runs in USER scope (`systemd-run --user`), so it needs no sudo and works on a developer
# laptop or in a CI job with a user systemd instance. It exercises exactly the directives
# from nutflix-seeder.service that the user manager can apply (MemoryDenyWriteExecute, the
# seccomp-based filters, RestrictAddressFamilies, LockPersonality, RestrictRealtime,
# RestrictNamespaces, RestrictSUIDSGID, UMask). ProtectSystem/ProtectHome/PrivateTmp/
# CapabilityBoundingSet need a system manager and are NOT exercised here.
#
# Run from the repo root after `npm ci --ignore-scripts` (needs node_modules for the
# native modules + hyperdht): bash deploy/systemd/test-hardening.sh
# Re-run on every Node major bump and every change to the units. Expected results and the
# reasoning are in MDWE-RESULTS.md; the last run's table is appended there by hand.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
NODE="${NODE:-$(command -v node)}"
[[ -x "$NODE" ]] || { echo "node not found"; exit 2; }
[[ -d node_modules/sodium-native ]] || { echo "run npm ci --ignore-scripts first"; exit 2; }
if ! systemctl --user is-system-running --quiet 2>/dev/null; then
  echo "no user systemd instance; cannot run systemd-run --user"; exit 2
fi

# The portable subset of nutflix-seeder.service's [Service] hardening.
FILTER=(
  -p SystemCallArchitectures=native
  -p SystemCallFilter=@system-service
  -p 'SystemCallFilter=~@privileged @resources @obsolete @mount @reboot @swap @cpu-emulation @debug @module @raw-io'
  -p SystemCallErrorNumber=EPERM
  -p LockPersonality=yes
  -p RestrictRealtime=yes
  -p RestrictNamespaces=yes
  -p RestrictSUIDSGID=yes
  -p UMask=0077
  -p "WorkingDirectory=$PWD"
)
RAF_PLAN=(-p 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX')
RAF_UNIT=(-p 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK')
MDWE=(-p MemoryDenyWriteExecute=yes)

pass=0; fail=0
row() { # <expect ok|fail> <label> -- <systemd-run props...> -- <node args...>
  local expect="$1" label="$2"; shift 2
  local props=() args=()
  [[ "$1" == "--" ]] && shift
  while [[ $# -gt 0 && "$1" != "--" ]]; do props+=("$1"); shift; done
  shift
  args=("$@")
  local out rc verdict
  out=$(timeout 120 systemd-run --user --wait --pipe --collect --quiet "${props[@]}" "$NODE" "${args[@]}" 2>&1)
  rc=$?
  local summary
  summary=$(printf '%s\n' "$out" | grep -vE 'Warning: disabling flag' | grep -E '^(ok|ERR|# Check failed|Fatal)' | head -1)
  if { [[ $expect == ok && $rc -eq 0 && $summary == ok* ]] || { [[ $expect == fail ]] && { [[ $rc -ne 0 ]] || [[ $summary == ERR* ]]; }; }; }; then
    verdict=PASS; pass=$((pass+1))
  else
    verdict=FAIL; fail=$((fail+1))
  fi
  printf '%-4s | %-72s | rc=%-3s | %s\n' "$verdict" "$label" "$rc" "${summary:-<no marker output>}"
}

echo "node $("$NODE" --version), systemd $(systemd-run --version | head -1 | awk '{print $2}'), kernel $(uname -r)"
echo "expect | case | exit | output"
# 1. MDWE vs JIT
row fail "MDWE=yes, default JIT, trivial script (dies at startup, not at tier-up)" -- "${MDWE[@]}" -- -e 'console.log("ok")'
row fail "MDWE=yes, default JIT, hot loop" -- "${MDWE[@]}" -- -e 'let s=0;for(let i=0;i<5e6;i++)s+=i;console.log("ok",s)'
row ok   "MDWE=no,  default JIT, hot loop (control)" -- -p MemoryDenyWriteExecute=no -- -e 'let s=0;for(let i=0;i<5e6;i++)s+=i;console.log("ok",s)'
row ok   "MDWE=yes, --jitless, hot loop" -- "${MDWE[@]}" -- --jitless -e 'let s=0;for(let i=0;i<5e6;i++)s+=i;console.log("ok",s)'
row ok   "MDWE=yes, --jitless, WebAssembly is absent (expected, documented)" -- "${MDWE[@]}" -- --jitless -e 'console.log(typeof WebAssembly==="undefined"?"ok wasm-absent":"ERR wasm present")'
# 2. native addons under MDWE + jitless
row ok   "MDWE=yes, --jitless, sodium-native hash + secure buffer + mlock" -- "${MDWE[@]}" -p "WorkingDirectory=$PWD" -- --jitless -e 'const s=require("sodium-native");const h=Buffer.alloc(32);s.crypto_generichash(h,Buffer.from("x"));const b=s.sodium_malloc(64);s.sodium_mprotect_noaccess(b);s.sodium_mprotect_readwrite(b);const m=Buffer.alloc(4096);s.sodium_mlock(m);console.log("ok sodium",b.secure)'
row ok   "MDWE=yes, --jitless, udx-native socket bind" -- "${MDWE[@]}" -p "WorkingDirectory=$PWD" -- --jitless -e 'const U=require("udx-native");const u=new U();const s=u.createSocket();s.bind(0);console.log("ok udx",s.address().port>0);s.close()'
row ok   "MDWE=yes, --jitless, rocksdb-native via corestore append/get" -- "${MDWE[@]}" -p "WorkingDirectory=$PWD" -- --jitless -e 'const C=require("corestore");(async()=>{const st=new C(require("fs").mkdtempSync(require("os").tmpdir()+"/nutflix-hard-"));const c=st.get({name:"t"});await c.ready();await c.append(Buffer.from("b"));console.log("ok corestore",(await c.get(0)).toString());await st.close()})().catch(e=>console.log("ERR",e.message))'
# 3. RestrictAddressFamilies: the literal §7 set vs the unit's set
row fail "plan RAF (no NETLINK), --jitless: os.networkInterfaces()" -- "${RAF_PLAN[@]}" -- --jitless -e 'try{console.log("ok",Object.keys(require("os").networkInterfaces()).length)}catch(e){console.log("ERR",e.code)}'
row fail "plan RAF (no NETLINK), --jitless: new HyperDHT().ready()" -- "${RAF_PLAN[@]}" -p "WorkingDirectory=$PWD" -- --jitless -e 'const D=require("hyperdht");(async()=>{try{const d=new D({bootstrap:[]});await d.ready();console.log("ok");await d.destroy()}catch(e){console.log("ERR",e.code||e.message)}})()'
row ok   "unit RAF (+AF_NETLINK), --jitless: new HyperDHT().ready()" -- "${RAF_UNIT[@]}" -p "WorkingDirectory=$PWD" -- --jitless -e 'const D=require("hyperdht");(async()=>{try{const d=new D({bootstrap:[]});await d.ready();console.log("ok dht",d.address().port>0);await d.destroy()}catch(e){console.log("ERR",e.code||e.message)}})()'
# 4. the whole portable set together
row ok   "FULL portable set + MDWE + unit RAF, --jitless: dht + sodium + http + worker" -- "${FILTER[@]}" "${MDWE[@]}" "${RAF_UNIT[@]}" -- --jitless -e 'const D=require("hyperdht");const s=require("sodium-native");const h=require("http");const {Worker}=require("worker_threads");(async()=>{try{const d=new D({bootstrap:[]});await d.ready();const b=s.sodium_malloc(32);s.sodium_mlock(Buffer.alloc(64));const srv=h.createServer((q,r)=>r.end("x"));await new Promise(r=>srv.listen(0,"127.0.0.1",r));await new Promise(r=>{const w=new Worker("require(\"worker_threads\").parentPort.postMessage(1)",{eval:true});w.on("message",r)});srv.close();await d.destroy();console.log("ok full",b.secure,process.umask().toString(8))}catch(e){console.log("ERR",e.code||e.message)}})()'
row fail "FULL portable set, default JIT (what the unit would do WITHOUT --jitless)" -- "${FILTER[@]}" "${MDWE[@]}" "${RAF_UNIT[@]}" -- -e 'console.log("ok")'

echo
echo "hardening test: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
