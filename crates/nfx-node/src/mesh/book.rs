//! A room's bookkeeping (NFX-10 §§6.5–6.6), as plain data with the clock passed in: who is
//! present, which events were taken, when the next offer to a peer may go, and how many
//! offers and answers a sender may have decrypted. The same rules and bounds as the browser
//! library's `signal-book.ts`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use nfx_proto::signal;

/// Peers whose presence one room holds.
pub const PEERS_PER_ROOM: usize = 256;
/// Negotiations in flight in one room (one per peer at most).
pub const NEGOTIATIONS_PER_ROOM: usize = 16;
/// Of those, offers of ours awaiting an answer, so offers never starve answering.
pub const PENDING_OFFERS_PER_ROOM: usize = 4;
/// After an offer to a peer fails, the next waits this long, doubling per failure up to
/// [`OFFER_BACKOFF_MAX`].
pub const OFFER_BACKOFF: Duration = Duration::from_secs(30);
pub const OFFER_BACKOFF_MAX: Duration = Duration::from_secs(600);
/// Offers and answers decrypted per sender per [`DIRECTED_WINDOW`].
pub const DIRECTED_PER_SENDER: u32 = 8;
pub const DIRECTED_WINDOW: Duration = Duration::from_secs(30);
/// Event ids remembered to take each event once.
pub const SEEN_IDS: usize = 4096;
/// How long an id is remembered: past this, the event fails the freshness check anyway (60 s
/// old at most, 30 s ahead at most), so a replay is dropped without it.
pub const SEEN_FOR: u64 = signal::MAX_AGE + signal::MAX_FUTURE + 30;
/// How long a `disconnect` is kept, so a replayed older `connect` cannot bring its peer back.
const TOMBSTONE: u64 = 60;

/// Presence per sender session key: the newest event by `created_at` wins, and a
/// `disconnect` wins a tie with a `connect` of the same second. At most `max` peers; a new
/// one beyond that is refused until one expires.
#[derive(Debug)]
pub struct PresenceBook {
    /// `(created_at, expiration)`; an expiration of 0 is a `disconnect` (a tombstone).
    peers: HashMap<String, (u64, u64)>,
    max: usize,
}

impl Default for PresenceBook {
    fn default() -> Self {
        Self::new(PEERS_PER_ROOM)
    }
}

impl PresenceBook {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self {
            peers: HashMap::new(),
            max,
        }
    }

    /// Take a `connect` (with its expiration) or a `disconnect` (`None`). True if it is now
    /// the peer's newest.
    pub fn add(&mut self, peer: &str, created_at: u64, expiration: Option<u64>, now: u64) -> bool {
        let leaving = expiration.is_none();
        if let Some(&(held_at, held_exp)) = self.peers.get(peer) {
            if created_at < held_at || (created_at == held_at && (!leaving || held_exp == 0)) {
                return false;
            }
        } else if self.peers.len() >= self.max {
            self.prune(now);
            if self.peers.len() >= self.max {
                return false;
            }
        }
        self.peers
            .insert(peer.to_owned(), (created_at, expiration.unwrap_or(0)));
        true
    }

    /// Whether `peer` is present at `now`.
    #[must_use]
    pub fn present(&self, peer: &str, now: u64) -> bool {
        self.peers.get(peer).is_some_and(|&(_, exp)| exp > now)
    }

    /// Forget peers whose presence ended (a `disconnect` once no event older than it is
    /// fresh).
    pub fn prune(&mut self, now: u64) {
        self.peers.retain(|_, &mut (at, exp)| {
            let until = if exp == 0 { at + TOMBSTONE } else { exp };
            until > now
        });
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.peers.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.peers.is_empty()
    }
}

/// The ids of the last `max` events taken, each for [`SEEN_FOR`] seconds, so each is taken
/// once whichever relays deliver it. Only ids of events that verified are added: a relay that
/// sends a forgery under a real event's id must not make the real one look like a repeat.
#[derive(Debug)]
pub struct SeenIds {
    ids: HashSet<String>,
    /// Oldest first, with when each was taken.
    order: VecDeque<(String, u64)>,
    max: usize,
}

impl Default for SeenIds {
    fn default() -> Self {
        Self::new(SEEN_IDS)
    }
}

impl SeenIds {
    #[must_use]
    pub fn new(max: usize) -> Self {
        Self {
            ids: HashSet::new(),
            order: VecDeque::new(),
            max,
        }
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.ids.contains(id)
    }

    /// Remember a verified event's id, taken at `now`; forget those held past [`SEEN_FOR`].
    pub fn add(&mut self, id: &str, now: u64) {
        while let Some((old, at)) = self.order.front()
            && at.saturating_add(SEEN_FOR) <= now
        {
            self.ids.remove(old);
            self.order.pop_front();
        }
        if self.ids.contains(id) {
            return;
        }
        while self.order.len() >= self.max.max(1) {
            if let Some((old, _)) = self.order.pop_front() {
                self.ids.remove(&old);
            }
        }
        self.ids.insert(id.to_owned());
        self.order.push_back((id.to_owned(), now));
    }
}

/// When this session may next offer to each peer: after a failed offer, [`OFFER_BACKOFF`]
/// doubling per failure up to [`OFFER_BACKOFF_MAX`], so a peer that announces itself and
/// never answers costs one offer per backoff, not one per presence. A peer that took
/// something is forgotten. At most `max_peers` are held; the one free soonest goes first.
#[derive(Debug)]
pub struct OfferBackoff {
    peers: HashMap<String, (u32, Instant)>,
    max_peers: usize,
}

impl Default for OfferBackoff {
    fn default() -> Self {
        Self::new(PEERS_PER_ROOM)
    }
}

