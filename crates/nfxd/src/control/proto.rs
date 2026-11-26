//! Protocol 1 of the control socket (`docs/nfx/control.md`): its messages, limits and
//! framing.
//!
//! This file depends on serde and serde_json only, and does no I/O. The manager includes
//! it by path, so both ends are built from the same types; `vectors.json` beside it holds
//! every shape, and the tests at the end of this file run in both crates.
//!
//! The node is strict about what it receives: an unknown method, an unknown field or a
//! value of the wrong type is refused. A client is lenient about what it is sent: it
//! ignores reply fields it does not know and reads an unknown state as
//! [`State::Unknown`], which is what lets an older client manage a newer node.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol's version. A change of meaning bumps it; additions do not (§5).
pub const PROTO: u32 = 1;
/// The largest frame body, in bytes. Both ends refuse a longer one before reading it.
pub const MAX_FRAME: usize = 256 * 1024;
/// Connections a node takes at once.
pub const MAX_CONNECTIONS: usize = 2;
/// A connection with no request for this long is closed.
pub const IDLE_SECS: u64 = 30;
/// A frame must arrive whole within this long.
pub const FRAME_SECS: u64 = 10;
/// Requests a connection may make in one second.
pub const MAX_PER_SEC: u32 = 20;
/// The least time between two `settings.set`.
pub const SETTINGS_EVERY_SECS: u64 = 10;
/// Videos one `list` reports.
pub const MAX_LISTED: usize = 1000;
/// Videos one `lookup` page reports.
pub const LOOKUP_PAGE: usize = 100;
/// Creator keys a node holds.
pub const MAX_KEYS: usize = 16;

/// Length limits, in characters unless said otherwise.
pub mod limit {
    pub const CLIENT: usize = 64;
    /// A video address, in bytes: `38504:<64 hex>:<namespace>:<video-id>`.
    pub const ADDRESS: usize = 512;
    pub const NPUB: usize = 128;
    pub const NAMESPACE: usize = 64;
    pub const CURSOR: usize = 256;
    pub const URL: usize = 255;
    pub const RELAYS: usize = 16;
    pub const IROH_RELAYS: usize = 8;
    /// A filesystem path, in bytes.
    pub const PATH: usize = 4096;
    pub const TITLE: usize = 200;
    pub const DESCRIPTION: usize = 10_000;
    pub const ALT: usize = 1000;
    pub const TAGS: usize = 16;
    pub const TAG: usize = 64;
    pub const DETAIL: usize = 200;
    pub const CAP_MIN: u64 = 1 << 30;
    pub const CAP_MAX: u64 = 1 << 50;
}

/// What a node offers, as `hello` lists it. A client uses a method only when its
/// capability is listed.
pub mod cap {
    pub const LIBRARY: &str = "library";
    pub const LOOKUP: &str = "lookup";
    pub const PUBLISH: &str = "publish";
    pub const SETTINGS: &str = "settings";
    pub const SHUTDOWN: &str = "shutdown";
    /// Reserved (§6): no node offers it yet.
    pub const WALLET: &str = "wallet";
}

/// The names of the settings, as `pinned` and an `invalid` or `pinned` error use them.
pub mod setting {
    pub const RELAYS: &str = "relays";
    pub const IROH_RELAYS: &str = "iroh_relays";
    pub const CAP_BYTES: &str = "cap_bytes";
    pub const SEEDING: &str = "seeding";
}

// ---------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------

/// Why a frame was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// A length of zero.
    Empty,
    /// A length over [`MAX_FRAME`].
    TooLarge,
    /// The body is not the JSON this end expected.
    Json,
}

impl core::fmt::Display for FrameError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Empty => "an empty frame",
            Self::TooLarge => "a frame over the limit",
            Self::Json => "a frame that is not a valid message",
        })
    }
}

impl std::error::Error for FrameError {}

/// The body length a frame's 4-byte header announces, checked against the limits.
pub fn frame_len(header: [u8; 4]) -> Result<usize, FrameError> {
    match u32::from_be_bytes(header) as usize {
        0 => Err(FrameError::Empty),
        n if n > MAX_FRAME => Err(FrameError::TooLarge),
        n => Ok(n),
    }
}

