//! ffprobe argv and JSON parsing (port of L8 `ffprobe.ts`).

use serde_json::Value;

use crate::{MediaError, Result};

/// What packaging needs to know about a source file.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaProbe {
    /// e.g. `"mov,mp4,m4a,3gp,3g2,mj2"`.
    pub container: String,
    pub duration_sec: f64,
    pub bitrate_kbps: Option<u64>,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoInfo {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// 90/180/270; absent when 0.
    pub rotation: Option<u32>,
    pub pixel_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioInfo {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
}

/// Argv for probing `path`. `path` is one argv element — never shell-interpolated.
#[must_use]
pub fn ffprobe_argv(path: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        path,
    ]
    .map(str::to_owned)
    .to_vec()
}

/// A number, or a string holding one (ffprobe mixes both).
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !s.trim().is_empty() => {
            s.trim().parse::<f64>().ok().filter(|f| f.is_finite())
        }
        _ => None,
    }
}

fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `"30000/1001"` → 29.97; `"0/0"` → `None`.
#[must_use]
pub fn parse_rational(v: Option<&Value>) -> Option<f64> {
    let Some(s) = string(v) else {
        return num(v);
    };
    match s.trim().split_once('/') {
        Some((a, b))
            if !a.trim().is_empty()
                && a.trim().bytes().all(|c| c.is_ascii_digit())
                && !b.trim().is_empty()
                && b.trim().bytes().all(|c| c.is_ascii_digit()) =>
        {
            let a: f64 = a.trim().parse().ok()?;
            let b: f64 = b.trim().parse().ok()?;
            (b != 0.0).then(|| a / b)
        }
        _ => num(v),
    }
}

/// Normalises any rotation to 0/90/180/270.
#[must_use]
pub fn normalise_rotation(v: Option<&Value>) -> Option<u32> {
    let n = num(v)?.round();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let r = (((n % 360.0) + 360.0) % 360.0) as u32;
    Some(r)
}

fn u32_of(v: Option<&Value>) -> Option<u32> {
    let n = num(v)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    (n >= 0.0 && n <= f64::from(u32::MAX)).then_some(n as u32)
}

/// Parse `ffprobe -print_format json -show_format -show_streams` output.
pub fn parse_ffprobe_json(text: &str) -> Result<MediaProbe> {
    let bad = |m: &str| MediaError::ProbeParse(m.to_owned());
    let raw: Value = serde_json::from_str(text).map_err(|_| bad("ffprobe output is not JSON"))?;
    let obj = raw
        .as_object()
        .ok_or_else(|| bad("ffprobe output is not an object"))?;
    let streams: Vec<&Value> = match obj.get("streams") {
        Some(Value::Array(items)) if items.iter().all(Value::is_object) => items.iter().collect(),
        _ => Vec::new(),
    };
    let format = obj.get("format").filter(|f| f.is_object());
    let container = string(format.and_then(|f| f.get("format_name")))
        .ok_or_else(|| bad("ffprobe: missing format.format_name"))?
        .to_owned();

    let video = streams.iter().find(|s| {
        string(s.get("codec_type")) == Some("video")
            && num(s.get("disposition").and_then(|d| d.get("attached_pic"))) != Some(1.0)
    });
    let audio = streams
        .iter()
        .find(|s| string(s.get("codec_type")) == Some("audio"));

    // Some containers (raw streams) carry duration only on the stream.
    let duration_sec = num(format.and_then(|f| f.get("duration")))
        .or_else(|| num(video.and_then(|v| v.get("duration"))))
        .unwrap_or(0.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let bitrate_kbps = num(format.and_then(|f| f.get("bit_rate")))
        .filter(|b| *b >= 0.0)
        .map(|b| (b / 1000.0).round() as u64);

    let video = match video {
        None => None,
        Some(v) => {
            let (Some(codec), Some(width), Some(height)) = (
                string(v.get("codec_name")),
                u32_of(v.get("width")),
                u32_of(v.get("height")),
            ) else {
                return Err(bad("ffprobe: video stream lacks codec/width/height"));
            };
            let fps = parse_rational(v.get("avg_frame_rate"))
                .or_else(|| parse_rational(v.get("r_frame_rate")))
                .unwrap_or(0.0);
            let side_rotation = v
                .get("side_data_list")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().find_map(|d| d.get("rotation")));
            let rotation = normalise_rotation(side_rotation)
                .or_else(|| normalise_rotation(v.get("tags").and_then(|t| t.get("rotate"))))
                .filter(|r| *r != 0);
            Some(VideoInfo {
                codec: codec.to_owned(),
                width,
                height,
                fps,
                rotation,
                pixel_format: string(v.get("pix_fmt")).map(str::to_owned),
            })
        }
    };
    let audio = audio.map(|a| AudioInfo {
        codec: string(a.get("codec_name")).unwrap_or("unknown").to_owned(),
        channels: u32_of(a.get("channels")).unwrap_or(0),
        sample_rate: u32_of(a.get("sample_rate")).unwrap_or(0),
    });
    Ok(MediaProbe {
        container,
        duration_sec,
        bitrate_kbps,
        video,
        audio,
    })
}

/// Display dimensions after the container rotation (90/270 swap width and height).
#[must_use]
pub fn display_dimensions(video: &VideoInfo) -> (u32, u32) {
    match video.rotation {
        Some(90 | 270) => (video.height, video.width),
        _ => (video.width, video.height),
    }
}

#[must_use]
pub fn is_mp4_container(container: &str) -> bool {
    container
        .split(',')
        .any(|c| matches!(c, "mp4" | "mov" | "m4a"))
}
