//! An NFX-04 scoped relay that a seeder can embed (§7): nostr-sdk's relay behind NFX
//! admission (§1), the §2 rate limits and a §3 NIP-11 document, served over HTTP/1.1.
//!
//! Admission runs the full `nfx-proto` checks: a kind-38504 event must pass NFX-02, and
//! a kind-20464 event must pass NFX-03 at the time it arrives, both in a namespace this
//! relay serves. Everything else is `blocked: out of scope`. Beacons are ephemeral, so
//! nostr-sdk forwards them to live subscribers and never stores them; expired events are
//! refused on write and skipped on read (NIP-40). The host's own events go through the
//! same door as everyone else's (§7).
//!
//! Stored manifests live in memory, capped at [`MAX_STORED_EVENTS`]: a restart forgets
//! them, and publishers re-mirror (§4). TLS belongs in front, as for the origin.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{self, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use nfx_proto::beacon::Beacon;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::Namespace;
use nfx_proto::{KIND_BEACON, KIND_MANIFEST, MAX_CLOCK_SKEW};
use nostr_sdk::prelude as ns;
use tokio::net::TcpListener;

use crate::limit::{ConnGuard, ConnLimits};
use crate::nostr::from_nostr;
use crate::origin::{BoxFuture, HEADER_READ_TIMEOUT};
use crate::unix_now;

/// §2: at most one beacon per (`pubkey`, `a`) per this many seconds.
pub const BEACON_FLOOR_SECS: u64 = 20;
/// §2: manifest publishes per pubkey per hour.
pub const MANIFESTS_PER_HOUR: usize = 12;
/// §2: concurrent subscriptions per connection.
pub const MAX_SUBSCRIPTIONS: usize = 20;
/// §2: entries in any one tag list of a filter (`#a`, `#n`, …).
pub const MAX_FILTER_VALUES: usize = 256;
/// §2: hard size limits, on the event's JSON.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_BEACON_BYTES: usize = 16 * 1024;
/// Events per minute per connection, across videos. A seeder announcing many videos at
/// TTL/2 over one connection must fit; the per-key limits above are the real bound.
const EVENTS_PER_MINUTE: u32 = 1_200;
/// Stored events (manifests; beacons are never stored). Keys are free, so a flood of valid
/// manifests from fresh keys must not grow memory without bound; past the cap the oldest
/// go. Publishers mirror manifests to public relays too (§4).
pub const MAX_STORED_EVENTS: usize = 20_000;
/// Rate-limit keys kept before stale ones are swept.
const SWEEP_ABOVE: usize = 10_000;
/// Sweeps are O(keys), so they run at most this often, never once per admission.
const SWEEP_EVERY_SECS: u64 = 60;
/// Room for the `["EVENT", …]` framing around the largest admitted event.
const MAX_MESSAGE_BYTES: usize = MAX_MANIFEST_BYTES + 1024;

type Refusal = (ns::MachineReadablePrefix, String);

#[derive(Debug, Default)]
struct Limits {
    /// (pubkey, a-tag) → when the last beacon was admitted.
    beacons: HashMap<(String, String), u64>,
    /// pubkey → admission times within the last hour.
    manifests: HashMap<String, VecDeque<u64>>,
    /// When stale keys were last swept (at most once per [`SWEEP_EVERY_SECS`]).
    swept_at: u64,
}

/// NFX-04 §1 admission and §2 publish limits.
#[derive(Debug)]
struct Admission {
    namespaces: BTreeSet<String>,
    limits: Mutex<Limits>,
}

