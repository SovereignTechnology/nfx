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

/// Upper bound for one collection transfer.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound for one blob: a seeder that accepts and then stalls costs this, not more.
pub const MEMBER_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest hash list accepted before its sha256 is known (it names ~10^5 files).
pub const MAX_HASH_LIST_BYTES: u64 = 16 * 1024 * 1024;
/// BLAKE3 chunk size in iroh-blobs.
const CHUNK: u64 = 1024;

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
    pub async fn fetch(
        &self,
        anchor: &Anchor<'_>,
        meta: &BlobTicket,
        renditions: &[(String, BlobTicket)],
        dest: &dyn ContentStore,
    ) -> Result<HashList> {
        tokio::time::timeout(
            FETCH_TIMEOUT,
            self.fetch_inner(anchor, meta, renditions, dest),
        )
        .await
        .map_err(|_| NodeError::Transport("collection transfer timed out".into()))?
    }

    async fn fetch_inner(
        &self,
        anchor: &Anchor<'_>,
        meta: &BlobTicket,
        renditions: &[(String, BlobTicket)],
        dest: &dyn ContentStore,
    ) -> Result<HashList> {
        let conn = self.connect_ticket(meta).await?;
        // The meta collection has at most one member per file, plus the hash list.
        let members = self
            .fetch_seq(&conn, meta.hash(), anchor.segs.saturating_add(1), false)
            .await?;
        let first = *members
            .first()
            .ok_or_else(|| NodeError::Collection("empty meta collection".into()))?;
        let list_bytes = self.fetch_member(&conn, first, MAX_HASH_LIST_BYTES).await?;
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
        for (i, (hash, sha)) in members.iter().zip(&expected).enumerate().skip(1) {
            let entry = listed(&index, sha)?;
            let bytes = self.fetch_member(&conn, *hash, entry.size).await?;
            check_sha(&bytes, sha, &format!("meta member {i}"))?;
            if matches!(entry.role, Role::PlaylistMaster | Role::Playlist) {
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
            let conn = if ticket.addr().id == meta.addr().id {
                conn.clone()
            } else {
                self.connect_ticket(ticket).await?
            };
            let count = u64::try_from(expected.len()).map_err(NodeError::transport)?;
            let members = self.fetch_seq(&conn, ticket.hash(), count, true).await?;
            for (i, (hash, sha)) in members.iter().zip(&expected).enumerate() {
                let size = listed(&index, sha)?.size;
                let bytes = self.fetch_member(&conn, *hash, size).await?;
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
    ) -> Result<Vec<Hash>> {
        let bytes = self
            .fetch_member(conn, hash, max_members.saturating_mul(32))
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
    /// until it has been read; after that it is untagged and collected.
    async fn fetch_member(&self, conn: &Connection, hash: Hash, cap: u64) -> Result<Bytes> {
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
            let chunks = cap.div_ceil(CHUNK).max(1);
            let request = GetRequest::blob_ranges(hash, ChunkRanges::chunks(..chunks));
            tokio::time::timeout(
                MEMBER_TIMEOUT,
                self.blobs().remote().execute_get(conn.clone(), request),
            )
            .await
            .map_err(|_| NodeError::Transport(format!("blob {hash} stalled")))?
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