/// `msg` as one frame: the header, then its JSON.
pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(msg).map_err(|_| FrameError::Json)?;
    if body.is_empty() {
        return Err(FrameError::Empty);
    }
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge);
    }
    let len = u32::try_from(body.len()).map_err(|_| FrameError::TooLarge)?;
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// A frame's body as a message.
pub fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, FrameError> {
    if body.is_empty() {
        return Err(FrameError::Empty);
    }
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge);
    }
    serde_json::from_slice(body).map_err(|_| FrameError::Json)
}

// ---------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------

/// A request as it travels: `{"id": 7, "method": "list", "params": {...}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u32,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

impl Request {
    /// The request that makes `call`.
    pub fn new(id: u32, call: &Call) -> Self {
        Self {
            id,
            method: call.method().to_owned(),
            params: call.params(),
        }
    }
}

/// A reply as it travels: exactly one of `result` and `error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Reply {
    /// A reply carrying `result`.
    pub fn ok<T: Serialize>(id: u32, result: &T) -> Self {
        match serde_json::to_value(result) {
            Ok(v) => Self {
                id,
                result: Some(v),
                error: None,
            },
            Err(_) => Self::err(id, ErrorCode::Internal),
        }
    }

    /// A reply carrying `code` and its fixed text.
    pub fn err(id: u32, code: ErrorCode) -> Self {
        Self::err_with(id, ErrorBody::new(code))
    }

    /// A reply carrying `error`.
    pub fn err_with(id: u32, error: ErrorBody) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }

    /// What the reply carries, as the type the caller expects. A reply with both parts or
    /// neither, or a result of another shape, is [`ErrorCode::Internal`]: the far end is
    /// not speaking this protocol.
    pub fn into_result<T: DeserializeOwned>(self) -> Result<T, ErrorBody> {
        match (self.result, self.error) {
            (Some(v), None) => {
                serde_json::from_value(v).map_err(|_| ErrorBody::new(ErrorCode::Internal))
            }
            (None, Some(e)) => Err(e),
            _ => Err(ErrorBody::new(ErrorCode::Internal)),
        }
    }
}

/// Why a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    UnknownMethod,
    UnsupportedVersion,
    NotFound,
    Conflict,
    Invalid,
    Pinned,
    OverCap,
    RateLimited,
    TooLarge,
    Unavailable,
    Denied,
    Internal,
    /// A code a newer node sent that this client does not know.
    #[serde(other)]
    Unknown,
}

impl ErrorCode {
    /// The fixed text of a code. No text of an error ever repeats what the client sent.
    pub fn text(self) -> &'static str {
        match self {
            Self::BadRequest => "not a valid request",
            Self::UnknownMethod => "no such method",
            Self::UnsupportedVersion => "protocol version not supported",
            Self::NotFound => "not found",
            Self::Conflict => "already so",
            Self::Invalid => "a value was refused",
            Self::Pinned => "fixed by the node's command line",
            Self::OverCap => "over the storage cap",
            Self::RateLimited => "too many requests",
            Self::TooLarge => "the frame is over the limit",
            Self::Unavailable => "not available now",
            Self::Denied => "the node will not do that",
            Self::Internal => "the node failed",
            Self::Unknown => "an error this client does not know",
        }
    }
}

/// The `error` part of a reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: ErrorCode,
    #[serde(default)]
    pub message: String,
    /// The field or setting the error is about, where there is one. A name, never a value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// With `unsupported_version`: the version the node speaks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proto: Option<u32>,
}

impl ErrorBody {
    /// `code` with its fixed text.
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            message: code.text().to_owned(),
            field: None,
            proto: None,
        }
    }

    /// `code`, naming the field it is about.
    pub fn about(code: ErrorCode, field: &'static str) -> Self {
        Self {
            field: Some(field.to_owned()),
            ..Self::new(code)
        }
    }
}

impl From<ErrorCode> for ErrorBody {
    fn from(code: ErrorCode) -> Self {
        Self::new(code)
    }
}

// ---------------------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------------------

/// What a request may do (§4): read changes nothing, change alters what the node does,
/// destructive can lose data or stop the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Read,
    Change,
    Destructive,
}

