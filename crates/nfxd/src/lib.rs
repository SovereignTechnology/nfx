//! The headless NFX node (ADR 0008): one process that seeds videos over iroh, fetches
//! videos it is told to watch, serves an NFX-05 §6 origin with swarm pull-through, and
//! can embed an NFX-04 scoped relay (§7). Everything here is wiring; the protocol lives
//! in `nfx-node` and `nfx-proto`.

pub mod daemon;
pub mod key;
pub mod package;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Node(#[from] nfx_node::NodeError),
    #[error("nfx: {0}")]
    Nfx(#[from] nfx_proto::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Config(String),
}

pub type Result<T> = core::result::Result<T, Error>;
