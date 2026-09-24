//! The rendition ladder (port of L8 `ladder.ts`, build-plan §6.4): 1080p / 720p / 360p,
//! never upscaled, one keyframe interval for every rendition so switches align.

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
    pub height: u32,
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
}

pub const LADDER_TIERS: [Tier; 3] = [
    Tier {
        label: "1080p",
        height: 1080,
        video_bitrate_kbps: 5000,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "720p",
        height: 720,
        video_bitrate_kbps: 2500,
        audio_bitrate_kbps: 128,
    },
    Tier {
        label: "360p",
        height: 360,
        video_bitrate_kbps: 800,
        audio_bitrate_kbps: 96,
    },
];

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
    /// "1080p" | "720p" | "360p" — never taller than the source.
    pub label: String,
    pub height: u32,
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

/// Plan the renditions for a probed source.
pub fn plan_ladder(
    probe: &MediaProbe,
    max_height: Option<u32>,
    codec: Codec,
) -> Result<LadderPlan> {
    let video = probe
        .video
        .as_ref()
        .ok_or_else(|| MediaError::NoVideoStream("input has no video stream".into()))?;
    let container = codec_container(codec);
    let (_, src_height) = display_dimensions(video);
    let cap = max_height.map_or(src_height, |m| src_height.min(m));
    let scale = bitrate_scale(codec);

    let mut renditions: Vec<RenditionSpec> = LADDER_TIERS
        .iter()
        .filter(|t| t.height <= cap)
        .map(|t| RenditionSpec {
            label: t.label.to_owned(),
            height: t.height,
            video_bitrate_kbps: round_u32(f64::from(t.video_bitrate_kbps) * scale),
            audio_bitrate_kbps: t.audio_bitrate_kbps,
            codec,
            container,
        })
        .collect();

    if renditions.is_empty() {
        // Source shorter than the lowest tier: one rendition at native (even) height.
        let h = 2.max(cap - cap % 2);
        let lowest = &LADDER_TIERS[LADDER_TIERS.len() - 1];
        let vk = round_u32(
            f64::from(lowest.video_bitrate_kbps) * f64::from(h) / f64::from(lowest.height),
        );
        renditions.push(RenditionSpec {
            label: format!("{h}p"),
            height: h,
            video_bitrate_kbps: 200.max(round_u32(f64::from(vk) * scale)),
            audio_bitrate_kbps: lowest.audio_bitrate_kbps,
            codec,
            container,
        });
    }

    Ok(LadderPlan {
        source: probe.clone(),
        renditions,
        thumbnail_times: thumbnail_times(probe.duration_sec),
        storyboard: storyboard_geometry(probe.duration_sec),
    })
}
