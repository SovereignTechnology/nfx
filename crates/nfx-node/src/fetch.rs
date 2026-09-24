//! Fetching a video over iroh and re-anchoring every file to sha256 (NFX-05 §4, NFX-06 §2).
//!
//! iroh verifies BLAKE3 on the wire, which proves only that the bytes match the seeder's
//! own collection. The signed anchor is the hash list's sha256, so every member is checked
//! against it, by position, before anything reaches the store.

use std::time::Duration;

use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, Hash, HashAndFormat};
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;
use nfx_proto::sha256;

use crate::node::Node;
use crate::store::ContentStore;
use crate::video::{meta_members, rendition_members};
use crate::{NodeError, Result};

/// Upper bound for one collection transfer.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// What a manifest tells a fetcher (NFX-02): the anchor, the address and the file count.
#[derive(Debug, Clone)]
pub struct Anchor<'a> {
    pub root: &'a str,
    pub video: &'a VideoAddr,
    pub segs: u64,
}

impl Node {
    /// Fetch the `meta` collection and the named renditions into `dest`. Returns the
    /// verified hash list. On any mismatch nothing further is stored and the peer should
    /// be discarded ([`NodeError::Poisoned`]).
    pub async fn fetch(
        &self,
        anchor: &Anchor<'_>,
        meta: &BlobTicket,
        renditions: &[(String, BlobTicket)],
        dest: &dyn ContentStore,
    ) -> Result<HashList> {
        let members = self.fetch_seq(meta).await?;
        let first = members
            .first()
            .ok_or_else(|| NodeError::Collection("empty meta collection".into()))?;
        let list_bytes = self.checked_bytes(*first, anchor.root, "hash list").await?;
        let mut root = [0u8; 32];
        hex::decode_to_slice(anchor.root, &mut root)
            .map_err(|_| NodeError::Collection("root is not hex".into()))?;
        let list = HashList::verify(&list_bytes, &root, anchor.video, anchor.segs)?;

        let expected = meta_members(anchor.root, &list);
        if members.len() != expected.len() {
            return Err(NodeError::Collection(format!(
                "meta has {} members, hash list implies {}",
                members.len(),
                expected.len()
            )));
        }
        let mut meta_files = Vec::with_capacity(members.len());
        for (i, (hash, sha)) in members.iter().zip(&expected).enumerate() {
            meta_files.push((
                sha.clone(),
                self.checked_bytes(*hash, sha, &format!("meta member {i}"))
                    .await?,
            ));
        }
        for (sha, bytes) in &meta_files {
            if list.files.iter().any(|f| {
                &f.sha256 == sha
                    && matches!(
                        f.role,
                        nfx_proto::hashlist::Role::PlaylistMaster
                            | nfx_proto::hashlist::Role::Playlist
                    )
            }) {
                list.check_playlist(bytes)?;
            }
        }
        for (sha, bytes) in &meta_files {
            dest.put_verified(sha, bytes)?;
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
            let members = self.fetch_seq(ticket).await?;
            if members.len() != expected.len() {
                return Err(NodeError::Collection(format!(
                    "{id}: {} members, playlist implies {}",
                    members.len(),
                    expected.len()
                )));
            }
            let mut files = Vec::with_capacity(members.len());
            for (i, (hash, sha)) in members.iter().zip(&expected).enumerate() {
                files.push((
                    sha,
                    self.checked_bytes(*hash, sha, &format!("{id} member {i}"))
                        .await?,
                ));
            }
            for (sha, bytes) in files {
                dest.put_verified(sha, &bytes)?;
            }
        }
        Ok(list)
    }

    /// Download a HashSeq collection whole and return its member hashes.
    async fn fetch_seq(&self, ticket: &BlobTicket) -> Result<Vec<Hash>> {
        if ticket.format() != BlobFormat::HashSeq {
            return Err(NodeError::Collection(
                "ticket is not for a collection".into(),
            ));
        }
        let transfer = async {
            let conn = self
                .endpoint()
                .connect(ticket.addr().clone(), iroh_blobs::ALPN)
                .await
                .map_err(NodeError::transport)?;
            self.blobs()
                .remote()
                .fetch(conn, HashAndFormat::hash_seq(ticket.hash()))
                .await
                .map_err(NodeError::transport)?;
            let bytes = self
                .blobs()
                .get_bytes(ticket.hash())
                .await
                .map_err(NodeError::transport)?;
            let seq = HashSeq::try_from(bytes).map_err(NodeError::transport)?;
            Ok::<_, NodeError>(seq.iter().collect())
        };
        tokio::time::timeout(FETCH_TIMEOUT, transfer)
            .await
            .map_err(|_| NodeError::Transport("collection transfer timed out".into()))?
    }

    /// The member's bytes, only if they hash to `expected_sha`.
    async fn checked_bytes(&self, hash: Hash, expected_sha: &str, what: &str) -> Result<Vec<u8>> {
        let bytes = self
            .blobs()
            .get_bytes(hash)
            .await
            .map_err(NodeError::transport)?;
        let got = hex::encode(sha256(&bytes));
        if got != expected_sha {
            return Err(NodeError::Poisoned {
                what: what.to_owned(),
                expected: expected_sha.to_owned(),
                got,
            });
        }
        Ok(bytes.to_vec())
    }
}
