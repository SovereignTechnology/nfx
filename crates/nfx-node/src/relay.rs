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
//! With seeder lookup on ([`MayAdmit::seeder_lookup`]), it also carries kind 20465 (NFX-17 §5):
//! a viewer's ask and a seeder's tell, ephemeral like beacons. Before an event is verified only
//! its size, its shape and the budget of its connection apply. Limits keyed on a key or a video
//! are charged after full verification, the embedded beacon included, so an unsigned event
//! cannot spend someone else's budget. An id already carried is dropped and charges nothing.
//!
//! With a STUN port ([`ScopedRelay::with_stun_port`]), its NIP-11 document says that the
//! relay's own host answers STUN Binding requests on that UDP port (`nfx.stun_port`, NFX-04 §3
//! as amended 2026-11-24), so clients that signal through it ask it for their mapping
//! (NFX-10 §1). The relay does not check that anything answers there: its operator says so.
//!
//! Stored manifests live in memory, capped at [`MAX_STORED_EVENTS`]. Without a state
//! directory a restart forgets them, and publishers re-mirror (§4); with one
//! ([`ScopedRelay::admitting_persisted`]) accepted manifests are kept on disk and reloaded,
//! re-verified and re-admitted (`relay_store`). TLS belongs in front, as for the origin.

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::hash::Hash;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{self, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use nfx_proto::beacon::Beacon;
use nfx_proto::deletion::Deletion;
use nfx_proto::lookup::{self, KIND_LOOKUP};
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
pub use crate::relay_store::Reload;
use crate::relay_store::{self, ManifestStore};
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
/// TTL/2 over one connection must fit (1200 videos at a 60 s lifetime); the per-key limits
/// above are the real bound.
const EVENTS_PER_MINUTE: u32 = 2_400;
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
/// Seeder lookup (NFX-17 §5): the window of the ask, route and connection limits.
pub const LOOKUP_WINDOW_SECS: u64 = 10;
/// Asks per (signer, video) per [`LOOKUP_WINDOW_SECS`].
pub const ASKS_PER_KEY_AND_VIDEO: usize = 2;
/// Asks per video per [`LOOKUP_WINDOW_SECS`].
pub const ASKS_PER_VIDEO: usize = 30;
/// Tells per (seeder, asker, video) per [`LOOKUP_WINDOW_SECS`].
pub const TELLS_PER_ROUTE: usize = 2;
/// Tells per seeder key per [`TELLS_PER_KEY_WINDOW_SECS`].
pub const TELLS_PER_KEY: usize = 160;
pub const TELLS_PER_KEY_WINDOW_SECS: u64 = 30;
/// Lookup events per connection per [`LOOKUP_WINDOW_SECS`]. The one limit charged before
/// verification: the connection is the only thing about an unverified event that is known.
pub const LOOKUPS_PER_CONNECTION: usize = 96;
/// How long a carried event id is remembered, so that a replay charges nothing.
pub const LOOKUP_SEEN_SECS: u64 = 120;
/// Carried ids remembered at once; past this the oldest go, which costs only a replay's charge.
const MAX_LOOKUP_SEEN: usize = 65_536;
/// Lookup rate-limit keys held at once. Keys and video names are free, so while this many are
/// live new lookups are refused, and viewers fall back on the periodic beacon.
const MAX_LOOKUP_KEYS: usize = 65_536;
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
    /// Seeder lookup, which sweeps itself.
    lookup: LookupLimits,
    /// When stale keys were last swept (at most once per [`SWEEP_EVERY_SECS`]).
    swept_at: u64,
}

/// The rate-limit state of seeder lookup (NFX-17 §5).
#[derive(Debug, Default)]
struct LookupLimits {
    /// Connection → lookup events in the last window, verified or not.
    connections: HashMap<SocketAddr, VecDeque<u64>>,
    /// (asker, a) → admitted asks.
    asks: HashMap<(String, String), VecDeque<u64>>,
    /// a → admitted asks.
    asks_per_video: HashMap<String, VecDeque<u64>>,
    /// (seeder, asker, a) → admitted tells.
    tells: HashMap<(String, String, String), VecDeque<u64>>,
    /// seeder → admitted tells.
    tells_per_key: HashMap<String, VecDeque<u64>>,
    /// Ids verified and carried. Only a verified event enters, so a forged one cannot poison it.
    seen: HashSet<String>,
    /// The same ids, oldest first, with when each was carried.
    seen_order: VecDeque<(u64, String)>,
    swept_at: u64,
}

