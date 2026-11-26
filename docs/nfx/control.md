# The nfxd control socket, protocol 1

How a local program asks a running `nfxd` what it holds and tells it what to change.
Decided in [ADR 0113](../decisions/0113-manager-window-and-control-socket.md). This is
not an NFX wire document: it never leaves one machine, and it may change with a `proto`
bump without touching `spec/`.

Status: **design**. Nothing here is built yet; the types will live in
`crates/nfxd/src/control/proto.rs`.

## 1. Transport

- `nfxd run --control <path>` opens a pathname `AF_UNIX` stream socket at `<path>`.
  Without the flag there is no socket. There is never a TCP listener.
- The socket's directory is created by the node with mode 0700. The node refuses to start
  the socket when the directory is a symlink, is not owned by the node's user, or grants
  anything to group or other. The socket's mode is 0600.
- The node takes an exclusive lock on `control.lock` in that directory, then removes any
  old socket file and binds. A second node on the same directory fails to take the lock
  and stops; it never removes the first one's socket.
- On each connection the node reads the peer's credentials. The peer's uid must be the
  node's own, or one named by `--control-allow-uid <uid>` (for a node that runs as a
  service account). Any other peer is closed without a reply.
- A client makes the same checks from its side before it sends anything: the directory's
  owner and mode, and that the peer's uid is the socket file's owner.
- The path must fit `sun_path` (107 bytes on Linux).
- At most 2 connections at once. A third is closed without a reply.

A node on another machine is reached by forwarding the socket, for example
`ssh -N -o StreamLocalBindUnlink=yes -L /run/user/1000/nfx-remote/booth.sock:/run/user/1001/nfxd/control.sock host`.
The far node sees the uid of the SSH login, so log in as the node's user or allow that
uid. Make the local directory 0700 yourself: OpenSSH sets the socket's mode, not the
directory's.

## 2. Framing

- A frame is a 4-byte big-endian length followed by that many bytes: one JSON object,
  UTF-8.
- The length is 1 to 262144 (256 KiB). Both ends enforce it before they read the body. A
  frame outside it ends the connection; the node first answers `too_large` with id 0.
- One request is in flight on a connection. A client sends a request and reads its reply
  before it sends the next. A second request before the reply ends the connection.
- A connection with no request for 30 s is closed. A frame that takes more than 10 s to
  arrive whole ends the connection.
- More than 20 requests in one second on a connection: `rate_limited`.

## 3. Requests and replies

```json
{"id": 7, "method": "list", "params": {"rev": 41}}
{"id": 7, "result": {"rev": 41, "unchanged": true}}
{"id": 8, "error": {"code": "not_found", "message": "no such video"}}
```

- `id` is an unsigned 32-bit number the client picks; the reply repeats it.
- `params` is an object. A method with no parameters takes `{}` or no `params` at all.
- A reply has exactly one of `result` and `error`.
- **The node is strict:** an unknown method is `unknown_method`, and an unknown or
  missing field, or a value of the wrong type, is `bad_request`.
- **A client is lenient:** it ignores reply fields it does not know, and shows a state it
  does not know as "unknown". This is what lets an older window manage a newer node.
- The first request on a connection must be `hello`. Anything else: `bad_request`.
- An error is `{"code": …, "message": …}`. `message` is fixed text chosen by the node.
  `field`, when present, names the parameter or setting the error is about. Neither ever
  repeats a value the client sent.

### Error codes

