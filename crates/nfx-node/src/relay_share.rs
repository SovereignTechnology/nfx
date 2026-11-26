//! A seeder's share of each relay it announces on (NFX-03 §7, decision record 0110).
//!
//! On a general relay, per seeder key: at most [`MAX_EVENTS`] events a minute, beacons and
//! NFX-17 tells together; beacons at most [`MAX_BEACONS`] a minute; tells keep the
//! difference, which beacons never take, and may use unused beacon share up to
//! [`MAX_TELLS`]. A seeder with more videos than fit at the beacon period stretches each
//! video's period on that relay, so the videos take turns and none is left out. A
//! `rate-limited:` or `blocked:` refusal pauses that relay for [`PAUSE_MIN`], doubling to
//! [`PAUSE_MAX`], until it accepts again.
//!
//! Relays named `unbounded` (scoped relays, NFX-04) are bound only by NFX-04 §2: they get
//! every beacon and every tell, and are paused only by a refusal.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::time::Instant;

/// The window the counts below are over.
pub const WINDOW: Duration = Duration::from_secs(60);
/// Events a minute per seeder key on a general relay, beacons and tells together.
pub const MAX_EVENTS: usize = 30;
/// Beacons a minute per seeder key on a general relay: 10 videos at a 30 s period.
pub const MAX_BEACONS: usize = 20;
/// Tells a minute per seeder key on a general relay (10 kept, up to 5 borrowed).
pub const MAX_TELLS: usize = 15;
/// The first pause after a `rate-limited:` or `blocked:` refusal.
pub const PAUSE_MIN: Duration = Duration::from_secs(60);
/// The longest pause; each refusal in a row doubles it up to this.
pub const PAUSE_MAX: Duration = Duration::from_secs(30 * 60);
const BEACONS_U32: u32 = 20;
const _: () = assert!(BEACONS_U32 as usize == MAX_BEACONS);
/// A tick this close to a video's turn counts as on time (interval ticks jitter).
const SLACK: Duration = Duration::from_secs(1);

/// One relay's key, however its URL is spelled (a trailing slash, letter case): the form
/// nostr-sdk's `RelayUrl` gives without its trailing slash, so every caller with its own
/// client (the beacon loop, NFX-17's answerer) counts against the same share. A string that
/// does not parse keys as itself.
fn key(url: &str) -> String {
    nostr_sdk::prelude::RelayUrl::parse(url).map_or_else(
        |_| url.to_owned(),
        |u| u.as_str_without_trailing_slash().to_owned(),
    )
}

/// Whether a relay's refusal asks the sender to slow down or stop (NIP-01 `OK` prefixes).
pub fn refusal_pauses(why: &str) -> bool {
    why.contains("rate-limited:") || why.contains("blocked:")
}

#[derive(Default)]
struct Relay {
    beacons: VecDeque<Instant>,
    tells: VecDeque<Instant>,
    /// When each video's beacon last went to this relay.
    last: BTreeMap<String, Instant>,
    paused_until: Option<Instant>,
    /// The current pause; zero when the relay last accepted.
    pause: Duration,
}

impl Relay {
    fn prune(&mut self, now: Instant) {
        for q in [&mut self.beacons, &mut self.tells] {
            while q.front().is_some_and(|t| now.duration_since(*t) >= WINDOW) {
                q.pop_front();
            }
        }
    }

    fn paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|t| now < t)
    }
}

/// Where one video's beacon goes this tick.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Turn {
    /// The relays to send it to now; each is counted as sent.
    pub to: Vec<String>,
    /// How many of the relays asked about are paused by a refusal.
    pub paused: usize,
}

/// Each relay's share for one seeder key. Cheap to share: one lock, held briefly.
pub struct RelayShare {
    period: Duration,
    unbounded: BTreeSet<String>,
    relays: Mutex<BTreeMap<String, Relay>>,
}

impl RelayShare {
    /// `period` is the beacon period (half the beacon TTL); `unbounded` the scoped relays.
    pub fn new(period: Duration, unbounded: impl IntoIterator<Item = String>) -> Self {
        Self {
            period,
            unbounded: unbounded.into_iter().map(|u| key(&u)).collect(),
            relays: Mutex::new(BTreeMap::new()),
        }
    }