/// Whether `times` holds fewer than `max` entries inside the last `window` seconds.
fn has_room(times: Option<&VecDeque<u64>>, now: u64, window: u64, max: usize) -> bool {
    times.is_none_or(|t| t.iter().filter(|at| now < **at + window).count() < max)
}

/// Record one use at `now`, dropping what has left the window.
fn charge(times: &mut VecDeque<u64>, now: u64, window: u64) {
    while times.front().is_some_and(|t| now >= t + window) {
        times.pop_front();
    }
    times.push_back(now);
}

/// Drop the keys with no use inside the last `window` seconds.
fn keep_live<K: Eq + Hash>(map: &mut HashMap<K, VecDeque<u64>>, now: u64, window: u64) {
    map.retain(|_, times| times.back().is_some_and(|at| now < at + window));
}

impl LookupLimits {
    /// Keys charged after verification. Connections are counted apart (`MAX_LOOKUP_KEYS` each), so
    /// a flood of unsigned events on fresh connections cannot fill this table.
    fn keys(&self) -> usize {
        self.asks.len() + self.asks_per_video.len() + self.tells.len() + self.tells_per_key.len()
    }

    /// Sweeps are O(keys): at most once per [`SWEEP_EVERY_SECS`] past [`SWEEP_ABOVE`] keys, and
    /// at most once a second while the table is full.
    fn sweep(&mut self, now: u64) {
        let keys = self.keys() + self.connections.len();
        let due = keys > SWEEP_ABOVE && now >= self.swept_at.saturating_add(SWEEP_EVERY_SECS);
        let full = (self.keys() >= MAX_LOOKUP_KEYS || self.connections.len() >= MAX_LOOKUP_KEYS)
            && now > self.swept_at;
        if !due && !full {
            return;
        }
        self.swept_at = now;
        keep_live(&mut self.connections, now, LOOKUP_WINDOW_SECS);
        keep_live(&mut self.asks, now, LOOKUP_WINDOW_SECS);
        keep_live(&mut self.asks_per_video, now, LOOKUP_WINDOW_SECS);
        keep_live(&mut self.tells, now, LOOKUP_WINDOW_SECS);
        keep_live(&mut self.tells_per_key, now, TELLS_PER_KEY_WINDOW_SECS);
    }

    /// Remember a verified and carried id.
    fn remember(&mut self, id: String, now: u64) {
        while self
            .seen_order
            .front()
            .is_some_and(|(at, _)| now >= at + LOOKUP_SEEN_SECS)
            || self.seen_order.len() >= MAX_LOOKUP_SEEN
        {
            if let Some((_, old)) = self.seen_order.pop_front() {
                self.seen.remove(&old);
            }
        }
        self.seen.insert(id.clone());
        self.seen_order.push_back((now, id));
    }
}

/// What a scoped relay admits beyond what NFX-04 §1 requires: its MAYs. Default: neither.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MayAdmit {
    /// Kind-25050 mesh signaling, `nfx-mesh/1` (§1 as amended 2026-11-18, NFX-10 §6).
    pub mesh_signaling: bool,
    /// Kind-33478 STUN service announcements for its networks (§1 as amended 2026-11-19,
    /// NFX-10 §1).
    pub stun_announcements: bool,
    /// Kind-20465 seeder lookup, asks and tells (NFX-17 §5). A scoped relay may list the kind
    /// only once NFX-04 is amended to allow it, so nothing turns this on by default.
    pub seeder_lookup: bool,
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
    /// The state directory's copy, when there is one: deletions are recorded there too.
    store: Option<Arc<ManifestStore>>,
}

