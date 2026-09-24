//! Manifests (NFX-02) and beacons (NFX-03) over Nostr relays, through nostr-sdk.
//!
//! Signing is nostr-sdk's: any async signer, a local key today and NIP-46 later. Every
//! event is parsed back through `nfx-proto` before it is sent, so nothing leaves that a
//! reader would reject. Relays are untrusted: everything a relay returns is re-verified
//! by `nfx-proto` and re-checked against the request, because a relay can ignore a filter.

use std::collections::{BTreeMap, BTreeSet};
use std::pin::Pin;
use std::time::Duration;

use n0_future::{Stream, StreamExt};
use nfx_proto::beacon::{Beacon, BeaconContent};
use nfx_proto::deletion::Deletion;
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::{Namespace, VideoAddr};
use nfx_proto::{KIND_BEACON, KIND_MANIFEST, Verified};
use nostr_sdk::prelude as ns;
use nostr_sdk::prelude::{AsyncGetPublicKey, AsyncSignEvent, FinalizeEventAsync as _};

use crate::{NodeError, Result, unix_now};

/// Beacon lifetime used by [`Relays::announce`]; republish every `BEACON_TTL / 2` (NFX-03 §3).
pub const BEACON_TTL: u64 = 120;

/// Most (seeder, manifest) entries a [`BeaconWatch`] holds. Keys are free to mint, so a
/// flood of valid beacons must not grow the table without bound: past the cap, the entry
/// closest to expiry is evicted.
pub const MAX_LIVE_BEACONS: usize = 4096;

/// Least time between re-sending a beacon subscription a relay closed.
pub const RESUBSCRIBE_EVERY: Duration = Duration::from_secs(5);

/// Sign an event with a nostr-sdk signer and return it in `nfx-proto` form.
async fn sign<S>(
    signer: &S,
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    created_at: u64,
) -> Result<Event>
where
    S: AsyncGetPublicKey + AsyncSignEvent,
{
    let tags = tags
        .into_iter()
        .map(ns::Tag::parse)
        .collect::<core::result::Result<Vec<_>, _>>()
        .map_err(NodeError::relay)?;
    let event = ns::EventBuilder::new(ns::Kind::from(kind), content)
        .tags(tags)
        .custom_created_at(ns::Timestamp::from(created_at))
        .finalize_async(signer)
        .await
        .map_err(NodeError::relay)?;
    from_nostr(&event)
}

pub(crate) fn from_nostr(event: &ns::Event) -> Result<Event> {
    let json = event.try_as_json().map_err(NodeError::relay)?;
    serde_json::from_str(&json).map_err(NodeError::relay)
}

fn to_nostr(event: &Event) -> Result<ns::Event> {
    let json = serde_json::to_string(event).map_err(NodeError::relay)?;
    ns::Event::from_json(json).map_err(NodeError::relay)
}

/// Sign `manifest` as a kind-38504 event. `manifest.author` and `manifest.created_at`
/// are ignored: they come from the signer and `created_at`. Returns the event and the
/// manifest as a reader will parse it.
pub async fn sign_manifest<S>(
    signer: &S,
    manifest: &Manifest,
    created_at: u64,
) -> Result<(Event, Verified<Manifest>)>
where
    S: AsyncGetPublicKey + AsyncSignEvent,
{
    let event = sign(
        signer,
        KIND_MANIFEST,
        manifest.tags(),
        manifest.description.clone(),
        created_at,
    )
    .await?;
    let parsed = Manifest::from_event(&event)?;
    let expected = Manifest {
        author: parsed.author.clone(),
        created_at,
        ..manifest.clone()
    };
    if *parsed != expected {
        return Err(NodeError::Relay(
            "signed manifest does not parse back to itself".into(),
        ));
    }
    Ok((event, parsed))
}

