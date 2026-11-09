//! Fetching a video over iroh and re-anchoring every file to sha256 (NFX-05 §4, NFX-06 §2).
//!
//! iroh verifies BLAKE3 on the wire, which proves only that the bytes match the seeder's
//! own collection. The signed anchor is the hash list's sha256, so every member is checked
//! against it, by position, before it reaches the store.
//!
//! A lying beacon can waste time, not bytes (NFX-06 §2). Nothing is downloaded whole on
//! the seeder's say-so: the collection's HashSeq is fetched alone, capped at 32 bytes per
//! member the manifest or playlist allows, and each member is then fetched on its own,
//! capped at the size the verified hash list gives it. A member is stored as soon as it
//! verifies, so memory holds one file at a time.
//!
//! A transfer's deadline grows with its work, so a long video fetches over a slow relay, and
//! a member already in the store is not fetched again, so a failed transfer's retry resumes.

use std::collections::BTreeMap;
use std::time::Duration;

use bytes::Bytes;
use iroh::endpoint::Connection;
use iroh_blobs::api::proto::BlobStatus;
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::protocol::{ChunkRanges, ChunkRangesExt as _, GetRequest};
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, Hash, HashAndFormat};
use nfx_proto::hashlist::{FileEntry, HashList, Role};
use nfx_proto::namespace::VideoAddr;
use nfx_proto::sha256;

use crate::node::Node;
use crate::store::ContentStore;
use crate::video::{meta_members, rendition_members};
use crate::{NodeError, Result};

/// A transfer's deadline before the hash list is known: connecting, the meta collection's
/// HashSeq and the hash list (at most [`MAX_HASH_LIST_BYTES`]). The deadline then grows by
/// [`FETCH_PER_FILE`] and [`FETCH_FLOOR_RATE`] for each file it fetches ([`Node::fetch`]).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Added to a transfer's deadline for each file, once the hash list names it.
pub const FETCH_PER_FILE: Duration = Duration::from_secs(1);
/// Added to a transfer's deadline for each file's size at this rate, in bytes per second: a
/// quarter of the 4 MiB/s an iroh relay commonly allows one client.
pub const FETCH_FLOOR_RATE: u64 = 1 << 20;
/// Upper bound for one blob: a seeder that accepts and then stalls costs this, not more. It
/// also caps what one file adds to a transfer's deadline.
pub const MEMBER_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest hash list accepted before its sha256 is known (it names ~10^5 files).
pub const MAX_HASH_LIST_BYTES: u64 = 16 * 1024 * 1024;
/// BLAKE3 chunk size in iroh-blobs.
const CHUNK: u64 = 1024;

/// What bounds one transfer: [`Node::fetch`] uses the constants above; tests scale them down.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) base: Duration,
    pub(crate) per_file: Duration,
    pub(crate) floor_rate: u64,
    pub(crate) member: Duration,
    /// A pause before each blob is requested, standing in for a slow link (tests only; zero
    /// otherwise). It counts against the deadline like any other wait.
    pub(crate) pace: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            base: FETCH_TIMEOUT,
            per_file: FETCH_PER_FILE,
            floor_rate: FETCH_FLOOR_RATE,
            member: MEMBER_TIMEOUT,
            pace: Duration::ZERO,
        }
    }
}

/// One transfer's deadline, which grows as the hash list names the files to fetch.
struct Deadline {
    at: tokio::time::Instant,
    limits: Limits,
}

impl Deadline {
    fn start(limits: Limits) -> Self {
        Self {
            at: tokio::time::Instant::now() + limits.base,
            limits,
        }
    }

    /// Room for one more file of `size` bytes: [`Limits::per_file`] plus its size at
    /// [`Limits::floor_rate`], never more than one blob may take ([`Limits::member`]).
    fn add_file(&mut self, size: u64) {
        let millis = size.saturating_mul(1000) / self.limits.floor_rate.max(1);
        let room = self
            .limits
            .per_file
            .saturating_add(Duration::from_millis(millis))
            .min(self.limits.member);
        self.at = self.at.checked_add(room).unwrap_or(self.at);
    }

