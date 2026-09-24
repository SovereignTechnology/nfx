//! WebVTT for a storyboard sprite (port of L8 `storyboard.ts`): one cue per tile, with the
//! `#xywh=` media-fragment players understand (video.js, hls.js, Shaka).

pub struct StoryboardVttInput<'a> {
    pub duration_sec: f64,
    pub interval_sec: u32,
    pub cols: u32,
    pub rows: u32,
    /// Full sprite dimensions as probed from the emitted JPEG.
    pub sprite_width: u32,
    pub sprite_height: u32,
    /// URL or content name the cues point at.
    pub sprite_url: &'a str,
}

#[must_use]
pub fn vtt_timestamp(sec: f64) -> String {
    let s = sec.max(0.0);
    let h = (s / 3600.0).floor();
    let m = ((s % 3600.0) / 60.0).floor();
    let rest = s - h * 3600.0 - m * 60.0;
    let whole = rest.floor();
    let ms = ((rest - whole) * 1000.0).round();
    let ms = if ms >= 1000.0 { 999.0 } else { ms };
    format!("{h:02.0}:{m:02.0}:{whole:02.0}.{ms:03.0}")
}

#[must_use]
pub fn storyboard_vtt(input: &StoryboardVttInput<'_>) -> String {
    let tile_w = input.sprite_width / input.cols.max(1);
    let tile_h = input.sprite_height / input.rows.max(1);
    let mut lines = vec!["WEBVTT".to_owned(), String::new()];
    for i in 0..input.cols * input.rows {
        let start = f64::from(i * input.interval_sec);
        if start >= input.duration_sec {
            break;
        }
        let end = input
            .duration_sec
            .min(start + f64::from(input.interval_sec));
        let x = (i % input.cols) * tile_w;
        let y = (i / input.cols) * tile_h;
        lines.push(format!(
            "{} --> {}",
            vtt_timestamp(start),
            vtt_timestamp(end)
        ));
        lines.push(format!(
            "{}#xywh={x},{y},{tile_w},{tile_h}",
            input.sprite_url
        ));
        lines.push(String::new());
    }
    lines.join("\n")
}
