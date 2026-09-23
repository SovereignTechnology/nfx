//! `nfx-verify-store <store-dir> <root-hex> <namespace:video-id> <segs>`
//!
//! Runs the NFX-05 consumer checks with `nfx-proto` over a directory of files named by
//! their sha256: the hash list against `root`, the Blossom rule on every listed file,
//! and the content-name rule on every playlist. Exit 0 only if everything holds.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use nfx_proto::hashlist::{HashList, Role, verify_file};
use nfx_proto::namespace::VideoAddr;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [store, root, video, segs] = args.as_slice() else {
        bail!("usage: nfx-verify-store <store-dir> <root-hex> <namespace:video-id> <segs>");
    };
    let store = PathBuf::from(store);
    let mut root_bytes = [0u8; 32];
    hex_decode(root, &mut root_bytes)?;
    let video = VideoAddr::parse(video)?;
    let segs: u64 = segs.parse()?;

    let list_bytes = std::fs::read(store.join(root)).context("hash list missing from store")?;
    let list = HashList::verify(&list_bytes, &root_bytes, &video, segs)?;
    println!("hash list: OK ({} files, {} renditions)", list.files.len(), list.renditions.len());

    let mut playlists = 0;
    for f in &list.files {
        let bytes = std::fs::read(store.join(&f.sha256)).with_context(|| format!("{} missing", f.name))?;
        verify_file(&f.sha256, &bytes).with_context(|| f.name.clone())?;
        if bytes.len() as u64 != f.size {
            bail!("{}: size {} != listed {}", f.name, bytes.len(), f.size);
        }
        if matches!(f.role, Role::PlaylistMaster | Role::Playlist) {
            list.check_playlist(&bytes).with_context(|| f.name.clone())?;
            playlists += 1;
        }
    }
    println!("files: all {} match their sha256 and size", list.files.len());
    println!("playlists: all {playlists} reference only listed content names");
    Ok(())
}

fn hex_decode(s: &str, out: &mut [u8; 32]) -> Result<()> {
    if s.len() != 64 || !s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        bail!("root must be 64 lowercase hex");
    }
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk)?, 16)?;
    }
    Ok(())
}