/// A request, by method.
#[derive(Debug, Clone, PartialEq)]
pub enum Call {
    Hello(Hello),
    Status,
    List(List),
    Sources(VideoRef),
    Routes(VideoRef),
    SettingsGet,
    SettingsSet(SettingsSet),
    Lookup(Lookup),
    Add(VideoRef),
    Pause(VideoRef),
    Resume(VideoRef),
    Remove(Remove),
    Keys,
    KeyCreate,
    Publish(Publish),
    Shutdown,
}

/// A method that takes no parameters accepts `{}` and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NoParams {}

fn params_of<T: DeserializeOwned>(params: Value) -> Result<T, ErrorBody> {
    // No `params` at all reads as `{}`.
    let params = if params.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        params
    };
    serde_json::from_value(params).map_err(|_| ErrorBody::new(ErrorCode::BadRequest))
}

fn value_of<T: Serialize>(params: &T) -> Value {
    serde_json::to_value(params).unwrap_or(Value::Null)
}

impl Call {
    /// The method's name on the wire.
    pub fn method(&self) -> &'static str {
        match self {
            Self::Hello(_) => "hello",
            Self::Status => "status",
            Self::List(_) => "list",
            Self::Sources(_) => "sources",
            Self::Routes(_) => "routes",
            Self::SettingsGet => "settings.get",
            Self::SettingsSet(_) => "settings.set",
            Self::Lookup(_) => "lookup",
            Self::Add(_) => "add",
            Self::Pause(_) => "pause",
            Self::Resume(_) => "resume",
            Self::Remove(_) => "remove",
            Self::Keys => "keys",
            Self::KeyCreate => "key.create",
            Self::Publish(_) => "publish",
            Self::Shutdown => "shutdown",
        }
    }

    /// The method's class.
    pub fn class(&self) -> Class {
        match self {
            Self::Hello(_)
            | Self::Status
            | Self::List(_)
            | Self::Sources(_)
            | Self::Routes(_)
            | Self::SettingsGet
            | Self::Lookup(_)
            | Self::Keys => Class::Read,
            Self::SettingsSet(_)
            | Self::Add(_)
            | Self::Pause(_)
            | Self::Resume(_)
            | Self::KeyCreate
            | Self::Publish(_) => Class::Change,
            Self::Remove(_) | Self::Shutdown => Class::Destructive,
        }
    }

    /// The capability a node must list for this method; `hello` needs none.
    pub fn cap(&self) -> Option<&'static str> {
        match self {
            Self::Hello(_) => None,
            Self::Status
            | Self::List(_)
            | Self::Sources(_)
            | Self::Routes(_)
            | Self::Add(_)
            | Self::Pause(_)
            | Self::Resume(_)
            | Self::Remove(_) => Some(cap::LIBRARY),
            Self::Lookup(_) => Some(cap::LOOKUP),
            Self::Keys | Self::KeyCreate | Self::Publish(_) => Some(cap::PUBLISH),
            Self::SettingsGet | Self::SettingsSet(_) => Some(cap::SETTINGS),
            Self::Shutdown => Some(cap::SHUTDOWN),
        }
    }

    /// The parameters as they travel.
    pub fn params(&self) -> Value {
        match self {
            Self::Hello(p) => value_of(p),
            Self::List(p) => value_of(p),
            Self::Sources(p)
            | Self::Routes(p)
            | Self::Add(p)
            | Self::Pause(p)
            | Self::Resume(p) => value_of(p),
            Self::SettingsSet(p) => value_of(p),
            Self::Lookup(p) => value_of(p),
            Self::Remove(p) => value_of(p),
            Self::Publish(p) => value_of(p),
            Self::Status | Self::SettingsGet | Self::Keys | Self::KeyCreate | Self::Shutdown => {
                value_of(&NoParams {})
            }
        }
    }

    /// The call a request makes, as the node reads it: strict about the method, the
    /// fields and their types, and about every length in [`limit`].
    pub fn parse(request: Request) -> Result<Self, ErrorBody> {
        let p = request.params;
        let call = match request.method.as_str() {
            "hello" => Self::Hello(params_of(p)?),
            "status" => Self::no_params(p, Self::Status)?,
            "list" => Self::List(params_of(p)?),
            "sources" => Self::Sources(params_of(p)?),
            "routes" => Self::Routes(params_of(p)?),
            "settings.get" => Self::no_params(p, Self::SettingsGet)?,
            "settings.set" => Self::SettingsSet(params_of(p)?),
            "lookup" => Self::Lookup(params_of(p)?),
            "add" => Self::Add(params_of(p)?),
            "pause" => Self::Pause(params_of(p)?),
            "resume" => Self::Resume(params_of(p)?),
            "remove" => Self::Remove(params_of(p)?),
            "keys" => Self::no_params(p, Self::Keys)?,
            "key.create" => Self::no_params(p, Self::KeyCreate)?,
            "publish" => Self::Publish(params_of(p)?),
            "shutdown" => Self::no_params(p, Self::Shutdown)?,
            _ => return Err(ErrorBody::new(ErrorCode::UnknownMethod)),
        };
        call.check()?;
        Ok(call)
    }

    fn no_params(params: Value, call: Self) -> Result<Self, ErrorBody> {
        params_of::<NoParams>(params).map(|_| call)
    }

    /// The length limits of [`limit`]. A client may run this before it sends.
    pub fn check(&self) -> Result<(), ErrorBody> {
        match self {
            Self::Hello(p) => chars("client", &p.client, 0, limit::CLIENT),
            Self::Sources(p)
            | Self::Routes(p)
            | Self::Add(p)
            | Self::Pause(p)
            | Self::Resume(p) => p.check(),
            Self::Remove(p) => bytes("a", &p.a, limit::ADDRESS),
            Self::Lookup(p) => {
                chars("npub", &p.npub, 1, limit::NPUB)?;
                chars("namespace", &p.namespace, 1, limit::NAMESPACE)?;
                match &p.cursor {
                    Some(c) => chars("cursor", c, 1, limit::CURSOR),
                    None => Ok(()),
                }
            }
            Self::SettingsSet(p) => p.settings.check(),
            Self::Publish(p) => p.check(),
            Self::List(_)
            | Self::Status
            | Self::SettingsGet
            | Self::Keys
            | Self::KeyCreate
            | Self::Shutdown => Ok(()),
        }
    }
}

