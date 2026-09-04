# Spike S-A — Hypercore per-peer upload gating

**Question (assumption A4):** when a peer exceeds the unpaid window, is there a Hypercore API
to pause uploads to *that peer*, or is stream-destroy the tool?

**Method:** source read of `hypercore@11.35.3` (`lib/replicator.js`, `index.js`), plus the
vendored `hyperswarm@4.17.0` and `protomux@3.11.0` READMEs. Not runtime-verified; lane L2's
definition of done covers that ("upload-event accounting matches").

**Date:** 2026-09-04

## Findings

1. **There is no public per-peer "stop uploading" API.** `Peer.sendSync()` hardcodes
   `uploading: true` (`replicator.js:702`); there is no `setUploading`, and `core.setActive()`
   is core-wide, not per-peer.
2. **An internal flag does exactly what we want, but it is not ours to use.** `Peer.paused`
   makes `isActive()` false (`:1922`), and `_fulfillRequest` silently drops block responses
   when `!isActive()` (`:1112`). But Hypercore itself sets and clears `paused` for its own
   backoff, fork-conflict and storage-full logic (`:1176, :1216, :1250, :1270, :1284,
   :2770, :2779`) and flips it back to `false` on conflict resolution. Piggybacking on it
   is an undocumented API that Hypercore can legitimately undo under us. **Rejected.**
3. **`core.on('upload', index, byteLength, peer)` fires synchronously BEFORE the block is
   written to the wire.** `_fulfillRequest` calls `replicator._onupload(...)` (`:1137`) and
   only then `wireData.send(...)` (`:1145`). Consequence: a handler that destroys the stream
   inside the `upload` event prevents *that* block from leaving. The seeder's accounting can
   therefore be exact — the block that crosses the window is counted and not sent.
4. **Remote in-flight is not something the seeder can cap.** `DEFAULT_MAX_INFLIGHT =
   [16, 512]` (`:46`) is the *requester's* concurrency; a viewer can have many requests
   queued at the seeder. But requests are serviced one at a time through
   `receiverQueue`/`_handleRequests` (`:972-989`), whose loop exits on `this.removed`, so
   after a destroy nothing further is served. Overshoot past the window is bounded by
   whatever `send()` calls already completed before our handler ran — i.e. zero, per (3).
5. **Two cut mechanisms exist, coarse and fine:**
   - **Stream destroy** (`peer.stream.destroy()`, i.e. the Noise/UDX connection): kills
     replication of *every* core on that connection *and* the `pay/1` channel. Simple; no
     way to send a final `ACK{ok:false, reason:'window-exceeded'}` after it.
   - **Channel close** (`peer.channel.close()`, protomux): closes only this core's
     replication channel on that mux; the connection and `pay/1` channel stay up, so we can
     send the reason first, then close. Hypercore will treat the peer as removed. But
     Hypercore's `mux.pair()` handler would accept a *re-opened* channel from the same
     peer, so a channel close must be paired with a ban check in the accept path, or the
     peer just reopens.
6. **Reconnect defence lives in Hyperswarm, not Hypercore.** `peerInfo.ban(true)` "will
   prevent any future reconnection attempts, but it will not close any existing
   connections" (hyperswarm README). So: ban first, then destroy. The ban is keyed on the
   Noise public key; the `pay/1` layer additionally bans the Nostr pubkey bound in `HELLO`,
   and `swarm.on('connection')` must reject connections from either.

## Decision

- **A4 stands, refined:** the tool is **`peerInfo.ban(true)` + `peer.stream.destroy()`**,
  invoked synchronously from the `upload` handler the moment `uploaded − paid > window`.
  Residual loss = window (default 4 blocks); the crossing block is not sent.
- **`pay/1` sends `ACK{ok:false, reason}` before the destroy** when the cut is a protocol
  decision (bad PAY, banned) rather than a window overrun; for the overrun there is no
  time to wait for a flush, so the destroy is immediate and the reason is only logged.
- **Contract impact:** `PayProtocol.cut(reason)` (already in contracts v1) is the right
  shape. `PaymentEngineSeeder.recordUpload()` must be called from inside the `upload`
  handler and its `onWindowExceeded` callback must run synchronously — a contract note is
  added in v2 (`recordUpload` returns the window so the caller can act in the same tick).
- **L2 must runtime-verify (3):** with two Corestores over a duplex pair, confirm that a
  destroy inside `upload` leaves the viewer with exactly `window` blocks downloaded.
- **Ban list is persisted by the seeder** keyed on *both* Noise key and Nostr pubkey.

## Open

- Whether to switch to channel-close + accept-path ban for the nicer "tell them why" UX.
  Not needed for correctness; revisit in Stage 3 if support requests show confused users.
