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
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::manifest::Manifest;
use tokio::net::TcpListener;

use crate::fetch::Anchor;
use crate::limit::ConnLimits;
use crate::node::Node;
use crate::store::ContentStore;
use crate::video::{meta_members, rendition_members};
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
        let root = manifest.root_hex();
        if !self.store.has(&root) {
            self.pull_into_store(manifest, &root).await?;
        }
        let list = HashList::verify_for(&self.store.get(&root)?, manifest)?;
        let types = list
            .files
            .iter()
            .map(|f| (f.sha256.clone(), content_type(f.role, &f.sha256, manifest)))
            .collect();
        let master = list
            .files
            .iter()
            .find(|f| f.role == Role::PlaylistMaster)
            .map(|f| f.sha256.clone());
        let mut index = self.index.write().unwrap_or_else(PoisonError::into_inner);
        for f in &list.files {
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
    created_at: u64,
    expiration: u64,
    /// Rendition id, or `meta` → ticket.
    tickets: BTreeMap<String, String>,
    /// Tried last until this time (unix seconds); 0 when the last attempt succeeded.
    cooldown_until: u64,
    /// Heard only over gossip, never in a relay's beacon.
    gossip: bool,
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
pub struct SwarmPull {
    node: Arc<Node>,
    /// manifest a-tag → sources, in the order learned.
    sources: RwLock<BTreeMap<String, Vec<Source>>>,
}

impl SwarmPull {
    #[must_use]
    pub fn new(node: Arc<Node>) -> Self {
        Self {
            node,
            sources: RwLock::new(BTreeMap::new()),
        }
    }

    /// Record the iroh tickets of a verified beacon from a relay ([`Beacon::from_event`]).
    /// A newer beacon from the same seeder replaces its entry in place; an older one is
    /// ignored.
    pub fn learn(&self, beacon: &Verified<Beacon>) {
        self.learn_as(beacon, false);
    }

    /// Record a seeder heard over the video's gossip swarm (a `here` envelope's
    /// [`presence_for`](nfx_proto::gossip::Envelope)). Ranked below relay beacons: see
    /// [`SwarmPull`].
    pub fn learn_gossip(&self, presence: &Verified<Beacon>) {
        self.learn_as(presence, true);
    }

    fn learn_as(&self, beacon: &Verified<Beacon>, gossip: bool) {
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
        if list.len() >= MAX_SOURCES_PER_VIDEO {
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
            created_at: beacon.created_at,
            expiration: beacon.expiration,
            tickets,
            cooldown_until: 0,
            gossip,
        });
    }

    /// Unexpired sources for a manifest at `now`: those not on cooldown first, in the
    /// order learned, then the rest by when their cooldown ends.
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
        live.sort_by_key(|s| {
            if s.cooldown_until > now {
                s.cooldown_until
            } else {
                0
            }
        });
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

    /// The iroh endpoints of the live sources for a manifest (`a` tag), with the addresses
    /// their tickets carry: who to bootstrap the video's gossip swarm from (NFX-06 §4).
    /// One entry per endpoint.
    #[must_use]
    pub fn peers(&self, manifest_a: &str) -> Vec<iroh::EndpointAddr> {
        let mut out: Vec<iroh::EndpointAddr> = Vec::new();
        for source in self.live(manifest_a, unix_now()) {
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
            let renditions = list
                .renditions
                .iter()
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
