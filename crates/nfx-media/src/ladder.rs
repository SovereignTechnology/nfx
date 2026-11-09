//! Rendition sizes (after L8 `ladder.ts`, build-plan §6.4): six tiers from 2160p to 360p,
//! never upscaled, one keyframe interval for every rendition so switches align.
//!
//! - **Size** is the short side of the picture as displayed (rotation applied): its height
//!   when landscape, its width when portrait, so `720p` means the same pixel count either
//!   way (1280x720 or 720x1280), as on most video sites. The other side follows the aspect.
//! - **Offered sizes** ([`offered`]): for a source of size `S` (its short side, even, at most
//!   [`MAX_HEIGHT`]), every tier no larger than `S`, then `<S>p` itself when `S` is no tier.
//!   Nothing is ever upscaled.
//! - **What packaging makes** ([`Renditions`]): by default **one** rendition, 720p, or
//!   `<S>p` for a source smaller than 720; or exactly the offered sizes a creator names
//!   (`nfx-package --renditions 2160p`, `1080p,360p`, `1000p` for a source 1000 lines on its
//!   short side, or
//!   `1080p,720p,360p`, the old ladder). While the network is small every rendition is its
//!   own set of segments and its own browser swarm (NFX-10 §2), so more of them cost storage
//!   and split the swarms for little gain (nutflix-pear#97 tracks a fuller default).
//! - **Bitrates** ([`rendition_at`]): a tier's own; between two tiers, interpolated linearly
//!   by size; below 360p, L8's rule for a source smaller than every tier.
//!
//! nutflix-pear's `packages/core/src/media/ladder.ts` ports these rules for its Studio's size
//! picker: labels and bitrates must stay identical in both.

use crate::probe::{MediaProbe, display_dimensions};
use crate::{MediaError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Vp9,
    Av1,
}

/// L8's container choice for its progressive output. NFX packaging always writes CMAF
/// (fMP4); see [`crate::package`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mp4,
    Webm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tier {
    pub label: &'static str,
    /// The short side in lines (the label's number).
    pub short_side: u32,
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
}

/// The tiers, tallest first (H.264 bitrates; [`rendition_at`] scales them for other codecs).
pub const LADDER_TIERS: [Tier; 6] = [
    Tier {
        label: "2160p",
        short_side: 2160,
        video_bitrate_kbps: 16000,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "1440p",
        short_side: 1440,
        video_bitrate_kbps: 8000,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "1080p",
        short_side: 1080,
        video_bitrate_kbps: 5000,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "720p",
        short_side: 720,
        video_bitrate_kbps: 2500,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "480p",
        short_side: 480,
        video_bitrate_kbps: 1200,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "360p",
        short_side: 360,
        video_bitrate_kbps: 800,
        audio_bitrate_kbps: 96,
    },
];

/// The largest size: a larger source is packaged at most this size (its short side).
pub const MAX_HEIGHT: u32 = 2160;

/// The size of the one rendition a video gets when its creator names none. Never
/// upscaled: a smaller source gets its own (even) size.
pub const DEFAULT_HEIGHT: u32 = 720;

