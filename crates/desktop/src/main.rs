//! The NFX desktop viewer (ADR 0008): `nfxd`'s [`Daemon`] behind a Tauri 2 window.
//!
//! - **Resolve and fetch**: a manifest address (`a` tag) is resolved over the configured
//!   scoped relays; seeders come from verified beacons; bytes arrive over iroh and are
//!   re-anchored to sha256 before they are stored (NFX-05 §4, NFX-06 §2).
//! - **Play**: the page's hls.js reads `nfx://localhost/<root>/…` (Windows and Android:
//!   `http://nfx.localhost/…`), served by the daemon's internal origin. The origin
//!   re-verifies every file on read and pulls misses from the swarm, so playback starts
//!   before the whole video is here.
//! - **Give back, if you choose to**: with "share" on, a watched video is fetched whole and
//!   seeded (a free M1 peer). Sharing announces each video publicly, signed with this
//!   node's key and with this computer's addresses, so it is **off by default**; without
//!   it the app announces nothing and never asks the router to open a port.
//!
//! - **Seeder ratings, if you choose to** (NFX-16, read-only): with the user's npub and at
//!   least one general relay set, the node reads the user's follow and mute lists and the
//!   ratings of those they follow, and tries well-rated seeders first. Ratings only order
//!   pulls; they never exclude a seeder, and the app publishes nothing. Reading one's own
//!   lists tells those relays that this computer's address goes with that key, so it is
//!   **off by default**. Keys are taken as npubs only: 64 hex digits would let a pasted
//!   secret key pass for a public one.
//!
//! State lives in the app data directory: `node.key` (the node's Nostr key, mode 0600,
//! never printed), `settings.json` (relays, share, ratings), and `store/` (content by
//! sha256).
//!
//! Test mode (`NFX_DESKTOP_TEST` = `{"a", "relays", "iroh_relays", "share", "rating_root",
//! "general_relays"}` JSON, optional `NFX_DESKTOP_DATA` = data directory): the page plays
//! that address by itself, reports each step on stdout as JSON lines and exits with
//! `RESULT PASS|FAIL`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use http_body_util::BodyExt as _;
use nfxd::daemon::{Config, Daemon, VideoState};
use nfxd::key;
use serde::{Deserialize, Serialize};
use tauri::http::{Method, Response, StatusCode};
use tauri::{Manager, State};
use tokio::sync::RwLock;

