//! Seeder ratings (NFX-16): nostr-social-memory's kind-7368 `rating` record with scope
//! `nfx.seeder`, read strictly (§1) and scored over the user's own circle (§4).
//!
//! This is a 1:1 port of the reference reader `spec/test-vectors/ratings.py`: the same
//! checks in the same order, the same newest-wins rule and the same truncating mean, so
//! both classify every vector alike. Ratings only ever order seeders for a watcher; a
//! seeder never reads them to set credit (ADR 0104 §6.4).

use std::collections::{BTreeMap, BTreeSet};

use crate::event::Event;
use crate::hex32::is_lower_hex;
use crate::{Error, KIND_RATING, MAX_CLOCK_SKEW, Result};

/// Kind of a NIP-02 follow list.
pub const KIND_FOLLOWS: u16 = 3;
/// Kind of a NIP-51 mute list.
pub const KIND_MUTES: u16 = 10000;
/// The only scope NFX reads.
pub const SCOPE: &str = "nfx.seeder";
/// The fixed range every NFX rating declares.
pub const MIN_RATING: i64 = -100;
/// The fixed range every NFX rating declares.
pub const MAX_RATING: i64 = 100;
/// Oldest rating counted, in seconds (30 days); also `expiration - created_at`.
pub const MAX_AGE: u64 = 30 * 24 * 60 * 60;
/// Most authors taken from one follow list. Truncating a follow list only admits
/// fewer authors, so it is the safe direction; mute lists are never truncated.
pub const MAX_FOLLOWS: usize = 10_000;

const REQUIRED_FACTS: [&str; 9] = [
    "type",
    "schema",
    "scope",
    "rater",
    "subject",
    "rating",
    "min_rating",
    "max_rating",
    "created_at",
];

/// A valid rating (NFX-16 §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rating {
    /// The event id, which breaks ties between two ratings of one moment.
    pub id: String,
    /// The author, who is also the signer.
    pub rater: String,
    /// The seeder's long-term key (NFX-07 §3), 64 lowercase hex.
    pub subject: String,
    /// −100..=100; 0 withdraws the author's earlier rating.
    pub rating: i64,
    /// The `created_at` fact. A value too large for u64 reads as `u64::MAX`, which is
    /// always in the future, as the reference reader's unbounded integers are.
    pub created_at: u64,
    /// The NIP-40 `expiration`, saturating the same way.
    pub expiration: u64,
    /// The event's own `created_at`.
    pub event_created_at: u64,
}

fn bad(msg: &str) -> Error {
    Error::Event(msg.to_string())
}

/// `0|[1-9][0-9]*`, saturating at `u64::MAX` past it.
fn uint(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    Some(s.parse().unwrap_or(u64::MAX))
}

/// `0|-?[1-9][0-9]*`: no `+`, no leading zero, no `-0`. Values past i64 are `None`,
/// which is outside −100..=100 either way.
fn canonical_int(s: &str) -> Option<Option<i64>> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    let b = digits.as_bytes();
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if b[0] == b'0' && (b.len() > 1 || digits.len() != s.len()) {
        return None;
    }
    Some(s.parse().ok())
}

/// The one value of the one tag called `name`; every tag is known non-empty here.
fn only<'a>(tags: &'a [Vec<String>], name: &str) -> Result<&'a str> {
    let mut found = tags.iter().filter(|t| t[0] == name);
    match (found.next(), found.next()) {
        (Some(t), None) if t.len() == 2 => Ok(t[1].as_str()),
        _ => Err(Error::Event(format!(
            "{name} must appear exactly once, with one value"
        ))),
    }
}

/// A lowercase canonical UUID: 8-4-4-4-12 lowercase hex digits.
fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| is_lower_hex(g, n))
}

