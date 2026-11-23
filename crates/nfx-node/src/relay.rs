//! An NFX-04 scoped relay that a seeder can embed (§7): nostr-sdk's relay behind NFX
//! admission (§1), the §2 rate limits and a §3 NIP-11 document, served over HTTP/1.1.
//!
//! Admission runs the full `nfx-proto` checks: a kind-38504 event must pass NFX-02, a
//! kind-20464 event must pass NFX-03 at the time it arrives, and a kind-5 deletion must
//! be a valid NFX deletion (NFX-02 §6), all in namespaces this relay serves. nostr-sdk's
//! store then applies deletions (NIP-09). Everything else is `blocked: out of scope`. Beacons are ephemeral, so
//! nostr-sdk forwards them to live subscribers and never stores them; expired events are
//! refused on write and skipped on read (NIP-40). The host's own events go through the
//! same door as everyone else's (§7).
//!
//! With mesh signaling on ([`ScopedRelay::with_options`]), it also carries kind 25050 with `i` =
//! `nfx-mesh/1` (NFX-04 §1 as amended 2026-11-18, NFX-10 §6): the checks a reader makes
//! that need no session (`nfx_proto::signal::relayable`), the room proof included, then a
//! presence floor per (sender, room, type) and a budget of offers and answers per sender.
//! They are ephemeral like beacons. The network cannot be checked: kind 25050 carries no
//! `n`, and the room key hides which video and network a room is.
//!
//! With STUN service announcements on ([`MayAdmit::stun_announcements`]), it also carries
//! kind 33478 (NFX-04 §1 as amended 2026-11-19, NFX-10 §1): an announcement must pass a
//! reader's checks when it arrives (`nfx_proto::stun::StunAnnouncement`) and name one of the
//! relay's networks, within 2 KiB, 12 per hour per operator key and [`MAX_STUN_ANNOUNCEMENTS`]
//! held at once. It is addressable, so the store keeps the newest per operator and server,
//! never returns it after its `expiration` (NIP-40), and drops it from the store once it has
//! expired, at the next admission of one.
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
use nfx_proto::deletion::Deletion;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::Namespace;
use nfx_proto::signal::{self, KIND_SIGNAL};
use nfx_proto::stun::{KIND_STUN_ANNOUNCEMENT, StunAnnouncement};
use nfx_proto::{KIND_BEACON, KIND_DELETION, KIND_MANIFEST, MAX_CLOCK_SKEW, Verified};
use nostr_database::error::Error as DbError;
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
/// Mesh signaling (§1 as amended 2026-11-18, §2): the hard size of a kind-25050 event (its
/// content is at most 32 KiB, NFX-10 §6.2, and its tags well under 4 KiB).
pub const MAX_SIGNAL_BYTES: usize = 36 * 1024;
/// At most one presence of a type (`connect` or `disconnect`) per (sender, room) per this
/// many seconds. Senders repeat `connect` every 30 s (NFX-10 §6.6).
pub const PRESENCE_FLOOR_SECS: u64 = 10;
/// Offers and answers per sender per [`DIRECTED_WINDOW_SECS`]. A peer has at most 16
/// negotiations in flight per room (NFX-10 §6.5); a seeder answers many rooms.
pub const DIRECTED_PER_WINDOW: usize = 64;
pub const DIRECTED_WINDOW_SECS: u64 = 30;
/// STUN service announcements (§1 as amended 2026-11-19, §2): the hard size of one. A
/// full one (8 networks) is under 1 KiB.
pub const MAX_STUN_ANNOUNCEMENT_BYTES: usize = 2 * 1024;
/// Announcements per operator key per hour. A sender re-sends each every 12 h (NFX-10 §1).
pub const STUN_ANNOUNCEMENTS_PER_HOUR: usize = 12;
/// Announcements held at once. Keys are free, so while this many are live a new one is
/// refused (one that replaces a held one is not): they never crowd manifests out of the store.
pub const MAX_STUN_ANNOUNCEMENTS: usize = 1024;
/// Room for the `["EVENT", …]` framing around the largest admitted event.
const MAX_MESSAGE_BYTES: usize = MAX_MANIFEST_BYTES + 1024;

type Refusal = (ns::MachineReadablePrefix, String);

#[derive(Debug, Default)]
struct Limits {
    /// (pubkey, a-tag) → when the last beacon was admitted.
    beacons: HashMap<(String, String), u64>,
    /// pubkey → admission times within the last hour.
    manifests: HashMap<String, VecDeque<u64>>,
    /// (sender, room, presence type) → when the last one was admitted.
    presence: HashMap<(String, String, &'static str), u64>,
    /// sender → offer and answer admission times within the last window.
    directed: HashMap<String, VecDeque<u64>>,
    /// (operator, server) → the held announcement: its `created_at`, `expiration` and id.
    stun: HashMap<(String, String), (u64, u64, String)>,
    /// operator → announcement admission times within the last hour.
    stun_times: HashMap<String, VecDeque<u64>>,
    /// When stale keys were last swept (at most once per [`SWEEP_EVERY_SECS`]).
    swept_at: u64,
}

/// What a scoped relay admits beyond what NFX-04 §1 requires: its MAYs. Default: neither.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MayAdmit {
    /// Kind-25050 mesh signaling, `nfx-mesh/1` (§1 as amended 2026-11-18, NFX-10 §6).
    pub mesh_signaling: bool,
    /// Kind-33478 STUN service announcements for its networks (§1 as amended 2026-11-19,
    /// NFX-10 §1).
    pub stun_announcements: bool,
}

