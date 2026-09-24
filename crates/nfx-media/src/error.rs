/// Why packaging failed. Mirrors the demo's `MediaError` codes where they overlap.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("probe-parse: {0}")]
    ProbeParse(String),
    #[error("no-video-stream: {0}")]
    NoVideoStream(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("mp4: {0}")]
    Mp4(String),
    #[error("ffmpeg: {0}")]
    Tool(String),
    #[error("package: {0}")]
    Package(String),
    #[error("NFX self-check failed: {0}")]
    Nfx(#[from] nfx_proto::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = core::result::Result<T, MediaError>;