/// What passed the synchronous checks.
enum Admitted {
    Beacon,
    Signal,
    Lookup,
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
        self.admit_counting(event, now, true)
    }

    /// Whether a manifest read back from the state directory passes today's rules: all of
    /// them but the publish budget, since reloading it is not a publish.
    fn readmits(&self, event: &ns::Event, now: u64) -> bool {
        event.kind.as_u16() == KIND_MANIFEST
            && matches!(
                self.admit_counting(event, now, false),
                Ok(Admitted::Manifest(_))
            )
    }

    fn admit_counting(
        &self,
        event: &ns::Event,
        now: u64,
        count: bool,
    ) -> Result<Admitted, Refusal> {
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
            None if !count => {}
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

    /// A kind-20465 seeder lookup event (NFX-17 §5). Until it is verified, nothing it says is
    /// authenticated, so only its size, its shape and its connection's budget apply. Limits keyed
    /// on a key or a video are checked together and charged after full verification.
    fn admit_lookup(
        &self,
        event: &ns::Event,
        addr: &SocketAddr,
        now: u64,
    ) -> Result<Admitted, Refusal> {
        use ns::MachineReadablePrefix::{Blocked, Duplicate, Invalid, RateLimited};
        let size = event.as_json().len();
        if size > lookup::MAX_TELL_BYTES {
            return Err((Invalid, "lookup event over 36 KiB".into()));
        }
        let id = event.id.to_hex();
        {
            let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
            let l = &mut limits.lookup;
            l.sweep(now);
            if l.seen.contains(&id) {
                return Err((Duplicate, "already carried".into()));
            }
            let times = l.connections.get(addr);
            if !has_room(times, now, LOOKUP_WINDOW_SECS, LOOKUPS_PER_CONNECTION) {
                return Err((RateLimited, "lookup events per 10 s".into()));
            }
            if times.is_none() && l.connections.len() >= MAX_LOOKUP_KEYS {
                return Err((RateLimited, "too many lookups at once".into()));
            }
            charge(
                l.connections.entry(*addr).or_default(),
                now,
                LOOKUP_WINDOW_SECS,
            );
        }
        let ev = from_nostr(event).map_err(|_| (Invalid, "unreadable event".to_owned()))?;
        if !lookup::is_known_type(&ev) {
            return Err((Blocked, "out of scope".into()));
        }
        let shape = lookup::shape(&ev, now).map_err(|e| (Invalid, e.to_string()))?;
        if !self.namespaces.contains(&shape.namespace) {
            return Err((Blocked, "out of scope".into()));
        }
        if self
            .creators
            .as_ref()
            .is_some_and(|c| !c.contains(&shape.creator))
        {
            return Err((Blocked, "creator not allowed here".into()));
        }
        if !lookup::size_ok(shape.kind, size) {
            return Err((Invalid, "ask over 1 KiB".into()));
        }
        let parsed = lookup::relayable(&ev, now).map_err(|e| (Invalid, e.to_string()))?;

        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        let l = &mut limits.lookup;
        // Another connection may have carried it while this one verified.
        if l.seen.contains(&id) {
            return Err((Duplicate, "already carried".into()));
        }
        if l.keys() >= MAX_LOOKUP_KEYS {
            return Err((RateLimited, "too many lookups at once".into()));
        }
        match parsed {
            lookup::Parsed::Ask(ask) => {
                let key = (ask.asker.clone(), ask.a.clone());
                let w = LOOKUP_WINDOW_SECS;
                if !has_room(l.asks.get(&key), now, w, ASKS_PER_KEY_AND_VIDEO) {
                    return Err((RateLimited, "two asks per 10 s per video".into()));
                }
                if !has_room(l.asks_per_video.get(&ask.a), now, w, ASKS_PER_VIDEO) {
                    return Err((RateLimited, "asks per 10 s for this video".into()));
                }
                charge(l.asks.entry(key).or_default(), now, w);
                charge(l.asks_per_video.entry(ask.a.clone()).or_default(), now, w);
            }
            lookup::Parsed::Tell(tell) => {
                let route = (tell.seeder.clone(), tell.asker.clone(), tell.a.clone());
                let (w, wk) = (LOOKUP_WINDOW_SECS, TELLS_PER_KEY_WINDOW_SECS);
                if !has_room(l.tells.get(&route), now, w, TELLS_PER_ROUTE) {
                    return Err((RateLimited, "two tells per 10 s per viewer".into()));
                }
                if !has_room(l.tells_per_key.get(&tell.seeder), now, wk, TELLS_PER_KEY) {
                    return Err((RateLimited, "tells per 30 s".into()));
                }
                charge(l.tells.entry(route).or_default(), now, w);
                charge(
                    l.tells_per_key.entry(tell.seeder.clone()).or_default(),
                    now,
                    wk,
                );
            }
            lookup::Parsed::Ignored(_) => return Err((Blocked, "out of scope".into())),
        }
        l.remember(id, now);
        Ok(Admitted::Lookup)
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
        if let Some(store) = &self.store {
            store.withdraw(d).await;
        }
    }

    /// Whether a stored deletion withdraws this revision (a replay of a deleted one). The
    /// state directory remembers deletions from before a restart.
    async fn withdrawn(&self, m: &Manifest) -> bool {
        if self
            .store
            .as_ref()
            .is_some_and(|s| s.withdrawn(&m.a_tag(), m.created_at))
        {
            return true;
        }
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
        addr: &'a SocketAddr,
    ) -> BoxFuture<'a, ns::WritePolicyResult> {
        Box::pin(async move {
            let now = unix_now();
            let admitted = if event.kind.as_u16() == KIND_LOOKUP && self.may.seeder_lookup {
                self.admit_lookup(event, addr, now)
            } else {
                self.admit(event, now)
            };
            match admitted {
                Ok(Admitted::Beacon | Admitted::Signal | Admitted::Lookup) => {
                    ns::WritePolicyResult::Accept
                }
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
    /// Where an accepted manifest is also written, when there is a state directory.
    store: Option<Arc<ManifestStore>>,
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
        Box::pin(async move {
            let status = self.inner.save_event(event).await?;
            if let (true, Some(store)) = (status.is_success(), &self.store) {
                store.put(event).await;
            }
            Ok(status)
        })
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
    store: Option<Arc<ManifestStore>>,
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
        Ok(Self::build(namespaces, allow_list(creators)?, may))
    }

    /// As [`ScopedRelay::admitting`], keeping accepted manifests in `dir` and serving those
    /// already there (issue #114): each re-verified and run through the rules this relay has
    /// now, so a file grants nothing. Deletions it has honoured stay honoured. Only kind 38504
    /// is kept (§7). A directory it cannot use, or a damaged file in it, never stops the
    /// relay: the returned [`Reload`] says what happened, for the caller to log.
    pub async fn admitting_persisted(
        namespaces: &[Namespace],
        creators: Option<&[String]>,
        may: MayAdmit,
        dir: &Path,
    ) -> crate::Result<(Self, Reload)> {
        use ns::NostrDatabase as _;
        let creators = allow_list(creators)?;
        let rules = Admission {
            namespaces: namespaces.iter().map(ToString::to_string).collect(),
            creators: creators.clone(),
            may,
            limits: Mutex::new(Limits::default()),
            db: Arc::new(nostr_memory::MemoryDatabase::bounded(
                std::num::NonZeroUsize::MIN,
            )),
            store: None,
        };
        let dir = dir.to_owned();
        // Reads and verifies up to the whole store: not on the async workers.
        let (store, events, mut reload) = tokio::task::spawn_blocking(move || {
            relay_store::open(&dir, MAX_STORED_EVENTS, |e, now| rules.readmits(e, now))
        })
        .await
        .map_err(crate::NodeError::relay)?;
        let (relay, database) = Self::build_on(namespaces, creators, may, store.map(Arc::new));
        // Straight into the memory store: these are on disk already. Each read copy is dropped
        // as it goes in, so a full store is not held twice.
        for event in events {
            if !matches!(database.inner.save_event(&event).await, Ok(s) if s.is_success()) {
                reload.served = reload.served.saturating_sub(1);
            }
        }
        Ok((relay, reload))
    }

    /// Say in the NIP-11 document that this relay's own host, the host named in its URL,
    /// answers STUN Binding requests on UDP `port` (`nfx.stun_port`, NFX-04 §3 as amended
    /// 2026-11-24). Clients that signal through the relay then ask it for their public mapping
    /// (NFX-10 §1): it sees their address anyway. `port` is 1024 to 65535. Nothing checks that
    /// the port answers: the operator says so. Clients ask only a relay that lists kind 25050,
    /// so it goes with mesh signaling.
    pub fn with_stun_port(mut self, port: u16) -> crate::Result<Self> {
        if port < nfx_proto::stun::MIN_PORT {
            return Err(crate::NodeError::Relay(format!(
                "STUN port {port}: not 1024 to 65535"
            )));
        }
        let mut doc: serde_json::Value =
            serde_json::from_slice(&self.nip11).map_err(crate::NodeError::relay)?;
        doc["nfx"]["stun_port"] = port.into();
        self.nip11 = Bytes::from(doc.to_string());
        Ok(self)
    }

    fn build(namespaces: &[Namespace], creators: Option<BTreeSet<String>>, may: MayAdmit) -> Self {
        Self::build_on(namespaces, creators, may, None).0
    }

    fn build_on(
        namespaces: &[Namespace],
        creators: Option<BTreeSet<String>>,
        may: MayAdmit,
        store: Option<Arc<ManifestStore>>,
    ) -> (Self, Arc<TitleSearch>) {
        let names: BTreeSet<String> = namespaces.iter().map(ToString::to_string).collect();
        let search = Arc::new(TitleSearch {
            inner: nostr_memory::MemoryDatabase::bounded(
                std::num::NonZeroUsize::new(MAX_STORED_EVENTS)
                    .unwrap_or(std::num::NonZeroUsize::MIN),
            ),
            store: store.clone(),
        });
        let database: Arc<dyn ns::NostrDatabase> = search.clone();
        let local = ns::LocalRelay::builder()
            .database(database.clone())
            .write_policy(Admission {
                namespaces: names.clone(),
                creators,
                may,
                limits: Mutex::new(Limits::default()),
                db: database,
                store: store.clone(),
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
        if may.seeder_lookup {
            kinds.push(KIND_LOOKUP);
            roles.push("lookup");
        }
        let mut also = Vec::new();
        if may.mesh_signaling {
            also.push("NFX mesh signaling (kind 25050, nfx-mesh/1)");
        }
        if may.stun_announcements {
            also.push("STUN service announcements (kind 33478)");
        }
        if may.seeder_lookup {
            also.push("seeder lookup (kind 20465)");
        }
        let description = match also.split_last() {
            None => "NFX-04 scoped relay: NFX manifests and beacons only".to_owned(),
            Some((last, [])) => {
                format!("NFX-04 scoped relay: NFX manifests and beacons, and {last}")
            }
            Some((last, rest)) => format!(
                "NFX-04 scoped relay: NFX manifests and beacons, {} and {last}",
                rest.join(", ")
            ),
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
        (
            Self {
                local,
                nip11: Bytes::from(nip11.to_string()),
                store,
            },
            search,
        )
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
        if let Some(store) = &self.store {
            store.close();
        }
    }
}

/// A creator allow-list as admission holds it. An empty list, or a key in any other form than
/// 64 lowercase hex, is an error: either would silently admit no one.
fn allow_list(creators: Option<&[String]>) -> crate::Result<Option<BTreeSet<String>>> {
    let Some(creators) = creators else {
        return Ok(None);
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
    Ok(Some(creators.iter().cloned().collect()))
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
            store: None,
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

    /// A distinct connection for the lookup tests.
    fn conn(port: u16) -> SocketAddr {
        SocketAddr::from(([127, 0, 0, 1], port))
    }

    fn to_ns(ev: &nfx_proto::event::Event) -> ns::Event {
        ns::Event::from_json(serde_json::to_string(ev).unwrap()).unwrap()
    }

    /// What the lookup tests share, from the vectors.
    struct LookupFixture {
        now: u64,
        a: String,
        seeder: [u8; 32],
        beacon: nfx_proto::event::Event,
    }

    fn lookup_fixture() -> LookupFixture {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/lookup.json")).unwrap();
        let hex = v["secret_keys_DO_NOT_USE"]["seeder"].as_str().unwrap();
        let mut seeder = [0u8; 32];
        for (i, b) in seeder.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        LookupFixture {
            now: v["now"].as_u64().unwrap(),
            a: v["manifest_a"].as_str().unwrap().to_owned(),
            seeder,
            beacon: serde_json::from_value(v["beacon"].clone()).unwrap(),
        }
    }

    const LOOKUP_ON: MayAdmit = MayAdmit {
        mesh_signaling: false,
        stun_announcements: false,
        seeder_lookup: true,
    };

    /// NFX-17 §5 against the vectors: off, the kind is out of scope; on, every valid event is
    /// carried and every other one refused, another type as out of scope.
    #[test]
    fn a_relay_admits_the_valid_lookup_events_and_refuses_the_rest() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/lookup.json")).unwrap();
        let now = v["now"].as_u64().unwrap();
        let net = ["nfx:mainnet:1"];
        let off = admission(&net, MayAdmit::default());
        let ask = ns::Event::from_json(v["ask"].to_string()).unwrap();
        assert!(refused(off.admit(&ask, now)).starts_with("blocked: out of scope"));

        for name in [
            "ask",
            "tell",
            "ask_with_unknown_tag",
            "tell_with_unknown_tag",
        ] {
            let ev = ns::Event::from_json(v[name].to_string()).unwrap();
            let relay = admission(&net, LOOKUP_ON);
            assert!(
                matches!(relay.admit_lookup(&ev, &conn(1), now), Ok(Admitted::Lookup)),
                "{name}"
            );
        }
        for case in v["boundaries"].as_array().unwrap() {
            let ev = ns::Event::from_json(case["event"].to_string()).unwrap();
            let relay = admission(&net, LOOKUP_ON);
            let r = relay.admit_lookup(&ev, &conn(1), now);
            assert!(matches!(r, Ok(Admitted::Lookup)), "{}", case["name"]);
        }

        let bad: serde_json::Value = serde_json::from_str(include_str!(
            "../../../spec/test-vectors/lookup-invalid.json"
        ))
        .unwrap();
        let now = bad["now"].as_u64().unwrap();
        for case in bad["rejected"].as_array().unwrap() {
            let ev = ns::Event::from_json(case["event"].to_string()).unwrap();
            let relay = admission(&net, LOOKUP_ON);
            assert!(
                relay.admit_lookup(&ev, &conn(1), now).is_err(),
                "{}",
                case["name"]
            );
        }
        for case in bad["ignored"].as_array().unwrap() {
            let ev = ns::Event::from_json(case["event"].to_string()).unwrap();
            let relay = admission(&net, LOOKUP_ON);
            assert!(
                refused(relay.admit_lookup(&ev, &conn(1), now))
                    .starts_with("blocked: out of scope"),
                "{}",
                case["name"]
            );
        }
    }

    /// §5: an event that fails verification charges nothing keyed on what it claims, so a
    /// forger cannot spend a viewer's or a seeder's budget.
    #[test]
    fn a_forged_lookup_event_spends_no_one_elses_budget() {
        let f = lookup_fixture();
        let relay = admission(&["nfx:mainnet:1"], LOOKUP_ON);
        let viewer = [7u8; 32];
        let forge = |ev: &nfx_proto::event::Event| {
            let mut json = serde_json::to_value(ev).unwrap();
            let sig = json["sig"].as_str().unwrap();
            let flipped = if sig.starts_with('0') { "1" } else { "0" };
            json["sig"] = format!("{flipped}{}", &sig[1..]).into();
            ns::Event::from_json(json.to_string()).unwrap()
        };
        let ask = lookup::ask(&viewer, &f.a, f.now).unwrap();
        for port in 1..=3 {
            assert!(
                refused(relay.admit_lookup(&forge(&ask), &conn(port), f.now))
                    .starts_with("invalid:")
            );
        }
        for at in [f.now, f.now - 1] {
            let real = lookup::ask(&viewer, &f.a, at).unwrap();
            assert!(relay.admit_lookup(&to_ns(&real), &conn(9), f.now).is_ok());
        }
        let tell = lookup::tell(&f.seeder, &f.beacon, &ask.pubkey, f.now).unwrap();
        for port in 4..=6 {
            assert!(
                refused(relay.admit_lookup(&forge(&tell), &conn(port), f.now))
                    .starts_with("invalid:")
            );
        }
        assert!(relay.admit_lookup(&to_ns(&tell), &conn(9), f.now).is_ok());
    }

    /// §5's limits, each on its own key, and a replay that charges nothing.
    #[test]
    fn lookup_events_are_rate_limited() {
        let f = lookup_fixture();
        let net = ["nfx:mainnet:1"];
        let admit = |r: &Admission, e: &nfx_proto::event::Event, port: u16, now: u64| {
            r.admit_lookup(&to_ns(e), &conn(port), now)
        };

        // Two asks per (key, video) per 10 s; a replay is dropped and charges nothing.
        let relay = admission(&net, LOOKUP_ON);
        let first = lookup::ask(&[1; 32], &f.a, f.now).unwrap();
        assert!(admit(&relay, &first, 1, f.now).is_ok());
        for _ in 0..3 {
            assert!(refused(admit(&relay, &first, 1, f.now)).starts_with("duplicate:"));
        }
        let second = lookup::ask(&[1; 32], &f.a, f.now - 1).unwrap();
        assert!(
            admit(&relay, &second, 1, f.now).is_ok(),
            "the replays cost nothing"
        );
        let third = lookup::ask(&[1; 32], &f.a, f.now - 2).unwrap();
        assert!(refused(admit(&relay, &third, 1, f.now)).starts_with("rate-limited:"));
        let later = f.now + LOOKUP_WINDOW_SECS;
        assert!(
            admit(&relay, &third, 1, later).is_ok(),
            "the window has passed"
        );

        // 30 asks per video per 10 s, whichever keys sign them.
        let relay = admission(&net, LOOKUP_ON);
        for i in 1..=ASKS_PER_VIDEO {
            let ask = lookup::ask(&[u8::try_from(i).unwrap(); 32], &f.a, f.now).unwrap();
            assert!(admit(&relay, &ask, 1, f.now).is_ok(), "{i}");
        }
        let over = lookup::ask(&[99; 32], &f.a, f.now).unwrap();
        assert!(refused(admit(&relay, &over, 1, f.now)).starts_with("rate-limited:"));

        // Two tells per (seeder, viewer, video) per 10 s; another viewer has its own.
        let relay = admission(&net, LOOKUP_ON);
        let viewer = "ab".repeat(32);
        for at in [f.now, f.now - 1] {
            let tell = lookup::tell(&f.seeder, &f.beacon, &viewer, at).unwrap();
            assert!(admit(&relay, &tell, 1, f.now).is_ok());
        }
        let tell = lookup::tell(&f.seeder, &f.beacon, &viewer, f.now - 2).unwrap();
        assert!(refused(admit(&relay, &tell, 1, f.now)).starts_with("rate-limited:"));
        let other = lookup::tell(&f.seeder, &f.beacon, &"cd".repeat(32), f.now).unwrap();
        assert!(admit(&relay, &other, 1, f.now).is_ok());

        // 160 tells per seeder key per 30 s, across connections.
        let relay = admission(&net, LOOKUP_ON);
        for i in 0..TELLS_PER_KEY {
            let tell = lookup::tell(&f.seeder, &f.beacon, &format!("{i:064x}"), f.now).unwrap();
            let port = u16::try_from(1 + i / LOOKUPS_PER_CONNECTION).unwrap();
            assert!(admit(&relay, &tell, port, f.now).is_ok(), "{i}");
        }
        let tell = lookup::tell(&f.seeder, &f.beacon, &"ef".repeat(32), f.now).unwrap();
        assert!(refused(admit(&relay, &tell, 9, f.now)).starts_with("rate-limited:"));

        // 96 lookup events per connection per 10 s, valid or not; another connection is free.
        let relay = admission(&net, LOOKUP_ON);
        let junk = lookup::ask(&[3; 32], &f.a, f.now + 3600).unwrap();
        for i in 0..LOOKUPS_PER_CONNECTION {
            assert!(
                refused(admit(&relay, &junk, 1, f.now)).starts_with("invalid:"),
                "{i}"
            );
        }
        let good = lookup::ask(&[4; 32], &f.a, f.now).unwrap();
        assert!(refused(admit(&relay, &good, 1, f.now)).contains("per 10 s"));
        assert!(admit(&relay, &good, 2, f.now).is_ok());
    }

    /// §5: another network and a creator off the allow-list are out of scope.
    #[test]
    fn lookup_events_respect_the_relays_scope() {
        let f = lookup_fixture();
        let ask = to_ns(&lookup::ask(&[1; 32], &f.a, f.now).unwrap());
        let elsewhere = admission(&["nfx:other:1"], LOOKUP_ON);
        assert!(
            refused(elsewhere.admit_lookup(&ask, &conn(1), f.now))
                .starts_with("blocked: out of scope")
        );
        let mut listed = admission(&["nfx:mainnet:1"], LOOKUP_ON);
        listed.creators = Some(BTreeSet::from(["00".repeat(32)]));
        assert!(
            refused(listed.admit_lookup(&ask, &conn(1), f.now))
                .starts_with("blocked: creator not allowed")
        );
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
            store: None,
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