/// NFX-04 §1 admission and §2 publish limits.
#[derive(Debug)]
struct Admission {
    namespaces: BTreeSet<String>,
    /// When set, only these creators' manifests and deletions, and beacons for their
    /// videos, are admitted: an operator's content policy (NFX-04 §8), and the strongest
    /// answer to floods from freshly minted keys.
    creators: Option<BTreeSet<String>>,
    /// Which of NFX-04 §1's MAYs it takes.
    may: MayAdmit,
    limits: Mutex<Limits>,
    /// The relay's own store, for applying NFX deletions (see [`Admission::apply`]).
    db: Arc<dyn ns::NostrDatabase>,
}

/// What passed the synchronous checks.
enum Admitted {
    Beacon,
    Signal,
    /// A STUN announcement, and the expired ones (operator, server, `created_at`) to drop
    /// from the store.
    Stun(Vec<(String, String, u64)>),
    Manifest(Box<Verified<Manifest>>),
    Deletion(Deletion),
}

impl Admission {
    /// Verification (signatures, NFX-02/03) runs before the lock is taken; the lock
    /// guards only the rate-limit counters.
    fn admit(&self, event: &ns::Event, now: u64) -> Result<Admitted, Refusal> {
        use ns::MachineReadablePrefix::{Blocked, Invalid, RateLimited};
        let kind = event.kind.as_u16();
        if kind == KIND_SIGNAL && self.may.mesh_signaling {
            return self.admit_signal(event, now);
        }
        if kind == KIND_STUN_ANNOUNCEMENT && self.may.stun_announcements {
            return self.admit_stun(event, now);
        }
        if kind != KIND_MANIFEST && kind != KIND_BEACON && kind != KIND_DELETION {
            return Err((Blocked, "out of scope".into()));
        }
        let ev = from_nostr(event).map_err(|_| (Invalid, "unreadable event".to_owned()))?;
        // NFX-02 §6: `a` tags only, all the author's own manifests, all served here.
        let deletion = if kind == KIND_DELETION {
            Some(Deletion::from_event(&ev).map_err(|e| (Invalid, e.to_string()))?)
        } else {
            None
        };
        let in_scope = if let Some(d) = &deletion {
            d.addresses
                .iter()
                .all(|a| self.namespaces.contains(&a.namespace().to_string()))
        } else {
            matches!(
                ev.single_tag("n"),
                Ok(Some([n, ..])) if self.namespaces.contains(n)
            )
        };
        if !in_scope {
            return Err((Blocked, "out of scope".into()));
        }
        let allowed = |creator: &str| self.creators.as_ref().is_none_or(|c| c.contains(creator));
        if (kind == KIND_MANIFEST || kind == KIND_DELETION) && !allowed(&ev.pubkey) {
            return Err((Blocked, "creator not allowed here".into()));
        }
        // A far-future `created_at` would outrank every real revision and, in the
        // capped store, never be evicted (§2).
        if ev.created_at > now.saturating_add(MAX_CLOCK_SKEW) {
            return Err((Invalid, "created_at is in the future".into()));
        }
        let size = event.as_json().len();
        let mut manifest = None;
        let beacon_key = if kind == KIND_MANIFEST || kind == KIND_DELETION {
            // Deletions were verified above and share the manifest budget (§2).
            if size > MAX_MANIFEST_BYTES {
                return Err((Invalid, "event over 64 KiB".into()));
            }
            if kind == KIND_MANIFEST {
                manifest = Some(Manifest::from_event(&ev).map_err(|e| (Invalid, e.to_string()))?);
            }
            None
        } else {
            if size > MAX_BEACON_BYTES {
                return Err((Invalid, "beacon over 16 KiB".into()));
            }
            let beacon = Beacon::from_event(&ev, now).map_err(|e| (Invalid, e.to_string()))?;
            if !allowed(&beacon.creator) {
                return Err((Blocked, "creator not allowed here".into()));
            }
            let a = format!(
                "{KIND_MANIFEST}:{}:{}",
                beacon.creator, beacon.content.video
            );
            Some((ev.pubkey.clone(), a))
        };

        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        limits.sweep(now);
        match beacon_key {
            None => {
                let times = limits.manifests.entry(ev.pubkey.clone()).or_default();
                while times.front().is_some_and(|t| now >= t + 3600) {
                    times.pop_front();
                }
                if times.len() >= MANIFESTS_PER_HOUR {
                    return Err((
                        RateLimited,
                        "manifest publishes and deletions per hour".into(),
                    ));
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
        Ok(match (manifest, deletion) {
            (Some(m), _) => Admitted::Manifest(Box::new(m)),
            (None, Some(d)) => Admitted::Deletion(d),
            (None, None) => Admitted::Beacon,
        })
    }

    /// A kind-25050 event (§1 as amended 2026-11-18): another protocol's is out of scope; an
    /// nfx-mesh/1 one must pass every check a reader makes that needs no session, the room
    /// proof included, then the presence floor or the offer-and-answer budget (§2).
    fn admit_signal(&self, event: &ns::Event, now: u64) -> Result<Admitted, Refusal> {
        use ns::MachineReadablePrefix::{Blocked, Invalid, RateLimited};
        if event.as_json().len() > MAX_SIGNAL_BYTES {
            return Err((Invalid, "signal over 36 KiB".into()));
        }
        let ev = from_nostr(event).map_err(|_| (Invalid, "unreadable event".to_owned()))?;
        if !signal::is_nfx_mesh(&ev) {
            return Err((Blocked, "out of scope".into()));
        }
        let r = signal::relayable(&ev, now).map_err(|e| (Invalid, e.to_string()))?;
        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        limits.sweep(now);
        if r.to.is_some() {
            let times = limits.directed.entry(r.sender).or_default();
            while times
                .front()
                .is_some_and(|t| now >= t + DIRECTED_WINDOW_SECS)
            {
                times.pop_front();
            }
            if times.len() >= DIRECTED_PER_WINDOW {
                return Err((RateLimited, "offers and answers per 30 s".into()));
            }
            times.push_back(now);
        } else {
            let key = (r.sender, r.room, r.kind.as_str());
            if limits
                .presence
                .get(&key)
                .is_some_and(|last| now < last + PRESENCE_FLOOR_SECS)
            {
                return Err((RateLimited, "one presence per 10 s per room".into()));
            }
            limits.presence.insert(key, now);
        }
        Ok(Admitted::Signal)
    }

    /// A kind-33478 STUN service announcement (§1 as amended 2026-11-19): a reader's checks
    /// at arrival (NFX-10 §1), one of this relay's networks, then the §2 size, per-key rate
    /// and the cap on those held. A creator allow-list does not apply: it names no video.
    fn admit_stun(&self, event: &ns::Event, now: u64) -> Result<Admitted, Refusal> {
        use ns::MachineReadablePrefix::{Blocked, Duplicate, Invalid, RateLimited};
        if event.as_json().len() > MAX_STUN_ANNOUNCEMENT_BYTES {
            return Err((Invalid, "announcement over 2 KiB".into()));
        }
        let ev = from_nostr(event).map_err(|_| (Invalid, "unreadable event".to_owned()))?;
        // The scope first, before the signature: another network's costs nothing more.
        let served = |n: &str| self.namespaces.contains(n);
        if !ev
            .tag_values("n")
            .any(|v| v.first().is_some_and(|n| served(n.as_str())))
        {
            return Err((Blocked, "out of scope".into()));
        }
        let a = StunAnnouncement::from_event(&ev, now).map_err(|e| (Invalid, e.to_string()))?;
        if !a.networks.iter().any(|n| served(n.to_string().as_str())) {
            return Err((Blocked, "out of scope".into()));
        }
        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        limits.sweep(now);
        let key = (a.operator.clone(), a.addr.clone());
        // The store keeps the newest per key and server, the lowest id on a tie (NIP-01): one
        // that would not replace the held one is refused here, so this table and the store
        // describe the same announcement. An expired one counts too: the store holds it until
        // it is dropped, and would keep it over an older one that this table then took for it.
        let replaces = match limits.stun.get(&key) {
            Some((held, expiration, id)) => {
                if *id == ev.id {
                    return Err((Duplicate, "already held".into()));
                }
                if a.created_at < *held {
                    return Err((
                        Invalid,
                        "a newer announcement of this server is held".into(),
                    ));
                }
                if a.created_at == *held && ev.id > *id {
                    return Err((
                        Duplicate,
                        "an equal announcement of this server, with a lower id, is held".into(),
                    ));
                }
                *expiration > now
            }
            None => false,
        };
        if !replaces {
            let live = limits.stun.values().filter(|(_, e, _)| *e > now).count();
            if live >= MAX_STUN_ANNOUNCEMENTS {
                return Err((RateLimited, "as many STUN announcements as it holds".into()));
            }
        }
        let times = limits.stun_times.entry(a.operator.clone()).or_default();
        while times.front().is_some_and(|t| now >= t + 3600) {
            times.pop_front();
        }
        if times.len() >= STUN_ANNOUNCEMENTS_PER_HOUR {
            return Err((RateLimited, "STUN announcements per hour".into()));
        }
        times.push_back(now);
        // Expired ones leave the table here, and the store once this one is accepted.
        let mut gone = Vec::new();
        limits.stun.retain(|k, (created_at, expiration, _)| {
            let keep = *expiration > now || *k == key;
            if !keep {
                gone.push((k.0.clone(), k.1.clone(), *created_at));
            }
            keep
        });
        limits
            .stun
            .insert(key, (a.created_at, a.expiration, ev.id.clone()));
        Ok(Admitted::Stun(gone))
    }

    /// Drop expired STUN announcements from the store: NIP-40 keeps them from every reader
    /// already, and this keeps them from holding room there.
    async fn drop_expired(&self, gone: &[(String, String, u64)]) {
        for (operator, server, created_at) in gone {
            let Ok(author) = ns::PublicKey::parse(operator) else {
                continue;
            };
            let filter = ns::Filter::new()
                .kind(ns::Kind::from(KIND_STUN_ANNOUNCEMENT))
                .author(author)
                .identifier(server.clone())
                .until(ns::Timestamp::from(*created_at));
            let _ = self.db.delete(filter).await;
        }
    }

    /// Remove the stored revisions a deletion withdraws. nostr-sdk's own NIP-09 handling
    /// cannot: it splits an `a` tag at every colon, so an NFX address
    /// (`38504:<pk>:nfx:<network>:<specver>:<id>`) reaches it as `d` = `nfx`.
    async fn apply(&self, d: &Deletion) {
        let Ok(author) = ns::PublicKey::parse(&d.author) else {
            return;
        };
        for addr in &d.addresses {
            let filter = ns::Filter::new()
                .kind(ns::Kind::from(KIND_MANIFEST))
                .author(author)
                .identifier(addr.to_string())
                .until(ns::Timestamp::from(d.created_at));
            let _ = self.db.delete(filter).await;
        }
    }

    /// Whether a stored deletion withdraws this revision (a replay of a deleted one).
    async fn withdrawn(&self, m: &Manifest) -> bool {
        let Ok(author) = ns::PublicKey::parse(&m.author) else {
            return false;
        };
        let filter = ns::Filter::new()
            .kind(ns::Kind::from(KIND_DELETION))
            .author(author)
            .custom_tag(ns::SingleLetterTag::LOWERCASE_A, m.a_tag());
        let Ok(found) = self.db.query(filter).await else {
            return false;
        };
        found
            .iter()
            .filter_map(|e| from_nostr(e).ok())
            .filter_map(|e| Deletion::from_event(&e).ok())
            .any(|d| d.deletes(m))
    }
}

impl Limits {
    /// Drop stale rate-limit keys, at most once per [`SWEEP_EVERY_SECS`] and only past
    /// [`SWEEP_ABOVE`] keys: sweeps are O(keys).
    fn sweep(&mut self, now: u64) {
        let keys = self.beacons.len()
            + self.manifests.len()
            + self.presence.len()
            + self.directed.len()
            + self.stun_times.len();
        if now < self.swept_at.saturating_add(SWEEP_EVERY_SECS) || keys <= SWEEP_ABOVE {
            return;
        }
        self.swept_at = now;
        self.beacons
            .retain(|_, last| now < *last + BEACON_FLOOR_SECS);
        self.manifests
            .retain(|_, times| times.back().is_some_and(|t| now < t + 3600));
        self.presence
            .retain(|_, last| now < *last + PRESENCE_FLOOR_SECS);
        self.directed
            .retain(|_, times| times.back().is_some_and(|t| now < t + DIRECTED_WINDOW_SECS));
        self.stun_times
            .retain(|_, times| times.back().is_some_and(|t| now < t + 3600));
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
                Ok(Admitted::Beacon | Admitted::Signal) => ns::WritePolicyResult::Accept,
                Ok(Admitted::Stun(gone)) => {
                    self.drop_expired(&gone).await;
                    ns::WritePolicyResult::Accept
                }
                Ok(Admitted::Manifest(m)) if self.withdrawn(&m).await => {
                    ns::WritePolicyResult::reject(
                        ns::MachineReadablePrefix::Invalid,
                        "deleted by its author (NFX-02 §6)",
                    )
                }
                Ok(Admitted::Manifest(_)) => ns::WritePolicyResult::Accept,
                Ok(Admitted::Deletion(d)) => {
                    self.apply(&d).await;
                    ns::WritePolicyResult::Accept
                }
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

/// The relay's event store: the in-memory one, with a NIP-50 `search` that matches the way the
/// desktop app's own test relay does: a case-insensitive substring of the event's content **or** of
/// its `title` tag. The memory store alone matches the content only, and a manifest's content is its
/// optional description, so a video published without one was in the relay yet invisible to a search
/// (measured 2026-11-07 on a live nfxd 0.1.0 relay: 0 hits for a title word until a description was added;
/// the app finds NFX videos by search, since its Trending and Shorts feeds never list them).
#[derive(Debug)]
struct TitleSearch {
    inner: nostr_memory::MemoryDatabase,
}

/// Whether `ev` answers a search for `needle` (already trimmed and lowercased).
fn search_matches(ev: &ns::Event, needle: &str) -> bool {
    ev.content.to_lowercase().contains(needle)
        || ev
            .tags
            .iter()
            .filter(|t| t.kind() == "title")
            .filter_map(|t| t.content())
            .any(|title| title.to_lowercase().contains(needle))
}

impl TitleSearch {
    /// `filter` without its `search` and `limit`, and the lowercase needle, when it searches.
    fn split(filter: &ns::Filter) -> Option<(ns::Filter, String)> {
        // A blank search matches everything: it is no search, not a search for spaces.
        let needle = filter.search.as_deref()?.trim().to_lowercase();
        let mut wide = filter.clone();
        wide.search = None;
        wide.limit = None;
        Some((wide, needle))
    }
}

impl ns::NostrDatabase for TitleSearch {
    fn backend(&self) -> &'static str {
        self.inner.backend()
    }

    fn features(&self) -> ns::Features {
        self.inner.features()
    }

    fn save_event<'a>(
        &'a self,
        event: &'a ns::Event,
    ) -> BoxFuture<'a, Result<ns::SaveEventStatus, DbError>> {
        self.inner.save_event(event)
    }

    fn check_id<'a>(
        &'a self,
        event_id: &'a ns::EventId,
    ) -> BoxFuture<'a, Result<ns::DatabaseEventStatus, DbError>> {
        self.inner.check_id(event_id)
    }

