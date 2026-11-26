//! Seeding a verified video over iroh (NFX-05 §5, NFX-06 §2).

use std::collections::BTreeMap;

use iroh_blobs::api::TempTag;
use iroh_blobs::api::blobs::{AddBytesOptions, AddPathOptions, ImportMode};
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, Hash, HashAndFormat};
use nfx_proto::beacon::{Chunks, Endpoint as BeaconEndpoint};
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;

use crate::node::Node;
use crate::store::{ContentStore, is_sha256_name};
use crate::video::{check_held, held_files, meta_members, rendition_members};
use crate::{NodeError, Result};

/// The iroh-blobs tags of a seeded video's collections start with this: `meta`, then
/// `r/<rendition id>` for each held rendition.
#[must_use]
pub fn tag_prefix(root: &str) -> String {
    format!("nfx/{root}/")
}

/// Tickets for a seeded video: the `meta` collection and one per held rendition.
#[derive(Debug, Clone)]
pub struct Seeded {
    pub root: String,
    pub list: HashList,
    pub meta: BlobTicket,
    pub renditions: BTreeMap<String, BlobTicket>,
    /// How much of the hash list is held, for the beacon (NFX-03 §4): `All`, or the count of
    /// its files a holder of only some renditions holds.
    pub chunks: Chunks,
}

impl Seeded {
    /// Beacon `tickets`: rendition id → ticket string, plus `meta` (NFX-03 §4), as made
    /// when seeding started. [`Node::beacon_endpoint`] remakes them with the node's current
    /// address.
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
        self.seed_renditions(store, root, video, segs, None).await
    }

    /// [`Node::seed`], holding only the renditions `only` names (every one when `None`):
    /// the meta collection whole, every playlist included, and one collection per held
    /// rendition, so beacons carry a ticket for each held rendition and no other (NFX-06
    /// §2). Only what is announced must be in `store`. An id the hash list does not have is
    /// an error.
    pub async fn seed_renditions(
        &self,
        store: &dyn ContentStore,
        root: &str,
        video: &VideoAddr,
        segs: u64,
        only: Option<&[String]>,
    ) -> Result<Seeded> {
        let mut root_bytes = [0u8; 32];
        hex::decode_to_slice(root, &mut root_bytes)
            .map_err(|_| NodeError::Collection("root is not hex".into()))?;
        let list = HashList::verify(&store.get(root)?, &root_bytes, video, segs)?;
        if let Some(ids) = only {
            check_held(&list, ids)?;
        }

        // Members are held by temporary tags until their collection is tagged by name.
        let mut meta_members_held = Vec::new();
        for sha in meta_members(root, &list) {
            if sha != root {
                list.check_playlist_or_other(&store.get(&sha)?, &sha)?;
            }
            meta_members_held.push(self.import(store, &sha).await?);
        }
        let meta = self.ticket(
            self.add_seq(&meta_members_held, &format!("{}meta", tag_prefix(root)))
                .await?,
        );

        let mut renditions = BTreeMap::new();
        for r in &list.renditions {
            if only.is_some_and(|ids| !ids.contains(&r.id)) {
                continue;
            }
            let playlist = list
                .files
                .iter()
                .find(|f| f.name == r.playlist)
                .ok_or_else(|| NodeError::Collection(format!("no playlist for {}", r.id)))?;
            let members = rendition_members(&list, &store.get(&playlist.sha256)?)?;
            let mut held = Vec::with_capacity(members.len());
            for sha in &members {
                held.push(self.import(store, sha).await?);
            }
            let name = format!("{}r/{}", tag_prefix(root), r.id);
            renditions.insert(r.id.clone(), self.ticket(self.add_seq(&held, &name).await?));
        }
        let chunks = if renditions.len() == list.renditions.len() {
            Chunks::All
        } else {
            let held = held_files(&list, store, only)?;
            Chunks::Count(
                list.files
                    .iter()
                    .filter(|f| held.contains(&f.sha256))
                    .count() as u64,
            )
        };
        Ok(Seeded {
            root: root.to_owned(),
            list,
            meta,
            renditions,
            chunks,
        })
    }

    /// The NFX-03 iroh endpoint for a seeded video. Its tickets name the node's address
    /// as it is now ([`Node::addr`]), not as it was when seeding started: a relay reached
    /// later, or an address that changed, is in the next beacon.
    #[must_use]
    pub fn beacon_endpoint(&self, seeded: &Seeded) -> BeaconEndpoint {
        let addr = self.addr();
        let ticket = |t: &BlobTicket| BlobTicket::new(addr.clone(), t.hash(), t.format());
        let mut tickets: BTreeMap<String, String> = seeded
            .renditions
            .iter()
            .map(|(id, t)| (id.clone(), ticket(t).to_string()))
            .collect();
        tickets.insert("meta".into(), ticket(&seeded.meta).to_string());
        BeaconEndpoint::Iroh {
            node: self.id().to_string(),
            relay: addr
                .relay_urls()
                .next()
                .map(ToString::to_string)
                .unwrap_or_default(),
            addrs: addr.ip_addrs().map(ToString::to_string).collect(),
            tickets,
        }
    }

    /// Drop the tags that keep the video `root`'s collections in iroh-blobs ([`Node::seed`]
    /// names them after its root), so that the next garbage collection frees every blob no
    /// other tagged collection holds. Its files stay where they are: the NFX store is the
    /// caller's. Seeding it again tags it again. Returns how many tags were dropped.
    pub async fn unseed(&self, root: &str) -> Result<u64> {
        if !is_sha256_name(root) {
            return Err(NodeError::Collection(format!("not a root: {root:?}")));
        }
        self.blobs()
            .tags()
            .delete_prefix(tag_prefix(root))
            .await
            .map_err(NodeError::transport)
    }

    /// Import a verified store file into iroh-blobs: by reference when the store has a
    /// path (store files are content-addressed and never change), by copy otherwise. Only a
    /// temporary tag holds it: what keeps it is the named tag of a collection it is in, so
    /// [`Node::unseed`] can let it go.
    async fn import(&self, store: &dyn ContentStore, sha: &str) -> Result<TempTag> {
        let bytes = store.get(sha)?; // re-verifies against the name
        match store.path_of(sha) {
            Some(path) => {
                self.blobs()
                    .add_path_with_opts(AddPathOptions {
                        path,
                        format: BlobFormat::Raw,
                        mode: ImportMode::TryReference,
                    })
                    .temp_tag()
                    .await
            }
            None => self.blobs().add_bytes(bytes).temp_tag().await,
        }
        .map_err(NodeError::transport)
    }

    /// A collection of `members`, tagged `name`: seeding the same video again replaces the
    /// tag rather than adding one.
    async fn add_seq(&self, members: &[TempTag], name: &str) -> Result<Hash> {
        let seq: HashSeq = members.iter().map(TempTag::hash).collect();
        let held = self
            .blobs()
            .add_bytes_with_opts(AddBytesOptions {
                data: seq.into_inner(),
                format: BlobFormat::HashSeq,
            })
            .temp_tag()
            .await
            .map_err(NodeError::transport)?;
        self.blobs()
            .tags()
            .set(name, HashAndFormat::hash_seq(held.hash()))
            .await
            .map_err(NodeError::transport)?;
        Ok(held.hash())
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