impl Rating {
    /// NFX-16 §1: a valid rating for `namespace`, or `Error::Event` saying why not.
    pub fn from_event(event: &Event, namespace: &str) -> Result<Self> {
        if event.kind != KIND_RATING {
            return Err(bad("kind is not 7368"));
        }
        if !event.content.is_empty() {
            return Err(bad("content is not empty"));
        }
        if !is_lower_hex(&event.pubkey, 64) {
            return Err(bad("pubkey is not 64 lowercase hex"));
        }
        event.verify()?;
        let tags = &event.tags;
        if tags.iter().any(Vec::is_empty) {
            return Err(bad("a tag is not a non-empty list of strings"));
        }

        if only(tags, "n")? != namespace {
            return Err(bad("n names another network"));
        }
        let expiration = uint(only(tags, "expiration")?)
            .ok_or_else(|| bad("expiration is not a decimal integer"))?;
        if tags.iter().any(|t| t[0] == "d" || t[0] == "e") {
            return Err(bad("d and e tags are not allowed"));
        }
        let mut subjects = tags
            .iter()
            .filter(|t| t[0] == "i" && t.len() >= 3 && t[2] == "subject");
        match (subjects.next(), subjects.next()) {
            (Some(t), None) if is_uuid(&t[1]) => {}
            _ => {
                return Err(bad(
                    "needs exactly one subject i tag holding a canonical lowercase UUID",
                ));
            }
        }

        let mut facts = BTreeMap::new();
        for name in REQUIRED_FACTS {
            facts.insert(name, only(tags, name)?);
        }
        if facts["type"] != "rating" || facts["schema"] != "1" {
            return Err(bad("not a schema-1 rating record"));
        }
        if facts["scope"] != SCOPE {
            return Err(bad("scope is not nfx.seeder"));
        }
        if facts["rater"] != event.pubkey {
            return Err(bad("rater is not the signer"));
        }
        let subject = facts["subject"];
        if !is_lower_hex(subject, 64) {
            return Err(bad("subject is not 64 lowercase hex"));
        }
        if subject == facts["rater"] {
            return Err(bad("a rater cannot rate itself"));
        }
        if facts["min_rating"] != MIN_RATING.to_string()
            || facts["max_rating"] != MAX_RATING.to_string()
        {
            return Err(bad("range is not -100..100"));
        }
        let rating = canonical_int(facts["rating"])
            .flatten()
            .filter(|r| (MIN_RATING..=MAX_RATING).contains(r))
            .ok_or_else(|| bad("rating is not a canonical integer in -100..100"))?;
        let created_at =
            uint(facts["created_at"]).ok_or_else(|| bad("created_at is not a decimal integer"))?;

        Ok(Self {
            id: event.id.clone(),
            rater: event.pubkey.clone(),
            subject: subject.to_string(),
            rating,
            created_at,
            expiration,
            event_created_at: event.created_at,
        })
    }
}

/// The authors whose ratings count (NFX-16 §4): the user's own key, the authors on
/// its follow list and any trusted authors, less everyone on its mute list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Admitted(BTreeSet<String>);

impl Admitted {
    pub fn new<'a>(
        root: &'a str,
        follows: impl IntoIterator<Item = &'a str>,
        trusted: impl IntoIterator<Item = &'a str>,
        muted: impl IntoIterator<Item = &'a str>,
    ) -> Self {
        let mut admitted: BTreeSet<String> = std::iter::once(root)
            .chain(follows)
            .chain(trusted)
            .map(str::to_string)
            .collect();
        for m in muted {
            admitted.remove(m);
        }
        Self(admitted)
    }

    #[must_use]
    pub fn contains(&self, author: &str) -> bool {
        self.0.contains(author)
    }

    /// The admitted authors, sorted.
    pub fn authors(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// What scoring made of one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// The author's newest rating of this seeder, and it counts.
    Counted,
    /// The same author rated the same seeder later (or, at the same moment, with a
    /// greater event id).
    Superseded,
    /// The author's newest rating of this seeder is 0: it adds nothing.
    Withdrawal,
    /// The author is not admitted.
    NotAdmitted,
    /// The `created_at` fact or the event is more than 15 minutes ahead of `now`.
    FromFuture,
    /// Older than 30 days, or past its `expiration`.
    Expired,
    /// Not a valid rating for this namespace (§1); the reason.
    Invalid(String),
}

/// One seeder's trusted score: the truncated mean of the counted ratings, and how many.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Score {
    pub score: i64,
    pub authors: u64,
}

