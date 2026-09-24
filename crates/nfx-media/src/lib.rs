//! NFX-05 packaging for the NFX master plan (ADR 0008, A2).
//!
//! - [`probe`], [`ladder`], [`argv`] and [`storyboard`] are behaviour-faithful ports of the
//!   demo's L8 planning code (`packages/core/src/media/{ffprobe,ladder,argv,storyboard}.ts`),
//!   with L8's own test expectations ported alongside. Spike S4 showed that L8's GOP pinning
//!   already yields CMAF-ready, switch-aligned segments; only the container tail changes.
//! - [`mp4`] reads CODECS strings from an init segment's `avcC`/`esds` boxes (ffprobe
//!   reports no profile for a bare init, S4).
//! - [`package`] runs ffmpeg (argv arrays only, never a shell), content-addresses every
//!   output file, rewrites playlists to content names, assembles the hash list, and
//!   verifies the result with `nfx-proto` before returning it.

pub mod argv;
mod error;
pub mod ladder;
pub mod mp4;
pub mod package;
pub mod probe;
pub mod storyboard;

pub use error::{MediaError, Result};
