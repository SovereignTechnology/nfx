//! Answering seeder lookups (NFX-17 §3): a viewer asks who seeds a video, and this node answers
//! at once with its own signed beacon.
//!
//! [`Book`] holds every decision and is pure (callers pass the clock and the event). [`Answerer`]
//! runs it on a relay connection of its own, so a slow publish never delays an answer.
//!
//! An ask is free to send, so the work it can cause is bounded before anything else: at most
//! [`VERIFY_PER_SEC`] signature checks a second per relay, none when a budget is already empty,
//! and budgets charged only after the ask verifies. An empty budget means no answer, and the
//! periodic beacon covers the viewer.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use n0_future::StreamExt as _;
use nfx_proto::KIND_BEACON;
use nfx_proto::beacon::{self, Beacon, BeaconContent, parse_a_tag};
use nfx_proto::event::Event;
use nfx_proto::lookup::{self, KIND_LOOKUP, Parsed, Type};
use nostr_sdk::prelude as ns;

use crate::nostr::{BEACON_TTL, from_nostr, to_nostr};

/// Asks verified per second per relay; the rest are dropped unverified.
pub const VERIFY_PER_SEC: u32 = 32;
/// Tells per (asker, video) per [`ASKER_WINDOW_SECS`]: the viewer's one re-ask.
pub const TELLS_PER_ASKER: usize = 2;
pub const ASKER_WINDOW_SECS: u64 = 10;
/// Per video: this many at once, then [`VIDEO_PER_SEC`].
pub const VIDEO_BURST: u64 = 8;
pub const VIDEO_PER_SEC: u64 = 1;
/// Across all videos: this many at once, then [`OVERALL_PER_SEC`].
pub const OVERALL_BURST: u64 = 32;
pub const OVERALL_PER_SEC: u64 = 4;
/// An ask heard on another relay within this long gets the same tell there, at no charge.
pub const ANSWER_AGAIN_SECS: u64 = 10;
/// How long an answered ask is remembered.
pub const SEEN_SECS: u64 = 120;
/// A tell embeds the newest beacon only if it has this long to live, so that it is still useful
/// to a viewer whose clock differs by up to 30 s. Otherwise a new one is signed.
pub const MIN_BEACON_LIFE: u64 = 30;

/// Answered asks remembered at once; past this the oldest go.
const MAX_ANSWERED: usize = 8192;
/// (asker, video) pairs remembered at once. Only an answered ask makes an entry.
const MAX_ASKERS: usize = 4096;
/// Videos per subscription filter, within NFX-04 §2's 256 tag values.
const VIDEOS_PER_FILTER: usize = 250;
/// How often the subscriptions are checked against the videos and the connected relays.
const SUBSCRIPTION_CHECK: Duration = Duration::from_secs(2);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);

/// A token bucket, counted in thousandths of a token so that it refills smoothly.
#[derive(Debug, Clone, Copy)]
struct Bucket {
    milli: u64,
    at_ms: u64,
    burst: u64,
    per_sec: u64,
}

impl Bucket {
    fn new(burst: u64, per_sec: u64, now_ms: u64) -> Self {
        Self {
            milli: burst * 1000,
            at_ms: now_ms,
            burst,
            per_sec,
        }
    }

    fn has_one(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.at_ms);
        self.milli = self
            .milli
            .saturating_add(elapsed.saturating_mul(self.per_sec))
            .min(self.burst * 1000);
        self.at_ms = self.at_ms.max(now_ms);
        self.milli >= 1000
    }

    fn take(&mut self) {
        self.milli = self.milli.saturating_sub(1000);
    }
}

#[derive(Debug)]
struct Served {
    beacon: Event,
    expiration: u64,
    content: BeaconContent,
    bucket: Bucket,
}

#[derive(Debug)]
struct Answered {
    /// The video asked about: forgetting it drops this answer too.
    a: String,
    at: u64,
    tell: Event,
    relays: HashSet<String>,
}

