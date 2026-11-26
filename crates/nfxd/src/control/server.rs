//! The node's end of the control socket (`docs/nfx/control.md` §1 to §3).
//!
//! What is decided here, before a request reaches the node:
//! - **Where.** A pathname Unix socket, mode 0600, in a directory of mode 0700 that this
//!   user owns ([`crate::private::dir`]). Never TCP.
//! - **One node.** A lock file in that directory is held for the listener's life. A second
//!   node fails to take it and stops; it never removes the first one's socket.
//! - **Who.** The peer's uid, read from the kernel on each connection, must be the node's
//!   own or one the operator allowed. Anyone else is closed without a reply.
//! - **How much.** Two connections; a frame of at most 256 KiB, whole within 10 s; a
//!   connection idle for 30 s is closed; 20 requests a second.
//! - **In what order.** `hello` first, with the version this node speaks.
//!
//! Everything else is the [`Handler`]'s.

use std::fs::{File, OpenOptions, Permissions, TryLockError};
use std::future::Future;
use std::os::unix::fs::{FileTypeExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, watch};
use tokio::time::timeout;

use super::proto::{
    self, Call, Class, Done, ErrorBody, ErrorCode, FrameError, HelloOk, Reply, Request, cap,
};
use crate::{Error, Result};

/// The lock file's name, beside the socket.
const LOCK_NAME: &str = "control.lock";
/// The longest socket path Linux takes (`sun_path` is 108 bytes with its final NUL).
const SUN_PATH_MAX: usize = 107;

/// What a [`Handler`] answers a call with: the result as JSON, or why not.
pub type Answer = core::result::Result<serde_json::Value, ErrorBody>;

/// `result` as an [`Answer`].
pub fn answer<T: Serialize>(result: &T) -> Answer {
    serde_json::to_value(result).map_err(|_| ErrorBody::new(ErrorCode::Internal))
}

/// The node behind the socket.
///
/// The server has already checked the peer, the frame, the request's shape and every
/// length (`Call::parse`), and has answered `hello` and `shutdown` itself. What is left
/// is what only the node can decide: whether an address, a URL or an npub is valid, and
/// what to do.
pub trait Handler: Send + Sync + 'static {
    /// What `hello` reports: the node's key, capabilities, pinned settings and namespaces.
    /// The server sets the protocol version, the node's version and the `shutdown`
    /// capability.
    fn hello(&self) -> impl Future<Output = HelloOk> + Send;

    /// Answer `call`, which is never `hello` or `shutdown`.
    fn call(&self, call: Call) -> impl Future<Output = Answer> + Send;
}

/// Where to listen and whom to let in.
#[derive(Debug, Clone)]
pub struct Options {
    /// The socket's absolute path. Its directory is made (mode 0700) if it is not there.
    pub path: PathBuf,
    /// Uids let in beside the node's own, for a node that runs as a service account.
    pub allow_uids: Vec<u32>,
    /// Whether a client may stop the node with `shutdown`.
    pub allow_shutdown: bool,
}

#[derive(Debug, Clone, Copy)]
struct Limits {
    connections: usize,
    idle: Duration,
    frame: Duration,
    per_sec: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: proto::MAX_CONNECTIONS,
            idle: Duration::from_secs(proto::IDLE_SECS),
            frame: Duration::from_secs(proto::FRAME_SECS),
            per_sec: proto::MAX_PER_SEC,
        }
    }
}

/// A bound control socket.
#[derive(Debug)]
pub struct Listener {
    listener: UnixListener,
    path: PathBuf,
    /// Held for the listener's life: one node for a control directory.
    _lock: File,
    own_uid: u32,
    allow_uids: Vec<u32>,
    allow_shutdown: bool,
    quit: watch::Sender<bool>,
    limits: Limits,
}

