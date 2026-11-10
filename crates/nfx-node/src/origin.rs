//! An NFX-05 §6 origin: hash-addressed HTTP serving over the content store, optionally
//! pulling misses through from the swarm (§6.2).
//!
//! The origin serves only files listed in hash lists it holds, and it holds a hash list
//! only after verifying it against a manifest's `root` (§6.2: it is not an open proxy for
//! arbitrary sha256 values). Every response body is read through
//! [`ContentStore::get`], which re-checks the bytes against their name. Nothing
//! unverified reaches a client, even from a store that rotted on disk. Behind a CDN, one
//! bad response would otherwise be cached for a year under `immutable`.
//!
//! TLS is terminated in front of this server (a CDN or reverse proxy); it speaks HTTP/1.1.
//! Connections are capped ([`crate::limit`]) and live at most [`CONNECTION_LIFETIME`];
//! a request that waits on the swarm gives up after [`PULL_DEADLINE`].

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use iroh_blobs::ticket::BlobTicket;
use nfx_proto::Verified;
use nfx_proto::beacon::{Beacon, Endpoint};
use nfx_proto::gossip::Presence;
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::manifest::Manifest;
use tokio::net::TcpListener;

use crate::fetch::Anchor;
use crate::limit::ConnLimits;
use crate::node::Node;
use crate::store::ContentStore;
use crate::video::{check_held, held_files, meta_members, rendition_members};
use crate::{NodeError, Result, unix_now};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `Cache-Control` for a hash-addressed hit (§6.1).
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Slow-loris bound: a client must finish its request headers within this.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// A connection is closed after this, whatever it is doing; clients reconnect.
pub const CONNECTION_LIFETIME: Duration = Duration::from_secs(300);
/// How long one request waits on a pull before answering 504 (`no-store`).
pub const PULL_DEADLINE: Duration = Duration::from_secs(60);
/// Most seeders remembered per video.
pub const MAX_SOURCES_PER_VIDEO: usize = 16;
/// Of those, at most this many heard only over gossip: announcing costs a swarm member
/// nothing, so gossip never fills the table.
pub const MAX_GOSSIP_SOURCES_PER_VIDEO: usize = 8;
/// A source that failed, or whose attempt was cut short, is tried last for this long.
pub const SOURCE_COOLDOWN_SECS: u64 = 300;

/// Thumb MIME types the origin will put in `Content-Type`. The manifest's `thumb` MIME is
/// creator-controlled; anything else is served as `application/octet-stream`, so a "thumb"
/// can never be served as HTML from the origin's domain.
const THUMB_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/avif"];

/// Fills the store on a miss (§6.2). An implementation fetches as an ordinary watcher and
/// must leave only verified files in the store ([`ContentStore::put_verified`]).
pub trait Pull: Send + Sync {
    /// Bring `sha` (a file of `manifest`'s video, or its hash list) into `store`.
    fn pull<'a>(
        &'a self,
        manifest: &'a Manifest,
        sha: &'a str,
        store: &'a dyn ContentStore,
    ) -> BoxFuture<'a, Result<()>>;
}

struct Video {
    manifest: Manifest,
    /// sha256 → Content-Type, as this video's hash list types the file.
    types: BTreeMap<String, &'static str>,
    master: Option<String>,
}

#[derive(Default)]
struct Index {
    /// root → video.
    videos: BTreeMap<String, Video>,
    /// sha256 → the first held root whose hash list names it.
    files: BTreeMap<String, String>,
}