/// What this node is announcing, and what it has answered.
#[derive(Debug)]
pub struct Book {
    videos: BTreeMap<String, Served>,
    overall: Bucket,
    /// (asker, a) → when it was answered.
    askers: HashMap<(String, String), VecDeque<u64>>,
    answered: HashMap<String, Answered>,
    /// The ids in `answered`, oldest first.
    order: VecDeque<String>,
    /// Relay → (the second, signature checks made in it).
    verifying: HashMap<String, (u64, u32)>,
}

impl Book {
    #[must_use]
    pub fn new(now_ms: u64) -> Self {
        Self {
            videos: BTreeMap::new(),
            overall: Bucket::new(OVERALL_BURST, OVERALL_PER_SEC, now_ms),
            askers: HashMap::new(),
            answered: HashMap::new(),
            order: VecDeque::new(),
            verifying: HashMap::new(),
        }
    }

    /// Hold `beacon`, this node's newest for the video `a`, to embed in tells. A beacon that does
    /// not verify, or serves another video, is not held.
    pub fn serve(&mut self, a: &str, beacon: Event, content: BeaconContent, now_ms: u64) {
        let Ok(parsed) = Beacon::from_event(&beacon, now_ms / 1000) else {
            return;
        };
        if beacon.single_tag("a").ok().flatten().map(|v| v[0].as_str()) != Some(a) {
            return;
        }
        let expiration = parsed.expiration;
        match self.videos.get_mut(a) {
            Some(held) => {
                held.beacon = beacon;
                held.expiration = expiration;
                held.content = content;
            }
            None => {
                self.videos.insert(
                    a.to_owned(),
                    Served {
                        beacon,
                        expiration,
                        content,
                        bucket: Bucket::new(VIDEO_BURST, VIDEO_PER_SEC, now_ms),
                    },
                );
            }
        }
    }

    /// Stop answering for the video `a`.
    pub fn forget(&mut self, a: &str) {
        self.videos.remove(a);
        // An ask answered on one relay must not be answered again on another once the video is
        // no longer served: `order` keeps the ids, and `expire` drops the stale ones.
        self.answered.retain(|_, done| done.a != a);
    }

    /// The videos to listen for, by network.
    fn wanted(&self) -> BTreeMap<String, Vec<String>> {
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for a in self.videos.keys() {
            if let Ok((_, addr)) = parse_a_tag(a) {
                out.entry(addr.namespace().to_string())
                    .or_default()
                    .push(a.clone());
            }
        }
        out
    }

    fn expire(&mut self, now: u64) {
        while let Some(id) = self.order.front() {
            let old = self
                .answered
                .get(id)
                .is_none_or(|d| now >= d.at + SEEN_SECS);
            if !old && self.order.len() < MAX_ANSWERED {
                break;
            }
            if let Some(id) = self.order.pop_front() {
                self.answered.remove(&id);
            }
        }
        if self.askers.len() >= MAX_ASKERS {
            self.askers
                .retain(|_, times| times.back().is_some_and(|at| now < at + ASKER_WINDOW_SECS));
        }
    }

