# 109. Browsers take segments from peers first

Date: 2026-11-26

## Status

Proposed 2026-11-26. Decided by the maintainer (sovtech). It amends NFX-10 §1 and §6.8, which
are a Draft, in place. Nothing on the wire changes.

## Context

- The web player's mesh engine (p2p-media-loader-core 4.0.0) asks an origin first: the
  segment hls.js wants and the next 15 s go over HTTPS, a peer download inside that stretch
  is cancelled in favour of HTTPS, and peers fill in only further ahead. With a healthy
  origin, most of a session's bytes come from it, and the first frame always does.
- NFX has no TURN (NFX-10 §6.8), so a browser reaches a peer only where UDP gets through. A
  browser whose WebRTC is switched off or kept to a proxy (a setting, a hardened build's
  default, or an extension) gathers no UDP candidate and connects to no peer. The player said
  nothing about it: such a viewer saw an origin as the only source and no reason.
- The maintainer's direction: a browser takes its video from the network's peers, and an
  origin is the exception. Later, nothing at all over HTTPS (the start-up files too), which
  needs a wire change and is not this record.

## Decision

1. **Where segments come from is an option of `open()`**, `segmentSource`:
   - `https-first`: as before, and still the library's default.
   - `peers-then-https`: a segment comes from a peer that announced it. HTTPS is a **rescue**,
     for the segment playback is asking for only: at once when no connected peer holds it and
     peers have had their wait to connect; or, when a peer holds it, only if playback is
     about to need it and has asked for it for the whole wait. Nothing is fetched over HTTPS
     in the background. Each rescue is counted and reported.
   - `peers-only`: never HTTPS for a segment. With no peer to deliver one, playback waits; it
     does not fail.
2. **One wait, `peerWaitMs` (default 4000).** It is how long peers get to connect at the
   start, how long playback must have asked for a segment a peer holds, and, as seconds of
   playback, how close playback must be to that segment. A stream that becomes current with
   no peer yet (a level change) gets the same wait, but it yields to a segment playback is
   about to need.
3. **The engine patch carries it** (`segmentPolicy`, `peerWaitMs` in
   web/player/engine): one pure function decides for each segment, and `http-first` is the
   engine's published code path, untouched. Under the other two the player's request is
   never failed after HTTP errors; the attempts are forgotten after a minute.
4. **Bounded reach.** With peers first the engine fetches 30 s ahead of playback and keeps
   at most 512 MiB, where unconfigured it reaches 6000 s and 4096 MiB: an nfxd serves a
   connection 60 requests at once and 20 a second after, and drops one that asks faster.
5. **The player says what it found.** At the start of a session with a mesh it checks once
   whether the browser's WebRTC gathers a UDP candidate (one throwaway connection, asking
   only the STUN servers the mesh would ask anyway). If none: a `mesh` event and
   `MeshStats.webrtc: 'blocked'`, and under `peers-then-https` the wait for peers ends there.
   While playback has nothing to play and waits for a peer: `waiting` (no peer connected, or
   connected peers have not delivered), then `resumed`.
6. **It can change while a session plays.** `Session.setSegmentSource` hands the running
   engine the settings of another source, so a page can give its viewer a switch that turns
   HTTPS off for segments, and on again. A download under way finishes where it started.
7. **Not on the mesh yet.** The hash list, playlists and init segments still come from an
   origin under all three, and levels are still those an origin holds (NFX-10 §1). A page
   that offers "no HTTPS" should say so.

## Consequences

- A page that sets `peers-then-https` moves its segment load from origins to the peers that
  hold the video: nfxd mesh endpoints and other viewers. An endpoint takes 16 connections by
  default, and one data channel carries one segment at a time, so a busy video needs more
  endpoints or more viewers that hold it. What a single connection carries (a 4K rendition
  included) is not measured yet; the new end-to-end test records the time to the first frame.
- `peers-only` has no fallback by design. Where UDP is blocked, where no reachable peer holds
  the video, or where the browser's WebRTC is off, nothing plays, and the page can say why.
- The STUN servers a page names are asked once at the start of every session with a mesh,
  not only when a peer appears. They are the page's own choice already (NFX-10 §1).
- The viewer's IP address goes to the same parties as before: signaling relays and the peers
  it connects to.
- Tests: `web/player/policy-unit.ts` (the decision function over every input),
  `web/player/unit.ts` (the option, the engine configuration, rescues, the WebRTC check with
  stand-in connections) and `web/player/e2e-peer-first.ts` (a browser and nfxd over a stock
  relay: peers only with the origin refusing every segment from the start; peers first with
  no rescue; no peer, so rescues after the wait; HTTPS switched off and on while it plays; a
  browser whose WebRTC cannot use UDP).