pub struct Origin {
    store: Arc<dyn ContentStore>,
    pull: Option<Arc<dyn Pull>>,
    index: RwLock<Index>,
    /// One pull at a time per video: concurrent misses wait, then find the file stored.
    flights: tokio::sync::Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Origin {
    /// An origin over `store`. With `pull`, misses are fetched from the swarm (§6.2).
    #[must_use]
    pub fn new(store: Arc<dyn ContentStore>, pull: Option<Arc<dyn Pull>>) -> Self {
        Self {
            store,
            pull,
            index: RwLock::new(Index::default()),
            flights: tokio::sync::Mutex::new(BTreeMap::new()),
        }
    }

    /// Serve `manifest`'s video; the type proves it passed NFX-02 §4. Its hash list is
    /// taken from the store, or pulled, and verified against `root`.
    pub async fn hold(&self, manifest: &Verified<Manifest>) -> Result<()> {
        self.hold_renditions(manifest, None).await
    }

    /// [`Origin::hold`], serving of the renditions only those `only` names (every one when
    /// `None`): the hash list and every file of the meta collection (every playlist, the
    /// master included), and the inits and segments of the held renditions. Another
    /// rendition's init or segment is not listed here, so it is answered `404` and never
    /// pulled. A held rendition's playlist missing from the store is pulled first, to read
    /// which files are the rendition's. An id the hash list does not have is an error.
    pub async fn hold_renditions(
        &self,
        manifest: &Verified<Manifest>,
        only: Option<&[String]>,
    ) -> Result<()> {
        let root = manifest.root_hex();
        if !self.store.has(&root) {
            self.pull_into_store(manifest, &root).await?;
        }
        let list = HashList::verify_for(&self.store.get(&root)?, manifest)?;
        let served = match only {
            None => None,
            Some(ids) => {
                check_held(&list, ids)?;
                for r in list.renditions.iter().filter(|r| ids.contains(&r.id)) {
                    if let Some(playlist) = list.files.iter().find(|f| f.name == r.playlist)
                        && !self.store.has(&playlist.sha256)
                    {
                        self.pull_into_store(manifest, &playlist.sha256).await?;
                    }
                }
                Some(held_files(&list, &*self.store, Some(ids))?)
            }
        };
        let serves = |sha: &str| served.as_ref().is_none_or(|s| s.contains(sha));
        let types = list
            .files
            .iter()
            .filter(|f| serves(&f.sha256))
            .map(|f| (f.sha256.clone(), content_type(f.role, &f.sha256, manifest)))
            .collect();
        let master = list
            .files
            .iter()
            .find(|f| f.role == Role::PlaylistMaster)
            .map(|f| f.sha256.clone());
        let mut index = self.index.write().unwrap_or_else(PoisonError::into_inner);
        for f in list.files.iter().filter(|f| serves(&f.sha256)) {
            index
                .files
                .entry(f.sha256.clone())
                .or_insert_with(|| root.clone());
        }
        index.videos.insert(
            root,
            Video {
                manifest: Manifest::clone(manifest),
                types,
                master,
            },
        );
        Ok(())
    }

    /// Answer one request (§6). `target` is the request's path and query. A query string
    /// is refused: each variant would be a separate year-long CDN object, and the CDN
    /// would stop shielding the origin.
    pub async fn respond(&self, method: &Method, target: &str) -> Response<Full<Bytes>> {
        let head = match *method {
            Method::GET => false,
            Method::HEAD => true,
            Method::OPTIONS => return preflight(),
            _ => return error(StatusCode::METHOD_NOT_ALLOWED, "GET or HEAD", false),
        };
        if target.contains('?') {
            return error(StatusCode::BAD_REQUEST, "no query strings", head);
        }
        let path = target;
        let Some(rest) = path.strip_prefix('/') else {
            return error(StatusCode::NOT_FOUND, "no route", head);
        };
        let parts: Vec<&str> = rest.split('/').collect();
        let target = match parts.as_slice() {
            [name] => content_name(name).and_then(|sha| self.lookup(sha, None)),
            [root, "master.m3u8"] => self.master(root),
            [root, name] => content_name(name).and_then(|sha| self.lookup(sha, Some(root))),
            _ => None,
        };
        let Some((sha, content_type, manifest)) = target else {
            return error(StatusCode::NOT_FOUND, "not listed here", head);
        };
        // A stored file that no longer verifies is never served: drop it and pull again.
        if self.store.has(&sha) && self.store.get(&sha).is_err() {
            let _ = self.store.remove(&sha);
        }
        if !self.store.has(&sha) {
            // The cause stays inside: a client learns only that the file is not here yet.
            match tokio::time::timeout(PULL_DEADLINE, self.pull_into_store(&manifest, &sha)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return error(StatusCode::BAD_GATEWAY, "not available yet", head),
                Err(_) => return error(StatusCode::GATEWAY_TIMEOUT, "not available yet", head),
            }
        }
        match self.store.get(&sha) {
            Ok(bytes) => hit(&sha, bytes, content_type, head),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "store miss", head),
        }
    }