    /// The tell to send on `relay` in answer to `ev`, if any. Everything `ev` says is unverified
    /// until [`lookup::read`] passes, so nothing is charged or remembered before that.
    pub fn offer(
        &mut self,
        ev: &Event,
        relay: &str,
        secret: &[u8; 32],
        now_ms: u64,
    ) -> Option<Event> {
        let now = now_ms / 1000;
        if ev.kind != KIND_LOOKUP {
            return None;
        }
        self.expire(now);
        // Already answered: the same tell on a relay that has not had it, so that one relay
        // swallowing tells cannot silence this seeder on the others (§3).
        if let Some(done) = self.answered.get_mut(&ev.id) {
            if now >= done.at + ANSWER_AGAIN_SECS || !done.relays.insert(relay.to_owned()) {
                return None;
            }
            return Some(done.tell.clone());
        }
        let shape = lookup::shape(ev, now).ok()?;
        if shape.kind != Type::Ask
            || !lookup::size_ok(Type::Ask, serde_json::to_string(ev).ok()?.len())
            || !self.videos.contains_key(&shape.a)
        {
            return None;
        }
        // Room for the work first, then for the answer. Reading a budget changes nothing.
        let slot = self.verifying.entry(relay.to_owned()).or_insert((now, 0));
        if slot.0 != now {
            *slot = (now, 0);
        }
        if slot.1 >= VERIFY_PER_SEC {
            return None;
        }
        if !self.overall.has_one(now_ms) {
            return None;
        }
        let key = (shape.asker.clone(), shape.a.clone());
        let answered_lately = self.askers.get(&key).map_or(0, |times| {
            times
                .iter()
                .filter(|at| now < **at + ASKER_WINDOW_SECS)
                .count()
        });
        if answered_lately >= TELLS_PER_ASKER {
            return None;
        }
        let video = self.videos.get_mut(&shape.a)?;
        if !video.bucket.has_one(now_ms) {
            return None;
        }
        slot.1 += 1;
        let Parsed::Ask(ask) = lookup::read(ev, now).ok()? else {
            return None;
        };

        if video.expiration.saturating_sub(now) < MIN_BEACON_LIFE {
            let tags = beacon::tags(&shape.a, now, BEACON_TTL).ok()?;
            let fresh =
                Event::sign(secret, now, KIND_BEACON, tags, video.content.to_content()).ok()?;
            video.expiration = Beacon::from_event(&fresh, now).ok()?.expiration;
            video.beacon = fresh;
        }
        // The ask's signer, verified just above, and no key named in a tag.
        let tell = lookup::tell(secret, &video.beacon, &ask.asker, now).ok()?;

        video.bucket.take();
        self.overall.take();
        let times = self.askers.entry(key).or_default();
        while times
            .front()
            .is_some_and(|at| now >= at + ASKER_WINDOW_SECS)
        {
            times.pop_front();
        }
        times.push_back(now);
        self.order.push_back(ev.id.clone());
        self.answered.insert(
            ev.id.clone(),
            Answered {
                a: shape.a.clone(),
                at: now,
                tell: tell.clone(),
                relays: HashSet::from([relay.to_owned()]),
            },
        );
        Some(tell)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Answers lookups on `relays` until shut down.
#[derive(Clone)]
pub struct Answerer {
    book: Arc<Mutex<Book>>,
    client: ns::Client,
    task: Arc<tokio::task::AbortHandle>,
}

impl Answerer {
    /// Connect to `relays`, without waiting for them, and start answering for the videos given
    /// to [`Answerer::serve`]. `secret` is the key this node signs its beacons with.
    pub async fn start(relays: &[String], secret: [u8; 32]) -> crate::Result<Self> {
        let client = ns::Client::default();
        for url in relays {
            client
                .add_relay(url.as_str())
                .await
                .map_err(crate::NodeError::relay)?;
        }
        client.connect().await;
        let book = Arc::new(Mutex::new(Book::new(now_ms())));
        let task = tokio::spawn(run(client.clone(), book.clone(), secret));
        Ok(Self {
            book,
            client,
            task: Arc::new(task.abort_handle()),
        })
    }

    fn book(&self) -> std::sync::MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Hold `beacon`, the newest signed for the video `a`.
    pub fn serve(&self, a: &str, beacon: Event, content: BeaconContent) {
        self.book().serve(a, beacon, content, now_ms());
    }

    /// Stop answering for the video `a`.
    pub fn forget(&self, a: &str) {
        self.book().forget(a);
    }

    pub async fn shutdown(&self) {
        self.task.abort();
        self.client.shutdown().await;
    }
}

/// A subscription as held: its id, its network and the videos it asks about.
type Held = (ns::SubscriptionId, String, Vec<String>);

async fn run(client: ns::Client, book: Arc<Mutex<Book>>, secret: [u8; 32]) {
    let mut notes = client.notifications();
    let mut check = tokio::time::interval(SUBSCRIPTION_CHECK);
    check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut held: Vec<Held> = Vec::new();
    // The list each relay was last sent: one that was away when the list changed gets it on return.
    let mut applied: HashMap<String, Vec<Held>> = HashMap::new();
    loop {
        tokio::select! {
            _ = check.tick() => {
                let wanted = book.lock().unwrap_or_else(PoisonError::into_inner).wanted();
                keep_subscribed(&client, &wanted, &mut held, &mut applied).await;
            }
            note = notes.next() => match note {
                Some(ns::ClientNotification::Event { relay_url, event, .. }) => {
                    let Ok(ask) = from_nostr(&event) else { continue };
                    let tell = book
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .offer(&ask, relay_url.as_str(), &secret, now_ms());
                    let Some(tell) = tell.and_then(|t| to_nostr(&t).ok()) else { continue };
                    if let Some(relay) = client.relays().await.get(&relay_url).cloned() {
                        tokio::spawn(async move {
                            let _ = relay.send_event(&tell).ok_timeout(SEND_TIMEOUT).await;
                        });
                    }
                }
                Some(ns::ClientNotification::Shutdown) | None => return,
                Some(_) => {}
            },
        }
    }
}

fn ask_filter(namespace: &str, videos: &[String]) -> ns::Filter {
    ns::Filter::new()
        .kind(ns::Kind::from(KIND_LOOKUP))
        .custom_tag(ns::SingleLetterTag::LOWERCASE_N, namespace.to_owned())
        .custom_tag(ns::SingleLetterTag::LOWERCASE_T, "ask")
        .custom_tags(ns::SingleLetterTag::LOWERCASE_A, videos.iter().cloned())
        .since(ns::Timestamp::from(
            crate::unix_now().saturating_sub(lookup::MAX_AGE),
        ))
}

/// Every connected relay holds one subscription per chunk of videos. A changed list replaces
/// them; a relay that lacks one (it connected late, reconnected or closed it) gets it again.
async fn keep_subscribed(
    client: &ns::Client,
    wanted: &BTreeMap<String, Vec<String>>,
    held: &mut Vec<Held>,
    applied: &mut HashMap<String, Vec<Held>>,
) {
    let mut next = Vec::new();
    for (namespace, videos) in wanted {
        for (i, chunk) in videos.chunks(VIDEOS_PER_FILTER).enumerate() {
            let id = ns::SubscriptionId::new(format!("nfx-lookup-{namespace}-{i}"));
            next.push((id, namespace.clone(), chunk.to_vec()));
        }
    }
    let changed = next != *held;
    if changed {
        for (id, ..) in held.iter() {
            if !next.iter().any(|(n, ..)| n == id) {
                let _ = client.unsubscribe(id).await;
            }
        }
    }
    for (url, relay) in client.relays().await {
        if !relay.status().is_connected() {
            continue;
        }
        // A relay not sent this list yet (it was away when the list changed, or is new) gets
        // every chunk again: its old subscription under the same id still has the old filter.
        let stale = applied.get(url.as_str()) != Some(&next);
        let mut all_sent = true;
        for (id, namespace, videos) in &next {
            if changed || stale || relay.subscription(id).await.is_none() {
                let filter = ask_filter(namespace, videos);
                let sent = client
                    .subscribe(ns::ReqTarget::single(url.clone(), [filter]))
                    .with_id(id.clone())
                    .await;
                all_sent &= sent.is_ok();
            }
        }
        // Only a relay that took every chunk counts as up to date: after a refused one, the
        // relay may still hold the old filter under that id, and the next round sends it again.
        if all_sent {
            applied.insert(url.to_string(), next.clone());
        }
    }
    *held = next;
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use nfx_proto::namespace::VideoAddr;

    use super::*;

    struct Fixture {
        now: u64,
        a: String,
        seeder: [u8; 32],
        beacon: Event,
        content: BeaconContent,
    }

    fn fixture() -> Fixture {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/lookup.json")).unwrap();
        let hex = v["secret_keys_DO_NOT_USE"]["seeder"].as_str().unwrap();
        let mut seeder = [0u8; 32];
        for (i, b) in seeder.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        let now = v["now"].as_u64().unwrap();
        let beacon: Event = serde_json::from_value(v["beacon"].clone()).unwrap();
        let content = Beacon::from_event(&beacon, now).unwrap().content.clone();
        Fixture {
            now,
            a: v["manifest_a"].as_str().unwrap().to_owned(),
            seeder,
            beacon,
            content,
        }
    }

    fn book(f: &Fixture) -> Book {
        let mut b = Book::new(f.now * 1000);
        b.serve(&f.a, f.beacon.clone(), f.content.clone(), f.now * 1000);
        b
    }

    fn ask(key: u8, f: &Fixture, at: u64) -> Event {
        lookup::ask(&[key; 32], &f.a, at).unwrap()
    }

    /// A beacon for another video of the same creator.
    fn other_video(f: &Fixture, i: usize) -> (String, Event, BeaconContent) {
        let (creator, addr) = parse_a_tag(&f.a).unwrap();
        let video = VideoAddr::new(addr.namespace().clone(), &format!("clip-{i:03}")).unwrap();
        let a = format!("38504:{creator}:{video}");
        let content = BeaconContent {
            video,
            ..f.content.clone()
        };
        let tags = beacon::tags(&a, f.now, 60).unwrap();
        let ev = Event::sign(&f.seeder, f.now, KIND_BEACON, tags, content.to_content()).unwrap();
        (a, ev, content)
    }

    #[test]
    fn an_ask_gets_the_newest_beacon_addressed_to_its_signer() {
        let f = fixture();
        let mut b = book(&f);
        let q = ask(1, &f, f.now);
        let tell = b.offer(&q, "r1", &f.seeder, f.now * 1000).unwrap();
        let Parsed::Tell(told) = lookup::read(&tell, f.now).unwrap() else {
            panic!("a tell")
        };
        assert_eq!(told.asker, q.pubkey);
        assert_eq!(told.event, f.beacon, "the periodic beacon, as signed");
    }

    #[test]
    fn nothing_is_answered_for_another_video_or_a_bad_event() {
        let f = fixture();
        let mut b = book(&f);
        let (other, ..) = other_video(&f, 1);
        let q = lookup::ask(&[1; 32], &other, f.now).unwrap();
        assert!(b.offer(&q, "r1", &f.seeder, f.now * 1000).is_none());
        let told = lookup::tell(&f.seeder, &f.beacon, &"ab".repeat(32), f.now).unwrap();
        assert!(
            b.offer(&told, "r1", &f.seeder, f.now * 1000).is_none(),
            "a tell is not an ask"
        );
        b.forget(&f.a);
        let q = ask(2, &f, f.now);
        assert!(b.offer(&q, "r1", &f.seeder, f.now * 1000).is_none());
    }

    /// A forged ask costs a signature check on its relay, and no budget at all.
    #[test]
    fn a_forged_ask_charges_nothing() {
        let f = fixture();
        let mut b = book(&f);
        let mut forged = ask(1, &f, f.now);
        forged.sig = "00".repeat(64);
        for _ in 0..VERIFY_PER_SEC {
            assert!(b.offer(&forged, "r1", &f.seeder, f.now * 1000).is_none());
        }
        // That relay has used this second's checks; another has not, and no budget moved.
        let q = ask(1, &f, f.now);
        assert!(b.offer(&q, "r1", &f.seeder, f.now * 1000).is_none());
        for i in 0..VIDEO_BURST {
            let q = ask(u8::try_from(i).unwrap() + 1, &f, f.now);
            assert!(b.offer(&q, "r2", &f.seeder, f.now * 1000).is_some(), "{i}");
        }
    }

    #[test]
    fn an_asker_gets_two_tells_per_video_per_ten_seconds() {
        let f = fixture();
        let mut b = book(&f);
        let t = f.now * 1000;
        assert!(b.offer(&ask(1, &f, f.now), "r", &f.seeder, t).is_some());
        assert!(b.offer(&ask(1, &f, f.now - 1), "r", &f.seeder, t).is_some());
        assert!(b.offer(&ask(1, &f, f.now - 2), "r", &f.seeder, t).is_none());
        let later = f.now + ASKER_WINDOW_SECS;
        let q = ask(1, &f, later);
        assert!(b.offer(&q, "r", &f.seeder, later * 1000).is_some());
    }

    #[test]
    fn a_video_answers_a_burst_of_eight_then_one_a_second() {
        let f = fixture();
        let mut b = book(&f);
        let t = f.now * 1000;
        for i in 1..=VIDEO_BURST {
            let q = ask(u8::try_from(i).unwrap(), &f, f.now);
            assert!(b.offer(&q, "r", &f.seeder, t).is_some(), "{i}");
        }
        assert!(b.offer(&ask(20, &f, f.now), "r", &f.seeder, t).is_none());
        let q = ask(21, &f, f.now);
        assert!(b.offer(&q, "r", &f.seeder, t + 1000).is_some(), "refilled");
        assert!(
            b.offer(&ask(22, &f, f.now), "r", &f.seeder, t + 1000)
                .is_none()
        );
    }

    #[test]
    fn a_seeder_answers_a_burst_of_thirty_two_then_four_a_second() {
        let f = fixture();
        let t = f.now * 1000;
        let mut b = Book::new(t);
        let videos: Vec<_> = (0..5).map(|i| other_video(&f, i)).collect();
        for (a, ev, content) in &videos {
            b.serve(a, ev.clone(), content.clone(), t);
        }
        let mut key = 0u8;
        let mut asked = |a: &str| {
            key += 1;
            lookup::ask(&[key; 32], a, f.now).unwrap()
        };
        let mut told = 0;
        for (a, ..) in &videos {
            for _ in 0..VIDEO_BURST {
                let relay = format!("r{told}");
                told += u64::from(b.offer(&asked(a), &relay, &f.seeder, t).is_some());
            }
        }
        assert_eq!(told, OVERALL_BURST);
        let (a, ..) = &videos[4];
        assert!(
            b.offer(&asked(a), "x", &f.seeder, t + 250).is_some(),
            "a quarter of a second buys one"
        );
    }

    /// One tell, signed once and charged once, for the relays an ask arrives on within 10 s.
    #[test]
    fn an_ask_on_another_relay_gets_the_same_tell_at_no_charge() {
        let f = fixture();
        let mut b = book(&f);
        let t = f.now * 1000;
        let q = ask(1, &f, f.now);
        let tell = b.offer(&q, "r1", &f.seeder, t).unwrap();
        assert!(b.offer(&q, "r1", &f.seeder, t).is_none(), "the same relay");
        assert_eq!(b.offer(&q, "r2", &f.seeder, t + 9000), Some(tell));
        assert!(
            b.offer(&q, "r3", &f.seeder, t + 10_000).is_none(),
            "past 10 s"
        );
        for i in 2..=VIDEO_BURST {
            let q = ask(u8::try_from(i).unwrap(), &f, f.now);
            assert!(b.offer(&q, "r1", &f.seeder, t).is_some(), "{i}: uncharged");
        }
    }

    #[test]
    fn a_beacon_with_under_thirty_seconds_left_is_replaced() {
        let f = fixture();
        let mut b = book(&f);
        let held = Beacon::from_event(&f.beacon, f.now).unwrap().expiration;
        let late = held - MIN_BEACON_LIFE + 1;
        let tell = b
            .offer(&ask(1, &f, late), "r", &f.seeder, late * 1000)
            .unwrap();
        let Parsed::Tell(told) = lookup::read(&tell, late).unwrap() else {
            panic!("a tell")
        };
        assert_ne!(told.event.id, f.beacon.id);
        assert_eq!(told.beacon.created_at, late);
        assert_eq!(told.expiration, late + BEACON_TTL);
    }

    /// A video that stops being served stops being answered, on every relay.
    #[test]
    fn a_forgotten_video_is_not_answered_from_the_cache_on_another_relay() {
        let f = fixture();
        let mut b = book(&f);
        let t = f.now * 1000;
        let q = ask(1, &f, f.now);
        assert!(b.offer(&q, "r1", &f.seeder, t).is_some());
        b.forget(&f.a);
        assert!(
            b.offer(&q, "r2", &f.seeder, t + 1000).is_none(),
            "the same ask on a second relay, after the video was forgotten"
        );
    }

    #[test]
    fn a_beacon_for_another_video_is_not_held() {
        let f = fixture();
        let mut b = Book::new(f.now * 1000);
        let (other, ev, content) = other_video(&f, 1);
        b.serve(&f.a, ev, content, f.now * 1000);
        assert!(b.wanted().is_empty(), "{other} was not asked for");
    }
}
