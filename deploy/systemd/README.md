# deploy/systemd — seeder and gateway units (build-plan §7)

| File | Purpose |
|------|---------|
| `nutflix-seeder.service` | Seeder daemon: Corestore + Hyperblobs over Hyperswarm, pay/1 server side |
| `nutflix-gateway.service` | Gateway: the seeder plus WS bridge + Blossom HTTP (inbound listener) |
| `nutflix.sysusers.conf` | `sysusers.d` fragment creating the two dedicated no-login accounts |
| `test-hardening.sh` | User-scope (`systemd-run --user`) test of MDWE + seccomp directives against Node 22 and the native modules |
| `MDWE-RESULTS.md` | The measured result behind `MemoryDenyWriteExecute=yes` + `--jitless`, and the `AF_NETLINK` finding |

Install (as root on the host):

```sh
install -m 0644 nutflix.sysusers.conf /etc/sysusers.d/nutflix.conf && systemd-sysusers
install -m 0644 nutflix-seeder.service nutflix-gateway.service /etc/systemd/system/
mkdir -p /etc/nutflix && install -m 0640 -o root -g nutflix-seeder seeder.json /etc/nutflix/
systemctl daemon-reload
systemctl enable --now nutflix-seeder            # and/or nutflix-gateway
systemd-analyze security nutflix-seeder          # sanity: should sit in the "SAFE" band
```

The application tree is expected at `/opt/nutflix` (a `git checkout` + `npm ci --ignore-scripts` + `npm run build`, owned by root, read-only to the service users — `ProtectSystem=strict` enforces the read-only part regardless of ownership).

## Assumptions the owning lanes must confirm

- **`ExecStart`**: `node --jitless <package main> --config /etc/nutflix/<svc>.json`. Keep `--jitless` (see below).
  - **Gateway: confirmed by L3** (the lane report (not published) "systemd entry-point confirmation"). `packages/gateway/dist/index.js` self-runs only as the main module, takes `--config`, exits 78 (`EX_CONFIG`) on a bad config so `Restart=on-failure` + `StartLimitBurst` fail fast, and `STATE_DIRECTORY` fills a missing `dataDir`. `Type=simple` is right (`sdNotify` is a no-op without `NOTIFY_SOCKET`).
  - **Seeder: NOT yet runnable from this unit.** `@sovit/seeder` deliberately ships no self-executing `main()` and no `bin/`: the shell that owns the `PaymentEngineSeeder` (L6's worker, or a Stage 2 service entry) calls `runDaemon()`. Until that entry exists, `nutflix-seeder.service`'s `ExecStart` points at a module that does nothing when executed. The seeder's own `renderSystemdUnit()` and duplicate unit file were **removed in the L2-v3 re-issue**; this directory is the only source of the units.

### Gateway configuration the unit does NOT set (operator must)

- **Public URL.** Blossom blob descriptors (`PUT /upload` → `url`, `GET /list/<pubkey>`) are built from `blossom.publicUrl`. With the default it points at `http://127.0.0.1:<port>`, which is useless to any client behind the reverse proxy. Set it to the proxy's public origin either in `/etc/nutflix/gateway.json` (`"blossom": { "publicUrl": "https://cdn.example" }`) or in the unit via `Environment=NUTFLIX_GATEWAY_PUBLIC_URL=https://cdn.example` (env always wins). It is not a secret, so `Environment=` is acceptable here.
- **`http.trustProxy`.** Default `false`. Set `"http": { "trustProxy": true }` in the JSON **only when the listener is reachable solely through the reverse proxy** (loopback bind, or a firewall that admits only the proxy). With it on, the gateway takes the client address for rate-limit buckets from the first `X-Forwarded-For` hop; if anything other than the proxy can reach the port, a client can choose its own bucket by sending that header. The gateway never reads `X-Forwarded-Proto` (descriptor URLs come from `publicUrl` above).
- **Proxy requirements** (from L3): forward `/`-rooted paths unchanged (Blossom endpoints must live at the root, BUD-01); pass `Upgrade`/`Connection` for `ws.path` (default `/ws`); disable request buffering and raise the proxy body limit to ≥ `http.maxUploadBytes` for `PUT /upload`; forward `Range` untouched.
- **Paths**: state in `/var/lib/nutflix-<svc>` (`$STATE_DIRECTORY`), runtime sockets in `/run/nutflix-<svc>` (`$RUNTIME_DIRECTORY`), config in `/etc/nutflix` (`$CONFIGURATION_DIRECTORY`, read-only). The daemons should read those environment variables rather than hard-code paths.
- **Key at rest** (§7: argon2id-derived passphrase key, never env vars): lives under the state directory (mode 0700 by `StateDirectoryMode`), decrypted at start with a passphrase read from `/etc/nutflix/<svc>.json`'s referenced file or a systemd credential (`LoadCredentialEncrypted=`, which the unit does not add yet because the key format is L2's). `Environment=` is deliberately not used for anything secret.
- **TLS**: the gateway binds an unprivileged port on loopback/LAN and a reverse proxy terminates TLS. The proxy is where `_headers.txt` from `scripts/csp-sri.mjs` goes.