    /// (sha, Content-Type, manifest) for a listed file, or a held root's hash list. Under
    /// `/<root>/…` the file is typed as that root's hash list types it.
    fn lookup(&self, sha: &str, root: Option<&str>) -> Option<(String, &'static str, Manifest)> {
        let index = self.index.read().unwrap_or_else(PoisonError::into_inner);
        if root.is_none()
            && let Some(v) = index.videos.get(sha)
        {
            return Some((sha.to_owned(), "application/json", v.manifest.clone()));
        }
        let video = match root {
            Some(root) => index.videos.get(root)?,
            None => index.videos.get(index.files.get(sha)?)?,
        };
        let content_type = video.types.get(sha)?;
        Some((sha.to_owned(), content_type, video.manifest.clone()))
    }

    fn master(&self, root: &str) -> Option<(String, &'static str, Manifest)> {
        let index = self.index.read().unwrap_or_else(PoisonError::into_inner);
        let v = index.videos.get(root)?;
        let sha = v.master.clone()?;
        let content_type = v.types.get(&sha)?;
        Some((sha, content_type, v.manifest.clone()))
    }

    async fn pull_into_store(&self, manifest: &Manifest, sha: &str) -> Result<()> {
        let Some(pull) = &self.pull else {
            return Err(NodeError::Collection("not in store".into()));
        };
        let flight = {
            let mut flights = self.flights.lock().await;
            flights.entry(manifest.root_hex()).or_default().clone()
        };
        let _guard = flight.lock().await;
        if self.store.has(sha) {
            return Ok(());
        }
        pull.pull(manifest, sha, &*self.store).await?;
        if self.store.has(sha) {
            Ok(())
        } else {
            Err(NodeError::Collection(format!("pull did not produce {sha}")))
        }
    }
}

/// `<sha256>` or `<sha256>.<ext>`; the extension is ignored for lookup (§6).
fn content_name(name: &str) -> Option<&str> {
    let (sha, ext) = match name.split_once('.') {
        Some((sha, ext)) => (sha, Some(ext)),
        None => (name, None),
    };
    let ext_ok = ext.is_none_or(|e| {
        (1..=16).contains(&e.len())
            && e.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    });
    let sha_ok = sha.len() == 64 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    (ext_ok && sha_ok).then_some(sha)
}

fn content_type(role: Role, sha: &str, manifest: &Manifest) -> &'static str {
    match role {
        Role::PlaylistMaster | Role::Playlist => "application/vnd.apple.mpegurl",
        Role::Init => "video/mp4",
        Role::Segment => "video/iso.segment",
        Role::Subtitle => "text/vtt; charset=utf-8",
        Role::Thumb => manifest
            .thumb
            .as_ref()
            .filter(|t| t.sha256 == sha)
            .and_then(|t| THUMB_TYPES.iter().find(|m| **m == t.mime))
            .copied()
            .unwrap_or("application/octet-stream"),
    }
}

/// Headers every response carries: CORS for the browser mesh, and no sniffing or
/// rendering of stored bytes as a document on the origin's domain.
fn base(
    status: StatusCode,
    content_type: &'static str,
    cache: &'static str,
) -> hyper::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, HeaderValue::from_static(content_type))
        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
        .header(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        )
        .header(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        )
        .header(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; sandbox"),
        )
}