    fn event_by_id<'a>(
        &'a self,
        event_id: &'a ns::EventId,
    ) -> BoxFuture<'a, Result<Option<ns::Event>, DbError>> {
        self.inner.event_by_id(event_id)
    }

    fn count(&self, filter: ns::Filter) -> BoxFuture<'_, Result<usize, DbError>> {
        Box::pin(async move {
            match Self::split(&filter) {
                None => self.inner.count(filter).await,
                Some(_) => Ok(self.query(filter).await?.len()),
            }
        })
    }

    fn query(&self, filter: ns::Filter) -> BoxFuture<'_, Result<BTreeSet<ns::Event>, DbError>> {
        Box::pin(async move {
            let Some((wide, needle)) = Self::split(&filter) else {
                return self.inner.query(filter).await;
            };
            // The newest first, as the store returns them; `limit` applies after the match.
            let hits = self
                .inner
                .query(wide)
                .await?
                .into_iter()
                .filter(|ev| search_matches(ev, &needle));
            Ok(match filter.limit {
                Some(n) => hits.take(n).collect(),
                None => hits.collect(),
            })
        })
    }

    fn delete(&self, filter: ns::Filter) -> BoxFuture<'_, Result<(), DbError>> {
        self.inner.delete(filter)
    }

    fn wipe(&self) -> BoxFuture<'_, Result<(), DbError>> {
        self.inner.wipe()
    }
}