fn chars(field: &'static str, s: &str, min: usize, max: usize) -> Result<(), ErrorBody> {
    // A string longer in bytes than four times the limit is over it whatever it holds, so
    // a huge value is never walked character by character.
    if s.len() > max.saturating_mul(4) {
        return Err(ErrorBody::about(ErrorCode::Invalid, field));
    }
    let n = s.chars().count();
    if n < min || n > max {
        return Err(ErrorBody::about(ErrorCode::Invalid, field));
    }
    Ok(())
}

fn bytes(field: &'static str, s: &str, max: usize) -> Result<(), ErrorBody> {
    if s.is_empty() || s.len() > max {
        return Err(ErrorBody::about(ErrorCode::Invalid, field));
    }
    Ok(())
}

/// `hello`: the first request on a connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub proto: u32,
    /// Who is asking, for the node's log only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client: String,
}

/// What `hello` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct HelloOk {
    pub proto: u32,
    /// The node's version.
    #[serde(default)]
    pub version: String,
    /// The node's public key in hex, the one its beacons are signed with. Absent on a node
    /// started without a key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// What the node offers ([`cap`]).
    #[serde(default)]
    pub caps: Vec<String>,
    /// The settings its command line fixed ([`setting`]).
    #[serde(default)]
    pub pinned: Vec<String>,
    /// The namespaces of the videos it holds, most used first.
    #[serde(default)]
    pub namespaces: Vec<String>,
}

impl HelloOk {
    /// Whether the node offers `cap`.
    pub fn has(&self, cap: &str) -> bool {
        self.caps.iter().any(|c| c == cap)
    }
}

/// What `status` answers: numbers only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StatusOk {
    #[serde(default)]
    pub downloading: u32,
    #[serde(default)]
    pub seeding: u32,
    #[serde(default)]
    pub paused: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub held_bytes: u64,
    #[serde(default)]
    pub cap_bytes: u64,
    #[serde(default)]
    pub relays: u32,
    #[serde(default)]
    pub relays_connected: u32,
    #[serde(default)]
    pub seeding_on: bool,
}

/// `list`: with the revision the client holds, an unchanged list costs one small reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<u64>,
}

/// What `list` answers. With `unchanged` nothing else is set.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ListOk {
    pub rev: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub unchanged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub videos: Option<Vec<Video>>,
    /// The node holds more than [`MAX_LISTED`] videos and reported the newest.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

