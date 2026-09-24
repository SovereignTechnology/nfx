//! A packaged video (`nfx-package` output: `<dir>/nfx.json` and `<dir>/store`) and the
//! open-mode manifest that announces it (NFX-02).

use std::path::Path;

use nfx_node::store::{ContentStore, FsStore};
use nfx_node::video::rendition_members;
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::manifest::{License, Manifest, Thumb};
use nfx_proto::namespace::VideoAddr;
use serde_json::Value;

use crate::{Error, Result};

/// A verified package.
pub struct Package {
    pub store: FsStore,
    pub root: [u8; 32],
    pub video: VideoAddr,
    pub segs: u64,
    pub list: HashList,
}

impl Package {
    /// Read `<dir>/nfx.json` and verify the hash list in `<dir>/store` against it.
    pub fn open(dir: &Path) -> Result<Self> {
        let meta: Value = serde_json::from_slice(&std::fs::read(dir.join("nfx.json"))?)
            .map_err(|e| Error::Config(format!("nfx.json: {e}")))?;
        let field = |k: &str| {
            meta.get(k)
                .ok_or_else(|| Error::Config(format!("nfx.json: missing {k}")))
        };
        let root_hex = field("root")?
            .as_str()
            .ok_or_else(|| Error::Config("nfx.json: root".into()))?;
        let mut root = [0u8; 32];
        hex::decode_to_slice(root_hex, &mut root)
            .map_err(|_| Error::Config("nfx.json: root is not 64 hex".into()))?;
        let video = VideoAddr::parse(
            field("video")?
                .as_str()
                .ok_or_else(|| Error::Config("nfx.json: video".into()))?,
        )?;
        let segs = field("segs")?
            .as_u64()
            .ok_or_else(|| Error::Config("nfx.json: segs".into()))?;
        let store = FsStore::open(dir.join("store"))?;
        let list = HashList::verify(&store.get(root_hex)?, &root, &video, segs)?;
        Ok(Self {
            store,
            root,
            video,
            segs,
            list,
        })
    }

    /// The open-mode, free manifest for this package. `author` and `created_at` are
    /// placeholders: signing sets them.
    pub fn manifest(
        &self,
        title: &str,
        description: &str,
        alt: Option<&str>,
        hashtags: &[String],
        published_at: u64,
    ) -> Result<Manifest> {
        let mut longest_ms = 0u64;
        for r in &self.list.renditions {
            let Some(playlist) = self.list.files.iter().find(|f| f.name == r.playlist) else {
                continue;
            };
            let members = rendition_members(&self.list, &self.store.get(&playlist.sha256)?)?;
            let ms: u64 = self
                .list
                .files
                .iter()
                .filter(|f| members.contains(&f.sha256))
                .filter_map(|f| f.dur_ms)
                .sum();
            longest_ms = longest_ms.max(ms);
        }
        let thumb = self
            .list
            .files
            .iter()
            .filter(|f| f.role == Role::Thumb)
            .find_map(|f| {
                let ext = f.name.rsplit_once('.')?.1;
                let mime = match ext {
                    "jpg" | "jpeg" => "image/jpeg",
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "avif" => "image/avif",
                    _ => return None,
                };
                Some(Thumb {
                    sha256: f.sha256.clone(),
                    mime: mime.into(),
                })
            });
        Ok(Manifest {
            author: String::new(),
            created_at: 0,
            addr: self.video.clone(),
            title: title.to_owned(),
            published_at,
            root: self.root,
            segs: self.segs,
            duration: (longest_ms > 0).then(|| longest_ms.div_ceil(1000)),
            thumb,
            price_hint: Some(0),
            license: License::Open,
            hashtags: hashtags.to_vec(),
            alt: alt.map(str::to_owned),
            description: description.to_owned(),
        })
    }
}