impl OfferBackoff {
    #[must_use]
    pub fn new(max_peers: usize) -> Self {
        Self {
            peers: HashMap::new(),
            max_peers,
        }
    }

    #[must_use]
    pub fn allowed(&self, peer: &str, now: Instant) -> bool {
        self.peers.get(peer).is_none_or(|&(_, until)| now >= until)
    }

    pub fn failed(&mut self, peer: &str, now: Instant) {
        let failures = self.peers.remove(peer).map_or(0, |(f, _)| f) + 1;
        if self.peers.len() >= self.max_peers
            && let Some(first) = self
                .peers
                .iter()
                .min_by_key(|(_, (_, until))| *until)
                .map(|(k, _)| k.clone())
        {
            self.peers.remove(&first);
        }
        let wait = OFFER_BACKOFF
            .saturating_mul(1 << (failures - 1).min(20))
            .min(OFFER_BACKOFF_MAX);
        self.peers.insert(peer.to_owned(), (failures, now + wait));
    }

    pub fn succeeded(&mut self, peer: &str) {
        self.peers.remove(peer);
    }
}

/// At most [`DIRECTED_PER_SENDER`] decryptions per sender per [`DIRECTED_WINDOW`]; at most
/// `max_senders` windows held, and a new sender is refused while all are live.
#[derive(Debug)]
pub struct SenderLimiter {
    windows: HashMap<String, (Instant, u32)>,
    max_senders: usize,
}

impl Default for SenderLimiter {
    fn default() -> Self {
        Self::new(PEERS_PER_ROOM)
    }
}

impl SenderLimiter {
    #[must_use]
    pub fn new(max_senders: usize) -> Self {
        Self {
            windows: HashMap::new(),
            max_senders,
        }
    }

    pub fn take(&mut self, sender: &str, now: Instant) -> bool {
        let expired = |start: Instant| now.duration_since(start) >= DIRECTED_WINDOW;
        match self.windows.get_mut(sender) {
            Some((start, count)) if !expired(*start) => {
                if *count >= DIRECTED_PER_SENDER {
                    return false;
                }
                *count += 1;
                true
            }
            Some(w) => {
                *w = (now, 1);
                true
            }
            None => {
                if self.windows.len() >= self.max_senders {
                    self.windows.retain(|_, (start, _)| !expired(*start));
                    if self.windows.len() >= self.max_senders {
                        return false;
                    }
                }
                self.windows.insert(sender.to_owned(), (now, 1));
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_keeps_the_newest_and_a_disconnect_wins_a_tie() {
        let mut book = PresenceBook::new(2);
        assert!(book.add("a", 100, Some(190), 100));
        assert!(book.present("a", 189));
        assert!(!book.present("a", 190));
        // An older event changes nothing.
        assert!(!book.add("a", 99, Some(189), 100));
        // A same-second connect does not win; a same-second disconnect does.
        assert!(!book.add("a", 100, Some(190), 100));
        assert!(book.add("a", 100, None, 100));
        assert!(!book.present("a", 100));
        // A replayed connect older than the disconnect does not bring the peer back.
        assert!(!book.add("a", 99, Some(189), 101));
        // The tombstone holds a slot until it is 60 s old.
        assert!(book.add("b", 100, Some(190), 100));
        assert!(!book.add("c", 100, Some(190), 150), "full");
        assert!(book.add("c", 160, Some(250), 160), "a's tombstone pruned");
        assert_eq!(book.len(), 2);
    }

    #[test]
    fn seen_ids_forget_the_oldest_past_the_cap_or_once_no_replay_could_pass() {
        let mut seen = SeenIds::new(2);
        seen.add("1", 100);
        seen.add("2", 100);
        seen.add("2", 100);
        assert!(seen.has("1") && seen.has("2"));
        seen.add("3", 101);
        assert!(!seen.has("1") && seen.has("2") && seen.has("3"));
        seen.add("4", 101 + SEEN_FOR);
        assert!(
            !seen.has("2") && !seen.has("3") && seen.has("4"),
            "aged out"
        );
    }

    #[test]
    fn backoff_doubles_to_ten_minutes_and_success_forgets() {
        let t0 = Instant::now();
        let mut b = OfferBackoff::new(4);
        assert!(b.allowed("p", t0));
        b.failed("p", t0);
        assert!(!b.allowed("p", t0 + Duration::from_secs(29)));
        assert!(b.allowed("p", t0 + Duration::from_secs(30)));
        b.failed("p", t0);
        assert!(!b.allowed("p", t0 + Duration::from_secs(59)));
        assert!(b.allowed("p", t0 + Duration::from_secs(60)));
        for _ in 0..30 {
            b.failed("p", t0);
        }
        assert!(!b.allowed("p", t0 + Duration::from_secs(599)));
        assert!(b.allowed("p", t0 + Duration::from_secs(600)));
        b.succeeded("p");
        assert!(b.allowed("p", t0));
        // Bounded: the entry free soonest goes first.
        for (i, p) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            b.failed(p, t0 + Duration::from_secs(i as u64));
        }
        assert!(b.allowed("a", t0), "evicted");
        assert!(!b.allowed("e", t0));
    }

    #[test]
    fn a_sender_gets_eight_decryptions_per_thirty_seconds() {
        let t0 = Instant::now();
        let mut l = SenderLimiter::new(2);
        for _ in 0..8 {
            assert!(l.take("s", t0));
        }
        assert!(!l.take("s", t0 + Duration::from_secs(29)));
        assert!(l.take("s", t0 + Duration::from_secs(30)));
        assert!(l.take("t", t0));
        assert!(
            !l.take("u", t0 + Duration::from_secs(1)),
            "both windows live"
        );
        assert!(
            l.take("u", t0 + Duration::from_secs(31)),
            "an expired one is dropped"
        );
    }
}