    /// The time left, or the transfer's error once there is none.
    fn left(&self) -> Result<Duration> {
        let left = self
            .at
            .saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err(timed_out());
        }
        Ok(left)
    }
}

fn timed_out() -> NodeError {
    NodeError::Transport("collection transfer timed out".into())
}

/// What a manifest tells a fetcher (NFX-02): the anchor, the address and the file count.
#[derive(Debug, Clone)]
pub struct Anchor<'a> {
    pub root: &'a str,
    pub video: &'a VideoAddr,
    pub segs: u64,
}

impl Node {
    /// Fetch the `meta` collection and the named renditions into `dest`. Returns the
    /// verified hash list. On a sha256 mismatch the peer is reported as
    /// [`NodeError::Poisoned`] and should be discarded; nothing unverified is stored.
    ///
    /// Files already in `dest` (each verified when it was stored) are not fetched again, so
    /// a retry after a failure goes on where the failed transfer stopped.
    ///
    /// The transfer has [`FETCH_TIMEOUT`] to connect and fetch the hash list. Then each file
    /// it fetches adds [`FETCH_PER_FILE`] plus its listed size at [`FETCH_FLOOR_RATE`] to the
    /// deadline, at most [`MEMBER_TIMEOUT`] a file, as the hash list and playlists name them.
    /// Worst case, a transfer of N files totalling B bytes is cut off 120 s + N × 1 s +
    /// B / 1 MiB/s after it began, and never later than 120 s + N × 30 s. For a video of 963
    /// files and 652 MiB that is about 29 minutes; the transfer needs about 163 s at an iroh
    /// relay's 4 MiB/s. Each blob must also arrive within [`MEMBER_TIMEOUT`]: a seeder that
    /// stalls is dropped after 30 s, and one that trickles at the deadline.
    pub async fn fetch(
        &self,
        anchor: &Anchor<'_>,
        meta: &BlobTicket,
        renditions: &[(String, BlobTicket)],
        dest: &dyn ContentStore,
    ) -> Result<HashList> {
        self.fetch_limited(anchor, meta, renditions, dest, Limits::default())
            .await
    }