    /// Where video `a`'s beacon goes now, out of `relays` (returned as given), with `videos` videos announced by
    /// this key. A paused relay gets nothing. A general relay gets it when the video's turn
    /// has come (its period stretched so that `videos` fit in [`MAX_BEACONS`] a minute) and
    /// the minute's share has room.
    pub fn beacon(&self, a: &str, videos: usize, relays: &[String], now: Instant) -> Turn {
        // `videos` beacons a period would be `videos / period` a minute: stretch the period
        // until they fit in MAX_BEACONS (20 a minute: 3 s of period per video).
        let videos = u32::try_from(videos.clamp(1, 1 << 20)).unwrap_or(1);
        let every = self.period.max(WINDOW * videos / BEACONS_U32);
        let mut map = self.relays.lock().unwrap_or_else(PoisonError::into_inner);
        let mut turn = Turn::default();
        for url in relays {
            let k = key(url);
            let unbounded = self.unbounded.contains(&k);
            let r = map.entry(k).or_default();
            if r.paused(now) {
                turn.paused += 1;
                continue;
            }
            if !unbounded {
                r.prune(now);
                let due = r
                    .last
                    .get(a)
                    .is_none_or(|t| now.duration_since(*t) + SLACK >= every);
                if !due
                    || r.beacons.len() >= MAX_BEACONS
                    || r.beacons.len() + r.tells.len() >= MAX_EVENTS
                {
                    continue;
                }
                r.beacons.push_back(now);
                r.last.insert(a.to_owned(), now);
            }
            turn.to.push(url.clone());
        }
        turn
    }

    /// Whether an NFX-17 tell may go to `url` now; it is counted if so.
    pub fn tell(&self, url: &str, now: Instant) -> bool {
        let k = key(url);
        let unbounded = self.unbounded.contains(&k);
        let mut map = self.relays.lock().unwrap_or_else(PoisonError::into_inner);
        let r = map.entry(k).or_default();
        if r.paused(now) {
            return false;
        }
        if unbounded {
            return true;
        }
        r.prune(now);
        if r.tells.len() >= MAX_TELLS || r.beacons.len() + r.tells.len() >= MAX_EVENTS {
            return false;
        }
        r.tells.push_back(now);
        true
    }

    /// `url`'s answer to an event sent through this share: a refusal that asks to slow down
    /// pauses it ([`PAUSE_MIN`], doubling to [`PAUSE_MAX`]); an acceptance ends the pause.
    /// Other refusals (a relay down, an event it does not want) change nothing.
    pub fn answered(&self, url: &str, answer: Result<(), &str>, now: Instant) {
        let mut map = self.relays.lock().unwrap_or_else(PoisonError::into_inner);
        let r = map.entry(key(url)).or_default();
        match answer {
            Ok(()) => {
                r.pause = Duration::ZERO;
                r.paused_until = None;
            }
            Err(why) if refusal_pauses(why) => {
                r.pause = if r.pause.is_zero() {
                    PAUSE_MIN
                } else {
                    (r.pause * 2).min(PAUSE_MAX)
                };
                r.paused_until = Some(now + r.pause);
            }
            Err(_) => {}
        }
    }

