//! Spike S2 (ADR 0008, A1): does hls.js in the Tauri 2 webview play NFX-05 CMAF served
//! from the Rust store through an `nfx://` custom scheme?
//!
//! The Rust side is the NFX consumer: it verifies the hash list against its root at start,
//! and every file's sha256 before serving it (the Blossom rule, NFX-05 §4). The page
//! (`ui/index.html`) plays, seeks and switches renditions by itself, reports each step
//! over IPC (printed here as JSON lines), and ends the run with `done`.
//!
//! Env: `NFX_STORE` = a directory of `<sha256>` files with `../nfx.json` beside it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use nfx_proto::hashlist::{HashList, Role, verify_file};
use nfx_proto::namespace::VideoAddr;
use tauri::http::{Response, header};

struct Store {
    dir: PathBuf,
    root: String,
    list: HashList,
    served: AtomicU64,
    refused: AtomicU64,
}

fn load_store() -> Result<Store> {
    let dir = PathBuf::from(std::env::var("NFX_STORE").context("set NFX_STORE")?);
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(
        dir.parent()
            .context("store has no parent")?
            .join("nfx.json"),
    )?)?;
    let root = meta["root"].as_str().context("root")?.to_owned();
    let mut root_bytes = [0u8; 32];
    hex::decode_to_slice(&root, &mut root_bytes)?;
    let video = VideoAddr::parse(meta["video"].as_str().context("video")?)?;
    let segs = meta["segs"].as_u64().context("segs")?;
    let list = HashList::verify(&std::fs::read(dir.join(&root))?, &root_bytes, &video, segs)?;
    Ok(Store {
        dir,
        root,
        list,
        served: AtomicU64::new(0),
        refused: AtomicU64::new(0),
    })
}

fn content_type(role: Role) -> &'static str {
    match role {
        Role::PlaylistMaster | Role::Playlist => "application/vnd.apple.mpegurl",
        Role::Init => "video/mp4",
        Role::Segment => "video/iso.segment",
        Role::Thumb => "image/jpeg",
        Role::Subtitle => "text/vtt",
    }
}

/// NFX-05 §6 paths over `nfx://localhost`: `/<root>`, `/<root>/master.m3u8`,
/// `/<root>/<sha256>.<ext>`. Bytes are sha256-verified before they are served.
fn serve(store: &Store, path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        Response::builder()
            .status(404)
            .body(Vec::new())
            .expect("static response")
    };
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let (sha, ctype) = match parts.as_slice() {
        [root] if *root == store.root => (store.root.clone(), "application/json"),
        [root, "master.m3u8"] if *root == store.root => {
            match store
                .list
                .files
                .iter()
                .find(|f| f.role == Role::PlaylistMaster)
            {
                Some(f) => (f.sha256.clone(), content_type(f.role)),
                None => return not_found(),
            }
        }
        [root, name] if *root == store.root => match store.list.resolve(name) {
            Some(f) => (f.sha256.clone(), content_type(f.role)),
            None => return not_found(),
        },
        _ => return not_found(),
    };
    let Ok(bytes) = std::fs::read(store.dir.join(&sha)) else {
        return not_found();
    };
    if verify_file(&sha, &bytes).is_err() {
        store.refused.fetch_add(1, Ordering::Relaxed);
        return Response::builder()
            .status(502)
            .body(Vec::new())
            .expect("static response");
    }
    store.served.fetch_add(1, Ordering::Relaxed);
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .expect("static response")
}

#[tauri::command]
fn report(line: String) {
    println!("{line}");
}

#[tauri::command]
fn nfx_root(store: tauri::State<'_, &'static Store>) -> String {
    store.root.clone()
}

#[tauri::command]
fn done(app: tauri::AppHandle, store: tauri::State<'_, &'static Store>, ok: bool) {
    println!(
        "{}",
        serde_json::json!({
            "step": "store",
            "served": store.served.load(Ordering::Relaxed),
            "refused": store.refused.load(Ordering::Relaxed),
        })
    );
    println!("RESULT {}", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
}

fn main() -> Result<()> {
    let store: &'static Store = Box::leak(Box::new(load_store()?));
    println!(
        "{}",
        serde_json::json!({ "step": "store-verified", "root": store.root, "files": store.list.files.len() })
    );
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(90));
        println!("RESULT TIMEOUT");
        std::process::exit(2);
    });
    tauri::Builder::default()
        .manage(store)
        .register_uri_scheme_protocol("nfx", move |_ctx, request| {
            serve(store, request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![report, nfx_root, done])
        .run(tauri::generate_context!())
        .context("tauri runtime")?;
    Ok(())
}