fn finish(
    builder: hyper::http::response::Builder,
    body: Bytes,
    head: bool,
) -> Response<Full<Bytes>> {
    let len = body.len();
    let body = if head { Bytes::new() } else { body };
    builder
        .header(header::CONTENT_LENGTH, len)
        .body(Full::new(body))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::new())))
}

/// The extension a download of this type is saved under. A URL's extension is ignored for
/// lookup (§6), so `<sha>.exe` fetches a segment; this keeps the saved name honest.
fn extension(content_type: &str) -> &'static str {
    match content_type {
        "application/vnd.apple.mpegurl" => "m3u8",
        "video/mp4" => "mp4",
        "video/iso.segment" => "m4s",
        "text/vtt; charset=utf-8" => "vtt",
        "application/json" => "json",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/avif" => "avif",
        _ => "bin",
    }
}

fn hit(sha: &str, bytes: Vec<u8>, content_type: &'static str, head: bool) -> Response<Full<Bytes>> {
    let disposition = format!("inline; filename=\"{sha}.{}\"", extension(content_type));
    let builder = base(StatusCode::OK, content_type, IMMUTABLE).header(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("inline")),
    );
    finish(builder, bytes.into(), head)
}

/// Errors are not content (§6.1): `no-store`.
fn error(status: StatusCode, why: &str, head: bool) -> Response<Full<Bytes>> {
    let mut builder = base(status, "text/plain; charset=utf-8", "no-store");
    if status == StatusCode::METHOD_NOT_ALLOWED {
        builder = builder.header(
            header::ALLOW,
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        );
    }
    finish(builder, Bytes::from(format!("{why}\n")), head)
}

fn preflight() -> Response<Full<Bytes>> {
    let builder = base(
        StatusCode::NO_CONTENT,
        "text/plain; charset=utf-8",
        "no-store",
    )
    .header(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD"),
    )
    .header(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    finish(builder, Bytes::new(), true)
}

/// Serve `origin` on `listener` until the task is dropped, with the default connection
/// caps. HTTP/1.1, no TLS.
pub async fn serve(origin: Arc<Origin>, listener: TcpListener) {
    serve_with_limits(origin, listener, Arc::new(ConnLimits::default())).await;
}

/// [`serve`] with explicit connection caps.
pub async fn serve_with_limits(
    origin: Arc<Origin>,
    listener: TcpListener,
    limits: Arc<ConnLimits>,
) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            // Out of file descriptors and the like: back off rather than spin.
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Some(guard) = limits.admit(peer) else {
            continue; // over a cap: the socket is dropped
        };
        let origin = origin.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let service = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                let origin = origin.clone();
                async move {
                    let target = req.uri().path_and_query().map_or("/", |p| p.as_str());
                    Ok::<_, Infallible>(origin.respond(req.method(), target).await)
                }
            });
            let conn = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_READ_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service);
            let _ = tokio::time::timeout(CONNECTION_LIFETIME, conn).await;
        });
    }
}

/// One seeder's iroh tickets, valid until its beacon expires.
#[derive(Debug, Clone)]
struct Source {
    seeder: String,
    /// The network (NFX-01) of the video this source serves; ratings are per network.
    namespace: String,
    created_at: u64,
    expiration: u64,
    /// Rendition id, or `meta` → ticket.
    tickets: BTreeMap<String, String>,
    /// Tried last until this time (unix seconds); 0 when the last attempt succeeded.
    cooldown_until: u64,
    /// Heard only over gossip, never in a relay's beacon.
    gossip: bool,
}