## Directive-by-directive

Both units share the same block; the gateway differs only in resource caps.

### Identity and filesystem

| Directive | Why |
|-----------|-----|
| `User=`/`Group=nutflix-<svc>` | §7 "dedicated user". Separate accounts per daemon so a compromised gateway cannot read seeder state. Created by `nutflix.sysusers.conf`, `nologin` shell, no home. |
| `WorkingDirectory=/opt/nutflix` | The read-only application tree. |
| `StateDirectory=` + `StateDirectoryMode=0700` | The **only** persistent writable location: corestore, key-at-rest blob, ban list. systemd creates it, chowns it, and adds it to the read-write set under `ProtectSystem=strict`. |
| `RuntimeDirectory=` (0700) | `/run/nutflix-<svc>` for a control socket; wiped on stop. |
| `ConfigurationDirectory=nutflix` | `/etc/nutflix` exists and is readable; it is **not** added to `ReadWritePaths`, so config stays read-only to the daemon. |
| `UMask=0077` | Anything the daemon creates (corestore files, key blobs) is private by default. Verified the process sees `077`. |
| `ProtectSystem=strict` | §7. Entire filesystem read-only except the directories systemd carved out above. A compromised process cannot modify its own code, `/etc`, or `/usr`. |
| `ProtectHome=yes` | §7. `/home`, `/root`, `/run/user` are empty/inaccessible. |
| `PrivateTmp=yes` | §7. Private `/tmp` and `/var/tmp`; no symlink races or leaks via shared tmp. |
| `PrivateDevices=yes` + `DevicePolicy=closed` | Minimal `/dev` (null, zero, random, urandom…), no physical devices. Node needs only `/dev/urandom`. |
| `ProtectProc=invisible` + `ProcSubset=pid` | Other processes are invisible in `/proc`; non-PID `/proc` files hidden. Reduces information available to an attacker inside. |
| `ProtectKernelTunables/Modules/Logs=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes` | No writes to `/proc/sys`, `/sys`, no module loading, no `dmesg`, no cgroup edits, no clock or hostname changes. All redundant with an empty capability set, kept as belt-and-braces and because `systemd-analyze security` scores them. |
| `RemoveIPC=yes` | SysV IPC / POSIX message queues owned by the user are removed on stop. |

### Privilege and syscall surface