impl Admission {
    /// Verification (signatures, NFX-02/03) runs before the lock is taken; the lock
    /// guards only the rate-limit counters.
    fn admit(&self, event: &ns::Event, now: u64) -> Result<(), Refusal> {
        use ns::MachineReadablePrefix::{Blocked, Invalid, RateLimited};
        let kind = event.kind.as_u16();
        if kind != KIND_MANIFEST && kind != KIND_BEACON {
            return Err((Blocked, "out of scope".into()));
        }
        let ev = from_nostr(event).map_err(|_| (Invalid, "unreadable event".to_owned()))?;
        let in_scope = matches!(
            ev.single_tag("n"),
            Ok(Some([n, ..])) if self.namespaces.contains(n)
        );
        if !in_scope {
            return Err((Blocked, "out of scope".into()));
        }
        // A far-future `created_at` would outrank every real revision and, in the
        // capped store, never be evicted (§2).
        if ev.created_at > now.saturating_add(MAX_CLOCK_SKEW) {
            return Err((Invalid, "created_at is in the future".into()));
        }
        let size = event.as_json().len();
        let beacon_key = if kind == KIND_MANIFEST {
            if size > MAX_MANIFEST_BYTES {
                return Err((Invalid, "manifest over 64 KiB".into()));
            }
            Manifest::from_event(&ev).map_err(|e| (Invalid, e.to_string()))?;
            None
        } else {
            if size > MAX_BEACON_BYTES {
                return Err((Invalid, "beacon over 16 KiB".into()));
            }
            let beacon = Beacon::from_event(&ev, now).map_err(|e| (Invalid, e.to_string()))?;
            let a = format!(
                "{KIND_MANIFEST}:{}:{}",
                beacon.creator, beacon.content.video
            );
            Some((ev.pubkey.clone(), a))
        };

        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        if now >= limits.swept_at.saturating_add(SWEEP_EVERY_SECS)
            && limits.beacons.len() + limits.manifests.len() > SWEEP_ABOVE
        {
            limits.swept_at = now;
            limits
                .beacons
                .retain(|_, last| now < *last + BEACON_FLOOR_SECS);
            limits
                .manifests
                .retain(|_, times| times.back().is_some_and(|t| now < t + 3600));
        }
        match beacon_key {
            None => {
                let times = limits.manifests.entry(ev.pubkey.clone()).or_default();
                while times.front().is_some_and(|t| now >= t + 3600) {
                    times.pop_front();
                }
                if times.len() >= MANIFESTS_PER_HOUR {
                    return Err((RateLimited, "manifest publishes per hour".into()));
                }
                times.push_back(now);
            }
            Some(key) => {
                if limits
                    .beacons
                    .get(&key)
                    .is_some_and(|last| now < last + BEACON_FLOOR_SECS)
                {
                    return Err((RateLimited, "one beacon per 20 s per video".into()));
                }
                limits.beacons.insert(key, now);
            }
        }
        Ok(())
    }
}

impl ns::WritePolicy for Admission {
    fn admit_event<'a>(
        &'a self,
        event: &'a ns::Event,
        _addr: &'a SocketAddr,
    ) -> BoxFuture<'a, ns::WritePolicyResult> {
        Box::pin(async move {
            match self.admit(event, unix_now()) {
                Ok(()) => ns::WritePolicyResult::Accept,
                Err((prefix, message)) => ns::WritePolicyResult::reject(prefix, message),
            }
        })
    }
}

/// §2 filter cardinality.
#[derive(Debug)]
struct QueryLimits;

/// Whether any tag list in `filter` exceeds [`MAX_FILTER_VALUES`].
#[must_use]
pub fn filter_too_wide(filter: &ns::Filter) -> bool {
    filter
        .generic_tags
        .values()
        .any(|values| values.len() > MAX_FILTER_VALUES)
}

impl ns::QueryPolicy for QueryLimits {
    fn admit_query<'a>(
        &'a self,
        query: &'a mut ns::Filter,
        _addr: &'a SocketAddr,
    ) -> BoxFuture<'a, ns::QueryPolicyResult> {
        Box::pin(async move {
            if filter_too_wide(query) {
                ns::QueryPolicyResult::reject(
                    ns::MachineReadablePrefix::Invalid,
                    "tag list over 256 entries",
                )
            } else {
                ns::QueryPolicyResult::Accept
            }
        })
    }
}

/// A scoped relay for `namespaces`.
pub struct ScopedRelay {
    local: ns::LocalRelay,
    nip11: Bytes,
}