    pub(crate) async fn fetch_limited(
        &self,
        anchor: &Anchor<'_>,
        meta: &BlobTicket,
        renditions: &[(String, BlobTicket)],
        dest: &dyn ContentStore,
        limits: Limits,
    ) -> Result<HashList> {
        let mut deadline = Deadline::start(limits);
        let conn = tokio::time::timeout(deadline.left()?, self.connect_ticket(meta))
            .await
            .map_err(|_| timed_out())??;
        // The meta collection has at most one member per file, plus the hash list.
        let members = self
            .fetch_seq(
                &conn,
                meta.hash(),
                anchor.segs.saturating_add(1),
                false,
                &deadline,
            )
            .await?;
        let first = *members
            .first()
            .ok_or_else(|| NodeError::Collection("empty meta collection".into()))?;
        let list_bytes = match stored(dest, anchor.root) {
            Some(bytes) => Bytes::from(bytes),
            None => {
                self.fetch_member(&conn, first, MAX_HASH_LIST_BYTES, &deadline)
                    .await?
            }
        };
        check_sha(&list_bytes, anchor.root, "hash list")?;
        let mut root = [0u8; 32];
        hex::decode_to_slice(anchor.root, &mut root)
            .map_err(|_| NodeError::Collection("root is not hex".into()))?;
        let list = HashList::verify(&list_bytes, &root, anchor.video, anchor.segs)?;
        let index: BTreeMap<&str, &FileEntry> =
            list.files.iter().map(|f| (f.sha256.as_str(), f)).collect();

        let expected = meta_members(anchor.root, &list);
        if members.len() != expected.len() {
            return Err(NodeError::Collection(format!(
                "meta has {} members, hash list implies {}",
                members.len(),
                expected.len()
            )));
        }
        dest.put_verified(anchor.root, &list_bytes)?;
        for sha in expected.iter().skip(1) {
            deadline.add_file(listed(&index, sha)?.size);
        }
        for (i, (hash, sha)) in members.iter().zip(&expected).enumerate().skip(1) {
            let entry = listed(&index, sha)?;
            let playlist = matches!(entry.role, Role::PlaylistMaster | Role::Playlist);
            // Held already (verified when stored): not fetched again. A playlist is read back
            // and checked against this hash list too; one that no longer verifies is fetched.
            if playlist {
                if let Some(bytes) = stored(dest, sha) {
                    list.check_playlist(&bytes)?;
                    continue;
                }
            } else if dest.has(sha) {
                continue;
            }
            let bytes = self
                .fetch_member(&conn, *hash, entry.size, &deadline)
                .await?;
            check_sha(&bytes, sha, &format!("meta member {i}"))?;
            if playlist {
                list.check_playlist(&bytes)?;
            }
            dest.put_verified(sha, &bytes)?;
        }

        for (id, ticket) in renditions {
            let rendition = list
                .renditions
                .iter()
                .find(|r| &r.id == id)
                .ok_or_else(|| NodeError::Collection(format!("no rendition {id:?}")))?;
            let playlist = list
                .files
                .iter()
                .find(|f| f.name == rendition.playlist)
                .ok_or_else(|| NodeError::Collection(format!("no playlist for {id}")))?;
            let expected = rendition_members(&list, &dest.get(&playlist.sha256)?)?;
            if expected.iter().all(|sha| dest.has(sha)) {
                continue; // held whole already
            }
            let conn = if ticket.addr().id == meta.addr().id {
                conn.clone()
            } else {
                tokio::time::timeout(deadline.left()?, self.connect_ticket(ticket))
                    .await
                    .map_err(|_| timed_out())??
            };
            for sha in &expected {
                deadline.add_file(listed(&index, sha)?.size);
            }
            let count = u64::try_from(expected.len()).map_err(NodeError::transport)?;
            let members = self
                .fetch_seq(&conn, ticket.hash(), count, true, &deadline)
                .await?;
            for (i, (hash, sha)) in members.iter().zip(&expected).enumerate() {
                if dest.has(sha) {
                    continue; // verified when it was stored
                }
                let size = listed(&index, sha)?.size;
                let bytes = self.fetch_member(&conn, *hash, size, &deadline).await?;
                check_sha(&bytes, sha, &format!("{id} member {i}"))?;
                dest.put_verified(sha, &bytes)?;
            }
        }
        Ok(list)
    }

    async fn connect_ticket(&self, ticket: &BlobTicket) -> Result<Connection> {
        if ticket.format() != BlobFormat::HashSeq {
            return Err(NodeError::Collection(
                "ticket is not for a collection".into(),
            ));
        }
        self.dial(ticket.addr(), iroh_blobs::ALPN).await
    }

    /// The members of a HashSeq, fetched alone and capped at `max_members` entries; with
    /// `exact`, the count must equal `max_members`.
    async fn fetch_seq(
        &self,
        conn: &Connection,
        hash: Hash,
        max_members: u64,
        exact: bool,
        deadline: &Deadline,
    ) -> Result<Vec<Hash>> {
        let bytes = self
            .fetch_member(conn, hash, max_members.saturating_mul(32), deadline)
            .await?;
        let seq = HashSeq::try_from(bytes).map_err(NodeError::transport)?;
        let members: Vec<Hash> = seq.iter().collect();
        if exact && u64::try_from(members.len()).ok() != Some(max_members) {
            return Err(NodeError::Collection(format!(
                "collection has {} members, expected {max_members}",
                members.len()
            )));
        }
        Ok(members)
    }

