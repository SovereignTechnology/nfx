# 113. A manager window for nfxd over a private control socket

Date: 2026-11-26

## Status

Proposed 2026-11-26. Decided by the maintainer (sovtech). It adds a second runtime beside
ADR 0008 §4's "Tauri 2 + a Rust core", for one tool: the manager. The viewer
(`crates/desktop`) stays on Tauri. Nothing on the wire changes: the control socket is
local to one machine and is not an NFX protocol document. Tracking issue: #135.

## Context

- `nfxd` is headless. Its settings are command-line flags, its output is status lines on
  stderr, and a running node offers nothing to ask or change: no socket, no admin route,
  no status file. `Daemon` can start, report states and shut down; it cannot add, pause,
  remove or list a video.
- The desktop viewer is for watching. Its window is a web view running JavaScript, and it
  holds its node in the same process as that page.
- The maintainer's direction: a minimal window to manage a node (options, what it seeds,
  downloads, and later a Cashu and Lightning wallet), written in Rust, with security first.
  It attaches to a node that is already running and can start one of its own, which keeps
  seeding after the window closes. A tray icon reopens the window.
- There is no wallet in this repository. The money code is a locked stub until the M2.1
  security stage (`docs/nfx/m2-plan.md`), and #79's questions are open.

## Decision

1. **Two programs, never one.** The window is `nfx-manager`, a new crate in
   `crates/manager` with its own Cargo workspace, as `crates/desktop` has. It contains no
   node code and links none of `nfxd`'s dependencies. The node is always the `nfxd`
   binary built from the main workspace, so the node, and later the wallet, is always
   code the lock covers (`crates/ci/check-locked.sh`). A manager with a node inside it
   would be money code resolved by a lock file the lock never reads.
2. **egui, not a web view.** The window is drawn by Rust code (egui and eframe, the glow
   renderer). There is no HTML, no JavaScript and no browser engine. The features that
   open links, read system fonts or keep state on disk are off.
3. **One way in: a Unix socket.** `nfxd run --control <path>` opens a pathname
   `AF_UNIX` socket, mode 0600, in a directory it creates 0700. It refuses a directory
   that is a symlink, belongs to another user, or is open to group or other. It takes a
   lock file first, so a second node cannot take the socket from a running one. It checks
   the peer's uid on every connection. Without `--control` there is no socket. There is
   no TCP listener in any mode. A node on another machine is managed by forwarding its
   socket over SSH. The protocol is in [`docs/nfx/control.md`](../nfx/control.md).
4. **Nothing secret crosses the socket.** No request returns a node key, a creator key, a
   wallet seed or ecash. A creator key is named by its npub and lives in one directory
   the node owns; no request takes the path of a key. An nsec in any field is refused,
   and the refusal never repeats it.
5. **What the socket may change is short.** Relays (`wss://` only), iroh relays, the
   storage cap and the seeding switch. The store, the state directory and the key files
   are fixed when the node starts. A flag given on the command line is pinned: the socket
   reports it and cannot change it.