impl ScopedRelay {
    #[must_use]
    pub fn new(namespaces: &[Namespace]) -> Self {
        let names: BTreeSet<String> = namespaces.iter().map(ToString::to_string).collect();
        let database = nostr_memory::MemoryDatabase::bounded(
            std::num::NonZeroUsize::new(MAX_STORED_EVENTS).unwrap_or(std::num::NonZeroUsize::MIN),
        );
        let local = ns::LocalRelay::builder()
            .database(database)
            .write_policy(Admission {
                namespaces: names.clone(),
                limits: Mutex::new(Limits::default()),
            })
            .query_policy(QueryLimits)
            .rate_limit(ns::RateLimit {
                max_reqs: MAX_SUBSCRIPTIONS,
                notes_per_minute: EVENTS_PER_MINUTE,
            })
            .max_event_size(MAX_MANIFEST_BYTES)
            .max_websocket_message_size(MAX_MESSAGE_BYTES)
            .max_connections(crate::limit::MAX_CONNECTIONS)
            .build();
        let nip11 = serde_json::json!({
            "name": "nfx scoped relay",
            "description": "NFX-04 scoped relay: NFX manifests and beacons only",
            "software": "nfx-node",
            "version": env!("CARGO_PKG_VERSION"),
            "supported_nips": [1, 11, 40],
            "limitation": {
                "max_message_length": MAX_MANIFEST_BYTES,
                "max_subscriptions": MAX_SUBSCRIPTIONS,
                "max_content_length": MAX_MANIFEST_BYTES,
                "restricted_writes": true
            },
            "nfx": {
                "networks": names,
                "kinds": [KIND_MANIFEST, KIND_BEACON],
                "roles": ["catalog", "availability"]
            }
        });
        Self {
            local,
            nip11: Bytes::from(nip11.to_string()),
        }
    }

    /// `guard` is the connection's admission slot; an upgraded WebSocket keeps it.
    fn respond(
        self: &Arc<Self>,
        mut req: Request<hyper::body::Incoming>,
        addr: SocketAddr,
        guard: Arc<ConnGuard>,
    ) -> Response<Full<Bytes>> {
        let headers = req.headers();
        let has = |name: header::HeaderName, token: &str| {
            headers
                .get_all(name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|v| v.split(','))
                .any(|v| v.trim().eq_ignore_ascii_case(token))
        };
        let upgrade = req.method() == hyper::Method::GET
            && has(header::CONNECTION, "upgrade")
            && has(header::UPGRADE, "websocket");
        if upgrade {
            let version_ok = headers
                .get(header::SEC_WEBSOCKET_VERSION)
                .is_some_and(|v| v.as_bytes() == b"13");
            let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).cloned() else {
                return plain(StatusCode::BAD_REQUEST, "missing Sec-WebSocket-Key");
            };
            if !version_ok {
                let mut r = plain(StatusCode::UPGRADE_REQUIRED, "WebSocket version 13 only");
                r.headers_mut().insert(
                    header::SEC_WEBSOCKET_VERSION,
                    HeaderValue::from_static("13"),
                );
                return r;
            }
            let on_upgrade = hyper::upgrade::on(&mut req);
            let relay = self.clone();
            tokio::spawn(async move {
                let _guard = guard;
                if let Ok(upgraded) = on_upgrade.await {
                    let _ = relay
                        .local
                        .take_connection(TokioIo::new(upgraded), addr)
                        .await;
                }
            });
            let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
            return Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header(header::CONNECTION, "Upgrade")
                .header(header::UPGRADE, "websocket")
                .header(header::SEC_WEBSOCKET_ACCEPT, accept)
                .body(Full::new(Bytes::new()))
                .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "upgrade"));
        }
        let wants_nip11 = headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("application/nostr+json"));
        if wants_nip11 {
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/nostr+json")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
                .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Full::new(self.nip11.clone()))
                .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "nip11"));
        }
        plain(StatusCode::OK, "nfx scoped relay (NIP-01 over WebSocket)")
    }

    /// Serve on `listener` until the task is dropped: WebSocket upgrades go to the relay,
    /// `Accept: application/nostr+json` gets the NIP-11 document.
    /// Connections are capped per address and in total ([`crate::limit`]); a WebSocket
    /// holds its slot for as long as it is open.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        let limits = Arc::new(ConnLimits::default());
        loop {
            let (stream, addr) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                }
            };
            let Some(guard) = limits.admit(addr) else {
                continue;
            };
            let guard = Arc::new(guard);
            let relay = self.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let (relay, guard) = (relay.clone(), guard.clone());
                    async move { Ok::<_, Infallible>(relay.respond(req, addr, guard)) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_READ_TIMEOUT)
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    }

    pub fn shutdown(&self) {
        self.local.shutdown();
    }
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn filters_wider_than_256_values_are_refused() {
        let a = |n: usize| (0..n).map(|i| format!("38504:x:nfx:mainnet:1:v{i}"));
        let ok = ns::Filter::new().custom_tags(ns::SingleLetterTag::LOWERCASE_A, a(256));
        let wide = ns::Filter::new().custom_tags(ns::SingleLetterTag::LOWERCASE_A, a(257));
        assert!(!filter_too_wide(&ok));
        assert!(filter_too_wide(&wide));
    }
}