| Directive | Why |
|-----------|-----|
| `NoNewPrivileges=yes` | §7. No setuid/setgid/fscaps escalation via `execve`, ever. Also a prerequisite for the seccomp filters to apply to unprivileged users. |
| `CapabilityBoundingSet=` + `AmbientCapabilities=` (empty) | The daemon needs no capability: unprivileged ports only, no raw sockets. An empty bounding set means even a root-in-namespace bug cannot regain them. |
| `RestrictSUIDSGID=yes` | Cannot create setuid/setgid files. |
| `LockPersonality=yes` | Locks the execution domain (`personality(2)`); blocks a historic ASLR-disable trick. |
| `RestrictRealtime=yes` | No realtime scheduling → cannot starve the host (T11). |
| `RestrictNamespaces=yes` | No user/mount/net namespaces from inside the service — closes the largest class of container-escape primitives. |
| `SystemCallArchitectures=native` | Only x86-64 syscalls; kills the 32-bit-ABI seccomp-bypass class. |
| `SystemCallFilter=@system-service` then `~@privileged @resources @obsolete @mount @reboot @swap @cpu-emulation @debug @module @raw-io` | Allowlist of what a normal service needs, minus groups a Node daemon never uses. **Verified** (test-hardening.sh) that Node 22 `--jitless` + `sodium-native` (`mlock`, `mprotect`), `udx-native`, `rocksdb-native`, `hyperdht`, `http`, `worker_threads` all run under it. `@resources` removal is safe: `mlock` lives in `@memlock`, which `@system-service` includes. |
| `SystemCallErrorNumber=EPERM` | A filtered syscall returns `EPERM` instead of `SIGSYS`-killing the process, so a stray call in a dependency surfaces as a logged error rather than a silent crash loop. |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK` | §7 says the first three. **`AF_NETLINK` is added and required**: `getifaddrs(3)` (libuv `uv_interface_addresses`, called by `udx-native` → `dht-rpc` → `hyperdht` at construction) opens a `NETLINK_ROUTE` socket; without it the swarm throws `EAFNOSUPPORT` before binding. Verified both ways in `MDWE-RESULTS.md` §3. Netlink here is read-only enumeration; with an empty capability set no `NET_ADMIN` operation is possible over it. |
| `MemoryDenyWriteExecute=yes` + `ExecStart=… --jitless …` | §7 "test against the JS engine's JIT" — tested, see `MDWE-RESULTS.md`. Node 22's default JIT **aborts at startup** under MDWE; with `--jitless` V8 never creates executable memory and everything works, at a measured ~1.7× cost on the secp256k1 (DLEQ) JS path and no cost to native hashing. The pair must be changed **together**. |

### Environment (T12 supply chain at runtime)

| Directive | Why |
|-----------|-----|
| `Environment=NODE_OPTIONS=` (pinned empty) | `NODE_OPTIONS=--require …` from a poisoned host environment is the standard way to inject code into a Node service; pinning it empty in the unit makes the host environment irrelevant. |
| `UnsetEnvironment=NODE_EXTRA_CA_CERTS NODE_PATH NODE_DEBUG NODE_PENDING_DEPRECATION` | Same class: extra CA roots, module-resolution overrides, debug leakage. |
| `Environment=NODE_ENV=production` | Conventional; libraries disable dev-only diagnostics. |

### Availability (T11)

| Directive | Why |
|-----------|-----|
| `Restart=on-failure`, `RestartSec=5s` | Come back after a crash, not instantly. |
| `StartLimitIntervalSec=300`, `StartLimitBurst=5` | A crash loop stops after 5 attempts in 5 minutes instead of pegging a core. |
| `TimeoutStopSec=30s` | Enough for corestore to flush; then SIGKILL. |
| `LimitNOFILE=65536` | Many peers = many sockets; the default 1024 is too low for a seeder. |
| `LimitCORE=0` | No core dumps: a core would contain decrypted key material (T14). |
| `TasksMax=` | Caps threads + child processes (libuv pool, workers). |
| `MemoryHigh=`/`MemoryMax=` | Throttle, then OOM-kill only this unit, never the host. Size per host. |
| `CPUQuota=` | The seeder cannot take the whole box during a DoS. Size per host. |
| `StandardOutput/Error=journal` | Journald handles rotation; the application-level redaction layer (§7) sits in front of every logger so nothing secret reaches it. |

### Considered and not set (say so, rather than pretend)

- `DynamicUser=yes` — would replace the sysusers accounts and implies most of the above. Rejected for now: persistent state under `/var/lib/private` plus the operator-facing key-at-rest file is easier to reason about with a stable UID. Revisit if the operator story changes.
- `PrivateUsers=yes` — maps the service user into a private user namespace; hardens further but is known to interact badly with `StateDirectory` ownership on some systemd versions and could not be tested without a system manager here.
- `PrivateNetwork=yes` / `IPAddressDeny=` — the seeder must talk to arbitrary peers; a gateway that only ever sees a reverse proxy could add `IPAddressAllow=localhost` + `IPAddressDeny=any` for its *inbound* side, but the embedded seeder's outbound swarm traffic makes a blanket deny wrong.
- `LoadCredentialEncrypted=` for the passphrase — the right mechanism (never env vars) but the key-at-rest format is lane L2's; add it when that lands.
- `ExecPaths=`/`NoExecPaths=` — `ProtectSystem=strict` plus MDWE already prevents executing anything written at runtime; explicit `NoExecPaths=/var/lib/nutflix-*` would be a cheap extra once state layout is fixed.

## Verifying on a real host

```sh
systemd-analyze security nutflix-seeder      # expect a low exposure score
systemd-analyze verify /etc/systemd/system/nutflix-seeder.service
journalctl -u nutflix-seeder -b              # EPERM lines here = a syscall the filter blocked
```