    /// One blob, downloading at most `cap` bytes of it: a blob larger than its hash-list
    /// size stays incomplete and is refused. A temp tag keeps it from garbage collection
    /// until it has been read; after that it is untagged and collected. It must arrive
    /// within the member limit and before the transfer's deadline, whichever is sooner.
    async fn fetch_member(
        &self,
        conn: &Connection,
        hash: Hash,
        cap: u64,
        deadline: &Deadline,
    ) -> Result<Bytes> {
        let _hold = self
            .blobs()
            .tags()
            .temp_tag(HashAndFormat::raw(hash))
            .await
            .map_err(NodeError::transport)?;
        let complete = |s: &BlobStatus| matches!(s, BlobStatus::Complete { size } if *size <= cap);
        let status = self
            .blobs()
            .status(hash)
            .await
            .map_err(NodeError::transport)?;
        if !complete(&status) {
            if !deadline.limits.pace.is_zero() {
                tokio::time::sleep(deadline.limits.pace).await;
            }
            let left = deadline.left()?;
            let wait = deadline.limits.member.min(left);
            let chunks = cap.div_ceil(CHUNK).max(1);
            let request = GetRequest::blob_ranges(hash, ChunkRanges::chunks(..chunks));
            tokio::time::timeout(
                wait,
                self.blobs().remote().execute_get(conn.clone(), request),
            )
            .await
            .map_err(|_| {
                if wait < deadline.limits.member {
                    timed_out()
                } else {
                    NodeError::Transport(format!("blob {hash} stalled"))
                }
            })?
            .map_err(NodeError::transport)?;
        }
        let status = self
            .blobs()
            .status(hash)
            .await
            .map_err(NodeError::transport)?;
        if !complete(&status) {
            return Err(NodeError::Collection(format!(
                "blob {hash} is larger than the {cap} bytes the hash list allows, or incomplete"
            )));
        }
        self.blobs()
            .get_bytes(hash)
            .await
            .map_err(NodeError::transport)
    }
}

/// A file `dest` holds and that still verifies, or `None`.
fn stored(dest: &dyn ContentStore, sha: &str) -> Option<Vec<u8>> {
    if dest.has(sha) {
        dest.get(sha).ok()
    } else {
        None
    }
}

fn listed<'a>(index: &BTreeMap<&str, &'a FileEntry>, sha: &str) -> Result<&'a FileEntry> {
    index
        .get(sha)
        .copied()
        .ok_or_else(|| NodeError::Collection(format!("{sha} is not listed")))
}