/// Sort sources into the order they are tried at `now`:
/// 1. not on cooldown first, the rest by when their cooldown ends, so no score rescues a
///    seeder that is failing now (NFX-16 §4, rank 1);
/// 2. a relay's source before one heard only over gossip;
/// 3. the higher trusted score for the source's namespace, an unrated seeder counting 0
///    (NFX-16 §4, rank 4);
/// 4. the order learned (the sort is stable).
fn rank(live: &mut [Source], scores: &BTreeMap<String, BTreeMap<String, i64>>, now: u64) {
    live.sort_by_key(|s| {
        let cooling = if s.cooldown_until > now {
            s.cooldown_until
        } else {
            0
        };
        let score = scores
            .get(&s.namespace)
            .and_then(|m| m.get(&s.seeder))
            .copied()
            .unwrap_or(0);
        (cooling, s.gossip, std::cmp::Reverse(score))
    });
}

/// A [`Pull`] over iroh: the tickets come from verified beacons ([`SwarmPull::learn`]).
///
/// - Sources lapse when their beacon expires (NFX-03: a seeder stops announcing by
///   stopping). At most [`MAX_SOURCES_PER_VIDEO`] are kept per video.
/// - Before each attempt a source is put on cooldown, which success clears. A source
///   that fails, stalls into a deadline, or is cut short by a cancelled request is
///   therefore tried after every other one for [`SOURCE_COOLDOWN_SECS`]. A staller
///   costs one attempt, not one per request.
/// - A source that serves bytes the hash list does not name is forgotten
///   ([`NodeError::Poisoned`]).
/// - A source heard only over gossip ([`SwarmPull::learn_gossip`]) is evicted first and
///   never displaces one from a relay's beacon. A swarm member can announce under any
///   number of fresh keys at no cost, while relays budget beacons (NFX-04 §2).
/// - Within those buckets, a seeder with a higher trusted score
///   ([`SwarmPull::set_scores`], NFX-16 §4) is tried first; an unrated seeder counts 0.
///   A score never lifts a seeder out of cooldown: it never rescues one failing now.
pub struct SwarmPull {
    node: Arc<Node>,
    /// manifest a-tag → sources, in the order learned.
    sources: RwLock<BTreeMap<String, Vec<Source>>>,
    /// namespace → seeder (hex) → trusted score (NFX-16 §4).
    scores: RwLock<BTreeMap<String, BTreeMap<String, i64>>>,
}

impl SwarmPull {
    #[must_use]
    pub fn new(node: Arc<Node>) -> Self {
        Self {
            node,
            sources: RwLock::new(BTreeMap::new()),
            scores: RwLock::new(BTreeMap::new()),
        }
    }

    /// Replace the trusted scores (NFX-16 §4) for one namespace: seeder pubkey (hex) →
    /// score. Seeders absent from the map count 0. These only order the sources this
    /// node tries; nothing a seeder sees depends on them (ADR 0104 §6.4).
    pub fn set_scores(&self, namespace: &str, scores: BTreeMap<String, i64>) {
        let mut all = self.scores.write().unwrap_or_else(PoisonError::into_inner);
        if scores.is_empty() {
            all.remove(namespace);
        } else {
            all.insert(namespace.to_string(), scores);
        }
    }

    /// The namespaces of every video this node holds a source for.
    #[must_use]
    pub fn namespaces(&self) -> std::collections::BTreeSet<String> {
        self.sources
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .flatten()
            .map(|s| s.namespace.clone())
            .collect()
    }

    /// Record the iroh tickets of a verified beacon from a relay ([`Beacon::from_event`]).
    /// A newer beacon from the same seeder replaces its entry in place; an older one is
    /// ignored.
    pub fn learn(&self, beacon: &Verified<Beacon>) {
        self.learn_as(beacon, false);
    }

    /// Record a seeder heard over the video's gossip swarm (a `here` envelope's
    /// `presence_for`). Ranked below relay beacons: see [`SwarmPull`].
    pub fn learn_gossip(&self, presence: &Verified<Presence>) {
        self.learn_as(&presence.beacon, true);
    }

    /// A seeder said `bye` on the swarm: forget it, unless a relay's beacon vouches for it
    /// (that source lapses with its beacon).
    pub fn forget_gossip(&self, manifest_a: &str, seeder: &str) {
        let mut sources = self.sources.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(list) = sources.get_mut(manifest_a) {
            list.retain(|s| !(s.gossip && s.seeder == seeder));
        }
    }