/// Sign a kind-20464 beacon serving `manifest_a` (a [`Manifest::a_tag`]).
pub async fn sign_beacon<S>(
    signer: &S,
    manifest_a: &str,
    content: &BeaconContent,
    created_at: u64,
    ttl: u64,
) -> Result<Event>
where
    S: AsyncGetPublicKey + AsyncSignEvent,
{
    let tags = nfx_proto::beacon::tags(manifest_a, created_at, ttl)?;
    let event = sign(signer, KIND_BEACON, tags, content.to_content(), created_at).await?;
    Beacon::from_event(&event, created_at)?;
    Ok(event)
}

/// Sign a NIP-09 deletion of `manifest_a_tags` (each a [`Manifest::a_tag`] of the
/// signer's own) and check it is a valid NFX deletion (NFX-02 §6).
pub async fn sign_deletion<S>(
    signer: &S,
    manifest_a_tags: &[String],
    created_at: u64,
) -> Result<Event>
where
    S: AsyncGetPublicKey + AsyncSignEvent,
{
    let event = sign(
        signer,
        nfx_proto::KIND_DELETION,
        nfx_proto::deletion::tags(manifest_a_tags),
        String::new(),
        created_at,
    )
    .await?;
    Deletion::from_event(&event)?;
    Ok(event)
}

/// Which manifests to fetch. Empty `authors` or `videos` means "any".
#[derive(Debug, Clone)]
pub struct ManifestQuery {
    pub namespace: Namespace,
    pub authors: Vec<String>,
    pub videos: Vec<VideoAddr>,
}

impl ManifestQuery {
    fn admits(&self, m: &Manifest) -> bool {
        m.addr.namespace() == &self.namespace
            && (self.authors.is_empty() || self.authors.contains(&m.author))
            && (self.videos.is_empty() || self.videos.contains(&m.addr))
    }
}

/// A set of Nostr relays.
pub struct Relays {
    client: ns::Client,
}

impl Relays {
    /// Add `urls` and connect, waiting at most `timeout` for the connections.
    pub async fn connect(urls: &[String], timeout: Duration) -> Result<Self> {
        let client = ns::Client::default();
        for url in urls {
            client
                .add_relay(url.as_str())
                .await
                .map_err(NodeError::relay)?;
        }
        client.connect().and_wait(timeout).await;
        Ok(Self { client })
    }

    /// How many relays are connected now.
    pub async fn connected(&self) -> usize {
        self.client
            .relays()
            .await
            .values()
            .filter(|r| r.status().is_connected())
            .count()
    }

    /// An error when no relay is connected: an empty answer must mean "none found", never
    /// "nobody was asked".
    async fn require_connected(&self) -> Result<()> {
        if self.connected().await == 0 {
            return Err(NodeError::Relay("no relay is connected".into()));
        }
        Ok(())
    }

    /// Send a signed event. Succeeds when at least one relay accepted it; returns how many did.
    pub async fn publish(&self, event: &Event) -> Result<usize> {
        let out = self
            .client
            .send_event(&to_nostr(event)?)
            .await
            .map_err(NodeError::relay)?;
        if out.success.is_empty() {
            return Err(NodeError::Relay(format!(
                "no relay accepted event {} ({} refused)",
                event.id,
                out.failed.len()
            )));
        }
        Ok(out.success.len())
    }

    /// Sign and publish a beacon for `manifest` now, with [`BEACON_TTL`].
    pub async fn announce<S>(
        &self,
        signer: &S,
        manifest: &Manifest,
        content: &BeaconContent,
    ) -> Result<usize>
    where
        S: AsyncGetPublicKey + AsyncSignEvent,
    {
        let event = sign_beacon(signer, &manifest.a_tag(), content, unix_now(), BEACON_TTL).await?;
        self.publish(&event).await
    }