fn check_sha(bytes: &[u8], expected: &str, what: &str) -> Result<()> {
    let got = hex::encode(sha256(bytes));
    if got != expected {
        return Err(NodeError::Poisoned {
            what: what.to_owned(),
            expected: expected.to_owned(),
            got,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::net::{Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};

    use base64::Engine as _;
    use iroh::endpoint::presets;
    use iroh::protocol::{AcceptError, ProtocolHandler, Router};
    use iroh::{Endpoint, EndpointAddr, RelayMode, TransportAddr};
    use nfx_proto::Verified;
    use nfx_proto::event::Event;
    use nfx_proto::manifest::Manifest;
    use serde_json::Value;

    use super::*;
    use crate::node::NodeConfig;
    use crate::seed::Seeded;
    use crate::store::FsStore;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfx-fetch-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// The NFX test-vector video (`spec/test-vectors/`), written into a fresh store.
    fn vector(dir: &Path) -> (FsStore, Verified<Manifest>, HashList) {
        let m: Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
        let event: Event = serde_json::from_value(m["event"].clone()).unwrap();
        let manifest = Manifest::from_event(&event).unwrap();
        let hl: Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/hashlist.json")).unwrap();
        let list: HashList = serde_json::from_value(hl["hashlist"].clone()).unwrap();
        let store = FsStore::open(dir).unwrap();
        store.put(&list.render()).unwrap();
        for b64 in hl["fabricated"].as_object().unwrap().values() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64.as_str().unwrap())
                .unwrap();
            store.put(&bytes).unwrap();
        }
        for text in hl["playlists"].as_object().unwrap().values() {
            store.put(text.as_str().unwrap().as_bytes()).unwrap();
        }
        (store, manifest, list)
    }

    /// How a node on this host is dialled: its bound IPv4 socket, on loopback.
    fn on_loopback(endpoint: &Endpoint) -> EndpointAddr {
        let port = endpoint
            .bound_sockets()
            .iter()
            .find(|a| a.is_ipv4())
            .unwrap()
            .port();
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        EndpointAddr::from_parts(endpoint.id(), [TransportAddr::Ip(addr)])
    }

    /// A seeder of the test video with no relay, and its tickets as reached on loopback.
    async fn seeder(name: &str) -> (Node, Seeded, Verified<Manifest>, HashList) {
        let (store, manifest, list) = vector(&tmp(name));
        let node = Node::spawn(NodeConfig {
            no_portmapper: true,
            ..NodeConfig::default()
        })
        .await
        .unwrap();
        let mut seeded = node
            .seed(&store, &manifest.root_hex(), &manifest.addr, manifest.segs)
            .await
            .unwrap();
        let addr = on_loopback(node.endpoint());
        let local = |t: &BlobTicket| BlobTicket::new(addr.clone(), t.hash(), t.format());
        seeded.meta = local(&seeded.meta);
        for t in seeded.renditions.values_mut() {
            *t = local(t);
        }
        (node, seeded, manifest, list)
    }

    async fn fetcher() -> Node {
        Node::spawn(NodeConfig {
            no_portmapper: true,
            ..NodeConfig::default()
        })
        .await
        .unwrap()
    }

    /// Scaled down: a 3 s base plays the 120 s, and a 600 ms pause before each blob plays a
    /// slow relay. The whole transfer (10 blobs: two HashSeqs, the hash list and the 7
    /// files) takes over 6 s.
    fn slow(per_file: Duration) -> Limits {
        Limits {
            base: Duration::from_secs(3),
            per_file,
            floor_rate: u64::MAX,
            member: Duration::from_secs(10),
            pace: Duration::from_millis(600),
        }
    }

    async fn fetch_all(
        node: &Node,
        seeded: &Seeded,
        manifest: &Verified<Manifest>,
        dest: &FsStore,
        limits: Limits,
    ) -> Result<HashList> {
        let root = manifest.root_hex();
        let anchor = Anchor {
            root: &root,
            video: &manifest.addr,
            segs: manifest.segs,
        };
        let renditions: Vec<(String, BlobTicket)> = seeded
            .renditions
            .iter()
            .map(|(id, t)| (id.clone(), t.clone()))
            .collect();
        node.fetch_limited(&anchor, &seeded.meta, &renditions, dest, limits)
            .await
    }

    #[test]
    fn the_deadline_grows_per_file_by_size_and_never_more_than_a_blob_may_take() {
        let limits = Limits::default();
        let mut d = Deadline::start(limits);
        let start = d.at;
        d.add_file(0);
        assert_eq!(d.at - start, FETCH_PER_FILE);
        d.add_file(FETCH_FLOOR_RATE * 4); // 4 s at the floor rate, plus the second
        assert_eq!(d.at - start, FETCH_PER_FILE * 2 + Duration::from_secs(4));
        d.add_file(u64::MAX); // a hash list claiming a huge file buys one blob's time
        assert_eq!(
            d.at - start,
            FETCH_PER_FILE * 2 + Duration::from_secs(4) + MEMBER_TIMEOUT
        );
        // The 963-file, 652 MiB video that a fixed 120 s could not fetch at 4 MiB/s.
        let mut d = Deadline::start(limits);
        let start = d.at;
        for _ in 0..963 {
            d.add_file(652 * (1 << 20) / 963);
        }
        let budget = (d.at - start) + FETCH_TIMEOUT;
        let needed = Duration::from_secs(652 / 4);
        assert!(budget > needed * 5, "{budget:?}");
        assert!(budget < Duration::from_secs(1800), "{budget:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_transfer_slower_than_the_base_deadline_completes_and_a_fixed_cap_would_not() {
        let (seed, seeded, manifest, list) = seeder("slow-seed").await;
        // A fixed cap (no growth per file) cuts the slow transfer off.
        let node = fetcher().await;
        let dest = FsStore::open(tmp("slow-fixed")).unwrap();
        let err = fetch_all(&node, &seeded, &manifest, &dest, slow(Duration::ZERO))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err}");
        node.shutdown().await.unwrap();
        // Growing by 2 s a file (3 s + 7 × 2 s in all), it completes, every file verified.
        let node = fetcher().await;
        let dest = FsStore::open(tmp("slow-scaled")).unwrap();
        let started = tokio::time::Instant::now();
        let got = fetch_all(
            &node,
            &seeded,
            &manifest,
            &dest,
            slow(Duration::from_secs(2)),
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() > Duration::from_secs(3),
            "slower than the base"
        );
        assert_eq!(got, list);
        for f in &list.files {
            dest.get(&f.sha256).unwrap();
        }
        node.shutdown().await.unwrap();
        seed.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn retries_resume_from_what_is_stored_instead_of_starting_over() {
        let (seed, seeded, manifest, list) = seeder("resume-seed").await;
        let dest = FsStore::open(tmp("resume-dest")).unwrap();
        let held = |dest: &FsStore| list.files.iter().filter(|f| dest.has(&f.sha256)).count();
        // Each attempt has the fixed 3 s that cannot carry the whole slow transfer, and a
        // fresh node (nothing in its iroh-blobs). Starting over, none would ever finish;
        // resuming, each keeps what it verified and the next goes on from there.
        let mut attempts = 0;
        let mut before = held(&dest);
        loop {
            attempts += 1;
            assert!(
                attempts <= 8,
                "no progress: {before} of {} files",
                list.files.len()
            );
            let node = fetcher().await;
            let done = fetch_all(&node, &seeded, &manifest, &dest, slow(Duration::ZERO)).await;
            node.shutdown().await.unwrap();
            match done {
                Ok(got) => {
                    assert_eq!(got, list);
                    break;
                }
                Err(e) => {
                    assert!(e.to_string().contains("timed out"), "{e}");
                    let now = held(&dest);
                    assert!(now > before, "attempt {attempts} kept nothing");
                    before = now;
                }
            }
        }
        assert!(
            attempts > 1,
            "the transfer was meant to need several attempts"
        );
        for f in &list.files {
            dest.get(&f.sha256).unwrap();
        }
        seed.shutdown().await.unwrap();
    }

    /// A peer that takes the blobs connection and never answers.
    #[derive(Debug, Clone)]
    struct Silent;

    impl ProtocolHandler for Silent {
        async fn accept(
            &self,
            connection: iroh::endpoint::Connection,
        ) -> std::result::Result<(), AcceptError> {
            let _ = connection.closed().await;
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_seeder_that_stalls_is_cut_off_by_the_member_limit_not_the_deadline() {
        let (_, manifest, _) = vector(&tmp("stall-vector"));
        let endpoint = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await
            .unwrap();
        let addr = on_loopback(&endpoint);
        let silent = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, Silent)
            .spawn();
        let meta = BlobTicket::new(addr, Hash::new(b"anything"), BlobFormat::HashSeq);
        let node = fetcher().await;
        let dest = FsStore::open(tmp("stall-dest")).unwrap();
        let root = manifest.root_hex();
        let anchor = Anchor {
            root: &root,
            video: &manifest.addr,
            segs: manifest.segs,
        };
        let limits = Limits {
            base: Duration::from_secs(60),
            member: Duration::from_millis(500),
            pace: Duration::ZERO,
            ..Limits::default()
        };
        let started = tokio::time::Instant::now();
        let err = node
            .fetch_limited(&anchor, &meta, &[], &dest, limits)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("stalled"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cut off after {:?}",
            started.elapsed()
        );
        node.shutdown().await.unwrap();
        silent.shutdown().await.unwrap();
    }
}