    fn learn_as(&self, beacon: &Beacon, gossip: bool) {
        let a = format!(
            "{}:{}:{}",
            nfx_proto::KIND_MANIFEST,
            beacon.creator,
            beacon.content.video
        );
        let tickets: BTreeMap<String, String> = beacon
            .content
            .endpoints
            .iter()
            .filter_map(|e| match e {
                Endpoint::Iroh { node, tickets, .. } if tickets_name(node, tickets) => {
                    Some(tickets.clone())
                }
                _ => None,
            })
            .flatten()
            .collect();
        if !tickets.contains_key("meta") {
            return;
        }
        let now = unix_now();
        let mut sources = self.sources.write().unwrap_or_else(PoisonError::into_inner);
        let list = sources.entry(a).or_default();
        list.retain(|s| now < s.expiration);
        if let Some(held) = list.iter_mut().find(|s| s.seeder == beacon.seeder) {
            held.gossip &= gossip; // a relay's beacon vouches for it from now on
            if held.created_at < beacon.created_at {
                held.created_at = beacon.created_at;
                held.expiration = beacon.expiration;
                held.tickets = tickets; // keeps its cooldown: a new beacon is no new chance
            }
            return;
        }
        let gossip_full =
            gossip && list.iter().filter(|s| s.gossip).count() >= MAX_GOSSIP_SOURCES_PER_VIDEO;
        if list.len() >= MAX_SOURCES_PER_VIDEO || gossip_full {
            // Make room: one heard only over gossip first, then one on cooldown, then the
            // one announced longest ago. Gossip never displaces a relay's source.
            let evict = list
                .iter()
                .enumerate()
                .filter(|(_, s)| !gossip || s.gossip)
                .max_by_key(|(_, s)| {
                    (
                        s.gossip,
                        s.cooldown_until > now,
                        std::cmp::Reverse(s.created_at),
                    )
                })
                .map(|(i, _)| i);
            match evict {
                Some(i) => {
                    list.remove(i);
                }
                None => return,
            }
        }
        list.push(Source {
            seeder: beacon.seeder.clone(),
            namespace: beacon.content.video.namespace().to_string(),
            created_at: beacon.created_at,
            expiration: beacon.expiration,
            tickets,
            cooldown_until: 0,
            gossip,
        });
    }