/// The result of [`score`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scored {
    /// Per seeder (subject), only those with at least one counted rating.
    pub scores: BTreeMap<String, Score>,
    /// One verdict per input event, in input order.
    pub verdicts: Vec<Verdict>,
}

/// NFX-16 §4: score `events` for `namespace` at `now`, counting `admitted` authors only.
#[must_use]
pub fn score(events: &[Event], namespace: &str, now: u64, admitted: &Admitted) -> Scored {
    let mut verdicts: Vec<Option<Verdict>> = Vec::with_capacity(events.len());
    // (rater, subject) -> ((created_at fact, event id), rating)
    let mut latest: BTreeMap<(String, String), ((u64, String), i64)> = BTreeMap::new();
    let horizon = now.saturating_add(MAX_CLOCK_SKEW);
    for event in events {
        let r = match Rating::from_event(event, namespace) {
            Ok(r) => r,
            Err(e) => {
                verdicts.push(Some(Verdict::Invalid(invalid_reason(&e))));
                continue;
            }
        };
        if !admitted.contains(&r.rater) {
            verdicts.push(Some(Verdict::NotAdmitted));
            continue;
        }
        if r.created_at > horizon || r.event_created_at > horizon {
            verdicts.push(Some(Verdict::FromFuture));
            continue;
        }
        if now.saturating_sub(r.created_at) > MAX_AGE || r.expiration <= now {
            verdicts.push(Some(Verdict::Expired));
            continue;
        }
        verdicts.push(None);
        let rank = (r.created_at, r.id);
        match latest.entry((r.rater, r.subject)) {
            std::collections::btree_map::Entry::Vacant(v) => {
                v.insert((rank, r.rating));
            }
            std::collections::btree_map::Entry::Occupied(mut o) => {
                if rank > o.get().0 {
                    o.insert((rank, r.rating));
                }
            }
        }
    }

    let newest: BTreeMap<&str, i64> = latest
        .values()
        .map(|((_, id), rating)| (id.as_str(), *rating))
        .collect();
    let verdicts = events
        .iter()
        .zip(verdicts)
        .map(|(event, v)| {
            v.unwrap_or_else(|| match newest.get(event.id.as_str()) {
                None => Verdict::Superseded,
                Some(0) => Verdict::Withdrawal,
                Some(_) => Verdict::Counted,
            })
        })
        .collect();

    let mut totals: BTreeMap<String, (i64, u64)> = BTreeMap::new();
    for ((_, subject), (_, rating)) in &latest {
        if *rating == 0 {
            continue;
        }
        let t = totals.entry(subject.clone()).or_insert((0, 0));
        t.0 += rating;
        t.1 += 1;
    }
    let scores = totals
        .into_iter()
        .map(|(subject, (sum, n))| {
            // i64 division truncates toward zero, as §4 requires; n ≥ 1 here.
            let score = sum / i64::try_from(n).unwrap_or(i64::MAX);
            (subject, Score { score, authors: n })
        })
        .collect();
    Scored { scores, verdicts }
}

fn invalid_reason(e: &Error) -> String {
    match e {
        Error::Event(msg) => msg.clone(),
        Error::Signature => "bad signature".to_string(),
        other => other.to_string(),
    }
}

/// The pubkeys a follow list (kind 3) or mute list (kind 10000) by `author` names: its
/// `p` tags holding 64 lowercase hex, deduplicated, in order. A follow list keeps at
/// most [`MAX_FOLLOWS`]; a mute list is never truncated.
pub fn listed_pubkeys(event: &Event, kind: u16, author: &str) -> Result<Vec<String>> {
    if kind != KIND_FOLLOWS && kind != KIND_MUTES {
        return Err(bad("only follow and mute lists are read"));
    }
    if event.kind != kind {
        return Err(bad("unexpected list kind"));
    }
    if event.pubkey != author {
        return Err(bad("list is not by the expected author"));
    }
    event.verify()?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for t in &event.tags {
        if t.len() >= 2 && t[0] == "p" && is_lower_hex(&t[1], 64) && seen.insert(t[1].as_str()) {
            if kind == KIND_FOLLOWS && out.len() == MAX_FOLLOWS {
                break;
            }
            out.push(t[1].clone());
        }
    }
    Ok(out)
}