impl Listener {
    /// Check the directory, take the lock, clear a dead node's socket and bind. Call it
    /// inside a tokio runtime.
    pub fn bind(options: Options) -> Result<Self> {
        let Options {
            path,
            allow_uids,
            allow_shutdown,
        } = options;
        let refuse = |why: &str| Error::Config(format!("--control {}: {why}", path.display()));
        if !path.is_absolute() {
            return Err(refuse("give an absolute path"));
        }
        let (Some(dir), Some(_)) = (path.parent(), path.file_name()) else {
            return Err(refuse("name a socket file inside a directory"));
        };
        if path.as_os_str().len() > SUN_PATH_MAX {
            return Err(refuse("the path is too long for a Unix socket (107 bytes)"));
        }
        crate::private::dir(dir, "control directory")?;

        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join(LOCK_NAME))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(refuse("another node holds this control socket"));
            }
            Err(TryLockError::Error(e)) => return Err(e.into()),
        }
        // The lock is ours, so nothing is listening on a socket file left here: it is a
        // dead node's. Anything that is not a socket is not ours to remove.
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(&path)?,
            Ok(_) => return Err(refuse("exists and is not a socket")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let listener = UnixListener::bind(&path)?;
        // The directory already keeps every other user out; this is the second lock.
        std::fs::set_permissions(&path, Permissions::from_mode(0o600))?;
        let (quit, _) = watch::channel(false);
        Ok(Self {
            listener,
            path,
            _lock: lock,
            own_uid: rustix::process::geteuid().as_raw(),
            allow_uids,
            allow_shutdown,
            quit,
            limits: Limits::default(),
        })
    }

    /// The socket's path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Turns true once a client's `shutdown` has been answered. The node watches it and
    /// shuts down as it does on SIGTERM.
    pub fn quit(&self) -> watch::Receiver<bool> {
        self.quit.subscribe()
    }

    /// Serve connections until `stop` turns true (or its sender is gone). Open connections
    /// are dropped then, and the socket file is removed.
    pub async fn serve<H: Handler>(self, handler: Arc<H>, mut stop: watch::Receiver<bool>) {
        let slots = Arc::new(Semaphore::new(self.limits.connections));
        let shared = Arc::new(Shared {
            allow_shutdown: self.allow_shutdown,
            quit: self.quit.clone(),
            limits: self.limits,
        });
        loop {
            tokio::select! {
                () = stopped(&mut stop) => break,
                accepted = self.listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        // Out of descriptors, most likely: do not spin on it.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    };
                    if !self.admits(&stream) {
                        continue; // dropped: closed without a reply
                    }
                    let Ok(slot) = Arc::clone(&slots).try_acquire_owned() else {
                        continue; // over the limit: closed without a reply
                    };
                    let handler = Arc::clone(&handler);
                    let shared = Arc::clone(&shared);
                    let mut stop = stop.clone();
                    tokio::spawn(async move {
                        let _slot = slot;
                        tokio::select! {
                            () = connection(stream, handler.as_ref(), &shared) => {}
                            () = stopped(&mut stop) => {}
                        }
                    });
                }
            }
        }
    }

    fn admits(&self, stream: &UnixStream) -> bool {
        stream
            .peer_cred()
            .is_ok_and(|peer| permitted(peer.uid(), self.own_uid, &self.allow_uids))
    }

    #[cfg(test)]
    fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        // The lock is still held here, so the file at the path is this listener's.
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Whether a peer with `uid` may use the socket of a node running as `own`.
fn permitted(uid: u32, own: u32, allowed: &[u32]) -> bool {
    uid == own || allowed.contains(&uid)
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    // An error is the sender gone: nobody can stop the server any more, so it stops.
    let _ = stop.wait_for(|stop| *stop).await;
}

struct Shared {
    allow_shutdown: bool,
    quit: watch::Sender<bool>,
    limits: Limits,
}

/// One connection: frames in, one reply for each, in order.
async fn connection<H: Handler>(mut stream: UnixStream, handler: &H, shared: &Shared) {
    let limits = shared.limits;
    let mut greeted = false;
    let mut second = Instant::now();
    let mut in_second = 0u32;
    loop {
        let mut header = [0u8; 4];
        if !read(&mut stream, &mut header, limits.idle).await {
            return;
        }
        let len = match proto::frame_len(header) {
            Ok(len) => len,
            Err(FrameError::TooLarge) => {
                // Said before the body is read; the connection cannot be resynchronised.
                let reply = Reply::err(0, ErrorCode::TooLarge);
                let _ = send(&mut stream, &reply, limits.frame).await;
                return;
            }
            Err(_) => return,
        };
        let mut body = vec![0u8; len];
        if !read(&mut stream, &mut body, limits.frame).await {
            return;
        }
        if second.elapsed() >= Duration::from_secs(1) {
            second = Instant::now();
            in_second = 0;
        }
        in_second = in_second.saturating_add(1);
        let (reply, quit) = if in_second > limits.per_sec {
            let id = proto::decode::<Request>(&body).map_or(0, |r| r.id);
            (Reply::err(id, ErrorCode::RateLimited), false)
        } else {
            respond(&body, &mut greeted, handler, shared).await
        };
        if !send(&mut stream, &reply, limits.frame).await {
            return;
        }
        if quit {
            shared.quit.send_replace(true);
            return;
        }
    }
}