/// A scoped relay for `namespaces`.
pub struct ScopedRelay {
    local: ns::LocalRelay,
    nip11: Bytes,
}

impl ScopedRelay {
    /// An open scoped relay: any creator's manifests in `namespaces`.
    #[must_use]
    pub fn new(namespaces: &[Namespace]) -> Self {
        Self::build(namespaces, None, MayAdmit::default())
    }

    /// A scoped relay admitting only `creators` (x-only pubkey, 64 lowercase hex): their
    /// manifests and deletions, and beacons for their videos. It limits *which videos* the
    /// relay carries. It does not limit who may seed them: beacons from any seeder key for
    /// a listed creator's video are admitted (under the §2 per-key limits).
    ///
    /// An empty list, or a key in any other form, is an error: either would silently
    /// admit no one.
    pub fn with_creators(namespaces: &[Namespace], creators: &[String]) -> crate::Result<Self> {
        Self::admitting(namespaces, Some(creators), MayAdmit::default())
    }

    /// A scoped relay with an optional creator allow-list (as [`ScopedRelay::with_creators`])
    /// that, with `mesh_signaling`, also carries kind-25050 mesh signaling (NFX-04 §1 as
    /// amended 2026-11-18): ephemeral, nfx-mesh/1 only, every check a reader makes that needs
    /// no session, room proof included, then the §2 presence floor and offer-and-answer
    /// budget. The allow-list does not apply to signaling: a room key does not say whose
    /// video it is.
    pub fn with_options(
        namespaces: &[Namespace],
        creators: Option<&[String]>,
        mesh_signaling: bool,
    ) -> crate::Result<Self> {
        Self::admitting(
            namespaces,
            creators,
            MayAdmit {
                mesh_signaling,
                ..MayAdmit::default()
            },
        )
    }