// serde passes the field by reference.
fn is_false(b: &bool) -> bool {
    !*b
}

/// One video a node holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Video {
    /// Its address, `38504:<creator>:<namespace>:<video-id>`.
    pub a: String,
    /// Its title, capped by the node. Text from the network: a client still cleans it.
    #[serde(default)]
    pub title: String,
    pub state: State,
    /// Why, for a state that has a reason. Capped by the node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Paused by the user; `state` is then the last one it had.
    #[serde(default)]
    pub paused: bool,
    /// Why the node keeps it (NFX-18).
    #[serde(default)]
    pub reasons: Vec<Reason>,
    /// Bytes of the renditions the node keeps; 0 while not known.
    #[serde(default)]
    pub size: u64,
    /// How many of those bytes are in the store.
    #[serde(default)]
    pub held: u64,
    /// Bytes this node fetched from peers since it started.
    #[serde(default)]
    pub received: u64,
    /// Seeders the node knows for it, itself not counted.
    #[serde(default)]
    pub seeders: u32,
    /// When it was added, in Unix seconds.
    #[serde(default)]
    pub added_at: u64,
}

/// What the node is doing with a video.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Resolving,
    Fetching,
    Seeding,
    Unannounced,
    AwaitingRelay,
    Serving,
    Deleted,
    Failed,
    /// A state a newer node sent that this client does not know.
    #[serde(other)]
    Unknown,
}

/// Why a node keeps a video (NFX-18 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Watched,
    Downloaded,
    Published,
    #[serde(other)]
    Unknown,
}

/// The one parameter of the methods that name a video.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoRef {
    pub a: String,
}

impl VideoRef {
    fn check(&self) -> Result<(), ErrorBody> {
        bytes("a", &self.a, limit::ADDRESS)
    }
}

/// What `add` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddOk {
    pub state: State,
}

/// What a method with nothing to report answers: `{}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Done {}

/// What `sources` answers: who the bytes came from.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SourcesOk {
    #[serde(default)]
    pub peers: Vec<Peer>,
}

/// One peer a video's bytes came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    /// The first 8 hex characters of its id.
    pub peer: String,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub blobs: u64,
    #[serde(default)]
    pub open: bool,
}

/// What `routes` answers. It carries IP addresses: a client asks only while its user has
/// the addresses switch on, never keeps the answer and never logs it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RoutesOk {
    #[serde(default)]
    pub routes: Vec<Route>,
}

/// How one peer is reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub peer: String,
    pub path: PathKind,
    /// `ip:port` for a direct path, a host name for a relay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<u32>,
}

/// The kind of path to a peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    Direct,
    Relay,
    #[serde(other)]
    Unknown,
}

/// The settings the socket reports.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(default)]
    pub iroh_relays: Vec<String>,
    #[serde(default)]
    pub cap_bytes: u64,
    #[serde(default)]
    pub seeding: bool,
}

/// What `settings.get` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SettingsGetOk {
    pub settings: Settings,
    #[serde(default)]
    pub pinned: Vec<String>,
}

/// `settings.set`: any of the four; a field left out keeps its value.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsSet {
    pub settings: SettingsPatch,
}

/// The fields `settings.set` may carry.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relays: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iroh_relays: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seeding: Option<bool>,
}

impl SettingsPatch {
    /// Whether it changes nothing.
    pub fn is_empty(&self) -> bool {
        self.relays.is_none()
            && self.iroh_relays.is_none()
            && self.cap_bytes.is_none()
            && self.seeding.is_none()
    }

    /// Counts and lengths only. What a URL may be is the node's to decide.
    fn check(&self) -> Result<(), ErrorBody> {
        if let Some(relays) = &self.relays {
            if relays.is_empty() || relays.len() > limit::RELAYS {
                return Err(ErrorBody::about(ErrorCode::Invalid, setting::RELAYS));
            }
            for url in relays {
                chars(setting::RELAYS, url, 1, limit::URL)?;
            }
        }
        if let Some(relays) = &self.iroh_relays {
            if relays.len() > limit::IROH_RELAYS {
                return Err(ErrorBody::about(ErrorCode::Invalid, setting::IROH_RELAYS));
            }
            for url in relays {
                chars(setting::IROH_RELAYS, url, 1, limit::URL)?;
            }
        }
        if let Some(cap) = self.cap_bytes
            && !(limit::CAP_MIN..=limit::CAP_MAX).contains(&cap)
        {
            return Err(ErrorBody::about(ErrorCode::Invalid, setting::CAP_BYTES));
        }
        Ok(())
    }
}