/// The reply to one frame, and whether the node is to shut down once it is sent.
async fn respond<H: Handler>(
    body: &[u8],
    greeted: &mut bool,
    handler: &H,
    shared: &Shared,
) -> (Reply, bool) {
    let Ok(request) = proto::decode::<Request>(body) else {
        return (Reply::err(0, ErrorCode::BadRequest), false);
    };
    let id = request.id;
    let call = match Call::parse(request) {
        Ok(call) => call,
        Err(e) => return (Reply::err_with(id, e), false),
    };
    match call {
        Call::Hello(hello) => {
            if hello.proto != proto::PROTO {
                let mut e = ErrorBody::new(ErrorCode::UnsupportedVersion);
                e.proto = Some(proto::PROTO);
                return (Reply::err_with(id, e), false);
            }
            if !*greeted {
                crate::status!("control: hello from \"{}\"", printable(&hello.client, 64));
            }
            *greeted = true;
            let mut ok = handler.hello().await;
            ok.proto = proto::PROTO;
            ok.version = env!("CARGO_PKG_VERSION").to_owned();
            ok.caps.retain(|c| c != cap::SHUTDOWN);
            if shared.allow_shutdown {
                ok.caps.push(cap::SHUTDOWN.to_owned());
            }
            (Reply::ok(id, &ok), false)
        }
        _ if !*greeted => (Reply::err(id, ErrorCode::BadRequest), false),
        Call::Shutdown => {
            if shared.allow_shutdown {
                crate::status!("control: shutdown: ok");
                (Reply::ok(id, &Done {}), true)
            } else {
                crate::status!("control: shutdown: {}", ErrorCode::Denied.text());
                (Reply::err(id, ErrorCode::Denied), false)
            }
        }
        call => {
            let method = call.method();
            // Every change is one line: the method, what it was about, the outcome. Never
            // a key, a path or a peer's address.
            let about = (call.class() != Class::Read).then(|| subject(&call));
            let result = handler.call(call).await;
            if let Some(about) = about {
                let outcome = result.as_ref().map_or_else(|e| e.code.text(), |_| "ok");
                crate::status!("control: {method}{about}: {outcome}");
            }
            let reply = match result {
                Ok(value) => Reply {
                    id,
                    result: Some(value),
                    error: None,
                },
                Err(e) => Reply::err_with(id, e),
            };
            (reply, false)
        }
    }
}

/// What a change is about, for its log line: a video's address or the names of the
/// settings. Nothing else a client sent is logged.
fn subject(call: &Call) -> String {
    match call {
        Call::Add(v) | Call::Pause(v) | Call::Resume(v) => format!(" {}", printable(&v.a, 200)),
        Call::Remove(r) => {
            let files = if r.delete_files { " and its files" } else { "" };
            format!(" {}{files}", printable(&r.a, 200))
        }
        Call::SettingsSet(set) => {
            let s = &set.settings;
            let names: Vec<&str> = [
                s.relays.as_ref().map(|_| proto::setting::RELAYS),
                s.iroh_relays.as_ref().map(|_| proto::setting::IROH_RELAYS),
                s.cap_bytes.map(|_| proto::setting::CAP_BYTES),
                s.seeding.map(|_| proto::setting::SEEDING),
            ]
            .into_iter()
            .flatten()
            .collect();
            format!(" {}", names.join(","))
        }
        _ => String::new(),
    }
}

/// Text a client sent, fit for one log line: printable ASCII only, and no more than `max`
/// characters, so it cannot start a line of its own or bury the log.
fn printable(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .filter(|c| *c != '"')
        .take(max)
        .collect()
}

async fn read(stream: &mut UnixStream, buf: &mut [u8], within: Duration) -> bool {
    matches!(timeout(within, stream.read_exact(buf)).await, Ok(Ok(_)))
}

