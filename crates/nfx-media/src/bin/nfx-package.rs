//! `nfx-package <input> --video <namespace:video-id> --out <dir> [--max-height N]
//! [--preset P] [--no-thumb] [--keep-work]`
//!
//! Packages a video as NFX-05 content into `<dir>/store` (files named by sha256) and
//! writes `<dir>/nfx.json` (`root`, `video`, `segs`), the layout the spike origin, the
//! Tauri spike and `nfx-verify-store` read. Uses `ffmpeg`/`ffprobe` from `PATH`, or
//! `NFX_FFMPEG` / `NFX_FFPROBE`.

use std::path::PathBuf;
use std::process::ExitCode;

use nfx_media::package::{PackageOptions, SystemRunner, package};
use nfx_proto::namespace::VideoAddr;

fn usage() -> ExitCode {
    eprintln!(
        "usage: nfx-package <input> --video <namespace:video-id> --out <dir> [--max-height N] [--preset P] [--no-thumb] [--keep-work]"
    );
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (mut input, mut video, mut out, mut max_height, mut preset) =
        (None, None, None, None, None);
    let (mut thumbnail, mut keep_work) = (true, false);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--video" => video = args.next(),
            "--out" => out = args.next().map(PathBuf::from),
            "--max-height" => max_height = args.next().and_then(|v| v.parse().ok()),
            "--preset" => preset = args.next(),
            "--no-thumb" => thumbnail = false,
            "--keep-work" => keep_work = true,
            s if !s.starts_with("--") && input.is_none() => input = Some(PathBuf::from(s)),
            _ => return usage(),
        }
    }
    let (Some(input), Some(video), Some(out)) = (input, video, out) else {
        return usage();
    };
    let video = match VideoAddr::parse(&video) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("--video: {e}");
            return ExitCode::from(2);
        }
    };
    let runner = SystemRunner {
        ffmpeg: std::env::var_os("NFX_FFMPEG").map_or_else(|| "ffmpeg".into(), PathBuf::from),
        ffprobe: std::env::var_os("NFX_FFPROBE").map_or_else(|| "ffprobe".into(), PathBuf::from),
    };
    let work = out.join("work");
    let opts = PackageOptions {
        video: video.clone(),
        max_height,
        preset,
        thumbnail,
    };
    let result = package(&input, &out.join("store"), &work, &runner, &opts);
    if !keep_work {
        let _ = std::fs::remove_dir_all(&work);
    }
    match result {
        Ok(p) => {
            let meta = serde_json::json!({ "root": p.root_hex(), "video": video.to_string(), "segs": p.segs() });
            let text = format!("{}\n", serde_json::to_string_pretty(&meta).expect("json"));
            if let Err(e) = std::fs::write(out.join("nfx.json"), &text) {
                eprintln!("writing nfx.json: {e}");
                return ExitCode::FAILURE;
            }
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("nfx-package: {e}");
            ExitCode::FAILURE
        }
    }
}