/// Keyframe interval in seconds — identical for every rendition so switches align.
pub const GOP_SECONDS: u32 = 2;
/// Thumbnail candidate positions as fractions of the duration.
pub const THUMBNAIL_FRACTIONS: [f64; 4] = [0.1, 0.3, 0.5, 0.7];
pub const STORYBOARD_COLS: u32 = 10;
pub const STORYBOARD_TILE_WIDTH: u32 = 160;
/// Storyboards aim for at most this many tiles.
pub const STORYBOARD_MAX_TILES: u32 = 100;
const STORYBOARD_INTERVALS: [u32; 9] = [1, 2, 5, 10, 20, 30, 60, 120, 300];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenditionSpec {
    /// A tier's label, or `<size>p` for a source's own size — never larger than the source.
    pub label: String,
    /// The output's short side in lines, the label's number: its height when landscape or
    /// square, its width when portrait ([`fit_short_side`]).
    pub short_side: u32,
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
    pub codec: Codec,
    pub container: Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoryboardGeometry {
    pub interval_sec: u32,
    pub cols: u32,
    pub rows: u32,
    pub tile_width: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LadderPlan {
    pub source: MediaProbe,
    pub renditions: Vec<RenditionSpec>,
    pub thumbnail_times: Vec<f64>,
    pub storyboard: Option<StoryboardGeometry>,
}

fn codec_container(codec: Codec) -> Container {
    if codec == Codec::Vp9 {
        Container::Webm
    } else {
        Container::Mp4
    }
}

fn bitrate_scale(codec: Codec) -> f64 {
    match codec {
        Codec::H264 => 1.0,
        Codec::Vp9 => 0.7,
        Codec::Av1 => 0.55,
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn round_u32(x: f64) -> u32 {
    x.round() as u32
}

/// Even output size preserving aspect for a target height.
#[must_use]
pub fn fit_to_height(src: (u32, u32), height: u32) -> (u32, u32) {
    let h = height - height % 2;
    let w = round_u32(f64::from(src.0) * f64::from(h) / f64::from(src.1));
    (w + w % 2, h)
}

/// Even output size preserving aspect for a target short side: the height of a landscape
/// or square source, the width of a portrait one.
#[must_use]
pub fn fit_short_side(src: (u32, u32), short_side: u32) -> (u32, u32) {
    if src.0 >= src.1 {
        fit_to_height(src, short_side)
    } else {
        let (long, short) = fit_to_height((src.1, src.0), short_side);
        (short, long)
    }
}

/// Thumbnail candidate timestamps for a duration, deduplicated and inside the clip.
#[must_use]
pub fn thumbnail_times(duration_sec: f64) -> Vec<f64> {
    if duration_sec.is_nan() || duration_sec <= 0.0 {
        return vec![0.0];
    }
    let mut out: Vec<f64> = Vec::new();
    for f in THUMBNAIL_FRACTIONS {
        let t = (duration_sec * f * 1000.0).floor() / 1000.0;
        if t >= 0.0 && t < duration_sec && !out.contains(&t) {
            out.push(t);
        }
    }
    if out.is_empty() { vec![0.0] } else { out }
}

#[must_use]
pub fn storyboard_geometry(duration_sec: f64) -> Option<StoryboardGeometry> {
    if duration_sec.is_nan() || duration_sec <= 0.0 {
        return None;
    }
    let tiles_for = |i: u32| (duration_sec / f64::from(i)).ceil();
    let interval = STORYBOARD_INTERVALS
        .iter()
        .copied()
        .find(|i| tiles_for(*i) <= f64::from(STORYBOARD_MAX_TILES))
        .unwrap_or(300);
    let tiles = round_u32(tiles_for(interval)).max(1);
    let cols = STORYBOARD_COLS.min(tiles);
    Some(StoryboardGeometry {
        interval_sec: interval,
        cols,
        rows: tiles.div_ceil(cols),
        tile_width: STORYBOARD_TILE_WIDTH,
    })
}

/// Which renditions packaging makes (`nfx-package --renditions`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Renditions {
    /// One rendition: 720p, or `<S>p` for a source smaller than 720 lines on its short side.
    #[default]
    Default,
    /// Exactly these sizes, by label, each one of the source's [`offered`] sizes and named
    /// once. Planned largest first, whatever order they are named in.
    Sizes(Vec<String>),
}

impl Renditions {
    /// A comma-separated list of labels, as `--renditions` takes it: `720p`, `1080p,360p`.
    /// Each entry is `<size>p` (a positive size, no leading zero) and named once;
    /// nothing else (no spaces, no empty entries) is accepted. Whether the source offers
    /// them is checked by [`plan`].
    pub fn parse(list: &str) -> Result<Self> {
        let mut labels: Vec<String> = Vec::new();
        for label in list.split(',') {
            if label_size(label).is_none() {
                return Err(MediaError::Renditions(format!(
                    "{label:?} is not a size (a number of lines and p, such as 720p)"
                )));
            }
            if labels.iter().any(|l| l == label) {
                return Err(MediaError::Renditions(format!("{label} is named twice")));
            }
            labels.push(label.to_owned());
        }
        Ok(Self::Sizes(labels))
    }
}

/// The size a label names: `720p` → 720. Digits without a leading zero, then `p`.
fn label_size(label: &str) -> Option<u32> {
    let digits = label.strip_suffix('p')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Even, and at least 2.
fn even(lines: u32) -> u32 {
    2.max(lines - lines % 2)
}

fn tier_spec(t: &Tier, codec: Codec) -> RenditionSpec {
    RenditionSpec {
        label: t.label.to_owned(),
        short_side: t.short_side,
        video_bitrate_kbps: round_u32(f64::from(t.video_bitrate_kbps) * bitrate_scale(codec)),
        audio_bitrate_kbps: t.audio_bitrate_kbps,
        codec,
        container: codec_container(codec),
    }
}

/// The rendition for an output whose short side is `size` lines (made even and at least 2,
/// at most [`MAX_HEIGHT`]), labelled `<size>p`:
/// - at a tier's size, that tier;
/// - between two tiers, `vk = round(lo.v + (hi.v − lo.v) × (h − lo.h) / (hi.h − lo.h))`
///   from their H.264 video bitrates, audio 128 kbps;
/// - below the lowest tier (360p), `vk = round(800 × h / 360)`, audio 96 kbps (L8's
///   rendition for a source shorter than every tier).
///
/// Off a tier the video bitrate is then `max(200, round(vk × scale))` for the codec's scale.
#[must_use]
pub fn rendition_at(size: u32, codec: Codec) -> RenditionSpec {
    let h = even(size.min(MAX_HEIGHT));
    if let Some(t) = LADDER_TIERS.iter().find(|t| t.short_side == h) {
        return tier_spec(t, codec);
    }
    // LADDER_TIERS runs tallest first, so `above` exists: h is below MAX_HEIGHT here.
    let lowest = &LADDER_TIERS[LADDER_TIERS.len() - 1];
    let above = LADDER_TIERS
        .iter()
        .rev()
        .find(|t| t.short_side > h)
        .unwrap_or(&LADDER_TIERS[0]);
    let (vk, audio) = match LADDER_TIERS.iter().find(|t| t.short_side < h) {
        Some(below) => {
            let (lo_h, lo_v) = (
                f64::from(below.short_side),
                f64::from(below.video_bitrate_kbps),
            );
            let (hi_h, hi_v) = (
                f64::from(above.short_side),
                f64::from(above.video_bitrate_kbps),
            );
            (
                round_u32(lo_v + (hi_v - lo_v) * (f64::from(h) - lo_h) / (hi_h - lo_h)),
                128,
            )
        }
        None => (
            round_u32(
                f64::from(lowest.video_bitrate_kbps) * f64::from(h) / f64::from(lowest.short_side),
            ),
            lowest.audio_bitrate_kbps,
        ),
    };
    RenditionSpec {
        label: format!("{h}p"),
        short_side: h,
        video_bitrate_kbps: 200.max(round_u32(f64::from(vk) * bitrate_scale(codec))),
        audio_bitrate_kbps: audio,
        codec,
        container: codec_container(codec),
    }
}

/// The source's size as packaging sees it: the short side of its display dimensions
/// (rotation applied), capped by `max_height` and [`MAX_HEIGHT`], even and at least 2.
pub fn source_size(probe: &MediaProbe, max_height: Option<u32>) -> Result<u32> {
    let video = probe
        .video
        .as_ref()
        .ok_or_else(|| MediaError::NoVideoStream("input has no video stream".into()))?;
    let (w, h) = display_dimensions(video);
    Ok(even(
        w.min(h).min(max_height.unwrap_or(u32::MAX)).min(MAX_HEIGHT),
    ))
}

/// The sizes a source offers, as [`offered`] lists them, for a source size `h` (already
/// even and capped).
fn offered_at(h: u32, codec: Codec) -> Vec<RenditionSpec> {
    let mut out: Vec<RenditionSpec> = LADDER_TIERS
        .iter()
        .filter(|t| t.short_side <= h)
        .map(|t| tier_spec(t, codec))
        .collect();
    if !LADDER_TIERS.iter().any(|t| t.short_side == h) {
        out.push(rendition_at(h, codec));
    }
    out
}

/// The sizes a creator may pick for this source: every tier no larger than it (largest
/// first), then its own size when that is no tier. Never larger than the source.
pub fn offered(
    probe: &MediaProbe,
    max_height: Option<u32>,
    codec: Codec,
) -> Result<Vec<RenditionSpec>> {
    Ok(offered_at(source_size(probe, max_height)?, codec))
}

/// Plan what `renditions` asks for, for a probed source treated as at most `max_height` on
/// its short side.
pub fn plan(
    probe: &MediaProbe,
    renditions: &Renditions,
    max_height: Option<u32>,
    codec: Codec,
) -> Result<LadderPlan> {
    let h = source_size(probe, max_height)?;
    let specs = match renditions {
        Renditions::Default => vec![rendition_at(DEFAULT_HEIGHT.min(h), codec)],
        Renditions::Sizes(labels) => {
            if labels.is_empty() {
                return Err(MediaError::Renditions("no size named".into()));
            }
            let offered = offered_at(h, codec);
            if let Some(missing) = labels
                .iter()
                .find(|l| !offered.iter().any(|o| &o.label == *l))
            {
                let list: Vec<&str> = offered.iter().map(|o| o.label.as_str()).collect();
                return Err(MediaError::Renditions(format!(
                    "{missing} is not offered for this source ({h} lines on its short side; packaging never upscales): offered {}",
                    list.join(", ")
                )));
            }
            if let Some(twice) = labels
                .iter()
                .enumerate()
                .find_map(|(i, l)| labels[..i].contains(l).then_some(l))
            {
                return Err(MediaError::Renditions(format!("{twice} is named twice")));
            }
            let mut specs: Vec<RenditionSpec> = offered
                .into_iter()
                .filter(|o| labels.contains(&o.label))
                .collect();
            specs.sort_by_key(|s| std::cmp::Reverse(s.short_side));
            specs
        }
    };
    Ok(LadderPlan {
        source: probe.clone(),
        renditions: specs,
        thumbnail_times: thumbnail_times(probe.duration_sec),
        storyboard: storyboard_geometry(probe.duration_sec),
    })
}