async fn send(stream: &mut UnixStream, reply: &Reply, within: Duration) -> bool {
    let frame = match proto::encode(reply) {
        Ok(frame) => frame,
        // A result too large for one frame: say that the node failed, not nothing.
        Err(_) => match proto::encode(&Reply::err(reply.id, ErrorCode::Internal)) {
            Ok(frame) => frame,
            Err(_) => return false,
        },
    };
    matches!(timeout(within, stream.write_all(&frame)).await, Ok(Ok(())))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::proto::{List, ListOk, Remove, SettingsPatch, SettingsSet, StatusOk, VideoRef};
    use super::*;

    const A: &str =
        "38504:abababababababababababababababababababababababababababababababab:nfx:testnet:1:v";

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<&'static str>>,
    }

    impl Handler for Fake {
        async fn hello(&self) -> HelloOk {
            HelloOk {
                // A handler that claims `shutdown` does not get it unless the operator did.
                caps: vec![cap::LIBRARY.to_owned(), cap::SHUTDOWN.to_owned()],
                namespaces: vec!["nfx:testnet:1".to_owned()],
                ..HelloOk::default()
            }
        }

        async fn call(&self, call: Call) -> Answer {
            self.calls.lock().unwrap().push(call.method());
            match call {
                Call::Status => answer(&StatusOk {
                    seeding: 12,
                    ..StatusOk::default()
                }),
                Call::Add(_) => Err(ErrorBody::new(ErrorCode::OverCap)),
                // A result that does not fit a frame.
                Call::List(_) => answer(&ListOk {
                    rev: 1,
                    videos: Some(
                        (0..3000)
                            .map(|i| proto::Video {
                                a: format!("{A}{i}"),
                                title: "t".repeat(proto::limit::TITLE),
                                state: proto::State::Seeding,
                                detail: None,
                                paused: false,
                                reasons: vec![],
                                size: 0,
                                held: 0,
                                received: 0,
                                seeders: 0,
                                added_at: 0,
                            })
                            .collect(),
                    ),
                    ..ListOk::default()
                }),
                _ => answer(&Done {}),
            }
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfxd-ctl-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn options(path: &Path) -> Options {
        Options {
            path: path.to_path_buf(),
            allow_uids: vec![],
            allow_shutdown: false,
        }
    }

    struct Running {
        handler: Arc<Fake>,
        stop: watch::Sender<bool>,
        quit: watch::Receiver<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    fn start(listener: Listener) -> Running {
        let handler = Arc::new(Fake::default());
        let (stop, stopping) = watch::channel(false);
        let quit = listener.quit();
        let task = tokio::spawn(listener.serve(Arc::clone(&handler), stopping));
        Running {
            handler,
            stop,
            quit,
            task,
        }
    }

    struct Client(UnixStream);

    impl Client {
        async fn connect(path: &Path) -> Self {
            Self(UnixStream::connect(path).await.unwrap())
        }

        async fn greeted(path: &Path) -> Self {
            let mut c = Self::connect(path).await;
            let reply = c.call(1, &hello()).await.expect("a reply to hello");
            assert!(reply.error.is_none(), "{reply:?}");
            c
        }

        async fn write(&mut self, bytes: &[u8]) {
            self.0.write_all(bytes).await.unwrap();
        }

        /// The next reply, or `None` when the node closed the connection.
        async fn reply(&mut self) -> Option<Reply> {
            let mut header = [0u8; 4];
            let read = timeout(Duration::from_secs(5), self.0.read_exact(&mut header)).await;
            read.expect("the node neither replied nor closed").ok()?;
            let mut body = vec![0u8; proto::frame_len(header).unwrap()];
            self.0.read_exact(&mut body).await.ok()?;
            Some(proto::decode(&body).unwrap())
        }

        async fn call(&mut self, id: u32, call: &Call) -> Option<Reply> {
            self.write(&proto::encode(&Request::new(id, call)).unwrap())
                .await;
            self.reply().await
        }

        async fn code(&mut self, id: u32, call: &Call) -> ErrorCode {
            let reply = self.call(id, call).await.expect("a reply");
            assert_eq!(reply.id, id);
            reply.error.expect("an error").code
        }
    }

    fn hello() -> Call {
        Call::Hello(proto::Hello {
            proto: proto::PROTO,
            client: "test/1".to_owned(),
        })
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    }

    #[tokio::test]
    async fn it_binds_a_private_socket_and_answers_in_order() {
        let dir = scratch("bind").join("ctl");
        let path = dir.join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&path), 0o600);
        assert!(
            std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_socket()
        );
        assert_eq!(mode(&dir.join(LOCK_NAME)), 0o600);

        let mut c = Client::connect(&path).await;
        let ok: HelloOk = c.call(7, &hello()).await.unwrap().into_result().unwrap();
        assert_eq!(ok.proto, proto::PROTO);
        assert_eq!(ok.version, env!("CARGO_PKG_VERSION"));
        // `shutdown` is the operator's to give, whatever the handler says.
        assert_eq!(ok.caps, [cap::LIBRARY]);
        assert_eq!(ok.namespaces, ["nfx:testnet:1"]);

        let status: StatusOk = c
            .call(8, &Call::Status)
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(status.seeding, 12);
        // A handler's refusal travels as it is.
        let add = Call::Add(VideoRef { a: A.to_owned() });
        assert_eq!(c.code(9, &add).await, ErrorCode::OverCap);
        // Two requests written at once are answered one after the other.
        let mut both = proto::encode(&Request::new(10, &Call::Status)).unwrap();
        both.extend(proto::encode(&Request::new(11, &Call::Keys)).unwrap());
        c.write(&both).await;
        assert_eq!(c.reply().await.unwrap().id, 10);
        assert_eq!(c.reply().await.unwrap().id, 11);
        assert_eq!(
            *node.handler.calls.lock().unwrap(),
            ["status", "add", "status", "keys"]
        );

        // Stopping drops the connection and removes the socket; the lock file stays.
        node.stop.send_replace(true);
        node.task.await.unwrap();
        assert!(c.reply().await.is_none());
        assert!(!path.exists());
        assert!(dir.join(LOCK_NAME).exists());
    }

    #[tokio::test]
    async fn it_refuses_a_place_that_is_not_private() {
        let d = scratch("place");
        let refusal = |path: &Path| Listener::bind(options(path)).unwrap_err().to_string();

        assert!(refusal(Path::new("relative/control.sock")).contains("absolute path"));
        assert!(refusal(Path::new("/")).contains("inside a directory"));
        let long = d.join("x".repeat(120)).join("control.sock");
        assert!(refusal(&long).contains("too long"));

        // A directory open to others, and a symlink to a good one.
        let open = d.join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, Permissions::from_mode(0o755)).unwrap();
        assert!(refusal(&open.join("control.sock")).contains("open to group or others"));
        let real = d.join("real");
        crate::private::dir(&real, "test directory").unwrap();
        let link = d.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(refusal(&link.join("control.sock")).contains("symlink is refused"));

        // Something that is not a socket at the path is left alone.
        let file = real.join("control.sock");
        std::fs::write(&file, b"mine").unwrap();
        assert!(refusal(&file).contains("is not a socket"));
        assert_eq!(std::fs::read(&file).unwrap(), b"mine");
    }

    #[tokio::test]
    async fn one_node_holds_a_socket_and_a_dead_one_is_replaced() {
        let path = scratch("one").join("ctl").join("control.sock");
        let first = Listener::bind(options(&path)).unwrap();
        let e = Listener::bind(options(&path)).unwrap_err().to_string();
        assert!(e.contains("another node holds this control socket"), "{e}");
        // The loser removed nothing: the first still answers.
        let node = start(first);
        Client::greeted(&path).await;
        node.stop.send_replace(true);
        node.task.await.unwrap();

        // A node that died without cleaning up leaves its socket file behind.
        let dead = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(dead);
        assert!(path.exists());
        let node = start(Listener::bind(options(&path)).unwrap());
        Client::greeted(&path).await;
        node.stop.send_replace(true);
        node.task.await.unwrap();
    }

    #[test]
    fn only_the_node_s_user_and_the_allowed_uids_are_let_in() {
        assert!(permitted(1000, 1000, &[]));
        assert!(!permitted(1001, 1000, &[]));
        assert!(!permitted(0, 1000, &[]), "root is not let in by default");
        assert!(permitted(1001, 1000, &[1001, 1002]));
        assert!(!permitted(1003, 1000, &[1001, 1002]));
    }

    #[tokio::test]
    async fn hello_comes_first_and_names_a_version_the_node_speaks() {
        let path = scratch("hello").join("ctl").join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());
        let mut c = Client::connect(&path).await;
        assert_eq!(c.code(1, &Call::Status).await, ErrorCode::BadRequest);

        let old = Call::Hello(proto::Hello {
            proto: 0,
            client: String::new(),
        });
        let reply = c.call(2, &old).await.unwrap();
        let e = reply.error.unwrap();
        assert_eq!(e.code, ErrorCode::UnsupportedVersion);
        assert_eq!(e.proto, Some(proto::PROTO));
        // A refused hello greets nobody.
        assert_eq!(c.code(3, &Call::Status).await, ErrorCode::BadRequest);
        assert!(node.handler.calls.lock().unwrap().is_empty());

        assert!(c.call(4, &hello()).await.unwrap().error.is_none());
        assert!(c.call(5, &Call::Status).await.unwrap().error.is_none());
        node.stop.send_replace(true);
    }

    #[tokio::test]
    async fn a_frame_that_is_not_a_request_is_refused_and_the_next_is_served() {
        let path = scratch("frames").join("ctl").join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());
        let mut c = Client::greeted(&path).await;

        // Not JSON, not an object, an unknown method, an unknown field, a value too long.
        for (body, code) in [
            (b"hello".to_vec(), ErrorCode::BadRequest),
            (b"[1,2,3]".to_vec(), ErrorCode::BadRequest),
            (
                br#"{"id":4,"method":"wallet.balance"}"#.to_vec(),
                ErrorCode::UnknownMethod,
            ),
            (
                br#"{"id":4,"method":"status","extra":1}"#.to_vec(),
                ErrorCode::BadRequest,
            ),
            (
                format!(
                    r#"{{"id":4,"method":"add","params":{{"a":"{}"}}}}"#,
                    "x".repeat(600)
                )
                .into_bytes(),
                ErrorCode::Invalid,
            ),
        ] {
            let mut frame = u32::try_from(body.len()).unwrap().to_be_bytes().to_vec();
            frame.extend(&body);
            c.write(&frame).await;
            assert_eq!(c.reply().await.unwrap().error.unwrap().code, code);
        }
        // None of them reached the node, and the connection still works.
        assert!(node.handler.calls.lock().unwrap().is_empty());
        assert!(c.call(5, &Call::Status).await.unwrap().error.is_none());

        // A result too large for a frame is an error, not silence.
        assert_eq!(
            c.code(6, &Call::List(List::default())).await,
            ErrorCode::Internal
        );
        node.stop.send_replace(true);
    }

    #[tokio::test]
    async fn a_frame_outside_the_limits_ends_the_connection() {
        let path = scratch("limits").join("ctl").join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());

        // Too large: said once, with id 0, before any of the body is read.
        let mut c = Client::greeted(&path).await;
        c.write(&u32::try_from(proto::MAX_FRAME + 1).unwrap().to_be_bytes())
            .await;
        let reply = c.reply().await.unwrap();
        assert_eq!(reply.id, 0);
        assert_eq!(reply.error.unwrap().code, ErrorCode::TooLarge);
        assert!(c.reply().await.is_none());

        // Empty: closed without a word.
        let mut c = Client::greeted(&path).await;
        c.write(&[0, 0, 0, 0]).await;
        assert!(c.reply().await.is_none());
        node.stop.send_replace(true);
    }

    #[tokio::test]
    async fn slow_idle_and_greedy_clients_are_cut_off() {
        let path = scratch("slow").join("ctl").join("control.sock");
        let limits = Limits {
            connections: 2,
            idle: Duration::from_millis(1500),
            frame: Duration::from_millis(300),
            per_sec: 5,
        };
        let node = start(Listener::bind(options(&path)).unwrap().with_limits(limits));

        // A frame that does not arrive whole in time.
        let mut c = Client::greeted(&path).await;
        c.write(&[0, 0, 0, 100, b'{']).await;
        assert!(c.reply().await.is_none());

        // A connection that asks nothing.
        let mut c = Client::greeted(&path).await;
        tokio::time::sleep(Duration::from_millis(2000)).await;
        assert!(c.reply().await.is_none());

        // More requests in a second than allowed: refused by id, and served again later.
        let mut c = Client::greeted(&path).await; // the first of the five
        for id in 2..=5 {
            assert!(c.call(id, &Call::Status).await.unwrap().error.is_none());
        }
        assert_eq!(c.code(6, &Call::Status).await, ErrorCode::RateLimited);
        assert_eq!(c.code(7, &Call::Status).await, ErrorCode::RateLimited);
        // The refused ones never reached the node.
        assert_eq!(node.handler.calls.lock().unwrap().len(), 4);
        // A second later (and still inside the idle limit) it is served again.
        tokio::time::sleep(Duration::from_millis(1050)).await;
        assert!(c.call(8, &Call::Status).await.unwrap().error.is_none());
        assert_eq!(node.handler.calls.lock().unwrap().len(), 5);
        node.stop.send_replace(true);
    }

    #[tokio::test]
    async fn a_third_connection_is_closed_and_a_freed_slot_is_reused() {
        let path = scratch("slots").join("ctl").join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());
        let first = Client::greeted(&path).await;
        let mut second = Client::greeted(&path).await;

        let mut third = Client::connect(&path).await;
        // It may be closed before or after the write; either way no reply comes.
        let _ = third
            .0
            .write_all(&proto::encode(&Request::new(1, &hello())).unwrap())
            .await;
        assert!(third.reply().await.is_none());

        // The two that were let in are still served.
        assert!(second.call(2, &Call::Status).await.unwrap().error.is_none());
        drop(first);
        // The slot comes back once the node has seen the first one close.
        let mut freed = None;
        for _ in 0..50 {
            let mut c = Client::connect(&path).await;
            let _ =
                c.0.write_all(&proto::encode(&Request::new(1, &hello())).unwrap())
                    .await;
            if let Some(reply) = c.reply().await {
                freed = Some(reply);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(freed.expect("the slot was never freed").error.is_none());
        node.stop.send_replace(true);
    }

    #[tokio::test]
    async fn shutdown_is_the_operator_s_to_allow() {
        // Not allowed: denied, and the node is not told to quit.
        let path = scratch("quit-no").join("ctl").join("control.sock");
        let node = start(Listener::bind(options(&path)).unwrap());
        let mut c = Client::greeted(&path).await;
        assert_eq!(c.code(2, &Call::Shutdown).await, ErrorCode::Denied);
        assert!(!*node.quit.borrow());
        node.stop.send_replace(true);

        // Allowed: answered first, then the node is told, and the handler never sees it.
        let path = scratch("quit-yes").join("ctl").join("control.sock");
        let mut allowed = options(&path);
        allowed.allow_shutdown = true;
        let mut node = start(Listener::bind(allowed).unwrap());
        let mut c = Client::connect(&path).await;
        let ok: HelloOk = c.call(1, &hello()).await.unwrap().into_result().unwrap();
        assert_eq!(ok.caps, [cap::LIBRARY, cap::SHUTDOWN]);
        // Before hello it is refused like anything else.
        let mut early = Client::connect(&path).await;
        assert_eq!(early.code(1, &Call::Shutdown).await, ErrorCode::BadRequest);
        assert!(!*node.quit.borrow());

        let done: Done = c
            .call(2, &Call::Shutdown)
            .await
            .unwrap()
            .into_result()
            .unwrap();
        assert_eq!(done, Done {});
        timeout(Duration::from_secs(5), node.quit.wait_for(|quit| *quit))
            .await
            .expect("the node was never told to quit")
            .unwrap();
        assert!(node.handler.calls.lock().unwrap().is_empty());
        node.stop.send_replace(true);
    }

    #[test]
    fn a_log_line_carries_only_what_is_safe_to_print() {
        assert_eq!(printable("nfx-manager/0.1.0", 64), "nfx-manager/0.1.0");
        // No line breaks, no escapes, no quotes, no other scripts, and a cap.
        assert_eq!(
            printable("a\nb\rc\x1b[31m\"d\u{202e}e\u{0}", 64),
            "abc[31mde"
        );
        assert_eq!(printable(&"x".repeat(500), 64).len(), 64);

        let v = VideoRef { a: A.to_owned() };
        assert_eq!(subject(&Call::Pause(v)), format!(" {A}"));
        assert_eq!(
            subject(&Call::Remove(Remove {
                a: format!("{A}\ncontrol: shutdown: ok"),
                delete_files: true,
            })),
            format!(" {A}control: shutdown: ok and its files")
        );
        let set = Call::SettingsSet(SettingsSet {
            settings: SettingsPatch {
                relays: Some(vec!["wss://relay.example.org".to_owned()]),
                seeding: Some(false),
                ..SettingsPatch::default()
            },
        });
        // The names of the settings, never their values.
        assert_eq!(subject(&set), " relays,seeding");
        assert_eq!(subject(&Call::KeyCreate), "");
    }
}