    /// A scoped relay with an optional creator allow-list (as [`ScopedRelay::with_creators`])
    /// that also takes the MAYs of NFX-04 §1 that `may` names: kind-25050 mesh signaling (as
    /// [`ScopedRelay::with_options`]) and kind-33478 STUN service announcements for its
    /// networks (§1 as amended 2026-11-19): a reader's checks at arrival, one of its
    /// networks, the §2 size, rate and cap, kept until they expire (NIP-40). The allow-list
    /// applies to neither: neither names a video.
    pub fn admitting(
        namespaces: &[Namespace],
        creators: Option<&[String]>,
        may: MayAdmit,
    ) -> crate::Result<Self> {
        let Some(creators) = creators else {
            return Ok(Self::build(namespaces, None, may));
        };
        if creators.is_empty() {
            return Err(crate::NodeError::Relay("empty creator allow-list".into()));
        }
        if let Some(bad) = creators.iter().find(|c| {
            c.len() != 64
                || !c
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(crate::NodeError::Relay(format!(
                "allow-list entry is not 64 lowercase hex: {bad}"
            )));
        }
        Ok(Self::build(
            namespaces,
            Some(creators.iter().cloned().collect()),
            may,
        ))
    }

    fn build(namespaces: &[Namespace], creators: Option<BTreeSet<String>>, may: MayAdmit) -> Self {
        let names: BTreeSet<String> = namespaces.iter().map(ToString::to_string).collect();
        let database: Arc<dyn ns::NostrDatabase> = Arc::new(TitleSearch {
            inner: nostr_memory::MemoryDatabase::bounded(
                std::num::NonZeroUsize::new(MAX_STORED_EVENTS)
                    .unwrap_or(std::num::NonZeroUsize::MIN),
            ),
        });
        let local = ns::LocalRelay::builder()
            .database(database.clone())
            .write_policy(Admission {
                namespaces: names.clone(),
                creators,
                may,
                limits: Mutex::new(Limits::default()),
                db: database,
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
        let mut kinds = vec![KIND_MANIFEST, KIND_BEACON, KIND_DELETION];
        let mut roles = vec!["catalog", "availability"];
        if may.mesh_signaling {
            kinds.push(KIND_SIGNAL);
            roles.push("signaling");
        }
        if may.stun_announcements {
            kinds.push(KIND_STUN_ANNOUNCEMENT);
            roles.push("stun");
        }
        let description = match (may.mesh_signaling, may.stun_announcements) {
            (false, false) => "NFX-04 scoped relay: NFX manifests and beacons only",
            (true, false) => {
                "NFX-04 scoped relay: NFX manifests and beacons, and NFX mesh signaling (kind 25050, nfx-mesh/1)"
            }
            (false, true) => {
                "NFX-04 scoped relay: NFX manifests and beacons, and STUN service announcements (kind 33478)"
            }
            (true, true) => {
                "NFX-04 scoped relay: NFX manifests and beacons, NFX mesh signaling (kind 25050, nfx-mesh/1) and STUN service announcements (kind 33478)"
            }
        };
        let nip11 = serde_json::json!({
            "name": "nfx scoped relay",
            "description": description,
            "software": "nfx-node",
            "version": env!("CARGO_PKG_VERSION"),
            "supported_nips": [1, 11, 40, 50],
            "limitation": {
                "max_message_length": MAX_MANIFEST_BYTES,
                "max_subscriptions": MAX_SUBSCRIPTIONS,
                "max_content_length": MAX_MANIFEST_BYTES,
                "restricted_writes": true
            },
            "nfx": {
                "networks": names,
                "kinds": kinds,
                "roles": roles
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

    fn admission(namespaces: &[&str], may: MayAdmit) -> Admission {
        Admission {
            namespaces: namespaces.iter().map(ToString::to_string).collect(),
            creators: None,
            may,
            limits: Mutex::new(Limits::default()),
            db: Arc::new(nostr_memory::MemoryDatabase::bounded(
                std::num::NonZeroUsize::new(100).unwrap(),
            )),
        }
    }

    fn stun_ad(secret: u8, addr: &str, nets: &[&str], created_at: u64, ttl: u64) -> ns::Event {
        let nets: Vec<Namespace> = nets.iter().map(|n| Namespace::parse(n).unwrap()).collect();
        let tags = nfx_proto::stun::tags(addr, &nets, created_at, ttl).unwrap();
        let ev = nfx_proto::event::Event::sign(
            &[secret; 32],
            created_at,
            KIND_STUN_ANNOUNCEMENT,
            tags,
            String::new(),
        )
        .unwrap();
        crate::nostr::to_nostr(&ev).unwrap()
    }

    fn refused(r: Result<Admitted, Refusal>) -> String {
        match r {
            Ok(_) => panic!("admitted"),
            Err((prefix, message)) => format!("{prefix}: {message}"),
        }
    }

    /// NFX-04 §1 as amended 2026-11-19, against the vectors: off, kind 33478 is out of scope;
    /// on, every valid announcement is admitted when the relay serves one of its networks
    /// (and refused as out of scope when it serves none), and every invalid one is refused.
    #[test]
    fn a_relay_admits_the_valid_stun_announcements_and_refuses_the_rest() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../spec/test-vectors/stun-announcement.json"
        ))
        .unwrap();
        let now = v["now"].as_u64().unwrap();
        let event = |c: &serde_json::Value| -> ns::Event {
            ns::Event::from_json(c["event"].to_string()).unwrap()
        };
        let off = admission(&["nfx:mainnet:1"], MayAdmit::default());
        let first = event(&v["valid"][0]);
        assert!(refused(off.admit(&first, now)).starts_with("blocked: out of scope"));
        let on = MayAdmit {
            stun_announcements: true,
            ..MayAdmit::default()
        };
        let elsewhere = admission(&["nfx:other:1"], on);
        let served = ["nfx:mainnet:1", "nfx:net-1:1"];
        for case in v["valid"].as_array().unwrap() {
            let name = &case["name"];
            assert!(
                refused(elsewhere.admit(&event(case), now)).starts_with("blocked: out of scope"),
                "{name}"
            );
            // Each on a relay of its own: several name one server at one `created_at`, and a
            // relay keeps one of those (the lowest id, NIP-01).
            let relay = admission(&served, on);
            assert!(
                matches!(relay.admit(&event(case), now), Ok(Admitted::Stun(_))),
                "{name}"
            );
            assert!(
                refused(relay.admit(&event(case), now)).starts_with("duplicate:"),
                "{name}: held already"
            );
        }
        let relay = admission(&served, on);
        for case in v["invalid"].as_array().unwrap() {
            let r = relay.admit(&event(case), now);
            assert!(r.is_err(), "{}", case["name"]);
        }
    }

    /// §2: 12 per hour per key, the newest per (key, server) only, at most 1024 held while
    /// live; an expired one frees its place and is named for the store to drop.
    #[test]
    fn stun_announcements_are_rate_limited_capped_and_forgotten_once_expired() {
        let on = MayAdmit {
            stun_announcements: true,
            ..MayAdmit::default()
        };
        let relay = admission(&["nfx:testnet:1"], on);
        let net = ["nfx:testnet:1"];
        let t0 = 1_790_000_000;
        // 12 an hour per key, whichever servers they name.
        for i in 0..12u8 {
            let ad = stun_ad(1, &format!("1.1.1.{}:3478", i + 1), &net, t0, 600);
            assert!(relay.admit(&ad, t0).is_ok(), "{i}");
        }
        let ad = stun_ad(1, "1.1.1.99:3478", &net, t0, 600);
        assert!(refused(relay.admit(&ad, t0)).starts_with("rate-limited:"));
        // An hour later the key has its budget again.
        let t1 = t0 + 3600;
        assert!(
            relay
                .admit(&stun_ad(1, "1.1.1.1:3478", &net, t1, 600), t1)
                .is_ok()
        );

        // A held announcement is replaced by a newer one, never by an older one.
        let held = stun_ad(2, "1.0.0.1:3478", &net, t1, 600);
        assert!(relay.admit(&held, t1).is_ok());
        let older = stun_ad(2, "1.0.0.1:3478", &net, t1 - 10, 600);
        assert!(refused(relay.admit(&older, t1)).starts_with("invalid: a newer"));
        let newer = stun_ad(2, "1.0.0.1:3478", &net, t1 + 5, 600);
        assert!(relay.admit(&newer, t1 + 5).is_ok());
        // On a tie the lower id is the one kept (NIP-01): the other is refused, whichever
        // comes first.
        let (x, y) = (
            stun_ad(3, "1.0.0.2:3478", &net, t1, 600),
            stun_ad(3, "1.0.0.2:3478", &net, t1, 601),
        );
        let (low, high) = if x.id.to_hex() < y.id.to_hex() {
            (x, y)
        } else {
            (y, x)
        };
        assert!(relay.admit(&high, t1).is_ok());
        assert!(relay.admit(&low, t1).is_ok(), "the lower id replaces it");
        assert!(refused(relay.admit(&high, t1)).starts_with("duplicate:"));
        // Expired but not yet dropped, it still outranks an older one that is live: the store
        // would keep it, and the table must not describe the other. A newer one replaces it.
        let short = stun_ad(4, "1.0.0.3:3478", &net, t1, 10);
        assert!(relay.admit(&short, t1).is_ok());
        let after = t1 + 20;
        let older = stun_ad(4, "1.0.0.3:3478", &net, t1 - 5, 600);
        assert!(refused(relay.admit(&older, after)).starts_with("invalid: a newer"));
        let newer = stun_ad(4, "1.0.0.3:3478", &net, after, 600);
        assert!(relay.admit(&newer, after).is_ok());

        // The cap: fill it with live announcements from fresh keys.
        let relay = admission(&["nfx:testnet:1"], on);
        let mut n = 0usize;
        'fill: for k in 1..=255u8 {
            for j in 0..12u8 {
                if n == MAX_STUN_ANNOUNCEMENTS {
                    break 'fill;
                }
                let ad = stun_ad(
                    k,
                    &format!("203.0.{j}.{k}:3478"),
                    &net,
                    t0,
                    60 + u64::from(k),
                );
                assert!(relay.admit(&ad, t0).is_ok(), "{k}/{j}");
                n += 1;
            }
        }
        assert_eq!(n, MAX_STUN_ANNOUNCEMENTS);
        let fresh = stun_ad(200, "1.0.0.200:3478", &net, t0, 600);
        assert!(refused(relay.admit(&fresh, t0)).starts_with("rate-limited:"));
        // A held one may still be renewed while the table is full.
        let renewal = stun_ad(86, "203.0.0.86:3478", &net, t0 + 1, 600);
        assert!(relay.admit(&renewal, t0 + 1).is_ok());
        // Once key 1's announcements (61 s) have expired, their places are free, and the next
        // admission names them for the store to drop; key 2's (62 s) are still live.
        let later = t0 + 61;
        let fresh = stun_ad(200, "1.0.0.200:3478", &net, later, 600);
        let key1 = nfx_proto::event::public_key_hex(&[1; 32]).unwrap();
        match relay.admit(&fresh, later) {
            Ok(Admitted::Stun(gone)) => {
                assert_eq!(gone.len(), 12, "{gone:?}");
                assert!(gone.iter().all(|(operator, _, _)| *operator == key1));
            }
            _ => panic!("admitted once places were free"),
        }
    }

    #[test]
    fn filters_wider_than_256_values_are_refused() {
        let a = |n: usize| (0..n).map(|i| format!("38504:x:nfx:mainnet:1:v{i}"));
        let ok = ns::Filter::new().custom_tags(ns::SingleLetterTag::LOWERCASE_A, a(256));
        let wide = ns::Filter::new().custom_tags(ns::SingleLetterTag::LOWERCASE_A, a(257));
        assert!(!filter_too_wide(&ok));
        assert!(filter_too_wide(&wide));
    }

    /// A search only narrows: it never returns an event the same filter without it would not, and
    /// `count`, `limit` and `delete` agree with `query`.
    #[tokio::test]
    async fn a_search_never_widens_the_other_constraints() {
        use ns::FinalizeEvent as _;
        use ns::NostrDatabase as _;
        let (a, b) = (ns::Keys::generate(), ns::Keys::generate());
        let db = TitleSearch {
            inner: nostr_memory::MemoryDatabase::bounded(std::num::NonZeroUsize::new(100).unwrap()),
        };
        let event = |keys: &ns::Keys, kind: u16, d: &str, title: &str, text: &str, at: u64| {
            ns::EventBuilder::new(ns::Kind::from(kind), text)
                .tags([
                    ns::Tag::parse(["d", d]).unwrap(),
                    ns::Tag::parse(["title", title]).unwrap(),
                ])
                .custom_created_at(ns::Timestamp::from_secs(at))
                .finalize(keys)
                .unwrap()
        };
        for ev in [
            event(&a, 38504, "one", "Salt Flats", "", 100),
            event(&b, 38504, "two", "Salt Marsh", "", 200),
            // Not a manifest, from `a`, with the word in its content.
            event(&a, 1, "note", "Note", "salt in a note", 300),
        ] {
            db.save_event(&ev).await.unwrap();
        }
        let kind = ns::Kind::from(38504u16);
        let query = |f: ns::Filter| async { db.query(f).await.unwrap().len() };
        // Without a search nothing changes.
        assert_eq!(query(ns::Filter::new().kind(kind)).await, 2);
        // The kind constraint holds: the note is not returned.
        assert_eq!(query(ns::Filter::new().kind(kind).search("salt")).await, 2);
        // So does the author constraint: `a` has a manifest and the note, `b` neither of them.
        let by_a = ns::Filter::new().author(a.public_key()).search("salt");
        assert_eq!(query(by_a.clone()).await, 2);
        assert_eq!(query(by_a.clone().kind(kind)).await, 1);
        assert_eq!(
            query(ns::Filter::new().author(b.public_key()).search("flats")).await,
            0
        );
        // And the time window.
        assert_eq!(
            query(
                ns::Filter::new()
                    .kind(kind)
                    .search("salt")
                    .since(ns::Timestamp::from_secs(150))
            )
            .await,
            1
        );
        // `count` agrees with `query`; `limit` applies after the match.
        for f in [
            by_a.clone(),
            by_a.clone().kind(kind),
            ns::Filter::new().kind(kind).search("marsh"),
        ] {
            assert_eq!(db.count(f.clone()).await.unwrap(), query(f).await);
        }
        let newest = db
            .query(ns::Filter::new().kind(kind).search("salt").limit(1))
            .await
            .unwrap();
        assert_eq!(newest.len(), 1);
        assert_eq!(
            newest.iter().next().unwrap().pubkey,
            b.public_key(),
            "the newest hit"
        );
        // `delete` goes straight to the store.
        db.delete(ns::Filter::new().author(b.public_key()))
            .await
            .unwrap();
        assert_eq!(query(ns::Filter::new().kind(kind).search("salt")).await, 1);
    }
}