    /// The current revision of every manifest matching `query` (NIP-01 addressable
    /// events: the highest `created_at` per author and `d`, ties to the lowest id).
    /// Events that fail NFX-02 or fall outside the query are dropped, whichever relay sent
    /// them.
    pub async fn manifests(
        &self,
        query: &ManifestQuery,
        timeout: Duration,
    ) -> Result<Vec<Verified<Manifest>>> {
        self.require_connected().await?;
        // A revision dated beyond the clock-skew window is ignored: it would outrank every
        // honest revision until real time caught up with it.
        let horizon = unix_now().saturating_add(nfx_proto::MAX_CLOCK_SKEW);
        let mut filter = ns::Filter::new()
            .kind(ns::Kind::from(KIND_MANIFEST))
            .custom_tag(n_tag(), query.namespace.to_string());
        if !query.authors.is_empty() {
            let authors = query
                .authors
                .iter()
                .map(|a| ns::PublicKey::parse(a))
                .collect::<core::result::Result<Vec<_>, _>>()
                .map_err(NodeError::relay)?;
            filter = filter.authors(authors);
        }
        if !query.videos.is_empty() {
            filter = filter.identifiers(query.videos.iter().map(ToString::to_string));
        }
        let events = self
            .client
            .fetch_events(filter)
            .timeout(timeout)
            .await
            .map_err(NodeError::relay)?;
        let mut newest: BTreeMap<(String, String), (u64, String, Verified<Manifest>)> =
            BTreeMap::new();
        for event in &events {
            let Ok(event) = from_nostr(event) else {
                continue;
            };
            let Ok(m) = Manifest::from_event(&event) else {
                continue;
            };
            if !query.admits(&m) || m.created_at > horizon {
                continue;
            }
            let key = (m.author.clone(), m.addr.to_string());
            let replace = newest.get(&key).is_none_or(|(at, id, _)| {
                (m.created_at, std::cmp::Reverse(&event.id)) > (*at, std::cmp::Reverse(id))
            });
            if replace {
                newest.insert(key, (m.created_at, event.id.clone(), m));
            }
        }
        let current: Vec<Verified<Manifest>> = newest.into_values().map(|(_, _, m)| m).collect();
        if current.is_empty() {
            return Ok(current);
        }
        // NFX-02 §6: a deletion by the author, at least as new as the revision, withdraws it.
        let named: Vec<&Manifest> = current.iter().map(|m| &**m).collect();
        let deletions = self.deletions(&named, timeout).await?;
        Ok(current
            .into_iter()
            .filter(|m| !deletions.iter().any(|d| d.deletes(m)))
            .collect())
    }

    /// Whether `manifest` has been withdrawn by a valid deletion from its author. Only an
    /// actual deletion counts: a relay that no longer holds the manifest (a restart) is not
    /// a deletion.
    pub async fn deleted(&self, manifest: &Manifest, timeout: Duration) -> Result<bool> {
        self.require_connected().await?;
        let deletions = self.deletions(&[manifest], timeout).await?;
        Ok(deletions.iter().any(|d| d.deletes(manifest)))
    }

    /// Valid NFX deletions by the authors of `manifests`, naming their addresses.
    async fn deletions(&self, manifests: &[&Manifest], timeout: Duration) -> Result<Vec<Deletion>> {
        let authors = manifests
            .iter()
            .map(|m| ns::PublicKey::parse(&m.author))
            .collect::<core::result::Result<Vec<_>, _>>()
            .map_err(NodeError::relay)?;
        let filter = ns::Filter::new()
            .kind(ns::Kind::from(nfx_proto::KIND_DELETION))
            .authors(authors)
            .custom_tags(
                ns::SingleLetterTag::LOWERCASE_A,
                manifests.iter().map(|m| m.a_tag()),
            );
        let events = self
            .client
            .fetch_events(filter)
            .timeout(timeout)
            .await
            .map_err(NodeError::relay)?;
        Ok(events
            .iter()
            .filter_map(|e| from_nostr(e).ok())
            .filter_map(|e| Deletion::from_event(&e).ok())
            .collect())
    }