    /// Unexpired sources for a manifest at `now`, in the order to try them ([`rank`]).
    fn live(&self, manifest_a: &str, now: u64) -> Vec<Source> {
        let mut live: Vec<Source> = self
            .sources
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(manifest_a)
            .map(|list| {
                list.iter()
                    .filter(|s| now < s.expiration)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        rank(
            &mut live,
            &self.scores.read().unwrap_or_else(PoisonError::into_inner),
            now,
        );
        live
    }

    /// Set a source's cooldown end (0 clears it).
    fn cool(&self, a: &str, seeder: &str, until: u64) {
        let mut sources = self.sources.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(s) = sources
            .get_mut(a)
            .and_then(|list| list.iter_mut().find(|s| s.seeder == seeder))
        {
            s.cooldown_until = until;
        }
    }

    /// Run `attempt` against each live source in turn: cooldown first (so a cancelled
    /// attempt counts as a failure), cleared on success, forgotten on a lie.
    async fn each_source<T, F, Fut>(&self, a: &str, mut attempt: F) -> Result<T>
    where
        F: FnMut(Source) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let mut last = NodeError::Collection(format!("no live source for {a}"));
        for source in self.live(a, unix_now()) {
            let seeder = source.seeder.clone();
            self.cool(a, &seeder, unix_now() + SOURCE_COOLDOWN_SECS);
            match attempt(source).await {
                Ok(v) => {
                    self.cool(a, &seeder, 0);
                    return Ok(v);
                }
                Err(e) => {
                    if matches!(e, NodeError::Poisoned { .. }) {
                        self.forget(a, &seeder);
                    }
                    last = e;
                }
            }
        }
        Err(last)
    }

    /// The iroh endpoints of the live sources heard from relays for a manifest (`a` tag),
    /// with the addresses their tickets carry: who to bootstrap the video's gossip swarm
    /// from (NFX-06 §4). Gossip-heard sources never bootstrap, so a swarm member cannot
    /// steer who the node joins through. One entry per endpoint.
    #[must_use]
    pub fn peers(&self, manifest_a: &str) -> Vec<iroh::EndpointAddr> {
        let mut out: Vec<iroh::EndpointAddr> = Vec::new();
        for source in self
            .live(manifest_a, unix_now())
            .into_iter()
            .filter(|s| !s.gossip)
        {
            for ticket in source.tickets.values() {
                if let Ok(t) = ticket.parse::<BlobTicket>()
                    && !out.iter().any(|p| p.id == t.addr().id)
                {
                    out.push(t.addr().clone());
                }
            }
        }
        out
    }

    /// The seeders currently usable for a manifest (`a` tag), in the order they are tried.
    #[must_use]
    pub fn sources(&self, manifest_a: &str) -> Vec<String> {
        self.live(manifest_a, unix_now())
            .into_iter()
            .map(|s| s.seeder)
            .collect()
    }

    fn forget(&self, a: &str, seeder: &str) {
        let mut sources = self.sources.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(list) = sources.get_mut(a) {
            list.retain(|s| s.seeder != seeder);
        }
    }

    async fn pull_from(
        &self,
        manifest: &Manifest,
        sha: &str,
        tickets: &BTreeMap<String, String>,
        store: &dyn ContentStore,
    ) -> Result<()> {
        let root = manifest.root_hex();
        let anchor = Anchor {
            root: &root,
            video: &manifest.addr,
            segs: manifest.segs,
        };
        let ticket = |id: &str| {
            tickets
                .get(id)
                .ok_or_else(|| NodeError::Collection(format!("no {id} ticket")))?
                .parse()
                .map_err(NodeError::transport)
        };
        let meta = ticket("meta")?;
        let list = if store.has(&root) {
            HashList::verify_for(&store.get(&root)?, manifest)?
        } else {
            self.node.fetch(&anchor, &meta, &[], store).await?
        };
        if meta_members(&root, &list).iter().any(|m| m == sha) {
            if !store.has(sha) {
                self.node.fetch(&anchor, &meta, &[], store).await?;
            }
            return Ok(());
        }
        for r in &list.renditions {
            let Some(playlist) = list.files.iter().find(|f| f.name == r.playlist) else {
                continue;
            };
            if !store.has(&playlist.sha256) {
                self.node.fetch(&anchor, &meta, &[], store).await?;
            }
            if rendition_members(&list, &store.get(&playlist.sha256)?)?
                .iter()
                .any(|m| m == sha)
            {
                self.node
                    .fetch(&anchor, &meta, &[(r.id.clone(), ticket(&r.id)?)], store)
                    .await?;
                return Ok(());
            }
        }
        Err(NodeError::Collection(format!("{sha} is in no rendition")))
    }
}

/// NFX-06 §2: every ticket of an iroh endpoint parses and names the endpoint's own `node`.
fn tickets_name(node: &str, tickets: &BTreeMap<String, String>) -> bool {
    tickets.values().all(|t| {
        t.parse::<BlobTicket>()
            .is_ok_and(|t| t.addr().id.to_string() == node)
    })
}

impl SwarmPull {
    /// Fetch `manifest`'s whole video (the meta collection and every rendition) into
    /// `store` from the first live source that has all of it. A lying source is forgotten
    /// and the next one tried. Returns the verified hash list.
    pub async fn fetch_video(
        &self,
        manifest: &Manifest,
        store: &dyn ContentStore,
    ) -> Result<HashList> {
        self.fetch_renditions(manifest, store, None).await
    }

