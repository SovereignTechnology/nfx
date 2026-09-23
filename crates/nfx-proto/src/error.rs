/// Why an NFX object was rejected. Every rejection is total: callers discard the
/// object, never render part of it (NFX-01 §4, NFX-02 §4).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("invalid namespace: {0}")]
    Namespace(String),
    #[error("invalid video id: {0}")]
    VideoId(String),
    #[error("invalid event: {0}")]
    Event(String),
    #[error("signature does not verify")]
    Signature,
    #[error("invalid manifest: {0}")]
    Manifest(String),
    #[error("invalid beacon: {0}")]
    Beacon(String),
    #[error("invalid hash list: {0}")]
    HashList(String),
    #[error("invalid playlist: {0}")]
    Playlist(String),
    #[error("non-canonical JSON: {0}")]
    Canon(String),
    #[error("invalid voucher: {0}")]
    Voucher(String),
    #[error("invalid gossip envelope: {0}")]
    Gossip(String),
}

pub type Result<T> = core::result::Result<T, Error>;