    /// Subscribe to beacons for the manifests addressed by `manifest_a_tags` on `namespace`
    /// (NFX-03 §5).
    pub async fn watch_beacons(
        &self,
        namespace: &Namespace,
        manifest_a_tags: &[String],
    ) -> Result<BeaconWatch> {
        // An empty `#a` list is read as "match nothing" by some relays and "no constraint"
        // by others; refuse it rather than depend on which.
        if manifest_a_tags.is_empty() {
            return Err(NodeError::Relay("no manifests to watch".into()));
        }
        for a in manifest_a_tags {
            let (_, addr) = nfx_proto::beacon::parse_a_tag(a)?;
            if addr.namespace() != namespace {
                return Err(NodeError::Relay(format!("{a} is not on {namespace}")));
            }
        }
        self.require_connected().await?;
        let notifications = self.client.notifications();
        let filter = ns::Filter::new()
            .kind(ns::Kind::from(KIND_BEACON))
            .custom_tag(n_tag(), namespace.to_string())
            .custom_tags(
                ns::SingleLetterTag::LOWERCASE_A,
                manifest_a_tags.iter().cloned(),
            );
        let sub = self
            .client
            .subscribe(filter.clone())
            .await
            .map_err(NodeError::relay)?
            .value;
        Ok(BeaconWatch {
            client: self.client.clone(),
            filter,
            resubscribed_at: None,
            notifications,
            sub,
            wanted: manifest_a_tags.iter().cloned().collect(),
            live: BTreeMap::new(),
            rejected: 0,
        })
    }

    pub async fn shutdown(self) {
        self.client.shutdown().await;
    }
}

fn n_tag() -> ns::SingleLetterTag {
    ns::SingleLetterTag::LOWERCASE_N
}

/// A live beacon table fed by one subscription (NFX-03 §5).
pub struct BeaconWatch {
    client: ns::Client,
    filter: ns::Filter,
    /// When the subscription was last re-sent after a relay closed it.
    resubscribed_at: Option<tokio::time::Instant>,
    notifications: Pin<Box<dyn Stream<Item = ns::ClientNotification> + Send>>,
    sub: ns::SubscriptionId,
    wanted: BTreeSet<String>,
    /// Newest verified beacon per (seeder, manifest a-tag).
    live: LiveTable,
    /// Events that failed NFX-03 or named a manifest this watch did not ask for.
    pub rejected: u64,
}

impl BeaconWatch {
    /// The next beacon that verifies now and is newer than the one held for its seeder and
    /// manifest. Older duplicates (NFX-03 §2) are skipped silently; invalid or unrequested
    /// events are counted in [`BeaconWatch::rejected`]. `None` when the client shuts down.
    ///
    /// A relay that closes the subscription (a lagging reader, a restart) gets it again,
    /// at most once per [`RESUBSCRIBE_EVERY`]: nostr-sdk drops a subscription on most
    /// `CLOSED` reasons, and a silent watch would stop a fetcher from learning seeders.
    pub async fn next(&mut self) -> Option<Verified<Beacon>> {
        while let Some(notification) = self.notifications.next().await {
            let event = match notification {
                ns::ClientNotification::Event {
                    subscription_id,
                    event,
                    ..
                } if subscription_id == self.sub => event,
                ns::ClientNotification::Message { relay_url, message }
                    if matches!(
                        message.as_ref(),
                        ns::RelayMessage::Closed { subscription_id, .. }
                            if subscription_id.as_ref() == &self.sub
                    ) =>
                {
                    self.resubscribe(relay_url).await;
                    continue;
                }
                ns::ClientNotification::Shutdown => return None,
                _ => continue,
            };
            let beacon = from_nostr(&event)
                .ok()
                .and_then(|e| Beacon::from_event(&e, unix_now()).ok());
            let Some(beacon) = beacon else {
                self.rejected += 1;
                continue;
            };
            let a = format!(
                "{KIND_MANIFEST}:{}:{}",
                beacon.creator, beacon.content.video
            );
            if !self.wanted.contains(&a) {
                self.rejected += 1;
                continue;
            }
            let key = (beacon.seeder.clone(), a);
            if self
                .live
                .get(&key)
                .is_some_and(|held| held.created_at >= beacon.created_at)
            {
                continue;
            }
            insert_bounded(
                &mut self.live,
                key,
                beacon.clone(),
                |b| b.expiration,
                unix_now(),
                MAX_LIVE_BEACONS,
            );
            return Some(beacon);
        }
        None
    }

