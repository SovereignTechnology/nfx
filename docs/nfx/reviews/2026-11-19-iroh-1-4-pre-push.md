# Pre-push review: iroh 1.2 → 1.4.2, iroh-blobs 0.105, iroh-gossip 0.103 (branch `deps/iroh-1-4`, 2026-11-19)

- **Scope:** `crates/Cargo.toml` and `crates/desktop/Cargo.toml` (iroh, iroh-relay, iroh-blobs,
  iroh-gossip), `crates/nfx-node/Cargo.toml` (`portmapper` 0.19.3 → 0.20.2, the version iroh now
  takes), both lock files, one import in `nfx-node/src/gossip.rs`, two stale entries in the
  `deny.toml` files, and the four money-lock pin lines the lock change moves.
- **Method:** `differential-review` on the lock diff and the money-lock pin edit (the one place the
  change touches reviewed-only paths); `sharp-edges` on the library defaults that moved.
- **Verdict:** no findings. Two notes below.

## Supply chain (lock diff, both locks)

- Every added package version comes from crates.io and carries a checksum; none from git or a
  path. `cargo deny check` passes on both locks (advisories, bans, licenses, sources), with no
  "not encountered" warnings left.
- Publishers of the 24 added versions (crates.io API): the iroh maintainers for the iroh family
  (`iroh`, `iroh-base`, `iroh-dns`, `iroh-gossip`, `iroh-relay`, `iroh-blobs`, `iroh-util`,
  `iroh-metrics`, `bao-tree`, `irpc`, `n0-error`, `netwatch`, `noq`, `portmapper`), the tokio
  maintainer (`tokio`, `tokio-util`), and each upstream's known maintainer for `igd-next`,
  `netdev` and `netlink-proto`. `libc` shows no publisher (its releases are published by CI).
- Net: 24 added, 35 removed package-versions in the workspace lock. Gone: `paste`,
  `attohttpc`, the `netlink-packet-*` set, the `objc2-*` set, `fixedbitset`,
  `futures-concurrency`, and the second `portmapper`/`netwatch`/`netdev` copies.

## Money lock

- Two pinned crates move, both forced by the new versions: `tokio` 1.53.3 → 1.54.1 (iroh 1.4.2
  requires it) and `libc` 0.2.189 → 0.2.191 (iroh-blobs 0.105 requires it). `cargo update
  --precise` could not hold either back.
- The pin diff is four lines in `crates/ci/locked-compiled.txt` (a `money-dep` and a
  `money-build` line for each crate) and the hash line for that file in `locked.sha256`.
  Versions and registry checksums come from the lock; features are unchanged. `locked.py facts`
  reports all 80 facts matching their pins. **A maintainer reads this diff before merge.**

## Library defaults that moved (`sharp-edges`)

- **iroh-blobs 0.105: provider event masks** (`observe` off by default). Production passes `None`
  to `BlobsProtocol::new` (`nfx-node/src/node.rs`), so no mask is in play. The only user of
  `provider::events` is `spikes/s1-iroh`, a separate crate outside the workspace and CI, left on
  its old pins.
- **iroh-gossip 0.103: `Event` is `#[non_exhaustive]`.** nfx reads
  `let Ok(Event::Received(msg)) = event else { continue }` and verifies every message as a signed
  envelope before trusting it, so a new variant is ignored by construction.
- **iroh-gossip 0.103: `max_peer_streams`.** Unset it keeps the endpoint's limit, as before. A
  peer sharing more topics than the limit now loses its connection, which closes a way for one peer
  to hold many topic streams open.
- **iroh-blobs 0.105: imports are synced before they count as complete.** Durability, not
  security; imports may be slower.

## Left alone, on purpose

- `spikes/s1-iroh` keeps its own pins (iroh 1.2, blobs 0.103, gossip 0.101): a frozen spike with
  its own lock, outside CI.
- The deployed public relay is a separate binary at 1.2.0. 1.4.2 carries server-side fixes
  (empty datagram no longer disconnects the recipient, full frame-length check, undecodable packets
  dropped); bumping it is a live change and its own step.

## Not proven here

- Wire interop with already-released nodes is expected, not observed: the ALPNs are unchanged
  (`/iroh-bytes/4`, `/iroh-gossip/1`), iroh-blobs' `protocol.rs` is byte-identical between 0.103
  and 0.105, the gossip message enums are identical, and 0.103 tests its stream header against the
  old encoding. No old-versus-new run was made.