/// How long a watch waits for a seeder (beacons republish every 60 s, NFX-03 §3).
const WATCH_TIMEOUT: Duration = Duration::from_secs(150);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Settings {
    /// Nostr scoped relays (NFX-04), `ws://` or `wss://`.
    relays: Vec<String>,
    /// The network's iroh relays (NFX-06 §1).
    iroh_relays: Vec<String>,
    /// Seed what is watched (see the module docs). Off unless the user turns it on.
    #[serde(default)]
    share: bool,
    /// Seeder ratings (NFX-16): the user's key, as 64 hex digits. Unset: ratings are off.
    #[serde(default)]
    rating_root: Option<String>,
    /// More authors whose ratings count, as 64 hex digits.
    #[serde(default)]
    rating_trusted: Vec<String>,
    /// General Nostr relays the user's lists and the ratings are read from.
    #[serde(default)]
    general_relays: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TestConfig {
    a: String,
    relays: Vec<String>,
    #[serde(default)]
    iroh_relays: Vec<String>,
    #[serde(default)]
    share: bool,
    /// An npub, or empty.
    #[serde(default)]
    rating_root: String,
    #[serde(default)]
    general_relays: Vec<String>,
}

struct AppState {
    dir: PathBuf,
    pubkey: String,
    /// Held as `Arc` so a call (a watch can take 150 s) never holds the lock while it waits.
    daemon: RwLock<Option<Arc<Daemon>>>,
    settings: RwLock<Settings>,
    test: Option<TestConfig>,
}

impl AppState {
    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    async fn start(&self, settings: &Settings) -> Result<Arc<Daemon>, String> {
        let keys = key::load(&self.dir.join("node.key")).map_err(|e| e.to_string())?;
        let iroh_relays = parse_iroh_relays(settings)?;
        Daemon::start(Config {
            keys: Some(keys),
            store: self.dir.join("store"),
            relays: settings.relays.clone(),
            iroh_relays,
            internal_origin: true,
            seed_watched: settings.share,
            // A viewer that shares nothing needs no inbound port.
            no_portmapper: !settings.share,
            rating_root: settings.rating_root.clone(),
            rating_trusted: settings.rating_trusted.clone(),
            general_relays: settings.general_relays.clone(),
            ..Config::default()
        })
        .await
        .map(Arc::new)
        .map_err(|e| e.to_string())
    }

    /// The running daemon, without holding the lock.
    async fn daemon(&self) -> Option<Arc<Daemon>> {
        self.daemon.read().await.clone()
    }

    /// NFX-05 §6 through the daemon's origin: verified bytes, misses pulled from the swarm.
    async fn serve(&self, method: &Method, path: &str) -> Response<Vec<u8>> {
        let origin = self.daemon().await.and_then(|d| d.origin());
        let Some(origin) = origin else {
            return plain(StatusCode::SERVICE_UNAVAILABLE, "no node running");
        };
        let (parts, body) = origin.respond(method, path).await.into_parts();
        let bytes = body
            .collect()
            .await
            .map(|c| c.to_bytes().to_vec())
            .unwrap_or_default();
        Response::from_parts(parts, bytes)
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    let mut r = Response::new(text.as_bytes().to_vec());
    *r.status_mut() = status;
    r
}

fn relay_ok(u: &str) -> bool {
    u.starts_with("wss://") || u.starts_with("ws://")
}

fn parse_iroh_relays(settings: &Settings) -> Result<Vec<iroh::RelayUrl>, String> {
    settings
        .iroh_relays
        .iter()
        .map(|u| u.parse().map_err(|_| format!("not an iroh relay URL: {u}")))
        .collect()
}

/// A key typed into the page, as 64 hex digits. Only an npub is taken (a `nostr:` prefix
/// is fine): bare hex would let a pasted secret key pass for a public one. The refusal
/// never repeats the input.
fn npub_hex(what: &str, v: &str) -> Result<String, String> {
    let hex = key::public_hex(v).map_err(|why| format!("{what}: {why}"))?;
    let v = v.trim();
    if !v.strip_prefix("nostr:").unwrap_or(v).starts_with("npub1") {
        return Err(format!("{what}: give an npub (npub1…)"));
    }
    Ok(hex)
}

/// The settings the page asked for, trimmed and checked. Nothing here touches the running
/// node, so a bad setting leaves it alone.
fn checked(
    relays: Vec<String>,
    iroh_relays: Vec<String>,
    share: bool,
    rating_root: &str,
    rating_trusted: Vec<String>,
    general_relays: Vec<String>,
) -> Result<Settings, String> {
    let trim = |v: Vec<String>| -> Vec<String> {
        v.into_iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let new = Settings {
        relays: trim(relays),
        iroh_relays: trim(iroh_relays),
        share,
        rating_root: match rating_root.trim() {
            "" => None,
            v => Some(npub_hex("your npub", v)?),
        },
        rating_trusted: trim(rating_trusted)
            .iter()
            .enumerate()
            .map(|(i, v)| npub_hex(&format!("trusted key {}", i + 1), v))
            .collect::<Result<_, _>>()?,
        general_relays: trim(general_relays),
    };
    if let Some(bad) = new.relays.iter().find(|u| !relay_ok(u)) {
        return Err(format!("a relay must be ws:// or wss://: {bad}"));
    }
    if let Some(bad) = new.general_relays.iter().find(|u| !relay_ok(u)) {
        return Err(format!("a general relay must be ws:// or wss://: {bad}"));
    }
    // The daemon refuses the same combinations; said here in the page's words.
    let rating = new.rating_root.is_some();
    if !rating && !new.rating_trusted.is_empty() {
        return Err("trusted keys need your npub too".into());
    }
    if rating && new.general_relays.is_empty() {
        return Err("seeder ratings need at least one general relay".into());
    }
    if !rating && !new.general_relays.is_empty() {
        return Err(
            "general relays are only read for seeder ratings: add your npub or clear them".into(),
        );
    }
    parse_iroh_relays(&new)?;
    Ok(new)
}

/// The app's own pages: `tauri://localhost` (Linux, macOS) or `http://tauri.localhost`
/// (Windows). `nfx://` serves media to them and is never a page to navigate to: a document
/// there would be a local origin with IPC.
fn app_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

#[derive(Serialize)]
struct SettingsView {
    relays: Vec<String>,
    iroh_relays: Vec<String>,
    share: bool,
    /// The user's npub, or empty.
    rating_root: String,
    rating_trusted: Vec<String>,
    general_relays: Vec<String>,
    pubkey: String,
}

#[tauri::command]
async fn settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let s = state.settings.read().await.clone();
    let npub = |hex: &String| key::npub(hex).unwrap_or_else(|| hex.clone());
    Ok(SettingsView {
        relays: s.relays,
        iroh_relays: s.iroh_relays,
        share: s.share,
        rating_root: s.rating_root.as_ref().map(npub).unwrap_or_default(),
        rating_trusted: s.rating_trusted.iter().map(npub).collect(),
        general_relays: s.general_relays,
        pubkey: state.pubkey.clone(),
    })
}

#[tauri::command]
async fn save_settings(
    state: State<'_, AppState>,
    relays: Vec<String>,
    iroh_relays: Vec<String>,
    share: bool,
    rating_root: String,
    rating_trusted: Vec<String>,
    general_relays: Vec<String>,
) -> Result<(), String> {
    // Checked before anything stops: a bad setting leaves the running node alone.
    let new = checked(
        relays,
        iroh_relays,
        share,
        &rating_root,
        rating_trusted,
        general_relays,
    )?;
    // Both nodes would open one store; stop the old one first. `shutdown` releases the
    // store even while a pending watch still holds the old daemon.
    let mut daemon = state.daemon.write().await;
    if let Some(old) = daemon.take() {
        old.shutdown().await;
    }
    match state.start(&new).await {
        Ok(d) => *daemon = Some(d),
        Err(e) => {
            // Back to the old settings rather than no node at all.
            let old = state.settings.read().await.clone();
            *daemon = state.start(&old).await.ok();
            return Err(e);
        }
    }
    let json = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
    std::fs::write(state.settings_path(), json).map_err(|e| e.to_string())?;
    *state.settings.write().await = new;
    Ok(())
}

#[derive(Serialize)]
struct Watched {
    a: String,
    root: String,
    title: String,
    video: String,
}

#[tauri::command]
async fn watch(state: State<'_, AppState>, a: String) -> Result<Watched, String> {
    let daemon = state
        .daemon()
        .await
        .ok_or("no node running; set relays first")?;
    let m = daemon
        .watch(a.trim(), WATCH_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Watched {
        a: m.a_tag(),
        root: m.root_hex(),
        title: m.title.clone(),
        video: m.addr.to_string(),
    })
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    Ok(state
        .daemon()
        .await
        .map(|d| {
            d.state()
                .into_iter()
                .map(|(a, s)| {
                    let s = match s {
                        VideoState::Unannounced(why) => format!("seeding (unannounced: {why})"),
                        VideoState::Failed(why) => format!("failed: {why}"),
                        other => format!("{other:?}").to_lowercase(),
                    };
                    (a, s)
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
fn test_config(state: State<'_, AppState>) -> Option<TestConfig> {
    state.test.clone()
}

/// Test mode only: a line of the e2e's report.
#[tauri::command]
fn report(state: State<'_, AppState>, line: String) -> Result<(), String> {
    if state.test.is_none() {
        return Err("not in test mode".into());
    }
    println!("{line}");
    Ok(())
}

/// Test mode only: the e2e's verdict, then exit.
#[tauri::command]
fn done(app: tauri::AppHandle, state: State<'_, AppState>, ok: bool) -> Result<(), String> {
    if state.test.is_none() {
        return Err("not in test mode".into());
    }
    println!("RESULT {}", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

fn load_settings(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn main() {
    let test: Option<TestConfig> = std::env::var("NFX_DESKTOP_TEST")
        .ok()
        .map(|j| serde_json::from_str(&j).expect("NFX_DESKTOP_TEST is JSON"));
    if test.is_some() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(240));
            println!("RESULT TIMEOUT");
            std::process::exit(2);
        });
    }
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("nav-guard")
                .on_navigation(|_, url| app_page(url))
                .build(),
        )
        .setup(move |app| {
            let dir = match std::env::var_os("NFX_DESKTOP_DATA") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let key_path = dir.join("node.key");
            let pubkey = if key_path.exists() {
                key::load(&key_path)?.public_key().to_hex()
            } else {
                key::create(&key_path)?.public_key().to_hex()
            };
            let mut settings = load_settings(&dir.join("settings.json"));
            if let Some(t) = &test {
                settings = checked(
                    t.relays.clone(),
                    t.iroh_relays.clone(),
                    t.share,
                    &t.rating_root,
                    Vec::new(),
                    t.general_relays.clone(),
                )?;
            }
            let state = AppState {
                dir,
                pubkey,
                daemon: RwLock::new(None),
                settings: RwLock::new(settings.clone()),
                test: test.clone(),
            };
            if !settings.relays.is_empty() {
                let daemon = tauri::async_runtime::block_on(state.start(&settings))?;
                *tauri::async_runtime::block_on(state.daemon.write()) = Some(daemon);
            }
            app.manage(state);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("nfx", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let method = request.method().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                responder.respond(state.serve(&method, &path).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            settings,
            save_settings,
            watch,
            status,
            test_config,
            report,
            done
        ])
        .run(tauri::generate_context!())
        .expect("tauri runtime");
}

#[cfg(test)]
mod tests {
    use super::checked;

    /// NIP-19's example key.
    const NPUB: &str = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
    const HEX: &str = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

    fn rating(root: &str, trusted: &[&str], general: &[&str]) -> Result<super::Settings, String> {
        let v = |x: &[&str]| x.iter().map(|s| (*s).to_owned()).collect();
        checked(
            vec!["wss://scoped.example".into()],
            Vec::new(),
            false,
            root,
            v(trusted),
            v(general),
        )
    }

    #[test]
    fn ratings_are_off_by_default_and_keys_come_out_as_hex() {
        let s = rating("", &[], &[]).unwrap();
        assert_eq!(s.rating_root, None);
        assert!(s.rating_trusted.is_empty() && s.general_relays.is_empty());

        let nostr = format!("nostr:{NPUB}");
        let padded = format!(" {NPUB} ");
        let s = rating(&padded, &[&nostr, "  "], &[" wss://general.example ", ""]).unwrap();
        assert_eq!(s.rating_root.as_deref(), Some(HEX));
        assert_eq!(s.rating_trusted, [HEX]);
        assert_eq!(s.general_relays, ["wss://general.example"]);

        // An old settings.json, from before ratings, still loads with them off.
        let old: super::Settings =
            serde_json::from_str(r#"{"relays":["wss://a"],"iroh_relays":[],"share":true}"#)
                .unwrap();
        assert_eq!(old.rating_root, None);
    }

    #[test]
    fn settings_that_cannot_work_or_that_hold_a_secret_are_refused() {
        let g = ["wss://general.example"];
        // A pasted secret key, as an nsec or as bare hex, is never taken and never repeated.
        let nsec = format!("nsec1{}", "q".repeat(58));
        for (root, trusted, general, want) in [
            (nsec.as_str(), &[][..], &g[..], "secret key"),
            (HEX, &[][..], &g[..], "your npub: give an npub"),
            (NPUB, &[HEX][..], &g[..], "trusted key 1: give an npub"),
            ("npub1nope", &[][..], &g[..], "not an npub"),
            ("", &[NPUB][..], &[][..], "need your npub"),
            (NPUB, &[][..], &[][..], "at least one general relay"),
            ("", &[][..], &g[..], "only read for seeder ratings"),
            (
                NPUB,
                &[][..],
                &["https://general.example"][..],
                "ws:// or wss://",
            ),
        ] {
            let err = rating(root, trusted, general).unwrap_err();
            assert!(
                err.contains(want),
                "{root:?} {trusted:?} {general:?}: {err}"
            );
            assert!(!err.contains(&nsec[5..]) && !err.contains(HEX), "{err}");
        }
    }
}