    async fn resubscribe(&mut self, relay: ns::RelayUrl) {
        if let Some(at) = self.resubscribed_at {
            tokio::time::sleep_until(at + RESUBSCRIBE_EVERY).await;
        }
        self.resubscribed_at = Some(tokio::time::Instant::now());
        // Best effort: if it fails, the next CLOSED (or a reconnect) tries again.
        let _ = self
            .client
            .subscribe(ns::ReqTarget::single(relay, [self.filter.clone()]))
            .with_id(self.sub.clone())
            .await;
    }

    /// Beacons not yet expired at `now`, newest per seeder and manifest. Expired ones are
    /// dropped from the table.
    pub fn live(&mut self, now: u64) -> Vec<&Verified<Beacon>> {
        self.live.retain(|_, b| now < b.expiration);
        self.live.values().collect()
    }
}

type LiveTable = BTreeMap<(String, String), Verified<Beacon>>;

/// Insert into a live table: drop what has expired at `now`, then, if a new key would
/// exceed `cap`, evict the entry closest to expiry.
fn insert_bounded<V>(
    live: &mut BTreeMap<(String, String), V>,
    key: (String, String),
    beacon: V,
    expiration: impl Fn(&V) -> u64,
    now: u64,
    cap: usize,
) {
    live.retain(|_, b| now < expiration(b));
    if !live.contains_key(&key) && live.len() >= cap {
        let soonest = live
            .iter()
            .min_by_key(|(_, b)| expiration(b))
            .map(|(k, _)| k.clone());
        if let Some(k) = soonest {
            live.remove(&k);
        }
    }
    live.insert(key, beacon);
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use nfx_proto::beacon::Chunks;

    use super::*;

    fn beacon(seeder: &str, expiration: u64) -> ((String, String), Beacon) {
        let video = VideoAddr::parse("nfx:mainnet:1:salt-flats-dusk").unwrap();
        let b = Beacon {
            seeder: seeder.into(),
            created_at: expiration - 120,
            expiration,
            creator: "c".into(),
            content: BeaconContent {
                v: 1,
                video,
                endpoints: vec![],
                skipped: vec![],
                chunks: Chunks::All,
                price_hint: 0,
                accepts_mints: vec![],
                free: true,
            },
        };
        ((seeder.into(), "a".into()), b)
    }

    #[test]
    fn the_live_table_prunes_expired_and_evicts_the_soonest_past_its_cap() {
        let mut live: BTreeMap<(String, String), Beacon> = BTreeMap::new();
        let expiry = |b: &Beacon| b.expiration;
        for (seeder, exp) in [("s1", 1_000), ("s2", 1_100)] {
            let (k, b) = beacon(seeder, exp);
            insert_bounded(&mut live, k, b, expiry, 900, 2);
        }
        // Full: a new seeder evicts s1, the entry closest to expiry.
        let (k, b) = beacon("s3", 1_200);
        insert_bounded(&mut live, k, b, expiry, 900, 2);
        let seeders: Vec<_> = live.keys().map(|(s, _)| s.as_str()).collect();
        assert_eq!(seeders, ["s2", "s3"]);
        // Replacing an existing key never evicts another.
        let (k, b) = beacon("s3", 1_300);
        insert_bounded(&mut live, k, b, expiry, 900, 2);
        assert_eq!(live.len(), 2);
        // Expired entries go first: at t=1_150, s2 has expired.
        let (k, b) = beacon("s4", 1_400);
        insert_bounded(&mut live, k, b, expiry, 1_150, 2);
        let seeders: Vec<_> = live.keys().map(|(s, _)| s.as_str()).collect();
        assert_eq!(seeders, ["s3", "s4"]);
    }
}
