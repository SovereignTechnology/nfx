//! Seeding a verified video over iroh (NFX-05 §5, NFX-06 §2).

use std::collections::BTreeMap;

use iroh_blobs::api::blobs::{AddBytesOptions, AddPathOptions, ImportMode};
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, Hash, HashAndFormat};
use nfx_proto::beacon::Endpoint as BeaconEndpoint;
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;

use crate::node::Node;
use crate::store::ContentStore;
use crate::video::{meta_members, rendition_members};
use crate::{NodeError, Result};

/// Tickets for a seeded video: the `meta` collection and one per rendition.
#[derive(Debug, Clone)]
pub struct Seeded {
    pub root: String,
    pub list: HashList,
    pub meta: BlobTicket,
    pub renditions: BTreeMap<String, BlobTicket>,
}

impl Seeded {
    /// Beacon `tickets`: rendition id → ticket string, plus `meta` (NFX-03 §4).
    #[must_use]
    pub fn tickets(&self) -> BTreeMap<String, String> {
        let mut out: BTreeMap<String, String> = self
            .renditions
            .iter()
            .map(|(k, t)| (k.clone(), t.to_string()))
            .collect();
        out.insert("meta".into(), self.meta.to_string());
        out
    }
}

impl Node {
    /// Seed the video whose hash list sits in `store` under `root`. Everything is verified
    /// first (NFX-05 §5): the hash list against `root`, the playlists against the
    /// content-name rule, and every file against its sha256.
    pub async fn seed(
        &self,
        store: &dyn ContentStore,
        root: &str,
        video: &VideoAddr,
        segs: u64,
    ) -> Result<Seeded> {
        let mut root_bytes = [0u8; 32];
        hex::decode_to_slice(root, &mut root_bytes)
            .map_err(|_| NodeError::Collection("root is not hex".into()))?;
        let list = HashList::verify(&store.get(root)?, &root_bytes, video, segs)?;

        let mut meta_hashes = Vec::new();
        for sha in meta_members(root, &list) {
            if sha != root {
                list.check_playlist_or_other(&store.get(&sha)?, &sha)?;
            }
            meta_hashes.push(self.import(store, &sha).await?);
        }
        let meta = self.ticket(self.add_seq(&meta_hashes).await?);

        let mut renditions = BTreeMap::new();
        for r in &list.renditions {
            let playlist = list
                .files
                .iter()
                .find(|f| f.name == r.playlist)
                .ok_or_else(|| NodeError::Collection(format!("no playlist for {}", r.id)))?;
            let members = rendition_members(&list, &store.get(&playlist.sha256)?)?;
            let mut hashes = Vec::with_capacity(members.len());
            for sha in &members {
                hashes.push(self.import(store, sha).await?);
            }
            renditions.insert(r.id.clone(), self.ticket(self.add_seq(&hashes).await?));
        }
        Ok(Seeded {
            root: root.to_owned(),
            list,
            meta,
            renditions,
        })
    }

    /// The NFX-03 iroh endpoint for a seeded video.
    #[must_use]
    pub fn beacon_endpoint(&self, seeded: &Seeded) -> BeaconEndpoint {
        let addr = self.addr();
        BeaconEndpoint::Iroh {
            node: self.id().to_string(),
            relay: addr
                .relay_urls()
                .next()
                .map(ToString::to_string)
                .unwrap_or_default(),
            addrs: addr.ip_addrs().map(ToString::to_string).collect(),
            tickets: seeded.tickets(),
        }
    }

    /// Import a verified store file into iroh-blobs: by reference when the store has a
    /// path (store files are content-addressed and never change), by copy otherwise.
    async fn import(&self, store: &dyn ContentStore, sha: &str) -> Result<Hash> {
        let bytes = store.get(sha)?; // re-verifies against the name
        let tag = match store.path_of(sha) {
            Some(path) => {
                self.blobs()
                    .add_path_with_opts(AddPathOptions {
                        path,
                        format: BlobFormat::Raw,
                        mode: ImportMode::TryReference,
                    })
                    .await
            }
            None => self.blobs().add_bytes(bytes).await,
        }
        .map_err(NodeError::transport)?;
        Ok(tag.hash)
    }

    async fn add_seq(&self, members: &[Hash]) -> Result<Hash> {
        let seq: HashSeq = members.iter().copied().collect();
        let tag = self
            .blobs()
            .add_bytes_with_opts(AddBytesOptions {
                data: seq.into_inner(),
                format: BlobFormat::HashSeq,
            })
            .await
            .map_err(NodeError::transport)?;
        self.blobs()
            .tags()
            .create(HashAndFormat::hash_seq(tag.hash))
            .await
            .map_err(NodeError::transport)?;
        Ok(tag.hash)
    }

    fn ticket(&self, hash: Hash) -> BlobTicket {
        BlobTicket::new(self.addr(), hash, BlobFormat::HashSeq)
    }
}

/// Meta members are playlists (content-name checked) or thumbs/subtitles (sha only).
trait MetaCheck {
    fn check_playlist_or_other(&self, bytes: &[u8], sha: &str) -> Result<()>;
}

impl MetaCheck for HashList {
    fn check_playlist_or_other(&self, bytes: &[u8], sha: &str) -> Result<()> {
        use nfx_proto::hashlist::Role;
        match self.files.iter().find(|f| f.sha256 == sha).map(|f| f.role) {
            Some(Role::PlaylistMaster | Role::Playlist) => Ok(self.check_playlist(bytes)?),
            Some(_) => Ok(()),
            None => Err(NodeError::Collection(format!("{sha} is not listed"))),
        }
    }
}
