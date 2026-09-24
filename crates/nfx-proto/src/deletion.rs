//! NFX-02 §6 deletions: NIP-09 kind-5 requests that withdraw the author's own manifests.

use crate::beacon::parse_a_tag;
use crate::event::Event;
use crate::manifest::Manifest;
use crate::namespace::VideoAddr;
use crate::{Error, KIND_DELETION, KIND_MANIFEST, Result};

/// A deletion that is valid for NFX (NFX-02 §6).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deletion {
    pub author: String,
    pub created_at: u64,
    /// The manifest addresses withdrawn, all the author's own.
    pub addresses: Vec<VideoAddr>,
}

impl Deletion {
    /// Verify a kind-5 event against NFX-02 §6: a valid signature, at least one `a` tag,
    /// every `a` a kind-38504 address of the author's own, and no `e` tag.
    pub fn from_event(event: &Event) -> Result<Self> {
        if event.kind != KIND_DELETION {
            return Err(bad("a deletion is kind 5"));
        }
        event.verify()?;
        if event.tag_values("e").next().is_some() {
            return Err(bad("manifests are addressed; an `e` tag is not allowed"));
        }
        let mut addresses = Vec::new();
        for values in event.tag_values("a") {
            let a = values.first().ok_or_else(|| bad("empty `a` tag"))?;
            let (author, addr) =
                parse_a_tag(a).map_err(|_| bad("`a` is not a kind-38504 address"))?;
            if author != event.pubkey {
                return Err(bad("every `a` must be the deletion author's own address"));
            }
            addresses.push(addr);
        }
        if addresses.is_empty() {
            return Err(bad("at least one `a` tag is required"));
        }
        Ok(Self {
            author: event.pubkey.clone(),
            created_at: event.created_at,
            addresses,
        })
    }

    /// Whether this deletion withdraws `manifest`: same author, one of its addresses, and
    /// at least as new as that revision (NIP-09). A later revision republishes the video.
    #[must_use]
    pub fn deletes(&self, manifest: &Manifest) -> bool {
        self.author == manifest.author
            && self.created_at >= manifest.created_at
            && self.addresses.contains(&manifest.addr)
    }
}

/// The tags of a deletion withdrawing `manifest_a_tags` (each a [`Manifest::a_tag`]).
#[must_use]
pub fn tags(manifest_a_tags: &[String]) -> Vec<Vec<String>> {
    let mut tags: Vec<Vec<String>> = manifest_a_tags
        .iter()
        .map(|a| vec!["a".to_owned(), a.clone()])
        .collect();
    tags.push(vec!["k".to_owned(), KIND_MANIFEST.to_string()]);
    tags
}

fn bad(reason: &str) -> Error {
    Error::Deletion(reason.to_owned())
}