| Code | Meaning |
|---|---|
| `bad_request` | Not a valid request (shape, type, unknown field, `hello` missing) |
| `unknown_method` | The node does not have this method |
| `unsupported_version` | `hello` named a `proto` the node does not speak |
| `not_found` | No such video, key or page |
| `conflict` | Already so: the video is already held, already paused, and so on |
| `invalid` | A value was refused (an address, a relay URL, an npub, a path, a length) |
| `pinned` | The setting is fixed by the node's command line |
| `over_cap` | Adding this would pass the storage cap |
| `rate_limited` | Too many requests, or `settings.set` again inside 10 s |
| `too_large` | The frame is over the limit |
| `unavailable` | The node cannot do it now (no relay connected, no node key, restarting) |
| `denied` | The node will not do it (delete a published video's files; `shutdown` not allowed) |
| `internal` | The node failed; its stderr has the cause |

## 4. Methods

Classes: **read** changes nothing; **change** alters what the node does; **destructive**
can lose data or stop the node. Every change and destructive request writes one line to
the node's stderr: the method, the outcome, and a video address or setting name where
there is one. Never a key, never a peer's address, never a path.

### 4.1 `hello` (read)

```json
{"proto": 1, "client": "nfx-manager/0.1.0"}
```

`client` is at most 64 characters and is only written to the log.

```json
{"proto": 1, "version": "0.1.5", "node": "<64 hex>", "caps": ["library", "lookup", "publish", "settings", "shutdown"],
 "pinned": ["relays"], "namespaces": ["nfx:testnet:1"]}
```

- `node` is the node's public key, the one its beacons are signed with. A node started
  without a key leaves it out, and has no `library`, `lookup` or `publish`.
- `caps` names what this node offers. A client uses a method only when its capability is
  listed: `library` (`status`, `list`, `sources`, `routes`, `add`, `pause`, `resume`,
  `remove`), `lookup`, `publish` (`keys`, `key.create`, `publish`), `settings`
  (`settings.get`, `settings.set`), `shutdown`. `wallet` is reserved (§6).
- `pinned` names the settings the command line fixed.
- `namespaces` are the namespaces of the videos the node holds, most used first; a client
  offers the first as the default for `lookup`.

### 4.2 `status` (read)

No parameters. Numbers only, so a program that shows nothing else (a tray icon) never
handles text from the network.

```json
{"downloading": 1, "seeding": 12, "paused": 0, "failed": 0,
 "held_bytes": 48318382080, "cap_bytes": 107374182400,
 "relays": 3, "relays_connected": 3, "seeding_on": true}
```

### 4.3 `list` (read)

```json
{"rev": 41}
```

`rev` is optional. The node counts a revision each time anything a `list` reports
changes. When the client's `rev` is current the reply is `{"rev": 41, "unchanged": true}`.
Otherwise:

```json
{"rev": 42, "held_bytes": 48318382080, "cap_bytes": 107374182400,
 "videos": [
  {"a": "38504:<64 hex>:nfx:testnet:1:<video-id>", "title": "Big Buck Bunny",
   "state": "seeding", "paused": false, "reasons": ["downloaded"],
   "size": 276134947, "held": 276134947, "received": 276134947,
   "seeders": 3, "added_at": 1795800000}
 ]}
```

- `state` is one of `resolving`, `fetching`, `seeding`, `unannounced`, `awaiting_relay`,
  `serving`, `deleted`, `failed`. `detail` (at most 200 characters) says why for
  `unannounced`, `awaiting_relay` and `failed`.
- `paused` is true for a video the user paused; its `state` is then the last one it had.
- `reasons` are NFX-18's: `watched`, `downloaded`, `published`.
- `size` is the bytes of the renditions the node keeps, 0 while it is not known. `held`
  is how many of them are in the store. `received` is what this node fetched from peers
  since it started.
- `seeders` is how many seeders the node knows for the video, itself not counted.
- `title` is at most 200 characters. The node caps it; a client still treats it as hostile.
- At most 1000 videos. A node that holds more reports the 1000 most recently added and
  `"truncated": true`.
- A client asks at most once a second.

### 4.4 `sources` and `routes` (read)

`{"a": "<address>"}` for both.

`sources` says who the bytes came from, by the first 8 hex characters of each peer's id:

```json
{"peers": [{"peer": "9f2c41aa", "bytes": 181403648, "blobs": 212, "open": true}]}
```

`routes` adds how each peer is reached. It carries IP addresses, so a client asks for it
only while its user has an "addresses" switch on, never keeps the answer, and never logs
it:

```json
{"routes": [{"peer": "9f2c41aa", "path": "direct", "addr": "203.0.113.7:41234", "rtt_ms": 38},
            {"peer": "17be0c55", "path": "relay", "addr": "relay.example.org"}]}
```

`path` is `direct`, `relay` or `unknown`.

### 4.5 `settings.get` (read) and `settings.set` (change)

`settings.get` takes no parameters:

```json
{"settings": {"relays": ["wss://relay.example.org"], "iroh_relays": [],
              "cap_bytes": 107374182400, "seeding": true},
 "pinned": ["relays"]}
```

`settings.set` takes `{"settings": {…}}` with any of the four fields; a field left out
keeps its value. The node checks every field, writes the settings file atomically,
restarts its node with them, and falls back to the old settings if the new ones do not
start. Reply: `{"restarted": true}`. Until the restart is done other methods answer
`unavailable`.

- `relays`: 1 to 16 URLs. `wss://` only; a host name or a public IP address; no user
  info, query or fragment; at most 255 characters. `ws://`, `localhost`, and loopback,
  private, link-local and unique-local addresses are refused: over the socket, a relay
  URL would otherwise make the node send a request to any address on the local network.
  (A name that resolves to a private address is not caught here.) A node that needs a
  `ws://` or local relay names it on the command line, which pins it.
- `iroh_relays`: 0 to 8 URLs, `https://` only, the same rules.
- `cap_bytes`: 1 GiB to 1 PiB.
- `seeding`: off stops announcing and serving; files stay.
- A pinned field: `pinned`. Any refused value: `invalid`. Both name the setting in `field`.
- One `settings.set` per 10 s: `rate_limited`.
- The store, the state directory and the key files are not settings. Nothing sets them
  after the node starts.

### 4.6 `lookup` (read)

```json
{"npub": "npub1…", "namespace": "nfx:testnet:1", "cursor": "…"}
```

The node asks its relays for that creator's manifests in that namespace, verifies each
(NFX-02), and drops deleted ones. `cursor` is optional and comes from the last reply.

```json
{"videos": [{"a": "38504:…", "title": "…", "published_at": 1795700000, "held": false}],
 "next": "…"}
```

- 100 videos a page; `next` is absent on the last page.
- Only an npub is accepted. Hex is refused: a pasted secret key would pass for a public
  key and go out to relays as a filter. An nsec is refused as one.
- This tells the node's relays which creator the user asked about, as watching does.

### 4.7 `add`, `pause`, `resume` (change)

All take `{"a": "<address>"}`.

- `add` resolves the video, checks its size against the cap before any segment is
  fetched, fetches it, and seeds it, with the reason `downloaded`. Reply:
  `{"state": "resolving"}`. Already held with that reason: `conflict`. Over the cap:
  `over_cap`; nothing is evicted to make room.
- `pause` stops fetching, announcing and serving one video. Its files stay, and it stays
  paused across a restart. Reply `{}`.
- `resume` undoes it. Reply `{}`.

### 4.8 `remove` (destructive)

```json
{"a": "<address>", "delete_files": false}
```

The node stops the video and forgets it. `delete_files` defaults to false. With true it
also deletes the video's files that no other kept video shares. Reply:
`{"deleted_bytes": 276134947}`, with 0 when the files stayed. For a video with the reason `published`, `delete_files`
is refused with `denied`: that copy may be the only one. (`nfxd` on a terminal can still
do it.)

### 4.9 `keys` (read), `key.create` and `publish` (change)

- `keys`: no parameters. Reply `{"keys": ["npub1…"]}`: the creator keys in the node's
  key directory (`<state>/creator-keys/`, mode 0700; each file 0600).
- `key.create`: no parameters. The node makes a key there and replies `{"npub": "npub1…"}`.
  At most 16 keys. There is no request that returns, imports or deletes a key: a key
  comes in by copying its file into the directory on a terminal.
- `publish`:

```json
{"package": "/home/me/videos/bunny.pkg", "key": "npub1…", "title": "Big Buck Bunny",
 "description": "…", "alt": "…", "tags": ["animation"]}
```

  `package` is the absolute path of a directory made by `nfx-package`. The node refuses a
  path that is not absolute, is not a directory, is reached through a symlink at its last
  component, or is not owned by the node's user. It copies the package's files into its
  store, signs the manifest with the named key, publishes it to its relays, and seeds the
  video with the reason `published`. Reply: `{"a": "38504:…", "relays": 3}`. No relay
  took it: `unavailable`, and nothing is kept.

  `title` 1 to 200 characters; `description` at most 10000; `alt` at most 1000; at most
  16 tags of at most 64 characters.

  Withdrawing a video (NFX-02 §6) is not on the socket: `nfxd delete` on a terminal.

### 4.10 `shutdown` (destructive)

No parameters. The node answers `{}`, then shuts down as it does on SIGTERM. Allowed only
on a node started with `--control-allow-shutdown` (a manager passes it to a node it
starts itself); otherwise `denied`. A node run by a service manager is stopped there.

## 5. Versions

- `proto` is 1. A node that receives another number answers `unsupported_version`, and
  the error carries `"proto": 1`, so the client can say which side is older.
- New methods, new capabilities, new reply fields and new `state` values do not change
  `proto`. A client finds a method by its capability.
- A change to the meaning of anything that exists, or a new required parameter, bumps
  `proto`.
- Golden vectors (`crates/nfxd/src/control/vectors.json`) hold every request and reply
  shape. The node and the manager both test against them.

## 6. Reserved: `wallet`

Not built. No wallet exists in this repository, and the money code is locked until M2.1.
This section fixes only what the socket will and will not carry, so that nothing built
before then has to change. It assumes #79 settles that the node is a wallet only and
reaches Lightning through mints.

The wallet lives in the node, in the locked money crate. A window sends intents:

| Method | Class | Purpose |
|---|---|---|
| `wallet.balance` | read | sats per mint, whole numbers |
| `wallet.mints` | read | the mints the node trusts |
| `wallet.history` | read | earned from seeding, spent on playback, deposits, cash-outs |
| `wallet.limits.get` | read | the spend limits in force |
| `wallet.deposit.quote`, `wallet.deposit.status` | change | an amount → a Lightning invoice from a trusted mint; then whether it was paid |
| `wallet.token.receive` | change | swap a pasted token into the wallet, at a trusted mint only |
| `wallet.cashout.quote`, `wallet.cashout.confirm` | change | the fee, then the payment, **to the one target set on the command line** |

**Never on the socket**, only on a terminal (`nfxd wallet …`): setting the cash-out
target; adding, removing or trusting a mint; changing a limit; sending a token; paying
any other invoice; showing or restoring the seed. A compromised window can then add
money and can send it to the owner's own target, and nothing else.

A window attached to a node on another machine ignores the `wallet` capability unless its
user turned it on for that node: a compromised node could show its own invoice as a
deposit.