/// What `settings.set` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SettingsSetOk {
    #[serde(default)]
    pub restarted: bool,
}

/// `lookup`: a creator's videos in one namespace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lookup {
    pub npub: String,
    pub namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// What `lookup` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LookupOk {
    #[serde(default)]
    pub videos: Vec<Found>,
    /// The cursor of the next page; absent on the last.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

/// One video a lookup found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Found {
    pub a: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub published_at: u64,
    /// Whether the node already holds it.
    #[serde(default)]
    pub held: bool,
}

/// `remove`: forget one video; its files stay unless `delete_files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remove {
    pub a: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub delete_files: bool,
}

/// What `remove` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RemoveOk {
    /// Bytes deleted; 0 when the files stayed.
    #[serde(default)]
    pub deleted_bytes: u64,
}

/// What `keys` answers: the creator keys the node holds, as npubs.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct KeysOk {
    #[serde(default)]
    pub keys: Vec<String>,
}

/// What `key.create` answers: the new key's npub, and nothing else of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyCreateOk {
    pub npub: String,
}

/// `publish`: a package made by `nfx-package`, under a creator key the node holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publish {
    /// The package directory's absolute path.
    pub package: String,
    /// The creator key, by npub.
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl Publish {
    fn check(&self) -> Result<(), ErrorBody> {
        bytes("package", &self.package, limit::PATH)?;
        chars("key", &self.key, 1, limit::NPUB)?;
        chars("title", &self.title, 1, limit::TITLE)?;
        if let Some(d) = &self.description {
            chars("description", d, 0, limit::DESCRIPTION)?;
        }
        if let Some(alt) = &self.alt {
            chars("alt", alt, 0, limit::ALT)?;
        }
        if self.tags.len() > limit::TAGS {
            return Err(ErrorBody::about(ErrorCode::Invalid, "tags"));
        }
        for tag in &self.tags {
            chars("tags", tag, 1, limit::TAG)?;
        }
        Ok(())
    }
}

