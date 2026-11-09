//! NFX-05 packaging for the NFX master plan (ADR 0008, A2).
//!
//! - [`probe`], [`argv`] and [`storyboard`] are behaviour-faithful ports of the
//!   demo's L8 planning code (`packages/core/src/media/{ffprobe,argv,storyboard}.ts`
//!   in the demo's snapshot at the tag `demo-base`),
//!   with L8's own test expectations ported alongside. Spike S4 showed that L8's GOP pinning
//!   already yields CMAF-ready, switch-aligned segments; only the container tail changes.
//! - [`ladder`] started as the port of L8's `ladder.ts`. Since 2026-11-09 it plans one
//!   rendition by default, or the sizes a creator picks up to 2160p on the short side, by
//!   the size rule nutflix-pear's `ladder.ts` shares (vectors in `tests/sizes.rs`).
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