6. **Text from the network is hostile.** A title or description from a manifest is shown
   as plain text, capped, with control, bidi-override and zero-width characters removed.
   The window opens no links, plays no video and decodes nothing fetched from the network.
   A peer's IP address is shown only behind a switch that is off each time the view opens
   and is never saved (as the viewer's "Stats for nerds" does).
7. **Removing is careful.** `remove` keeps the files unless asked to delete them, and
   refuses to delete the files of a video this node published: that copy may be the only
   one. `add` is refused at the storage cap; the manager never evicts to make room.
8. **Its own node, in the background.** When no node is running the window offers to
   start one. It starts the `nfxd` beside its own executable (found through
   `/proc/self/exe`, never `PATH`), in its own process group, and that node keeps seeding
   after the window closes. The window says so the first time, and **Stop node** ends it.
   Nothing is installed to start at login.
9. **The tray icon is a third program.** `nfx-tray` owns the icon and is the only one of
   the three that talks to D-Bus. Closing the window ends the window's process; the icon
   stays and starts the window again. Its menu shows numbers only, never a title.
10. **The window and the tray helper sandbox themselves.** At the start of `main`, after
    any node has been started: not dumpable, `no_new_privs`, and a Landlock ruleset (files
    read-only outside their own directories, no execute, no TCP). The window shows which
    of these the kernel gave it. The node marks itself not dumpable too.
11. **The wallet is reserved, not built.** When it exists it lives in the node, in the
    locked money crate, and the window sends intents under a `wallet` capability. The
    window may show balances and what was earned and spent, take a deposit, and cash out
    to **one target set on the command line**. Adding or trusting a mint, changing a
    limit, sending a token, paying any other invoice and showing or restoring the seed
    stay on a terminal. Attached to a node on another machine, the window ignores the
    capability unless its user turns it on for that node. This waits for #79 and M2.1;
    until then the wallet tab says it is not in this build.
12. **Where the protocol's types live.** `crates/nfxd/src/control/proto.rs` holds them and
    depends on serde only. The manager includes that one file by path, and golden vectors
    hold the two sides together. They become a crate of their own at the re-pin M2.1
    needs anyway: a new member of the main workspace is a re-pin.

## What it stops, and what it does not

| Attacker | Stopped | Not stopped |
|---|---|---|
| Hostile titles, relays and peers | Forgery (signatures, sha256), markup and links, a video larger than the cap | A relay that withholds events, or learns the node's IP address and what it asks for |
| Another user of the machine | Everything: the directory, the socket's mode, the uid check | |
| A compromised window | Reading a key or the seed; sending money anywhere but the preset target; changing a mint or a limit; pointing the node at a `ws://` or private address; deleting what the node published | Every request the window may make: add, pause, remove, publish under a creator key the node holds |
| A compromised node on another machine | Reaching the window's machine: the client caps frames, cleans every string and ignores `wallet` there | Lying about its own state |
| A program running as the same user | Reading the node's memory | Reading the node's key file (mode 0600, same owner) and using the socket. Out of scope |
| Supply chain | The window holds no secret; its own lock file and `deny.toml`; the smallest feature set | The egui and winit tree, and zbus in the tray helper, are trusted code |

## Consequences

- **A same-user attacker is not stopped, and this record says so.** The socket's checks keep
  other users out. Marking the node not dumpable matters once a wallet seed is encrypted at
  rest; today the key file is plaintext with mode 0600.
- **Linux first.** The socket, the uid check and Landlock are Linux. On a kernel before 7.1
  Landlock cannot stop a connection to a pathname Unix socket or a UDP packet, so the
  window's sandbox there covers files and TCP. The window names the level it has.
- **Screen readers are off by default.** AccessKit's Linux adapter brings a D-Bus
  connection and about sixty crates, three of them unmaintained. A cargo feature turns it
  on. The keyboard works either way.
- **Titles outside Latin, Greek and Cyrillic show as boxes** until the manager ships more
  fonts. It embeds Go Regular and Go Mono (BSD-3-Clause) so that no font licence needs an
  exception in `deny.toml`.
- **The tray needs a host.** A desktop with no StatusNotifierItem host shows no icon; the
  helper exits and the node still keeps seeding.
- **No file is dropped on the window under Wayland** (winit 0.30 has no drop there): a
  package's path is typed or pasted.
- **CI does not build the manager yet.** `.github/workflows` is pinned by the lock, so a job
  for `crates/manager` is a re-pin by the maintainer. Until then
  `crates/manager/check.sh` is the gate, as `crates/desktop` is checked today.
- **"Bytes sent" comes later.** Nothing in `nfx-node` counts what a node uploads. The
  library shows size, progress, bytes received and seeders known first.
- **`nfxd` gains flags:** `--control`, `--control-allow-uid`, `--control-allow-shutdown`.
  Its `publish` and `delete` logic moves from the binary into the library, unchanged.
- **Keep-and-seed (decision 0110, NFX-18) is the base.** A video the manager adds is kept
  for the reason `downloaded`, one it publishes for `published`, and neither is evicted to
  make room.