/// What `publish` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishOk {
    /// The new video's address.
    pub a: String,
    /// How many relays took the manifest.
    #[serde(default)]
    pub relays: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every shape of the protocol, shared by the node and the manager.
    const VECTORS: &str = include_str!("vectors.json");

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vectors {
        requests: Vec<RequestVector>,
        replies: Vec<ReplyVector>,
        refused: Vec<RefusedVector>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RequestVector {
        name: String,
        class: String,
        cap: Option<String>,
        json: Value,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ReplyVector {
        name: String,
        /// The method whose reply this is, or `error`.
        of: String,
        json: Value,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct RefusedVector {
        name: String,
        code: ErrorCode,
        field: Option<String>,
        json: Value,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(VECTORS).expect("vectors.json parses")
    }

    fn class_name(c: Class) -> &'static str {
        match c {
            Class::Read => "read",
            Class::Change => "change",
            Class::Destructive => "destructive",
        }
    }

    #[test]
    fn every_request_vector_parses_and_writes_back_the_same() {
        let v = vectors();
        let mut seen = std::collections::BTreeSet::new();
        for r in v.requests {
            let request: Request = serde_json::from_value(r.json.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", r.name));
            let id = request.id;
            let call = Call::parse(request).unwrap_or_else(|e| panic!("{}: {e:?}", r.name));
            assert_eq!(class_name(call.class()), r.class, "{}", r.name);
            assert_eq!(call.cap(), r.cap.as_deref(), "{}", r.name);
            seen.insert(call.method());
            let back = serde_json::to_value(Request::new(id, &call)).unwrap();
            // A method without parameters may be sent with no `params`; it is written with `{}`.
            let mut want = r.json;
            if want.get("params").is_none() {
                want["params"] = serde_json::json!({});
            }
            assert_eq!(back, want, "{}", r.name);
        }
        // Every method has at least one vector.
        let all = [
            "hello",
            "status",
            "list",
            "sources",
            "routes",
            "settings.get",
            "settings.set",
            "lookup",
            "add",
            "pause",
            "resume",
            "remove",
            "keys",
            "key.create",
            "publish",
            "shutdown",
        ];
        for m in all {
            assert!(seen.contains(m), "no request vector for {m}");
        }
        assert_eq!(seen.len(), all.len());
    }

    fn round_trip<T: DeserializeOwned + Serialize>(name: &str, result: Value) {
        let typed: T =
            serde_json::from_value(result.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(serde_json::to_value(&typed).unwrap(), result, "{name}");
    }

    #[test]
    fn every_reply_vector_reads_as_its_type_and_writes_back_the_same() {
        let mut seen = std::collections::BTreeSet::new();
        for r in vectors().replies {
            let reply: Reply = serde_json::from_value(r.json.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", r.name));
            assert_eq!(serde_json::to_value(&reply).unwrap(), r.json, "{}", r.name);
            seen.insert(r.of.clone());
            if r.of == "error" {
                assert!(reply.result.is_none(), "{}", r.name);
                let e = reply.error.expect("an error vector has an error");
                assert_ne!(e.code, ErrorCode::Unknown, "{}", r.name);
                assert_eq!(e.message, e.code.text(), "{}", r.name);
                continue;
            }
            let result = reply.result.expect("a result vector has a result");
            let n = &r.name;
            match r.of.as_str() {
                "hello" => round_trip::<HelloOk>(n, result),
                "status" => round_trip::<StatusOk>(n, result),
                "list" => round_trip::<ListOk>(n, result),
                "sources" => round_trip::<SourcesOk>(n, result),
                "routes" => round_trip::<RoutesOk>(n, result),
                "settings.get" => round_trip::<SettingsGetOk>(n, result),
                "settings.set" => round_trip::<SettingsSetOk>(n, result),
                "lookup" => round_trip::<LookupOk>(n, result),
                "add" => round_trip::<AddOk>(n, result),
                "pause" | "resume" | "shutdown" => round_trip::<Done>(n, result),
                "remove" => round_trip::<RemoveOk>(n, result),
                "keys" => round_trip::<KeysOk>(n, result),
                "key.create" => round_trip::<KeyCreateOk>(n, result),
                "publish" => round_trip::<PublishOk>(n, result),
                other => panic!("{n}: a reply vector of unknown method {other}"),
            }
        }
        for m in [
            "hello",
            "status",
            "list",
            "sources",
            "routes",
            "settings.get",
            "settings.set",
            "lookup",
            "add",
            "pause",
            "resume",
            "remove",
            "keys",
            "key.create",
            "publish",
            "shutdown",
            "error",
        ] {
            assert!(seen.contains(m), "no reply vector for {m}");
        }
    }

    #[test]
    fn every_refused_vector_is_refused_with_its_code() {
        for r in vectors().refused {
            let got = match serde_json::from_value::<Request>(r.json) {
                Ok(request) => Call::parse(request).map(|_| ()),
                // A frame that is not a request at all is a bad request.
                Err(_) => Err(ErrorBody::new(ErrorCode::BadRequest)),
            };
            let e = got.expect_err(&r.name);
            assert_eq!(e.code, r.code, "{}", r.name);
            assert_eq!(e.field, r.field, "{}", r.name);
            assert_eq!(e.message, r.code.text(), "{}", r.name);
        }
    }

    #[test]
    fn a_client_reads_what_it_does_not_know() {
        // A newer node: an unknown state, reason, path, error code and reply fields.
        let video: Video = serde_json::from_value(serde_json::json!({
            "a": "38504:x:nfx:testnet:1:v", "state": "verifying", "reasons": ["pinned", "watched"],
            "sent": 12, "added_at": 1
        }))
        .unwrap();
        assert_eq!(video.state, State::Unknown);
        assert_eq!(video.reasons, [Reason::Unknown, Reason::Watched]);
        let route: Route =
            serde_json::from_value(serde_json::json!({"peer": "9f2c41aa", "path": "hop"})).unwrap();
        assert_eq!(route.path, PathKind::Unknown);
        let reply: Reply = serde_json::from_value(serde_json::json!({
            "id": 3, "error": {"code": "wallet_locked", "message": "x", "retry_after": 5}, "trace": 1
        }))
        .unwrap();
        assert_eq!(
            reply.into_result::<Done>().unwrap_err().code,
            ErrorCode::Unknown
        );
        let hello: HelloOk = serde_json::from_value(serde_json::json!({
            "proto": 1, "caps": ["library", "teleport"], "motd": "hi"
        }))
        .unwrap();
        assert!(hello.has(cap::LIBRARY));
        assert!(!hello.has(cap::WALLET));
    }

    #[test]
    fn a_reply_with_both_parts_or_neither_is_not_this_protocol() {
        for json in [
            serde_json::json!({"id": 1}),
            serde_json::json!({"id": 1, "result": {}, "error": {"code": "internal"}}),
        ] {
            let reply: Reply = serde_json::from_value(json).unwrap();
            assert_eq!(
                reply.into_result::<Done>().unwrap_err().code,
                ErrorCode::Internal
            );
        }
        // A result of another shape too.
        let reply = Reply::ok(1, &serde_json::json!({"keys": 7}));
        assert_eq!(
            reply.into_result::<KeysOk>().unwrap_err().code,
            ErrorCode::Internal
        );
    }

    #[test]
    fn frames_are_bounded_before_the_body_is_read() {
        assert_eq!(frame_len([0, 0, 0, 0]), Err(FrameError::Empty));
        assert_eq!(frame_len([0, 0, 0, 1]), Ok(1));
        assert_eq!(frame_len([0, 4, 0, 0]), Ok(MAX_FRAME));
        assert_eq!(frame_len([0, 4, 0, 1]), Err(FrameError::TooLarge));
        assert_eq!(frame_len([0xff; 4]), Err(FrameError::TooLarge));

        let frame = encode(&Request::new(9, &Call::Status)).unwrap();
        let n = frame_len(frame[..4].try_into().unwrap()).unwrap();
        assert_eq!(n, frame.len() - 4);
        let back: Request = decode(&frame[4..]).unwrap();
        assert_eq!(Call::parse(back).unwrap(), Call::Status);

        // A message whose JSON passes the limit is never framed.
        let huge = Reply::ok(1, &"x".repeat(MAX_FRAME));
        assert_eq!(encode(&huge), Err(FrameError::TooLarge));
        assert_eq!(decode::<Request>(b""), Err(FrameError::Empty));
        assert_eq!(decode::<Request>(b"[1,2]"), Err(FrameError::Json));
        assert_eq!(decode::<Request>(b"{\"id\":1}"), Err(FrameError::Json));
        assert_eq!(
            decode::<Request>(&vec![b' '; MAX_FRAME + 1]),
            Err(FrameError::TooLarge)
        );
    }

    #[test]
    fn lengths_count_characters_and_never_walk_a_huge_value() {
        let title = |s: String| {
            Call::Publish(Publish {
                package: "/p".into(),
                key: "npub1x".into(),
                title: s,
                description: None,
                alt: None,
                tags: vec![],
            })
            .check()
        };
        // 200 characters of four bytes each are within the limit; 201 are not.
        assert!(title("\u{1F600}".repeat(limit::TITLE)).is_ok());
        assert_eq!(
            title("\u{1F600}".repeat(limit::TITLE + 1))
                .unwrap_err()
                .field
                .as_deref(),
            Some("title")
        );
        assert!(title(String::new()).is_err());
        assert!(title("x".repeat(limit::TITLE * 4 + 1)).is_err());
    }

    #[test]
    fn an_error_never_carries_what_was_sent() {
        // The shape of a secret key, not one.
        let secret = format!("nsec1{}", "q".repeat(58));
        let secret = secret.as_str();
        let cases = [
            serde_json::json!({"id": 1, "method": secret}),
            serde_json::json!({"id": 1, "method": "add", "params": {"a": secret, "x": secret}}),
            serde_json::json!({"id": 1, "method": "lookup",
                "params": {"npub": secret.repeat(40), "namespace": "nfx:testnet:1"}}),
            serde_json::json!({"id": 1, "method": "publish", "params": {"package": "/p",
                "key": "npub1x", "title": secret.repeat(40)}}),
        ];
        for json in cases {
            let request: Request = serde_json::from_value(json).unwrap();
            let e = Call::parse(request).unwrap_err();
            let text = serde_json::to_string(&Reply::err_with(1, e)).unwrap();
            assert!(!text.contains("nsec1"), "{text}");
        }
    }
}