    /// Forget video `a` (it is no longer announced).
    pub fn forget(&self, a: &str) {
        let mut map = self.relays.lock().unwrap_or_else(PoisonError::into_inner);
        for r in map.values_mut() {
            r.last.remove(a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERIOD: Duration = Duration::from_secs(30);

    fn urls(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn few_videos_go_out_at_the_full_period() {
        let s = RelayShare::new(PERIOD, []);
        let t0 = Instant::now();
        let r = urls(&["wss://a.example", "wss://b.example"]);
        for tick in 0..6u32 {
            let now = t0 + PERIOD * tick;
            for v in 0..10 {
                let turn = s.beacon(&format!("v{v}"), 10, &r, now);
                assert_eq!(turn.to, r, "tick {tick} video {v}");
            }
        }
    }

    #[test]
    fn many_videos_take_turns_within_the_beacon_share() {
        let s = RelayShare::new(PERIOD, []);
        let t0 = Instant::now();
        let r = urls(&["wss://general.example"]);
        let videos = 30;
        let mut sent = vec![0u32; videos];
        let mut per_minute = BTreeMap::<u32, usize>::new();
        for tick in 0..40u32 {
            let now = t0 + PERIOD * tick;
            for (v, n) in sent.iter_mut().enumerate() {
                if !s.beacon(&format!("v{v}"), videos, &r, now).to.is_empty() {
                    *n += 1;
                    *per_minute.entry(tick / 2).or_default() += 1;
                }
            }
        }
        assert!(
            per_minute.values().all(|n| *n <= MAX_BEACONS),
            "{per_minute:?}"
        );
        // 20 minutes: every video announced, none starved, none favoured by much.
        let (lo, hi) = (sent.iter().min().unwrap(), sent.iter().max().unwrap());
        assert!(*lo >= 8 && hi - lo <= 2, "{sent:?}");
    }

    #[test]
    fn a_scoped_relay_takes_every_beacon() {
        let s = RelayShare::new(PERIOD, urls(&["wss://scoped.example"]));
        let t0 = Instant::now();
        let r = urls(&["wss://scoped.example", "wss://general.example"]);
        let mut general = 0;
        for v in 0..30 {
            let turn = s.beacon(&format!("v{v}"), 30, &r, t0);
            assert_eq!(
                turn.to.first().map(String::as_str),
                Some("wss://scoped.example")
            );
            general += usize::from(turn.to.len() == 2);
        }
        assert_eq!(general, MAX_BEACONS);
        assert!(s.tell("wss://scoped.example", t0));
    }

    #[test]
    fn tells_keep_their_share_and_borrow_up_to_fifteen() {
        let s = RelayShare::new(PERIOD, []);
        let t0 = Instant::now();
        let r = urls(&["wss://g.example"]);
        // Beacons fill their 20: the tells still have 10.
        for v in 0..25 {
            let _ = s.beacon(&format!("v{v}"), 25, &r, t0);
        }
        assert_eq!(
            (0..20).filter(|_| s.tell("wss://g.example", t0)).count(),
            10
        );
        // A fresh minute with no beacons: tells stop at 15, and beacons then have 15 left.
        let t1 = t0 + WINDOW;
        assert_eq!(
            (0..20).filter(|_| s.tell("wss://g.example", t1)).count(),
            MAX_TELLS
        );
        let beacons = (0..25)
            .filter(|v| !s.beacon(&format!("w{v}"), 25, &r, t1).to.is_empty())
            .count();
        assert_eq!(beacons, MAX_EVENTS - MAX_TELLS);
    }

    #[test]
    fn a_rate_limited_relay_pauses_doubling_and_an_acceptance_ends_it() {
        let s = RelayShare::new(PERIOD, urls(&["wss://scoped.example"]));
        let t0 = Instant::now();
        let r = urls(&["wss://g.example", "wss://scoped.example"]);
        s.answered("wss://g.example", Err("rate-limited: slow down"), t0);
        let turn = s.beacon("v", 1, &r, t0);
        assert_eq!(
            turn,
            Turn {
                to: urls(&["wss://scoped.example"]),
                paused: 1
            }
        );
        assert!(!s.tell("wss://g.example", t0));
        // Back after 1 minute; refused again: 2 minutes.
        let t1 = t0 + PAUSE_MIN;
        assert_eq!(s.beacon("v", 1, &r, t1).paused, 0);
        s.answered("wss://g.example", Err("relay said: blocked: not here"), t1);
        assert_eq!(s.beacon("v", 1, &r, t1 + PAUSE_MIN).paused, 1);
        assert_eq!(s.beacon("v", 1, &r, t1 + PAUSE_MIN * 2).paused, 0);
        // Doubling stops at 30 minutes.
        let mut now = t1 + PAUSE_MIN * 2;
        for _ in 0..10 {
            s.answered("wss://g.example", Err("rate-limited:"), now);
            now += PAUSE_MAX;
        }
        assert_eq!(s.beacon("v", 1, &r, now).paused, 0);
        // An acceptance resets it: the next refusal pauses for 1 minute again.
        s.answered("wss://g.example", Ok(()), now);
        s.answered("wss://g.example", Err("rate-limited:"), now);
        assert_eq!(s.beacon("v", 1, &r, now + PAUSE_MIN).paused, 0);
        // A scoped relay pauses too; other refusals change nothing.
        s.answered("wss://scoped.example", Err("rate-limited:"), now);
        assert!(!s.tell("wss://scoped.example", now));
        s.answered("wss://g.example", Err("invalid: bad tag"), now + PAUSE_MIN);
        assert!(s.tell("wss://g.example", now + PAUSE_MIN));
    }

    #[test]
    fn every_spelling_of_a_relay_shares_one_bucket() {
        let s = RelayShare::new(PERIOD, urls(&["WSS://Scoped.Example/"]));
        let t0 = Instant::now();
        // The scoped list matches however it was written.
        assert!(s.tell("wss://scoped.example", t0));
        // Beacons under one spelling and tells under another count together.
        for v in 0..20 {
            let to = s
                .beacon(&format!("v{v}"), 20, &urls(&["wss://r.example"]), t0)
                .to;
            assert_eq!(to, urls(&["wss://r.example"]), "returned as given");
        }
        assert_eq!(
            (0..20).filter(|_| s.tell("wss://r.example/", t0)).count(),
            10
        );
        assert_eq!((0..5).filter(|_| s.tell("WSS://R.EXAMPLE", t0)).count(), 0);
        // A refusal under one spelling pauses every spelling (for PAUSE_MIN).
        s.answered("wss://r.example/", Err("rate-limited: slow down"), t0);
        let later = t0 + PAUSE_MIN / 2;
        assert_eq!(
            s.beacon("w", 1, &urls(&["wss://r.example"]), later).paused,
            1
        );
        assert!(!s.tell("wss://R.example", later));
    }

    #[test]
    fn a_forgotten_video_is_due_at_once() {
        let s = RelayShare::new(PERIOD, []);
        let t0 = Instant::now();
        let r = urls(&["wss://g.example"]);
        assert_eq!(s.beacon("v", 1, &r, t0).to.len(), 1);
        assert!(
            s.beacon("v", 1, &r, t0 + Duration::from_secs(5))
                .to
                .is_empty()
        );
        s.forget("v");
        assert_eq!(
            s.beacon("v", 1, &r, t0 + Duration::from_secs(5)).to.len(),
            1
        );
    }
}
