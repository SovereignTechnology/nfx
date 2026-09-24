//! ffmpeg argv builders (port of L8 `argv.ts`), plus the NFX CMAF tail.
//!
//! Every function returns an argv vector for a direct process spawn. There is no shell
//! anywhere, so a filename like `; rm -rf / #.mp4` is just a filename. Filter graphs are
//! built from numbers this crate computed, never from user input.

use std::path::Path;

use crate::ladder::{
    Codec, Container, GOP_SECONDS, RenditionSpec, StoryboardGeometry, fit_to_height,
};
use crate::probe::{MediaProbe, display_dimensions};
use crate::{MediaError, Result};

/// `-hide_banner -nostdin -y -loglevel error`: stderr carries only real errors (plus the
/// `-progress pipe:2` lines for renditions).
const COMMON: [&str; 5] = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];

/// Placeholder width in px (~500 bytes of JPEG, small enough to inline).
pub const PLACEHOLDER_WIDTH: u32 = 32;
pub const THUMBNAIL_WIDTH: u32 = 640;

fn owned(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

/// GOP length in frames for keyframe-aligned switching: `fps × GOP_SECONDS`, min 1.
#[must_use]
pub fn gop_frames(fps: f64) -> u32 {
    let fps = if fps > 0.0 { fps } else { 30.0 };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let g = (fps * f64::from(GOP_SECONDS)).round() as u32;
    g.max(1)
}

/// The exact output dimensions a rendition will have (even, aspect-preserving).
pub fn rendition_dimensions(source: &MediaProbe, spec: &RenditionSpec) -> Result<(u32, u32)> {
    let video = source
        .video
        .as_ref()
        .ok_or_else(|| MediaError::NoVideoStream("source has no video".into()))?;
    Ok(fit_to_height(display_dimensions(video), spec.height))
}

fn video_codec_args(spec: &RenditionSpec, g: u32, preset: &str) -> Vec<String> {
    let vb = format!("{}k", spec.video_bitrate_kbps);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let maxrate = format!(
        "{}k",
        (f64::from(spec.video_bitrate_kbps) * 1.5).round() as u32
    );
    let bufsize = format!("{}k", spec.video_bitrate_kbps * 2);
    let g = g.to_string();
    match spec.codec {
        Codec::H264 => owned(&[
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            &vb,
            "-maxrate",
            &maxrate,
            "-bufsize",
            &bufsize,
            "-g",
            &g,
            "-keyint_min",
            &g,
            "-sc_threshold",
            "0",
        ]),
        Codec::Vp9 => owned(&[
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            &vb,
            "-maxrate",
            &maxrate,
            "-bufsize",
            &bufsize,
            "-row-mt",
            "1",
            "-g",
            &g,
            "-keyint_min",
            &g,
        ]),
        Codec::Av1 => owned(&[
            "-c:v",
            "libsvtav1",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            &vb,
            "-maxrate",
            &maxrate,
            "-bufsize",
            &bufsize,
            "-g",
            &g,
        ]),
    }
}

fn audio_codec_args(spec: &RenditionSpec) -> Vec<String> {
    let ab = format!("{}k", spec.audio_bitrate_kbps);
    match spec.container {
        Container::Webm => owned(&["-c:a", "libopus", "-b:a", &ab, "-ac", "2", "-ar", "48000"]),
        Container::Mp4 => owned(&["-c:a", "aac", "-b:a", &ab, "-ac", "2", "-ar", "48000"]),
    }
}

/// Everything up to (not including) the container: input, maps, scale, codecs, forced
/// keyframes every `GOP_SECONDS` (so every rendition's keyframes line up), audio, and
/// stripped subtitles/data/metadata/chapters. Shared by the L8 and NFX tails.
fn rendition_head(
    input: &str,
    source: &MediaProbe,
    spec: &RenditionSpec,
    fps: f64,
    preset: Option<&str>,
) -> Result<Vec<String>> {
    let (w, h) = rendition_dimensions(source, spec)?;
    let mut argv = owned(&COMMON);
    argv.extend(owned(&[
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        &format!("scale={w}:{h}"),
    ]));
    argv.extend(video_codec_args(
        spec,
        gop_frames(fps),
        preset.unwrap_or("medium"),
    ));
    argv.extend(owned(&[
        "-force_key_frames",
        &format!("expr:gte(t,n_forced*{GOP_SECONDS})"),
    ]));
    argv.extend(audio_codec_args(spec));
    argv.extend(owned(&[
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
    ]));
    Ok(argv)
}

/// L8's progressive rendition (faststart MP4 or WebM). Kept for parity with the demo; NFX
/// packaging uses [`rendition_cmaf_argv`].
pub fn rendition_argv(
    input: &str,
    output: &str,
    source: &MediaProbe,
    spec: &RenditionSpec,
    fps: f64,
    preset: Option<&str>,
) -> Result<Vec<String>> {
    let mut argv = rendition_head(input, source, spec, fps, preset)?;
    match spec.container {
        Container::Mp4 => argv.extend(owned(&["-movflags", "+faststart", "-f", "mp4"])),
        Container::Webm => argv.extend(owned(&["-f", "webm"])),
    }
    argv.extend(owned(&["-progress", "pipe:2", "-nostats", output]));
    Ok(argv)
}

/// The NFX-05 rendition: L8's head with a CMAF tail. HLS VOD, fMP4 segments of exactly
/// `GOP_SECONDS`, `EXT-X-INDEPENDENT-SEGMENTS`, `init.mp4` + `seg_%05d.m4s` + `index.m3u8`
/// inside `out_dir`.
///
/// `out_dir` must not contain `%`: ffmpeg expands `-hls_segment_filename` as a format
/// string, so a `%` in the directory would be interpreted, not written.
pub fn rendition_cmaf_argv(
    input: &str,
    out_dir: &Path,
    source: &MediaProbe,
    spec: &RenditionSpec,
    fps: f64,
    preset: Option<&str>,
) -> Result<Vec<String>> {
    let dir = out_dir
        .to_str()
        .ok_or_else(|| MediaError::Package("output directory is not UTF-8".into()))?;
    if dir.contains('%') {
        return Err(MediaError::Package(
            "output directory must not contain '%'".into(),
        ));
    }
    let mut argv = rendition_head(input, source, spec, fps, preset)?;
    let segment_pattern = out_dir.join("seg_%05d.m4s");
    let playlist = out_dir.join("index.m3u8");
    argv.extend(owned(&[
        "-f",
        "hls",
        "-hls_time",
        &GOP_SECONDS.to_string(),
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "fmp4",
        "-hls_flags",
        "independent_segments",
        "-hls_fmp4_init_filename",
        "init.mp4",
        "-hls_segment_filename",
        segment_pattern.to_str().unwrap_or_default(),
        "-progress",
        "pipe:2",
        "-nostats",
        playlist.to_str().unwrap_or_default(),
    ]));
    Ok(argv)
}

/// Seconds as ffmpeg accepts them: fixed 3 decimals, never exponent notation, never
/// negative. (Rust rounds exact binary ties to even where JS `toFixed` rounds them up;
/// the difference is at most 1 ms on a seek position.)
#[must_use]
pub fn format_seconds(t: f64) -> String {
    let t = if t.is_finite() && t > 0.0 { t } else { 0.0 };
    format!("{t:.3}")
}

/// Single JPEG frame at `time_sec` (input-side seek), scaled to at most `width`.
#[must_use]
pub fn thumbnail_argv(input: &str, output: &str, time_sec: f64, width: u32) -> Vec<String> {
    let mut argv = owned(&COMMON);
    argv.extend(owned(&[
        "-ss",
        &format_seconds(time_sec),
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        &format!("scale='min({width},iw)':-2"),
        "-q:v",
        "2",
        "-f",
        "image2",
        output,
    ]));
    argv
}

/// Tiny low-quality JPEG for a blur-up placeholder.
#[must_use]
pub fn placeholder_argv(input: &str, output: &str, time_sec: f64) -> Vec<String> {
    let mut argv = owned(&COMMON);
    argv.extend(owned(&[
        "-ss",
        &format_seconds(time_sec),
        "-i",
        input,
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={PLACEHOLDER_WIDTH}:-2"),
        "-q:v",
        "12",
        "-f",
        "image2",
        output,
    ]));
    argv
}

/// Storyboard sprite: one frame every `interval_sec`, tiled `cols × rows`, one JPEG.
#[must_use]
pub fn storyboard_argv(input: &str, output: &str, sb: &StoryboardGeometry) -> Vec<String> {
    let mut argv = owned(&COMMON);
    argv.extend(owned(&[
        "-i",
        input,
        "-vf",
        &format!(
            "fps=1/{},scale={}:-2,tile={}x{}",
            sb.interval_sec, sb.tile_width, sb.cols, sb.rows
        ),
        "-frames:v",
        "1",
        "-q:v",
        "4",
        "-f",
        "image2",
        output,
    ]));
    argv
}