    /// [`SwarmPull::fetch_video`], fetching of the renditions only those `only` names
    /// (every one when `None`; none, for the meta collection alone): the meta collection
    /// whole, then the named renditions, from the first live source with a ticket for each
    /// of them. An id the hash list does not have is an error.
    pub async fn fetch_renditions(
        &self,
        manifest: &Manifest,
        store: &dyn ContentStore,
        only: Option<&[String]>,
    ) -> Result<HashList> {
        let a = manifest.a_tag();
        let root = manifest.root_hex();
        let anchor = Anchor {
            root: &root,
            video: &manifest.addr,
            segs: manifest.segs,
        };
        let anchor = &anchor;
        self.each_source(&a, |source| async move {
            let ticket = |id: &str| -> Result<BlobTicket> {
                source
                    .tickets
                    .get(id)
                    .ok_or_else(|| NodeError::Collection(format!("no {id} ticket")))?
                    .parse()
                    .map_err(NodeError::transport)
            };
            let meta = ticket("meta")?;
            let list = self.node.fetch(anchor, &meta, &[], store).await?;
            if let Some(ids) = only {
                check_held(&list, ids)?;
            }
            let renditions = list
                .renditions
                .iter()
                .filter(|r| only.is_none_or(|ids| ids.contains(&r.id)))
                .map(|r| Ok((r.id.clone(), ticket(&r.id)?)))
                .collect::<Result<Vec<_>>>()?;
            self.node.fetch(anchor, &meta, &renditions, store).await
        })
        .await
    }
}

impl Pull for SwarmPull {
    fn pull<'a>(
        &'a self,
        manifest: &'a Manifest,
        sha: &'a str,
        store: &'a dyn ContentStore,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let a = manifest.a_tag();
            self.each_source(&a, |source| async move {
                self.pull_from(manifest, sha, &source.tickets, store).await
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(seeder: &str, namespace: &str, cooldown_until: u64, gossip: bool) -> Source {
        Source {
            seeder: seeder.to_string(),
            namespace: namespace.to_string(),
            created_at: 1,
            expiration: u64::MAX,
            tickets: BTreeMap::new(),
            cooldown_until,
            gossip,
        }
    }

    fn order(live: &[Source]) -> Vec<&str> {
        live.iter().map(|s| s.seeder.as_str()).collect()
    }

    #[test]
    fn scores_order_within_buckets_and_never_rescue_a_cooling_seeder() {
        let ns = "nfx:mainnet:1";
        let now = 1_000;
        let mut live = vec![
            source("unrated", ns, 0, false),
            source("liked-but-cooling", ns, now + 60, false),
            source("disliked", ns, 0, false),
            source("liked", ns, 0, false),
            source("liked-gossip", ns, 0, true),
            source("liked-elsewhere", "nfx:testnet:1", 0, false),
            source("cooled-off", ns, now, false), // cooldown ended: not cooling
        ];
        let none = BTreeMap::new();
        rank(&mut live, &none, now);
        assert_eq!(
            order(&live),
            [
                "unrated",
                "disliked",
                "liked",
                "liked-elsewhere",
                "cooled-off",
                "liked-gossip",
                "liked-but-cooling",
            ],
            "unrated: today's order"
        );

        let scores = BTreeMap::from([
            (
                ns.to_string(),
                BTreeMap::from([
                    ("liked".to_string(), 90),
                    ("liked-but-cooling".to_string(), 100),
                    ("liked-gossip".to_string(), 100),
                    ("disliked".to_string(), -40),
                ]),
            ),
            (
                "nfx:testnet:1".to_string(),
                BTreeMap::from([("unrated".to_string(), 100)]),
            ),
        ]);
        rank(&mut live, &scores, now);
        assert_eq!(
            order(&live),
            [
                "liked",
                "unrated",
                "liked-elsewhere",
                "cooled-off",
                "disliked",
                "liked-gossip",
                "liked-but-cooling",
            ]
        );
    }
}
