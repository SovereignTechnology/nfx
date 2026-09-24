# Pre-push review: A2 `nfx-node` layer 3, the origin (`a2/nfx-node`, 2026-09-23)

Scope:
- `crates/nfx-node/src/origin.rs`: `Origin`, `serve` and `SwarmPull`;
- `tests/origin.rs`, with the fixtures moved into `tests/common/`;
- new direct dependencies, all already in the tree through iroh: `hyper` (server and
  http1), `hyper-util`, `http-body-util` and `bytes`.

Method: `differential-review` (a network-facing server) and `sharp-edges`.

## Adversarial pass

| Attack | Result |
|---|---|
| Use the origin as an open proxy for arbitrary sha256 values | Only files listed in a held hash list are served or pulled, and a hash list is held only after `HashList::verify_for` against a manifest. Tested: a stored but unlisted blob, and a listed file under a root that does not list it, both give 404. |
| Poison the CDN through the origin | Every body goes through `ContentStore::get`, which re-hashes. Pulled bytes are re-anchored to sha256 by `Node::fetch` before they are stored. Tested: a store file that rotted on disk gives 500 `no-store` and never its bytes; a lying seeder is caught and forgotten, and the honest one serves. |
| Path tricks | Paths are matched against exact shapes: 64 lowercase hex plus an optional `[a-z0-9]{1,16}` extension, with no empty components. Tested: uppercase, `..`, a trailing slash, `//`, percent-encoding, and `/../etc/passwd` all give 404 `no-store`. |
| Serve creator-controlled bytes as HTML (XSS on the origin's domain) | `Content-Type` comes from the role; the thumb MIME is allow-listed. Every response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Tested with a `text/html` thumb. |
| Cache an error for a year | Every non-200 carries `no-store` (§6.1), and hits never `Vary`. Tested. |
| Leak internals through errors | A failed pull answers `502 not available yet`; the cause is not echoed. |
| Stampede on a cold file | Pulls are serialised per video, and waiting requests re-check the store before pulling. Tested with four concurrent misses. |
| A dead or departed seeder | `SwarmPull` sources lapse when their beacon expires. An older beacon never replaces a newer one. Tested with an expired beacon. |
| Slow-loris | `header_read_timeout` is 10 s. |

## Sharp edges carried forward

- **Amplification is bounded only by the held set.** One request for a segment pulls
  that whole rendition (the M1 whole-collection fetch). The operator chooses which
  videos an origin holds; per-member fetch arrives with the M2 window gate.
- **Connection limits and idle keep-alive** belong to the CDN or reverse proxy in front.
  `serve` does not cap concurrent connections. Revisit if `nfxd` exposes it directly.
- **A slow pull holds an HTTP request** for up to `FETCH_TIMEOUT` (120 s) per source
  tried. CDNs usually time out first and retry, which is harmless, because errors are
  `no-store`. Ordering sources by health is `nfxd`'s job.
- **Beacon tickets name arbitrary iroh endpoints**, so a hostile beacon can make the
  origin dial an endpoint or address of the attacker's choosing, over QUIC only. The
  exposure is the same as any watcher's; noted for the scoped-relay work (NFX-04),
  which bounds who can publish beacons.

## Test harness note

iroh builds reqwest with `rustls-no-provider`, so a reqwest client in tests panics
without a crypto provider. The test uses hyper's own HTTP/1 client instead (a
dev-dependency feature, `client`).

Verdict: **no blocker.** The push waits for sovtech's OK.

**Erratum (pre-push audit, same day):** connection caps, a connection lifetime, a 60 s pull deadline, source cooldowns and query refusal were added. See `2026-09-23-a2-pre-push.md` #2, #3, #6.
