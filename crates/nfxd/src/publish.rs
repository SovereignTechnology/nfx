//! Publishing a creator's video (NFX-02): what `nfxd publish` does, as functions, so a
//! running node can do the same over the relays it already holds.

use nfx_node::nostr::{Relays, sign_manifest};
use nfx_node::unix_now;
use nfx_proto::Verified;
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nostr_sdk::prelude::Keys;

use crate::Result;
use crate::package::Package;

/// What a creator says about a video when publishing it.
#[derive(Debug, Clone, Copy, Default)]
pub struct About<'a> {
    pub title: &'a str,
    pub description: &'a str,
    pub alt: Option<&'a str>,
    pub tags: &'a [String],
}

/// A manifest that at least one relay took.
#[derive(Debug, Clone)]
pub struct Published {
    /// The video's address, `38504:<creator>:<namespace>:<video-id>`.
    pub a: String,
    /// How many relays accepted the manifest.
    pub accepted: usize,
    pub manifest: Verified<Manifest>,
}

/// Sign the open-mode manifest of `package` with `keys`. Nothing is sent: a package or a
/// title that makes no valid manifest fails here, before any relay is asked.
pub async fn sign_package(
    keys: &Keys,
    package: &Package,
    about: About<'_>,
) -> Result<(Event, Verified<Manifest>)> {
    let now = unix_now();
    let manifest = package.manifest(about.title, about.description, about.alt, about.tags, now)?;
    Ok(sign_manifest(keys, &manifest, now).await?)
}

/// Sign the manifest of `package` and send it to `relays`. Fails when no relay accepts it.
pub async fn publish(
    relays: &Relays,
    keys: &Keys,
    package: &Package,
    about: About<'_>,
) -> Result<Published> {
    let (event, manifest) = sign_package(keys, package, about).await?;
    let accepted = relays.publish(&event).await?;
    Ok(Published {
        a: manifest.a_tag(),
        accepted,
        manifest,
    })
}
