//! End to end with real ffmpeg: package a synthetic clip and check the NFX-05 result.
//! `#[ignore]`d because the CI image has no ffmpeg; `crates/ci/check.sh` runs it when
//! `ffmpeg` is on `PATH` (override with `NFX_FFMPEG` / `NFX_FFPROBE`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::process::Command;

use nfx_media::package::{PackageOptions, SystemRunner, package};
use nfx_proto::hashlist::Role;
use nfx_proto::namespace::VideoAddr;

fn runner() -> SystemRunner {
    SystemRunner {
        ffmpeg: std::env::var_os("NFX_FFMPEG").map_or_else(|| "ffmpeg".into(), PathBuf::from),
        ffprobe: std::env::var_os("NFX_FFPROBE").map_or_else(|| "ffprobe".into(), PathBuf::from),
    }
}

#[test]
#[ignore = "needs ffmpeg; run by crates/ci/check.sh when available"]
fn packages_a_720p_clip_into_verified_nfx05_content() {
    let tmp = std::env::temp_dir().join(format!("nfx-media-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    // A name with spaces and shell metacharacters: it must reach ffmpeg as one argument.
    let src = tmp.join("source $(id) 'x'.mp4");
    let status = Command::new(&runner().ffmpeg)
        .args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=30:duration=6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=6",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&src)
        .status()
        .unwrap();
    assert!(status.success(), "could not make the source clip");

    let video = VideoAddr::parse("nfx:regtest:1:media-it-clip").unwrap();
    let opts = PackageOptions {
        video: video.clone(),
        max_height: None,
        // Not ultrafast: x264 then drops CABAC/8x8dct and signals the lowest profile the
        // stream fits (Constrained Baseline, avc1.42c01f) even with `-profile:v high`.
        preset: Some("veryfast".into()),
        thumbnail: true,
    };
    let p = package(
        &src,
        &tmp.join("store"),
        &tmp.join("work"),
        &runner(),
        &opts,
    )
    .expect("package");

    assert_eq!(p.hash_list.video, video.to_string());
    assert_eq!(
        p.hash_list
            .renditions
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["720p", "360p"]
    );
    for r in &p.hash_list.renditions {
        let codecs = r.codecs.as_deref().unwrap();
        assert!(
            codecs.starts_with("avc1.64") && codecs.ends_with(",mp4a.40.2"),
            "{codecs}"
        );
    }
    assert_eq!(
        p.hash_list.renditions[0].resolution.as_deref(),
        Some("1280x720")
    );
    let count = |role: Role| p.hash_list.files.iter().filter(|f| f.role == role).count();
    assert_eq!(
        (
            count(Role::PlaylistMaster),
            count(Role::Playlist),
            count(Role::Init),
            count(Role::Segment),
            count(Role::Thumb)
        ),
        (1, 2, 2, 6, 1)
    );
    assert!(
        p.hash_list
            .files
            .iter()
            .filter(|f| f.role == Role::Segment)
            .all(|f| f.dur_ms == Some(2000))
    );
    // The store holds every listed file plus the hash list, all named by sha256.
    let stored = std::fs::read_dir(tmp.join("store")).unwrap().count();
    assert_eq!(stored, p.hash_list.files.len() + 1);
    std::fs::remove_dir_all(&tmp).unwrap();
}
