#[derive(Debug, thiserror::Error)]
pub enum NodeError {
    /// An NFX object failed verification (hash list, file, envelope).
    #[error("nfx: {0}")]
    Nfx(#[from] nfx_proto::Error),
    /// A peer served bytes whose sha256 is not the one the hash list names. Discard the
    /// peer for this session (NFX-05 §4).
    #[error("poisoned: {what}: expected sha256 {expected}, got {got}")]
    Poisoned {
        what: String,
        expected: String,
        got: String,
    },
    /// A collection's shape does not match the hash list (count or order).
    #[error("collection mismatch: {0}")]
    Collection(String),
    #[error("transport: {0}")]
    Transport(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl NodeError {
    pub(crate) fn transport(e: impl std::fmt::Display) -> Self {
        Self::Transport(e.to_string())
    }
}

pub type Result<T> = core::result::Result<T, NodeError>;
