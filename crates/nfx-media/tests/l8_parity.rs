//! The demo's L8 unit tests (`packages/core/src/media/__tests__/{ladder,argv,ffprobe}.test.ts`),
//! ported case by case, so the Rust planning code is held to the same expectations as the
//! TypeScript it replaces.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::float_cmp)]

use nfx_media::MediaError;
use nfx_media::argv::{
    format_seconds, gop_frames, placeholder_argv, rendition_argv, rendition_cmaf_argv,
    rendition_dimensions, storyboard_argv, thumbnail_argv,
};
use nfx_media::ladder::{
    Codec, Container, LADDER_TIERS, RenditionSpec, STORYBOARD_MAX_TILES, StoryboardGeometry,
    fit_to_height, plan_ladder, storyboard_geometry, thumbnail_times,
};
use nfx_media::probe::{
    AudioInfo, MediaProbe, VideoInfo, ffprobe_argv, parse_ffprobe_json, parse_rational,
};
use nfx_media::storyboard::{StoryboardVttInput, storyboard_vtt, vtt_timestamp};

fn src(width: u32, height: u32, rotation: Option<u32>, duration_sec: f64) -> MediaProbe {
    MediaProbe {
        container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
        duration_sec,
        bitrate_kbps: None,
        video: Some(VideoInfo {
            codec: "h264".into(),
            width,
            height,
            fps: 30.0,
            rotation,
            pixel_format: None,
        }),
        audio: Some(AudioInfo {
            codec: "aac".into(),
            channels: 2,
            sample_rate: 48000,
        }),
    }
}

fn labels(p: &MediaProbe, max: Option<u32>, codec: Codec) -> Vec<String> {
    plan_ladder(p, max, codec)
        .unwrap()
        .renditions
        .into_iter()
        .map(|r| r.label)
        .collect()
}

// ---------------------------------------------------------------- ladder.test.ts

#[test]
fn ladder_1080p_source_gives_three_h264_mp4_tiers() {
    let plan = plan_ladder(&src(1920, 1080, None, 120.0), None, Codec::H264).unwrap();
    assert_eq!(
        plan.renditions
            .iter()
            .map(|r| r.label.as_str())
            .collect::<Vec<_>>(),
        ["1080p", "720p", "360p"]
    );
    assert!(
        plan.renditions
            .iter()
            .all(|r| r.codec == Codec::H264 && r.container == Container::Mp4)
    );
    assert_eq!(
        plan.renditions[0],
        RenditionSpec {
            label: "1080p".into(),
            height: 1080,
            video_bitrate_kbps: 5000,
            audio_bitrate_kbps: 128,
            codec: Codec::H264,
            container: Container::Mp4,
        }
    );
}

#[test]
fn ladder_never_upscales() {
    assert_eq!(
        labels(&src(1280, 720, None, 120.0), None, Codec::H264),
        ["720p", "360p"]
    );
    assert_eq!(
        labels(&src(854, 480, None, 120.0), None, Codec::H264),
        ["360p"]
    );
}

#[test]
fn ladder_caps_4k_at_1080p() {
    assert_eq!(
        labels(&src(3840, 2160, None, 120.0), None, Codec::H264),
        ["1080p", "720p", "360p"]
    );
}

#[test]
fn ladder_below_360p_yields_one_native_even_rendition() {
    let plan = plan_ladder(&src(320, 240, None, 120.0), None, Codec::H264).unwrap();
    assert_eq!(plan.renditions.len(), 1);
    assert_eq!(plan.renditions[0].label, "240p");
    assert_eq!(plan.renditions[0].height, 240);
    assert!(plan.renditions[0].video_bitrate_kbps >= 200);
    assert_eq!(
        plan_ladder(&src(200, 135, None, 120.0), None, Codec::H264)
            .unwrap()
            .renditions[0]
            .height,
        134
    );
}

#[test]
fn ladder_uses_rotated_display_height() {
    assert_eq!(
        labels(&src(1920, 1080, Some(90), 120.0), None, Codec::H264),
        ["1080p", "720p", "360p"]
    );
}

#[test]
fn ladder_honours_max_height_and_codec() {
    let plan = plan_ladder(&src(1920, 1080, None, 120.0), Some(720), Codec::Vp9).unwrap();
    assert_eq!(
        plan.renditions
            .iter()
            .map(|r| r.label.as_str())
            .collect::<Vec<_>>(),
        ["720p", "360p"]
    );
    assert!(
        plan.renditions
            .iter()
            .all(|r| r.codec == Codec::Vp9 && r.container == Container::Webm)
    );
    assert!(plan.renditions[0].video_bitrate_kbps < 2500);
    assert_eq!(
        plan_ladder(&src(1920, 1080, None, 120.0), None, Codec::Av1)
            .unwrap()
            .renditions[0]
            .container,
        Container::Mp4
    );
}

#[test]
fn ladder_rejects_audio_only_input() {
    let audio_only = MediaProbe {
        container: "mp3".into(),
        duration_sec: 10.0,
        bitrate_kbps: None,
        video: None,
        audio: Some(AudioInfo {
            codec: "mp3".into(),
            channels: 2,
            sample_rate: 44100,
        }),
    };
    assert!(matches!(
        plan_ladder(&audio_only, None, Codec::H264),
        Err(MediaError::NoVideoStream(_))
    ));
}

#[test]
fn ladder_adds_thumbnails_and_storyboard() {
    let plan = plan_ladder(&src(1920, 1080, None, 100.0), None, Codec::H264).unwrap();
    assert_eq!(plan.thumbnail_times, [10.0, 30.0, 50.0, 70.0]);
    assert_eq!(
        plan.storyboard,
        Some(StoryboardGeometry {
            interval_sec: 1,
            cols: 10,
            rows: 10,
            tile_width: 160
        })
    );
    assert_eq!(LADDER_TIERS.map(|t| t.height), [1080, 720, 360]);
}

#[test]
fn fit_to_height_keeps_aspect_and_even_dimensions() {
    assert_eq!(fit_to_height((1920, 1080), 720), (1280, 720));
    assert_eq!(fit_to_height((1920, 1080), 360), (640, 360));
    assert_eq!(fit_to_height((1080, 1920), 720), (406, 720));
    assert_eq!(fit_to_height((4, 3), 361), (480, 360));
}

#[test]
fn thumbnail_times_spread_dedup_and_stay_inside() {
    assert_eq!(thumbnail_times(10.0), [1.0, 3.0, 5.0, 7.0]);
    assert_eq!(thumbnail_times(0.0), [0.0]);
    assert_eq!(thumbnail_times(f64::NAN), [0.0]);
    assert_eq!(thumbnail_times(0.001), [0.0]);
    assert!(thumbnail_times(0.5).iter().all(|t| *t < 0.5));
}

#[test]
fn storyboard_geometry_picks_the_smallest_interval() {
    assert_eq!(
        storyboard_geometry(30.0),
        Some(StoryboardGeometry {
            interval_sec: 1,
            cols: 10,
            rows: 3,
            tile_width: 160
        })
    );
    assert_eq!(storyboard_geometry(101.0).unwrap().interval_sec, 2);
    assert_eq!(storyboard_geometry(3600.0).unwrap().interval_sec, 60);
    let long = storyboard_geometry(6.0 * 3600.0).unwrap();
    assert!(
        (6.0 * 3600.0 / f64::from(long.interval_sec)).ceil() <= f64::from(STORYBOARD_MAX_TILES)
    );
    assert_eq!(
        storyboard_geometry(3.0),
        Some(StoryboardGeometry {
            interval_sec: 1,
            cols: 3,
            rows: 1,
            tile_width: 160
        })
    );
    assert_eq!(storyboard_geometry(0.0), None);
}

// ---------------------------------------------------------------- argv.test.ts

fn source() -> MediaProbe {
    let mut s = src(1920, 1080, None, 60.0);
    s.video.as_mut().unwrap().fps = 29.97;
    s
}

fn spec720() -> RenditionSpec {
    RenditionSpec {
        label: "720p".into(),
        height: 720,
        video_bitrate_kbps: 2500,
        audio_bitrate_kbps: 128,
        codec: Codec::H264,
        container: Container::Mp4,
    }
}

fn opt<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == flag)
        .and_then(|i| argv.get(i + 1))
        .map(String::as_str)
}

#[test]
fn rendition_argv_is_a_plain_argv_array() {
    let argv = rendition_argv(
        "/in/a.mp4",
        "/out/720p.mp4",
        &source(),
        &spec720(),
        29.97,
        Some("medium"),
    )
    .unwrap();
    assert_eq!(argv[0], "-hide_banner");
    assert_eq!(opt(&argv, "-i"), Some("/in/a.mp4"));
    assert_eq!(argv.last().unwrap(), "/out/720p.mp4");
    assert!(argv.iter().any(|a| a == "-nostdin") && argv.iter().any(|a| a == "-y"));

    let joined = argv.join(" ");
    assert!(joined.contains("-movflags +faststart"));
    for (flag, want) in [
        ("-f", "mp4"),
        ("-c:v", "libx264"),
        ("-c:a", "aac"),
        ("-preset", "medium"),
        ("-pix_fmt", "yuv420p"),
        ("-b:v", "2500k"),
        ("-maxrate", "3750k"),
        ("-bufsize", "5000k"),
        ("-b:a", "128k"),
        ("-g", "60"),
        ("-keyint_min", "60"),
        ("-sc_threshold", "0"),
        ("-force_key_frames", "expr:gte(t,n_forced*2)"),
        ("-vf", "scale=1280:720"),
        ("-map_metadata", "-1"),
        ("-map_chapters", "-1"),
        ("-progress", "pipe:2"),
    ] {
        assert_eq!(opt(&argv, flag), Some(want), "{flag}");
    }
    assert_eq!(
        rendition_dimensions(&source(), &spec720()).unwrap(),
        (1280, 720)
    );
    assert!(joined.contains("-map 0:v:0 -map 0:a:0?"));
    for flag in ["-sn", "-dn", "-nostats"] {
        assert!(argv.iter().any(|a| a == flag), "{flag}");
    }
}

#[test]
fn rendition_argv_portrait_vp9_av1_and_gop_fallback() {
    let mut portrait = source();
    portrait.video.as_mut().unwrap().rotation = Some(90);
    assert_eq!(
        opt(
            &rendition_argv("/in", "/out", &portrait, &spec720(), 30.0, None).unwrap(),
            "-vf"
        ),
        Some("scale=406:720")
    );

    let vp9 = rendition_argv(
        "/i",
        "/o.webm",
        &source(),
        &RenditionSpec {
            codec: Codec::Vp9,
            container: Container::Webm,
            ..spec720()
        },
        30.0,
        None,
    )
    .unwrap();
    assert_eq!(opt(&vp9, "-c:v"), Some("libvpx-vp9"));
    assert_eq!(opt(&vp9, "-c:a"), Some("libopus"));
    assert_eq!(opt(&vp9, "-f"), Some("webm"));
    assert!(!vp9.iter().any(|a| a == "-movflags"));
    let av1 = rendition_argv(
        "/i",
        "/o.mp4",
        &source(),
        &RenditionSpec {
            codec: Codec::Av1,
            ..spec720()
        },
        30.0,
        None,
    )
    .unwrap();
    assert_eq!(opt(&av1, "-c:v"), Some("libsvtav1"));
    assert!(av1.join(" ").contains("-movflags +faststart"));

    assert_eq!(gop_frames(0.0), 60);
    assert_eq!(gop_frames(24.0), 48);
    assert_eq!(gop_frames(0.2), 1);
}

#[test]
fn hostile_filenames_stay_single_argv_elements() {
    let hostile = "/tmp/up loads/$(touch /tmp/pwned); rm -rf ~ #`id`'\"|&&.mp4";
    let hostile_out = "/tmp/out dir/$(reboot)/720p.mp4";
    let sb = StoryboardGeometry {
        interval_sec: 1,
        cols: 10,
        rows: 2,
        tile_width: 160,
    };
    for argv in [
        rendition_argv(hostile, hostile_out, &source(), &spec720(), 30.0, None).unwrap(),
        thumbnail_argv(hostile, hostile_out, 1.0, 640),
        placeholder_argv(hostile, hostile_out, 1.0),
        storyboard_argv(hostile, hostile_out, &sb),
    ] {
        assert_eq!(opt(&argv, "-i"), Some(hostile));
        assert_eq!(argv.last().unwrap(), hostile_out);
        assert_eq!(
            argv.iter()
                .filter(|a| a.contains("$(") || a.contains("rm -rf"))
                .count(),
            2
        );
        assert!(
            !argv
                .iter()
                .any(|a| a == "-c" || a == "/bin/sh" || a == "sh")
        );
    }
    let argv = rendition_argv(hostile, hostile_out, &source(), &spec720(), 30.0, None).unwrap();
    let vf = opt(&argv, "-vf").unwrap();
    assert!(
        vf.strip_prefix("scale=")
            .unwrap()
            .split(':')
            .all(|n| n.parse::<u32>().is_ok())
    );
    let sb5 = StoryboardGeometry {
        interval_sec: 5,
        cols: 10,
        rows: 3,
        tile_width: 160,
    };
    assert_eq!(
        opt(&storyboard_argv(hostile, hostile_out, &sb5), "-vf"),
        Some("fps=1/5,scale=160:-2,tile=10x3")
    );
}

#[test]
fn still_image_argv_and_seconds_formatting() {
    let a = thumbnail_argv("/in.mp4", "/t.jpg", 12.3456, 640);
    assert!(a.iter().position(|x| x == "-ss") < a.iter().position(|x| x == "-i"));
    assert_eq!(opt(&a, "-ss"), Some("12.346"));
    assert_eq!(opt(&a, "-frames:v"), Some("1"));
    assert_eq!(opt(&a, "-vf"), Some("scale='min(640,iw)':-2"));
    assert_eq!(opt(&a, "-q:v"), Some("2"));
    assert_eq!(opt(&a, "-f"), Some("image2"));
    let p = placeholder_argv("/in.mp4", "/p.jpg", 0.0);
    assert_eq!(opt(&p, "-vf"), Some("scale=32:-2"));
    assert_eq!(opt(&p, "-q:v"), Some("12"));
    let s = storyboard_argv(
        "/in.mp4",
        "/s.jpg",
        &StoryboardGeometry {
            interval_sec: 2,
            cols: 10,
            rows: 5,
            tile_width: 160,
        },
    );
    assert_eq!(opt(&s, "-vf"), Some("fps=1/2,scale=160:-2,tile=10x5"));
    assert_eq!(opt(&s, "-frames:v"), Some("1"));
    assert_eq!(format_seconds(1e-7), "0.000");
    assert_eq!(format_seconds(-5.0), "0.000");
    assert_eq!(format_seconds(3600.5), "3600.500");
    assert_eq!(format_seconds(f64::NAN), "0.000");
}

// NFX addition: the CMAF tail.
#[test]
fn cmaf_argv_keeps_the_l8_head_and_swaps_the_container() {
    let dir = std::path::Path::new("/w/720p");
    let cmaf = rendition_cmaf_argv("/in", dir, &source(), &spec720(), 30.0, None).unwrap();
    let l8 = rendition_argv("/in", "/out.mp4", &source(), &spec720(), 30.0, None).unwrap();
    let head = l8.iter().position(|a| a == "-movflags").unwrap();
    assert_eq!(cmaf[..head], l8[..head], "identical encode settings");
    for (flag, want) in [
        ("-f", "hls"),
        ("-hls_time", "2"),
        ("-hls_playlist_type", "vod"),
        ("-hls_segment_type", "fmp4"),
        ("-hls_flags", "independent_segments"),
        ("-hls_fmp4_init_filename", "init.mp4"),
        ("-hls_segment_filename", "/w/720p/seg_%05d.m4s"),
    ] {
        assert_eq!(opt(&cmaf, flag), Some(want), "{flag}");
    }
    assert_eq!(cmaf.last().unwrap(), "/w/720p/index.m3u8");
    assert!(!cmaf.iter().any(|a| a == "-movflags"));
    assert!(
        rendition_cmaf_argv(
            "/in",
            std::path::Path::new("/w/100%d"),
            &source(),
            &spec720(),
            30.0,
            None
        )
        .is_err()
    );
}

// ---------------------------------------------------------------- ffprobe.test.ts

const REAL: &str = r#"{
  "streams": [
    { "index": 0, "codec_name": "h264", "codec_type": "video", "width": 640, "height": 360,
      "pix_fmt": "yuv420p", "r_frame_rate": "30/1", "avg_frame_rate": "30/1",
      "duration": "3.000000", "bit_rate": "183773", "disposition": { "attached_pic": 0 },
      "side_data_list": [ { "side_data_type": "Display Matrix", "rotation": 90 } ] },
    { "index": 1, "codec_name": "aac", "codec_type": "audio", "sample_rate": "44100",
      "channels": 1, "channel_layout": "mono", "bit_rate": "69594" }
  ],
  "format": { "filename": "in.mp4", "nb_streams": 2, "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
    "duration": "3.000000", "size": "99185", "bit_rate": "264493" }
}"#;

#[test]
fn ffprobe_argv_keeps_the_path_whole() {
    let hostile = "/tmp/x/; rm -rf / #$(id) 'a b'.mp4";
    let argv = ffprobe_argv(hostile);
    assert_eq!(argv.last().unwrap(), hostile);
    assert!(argv.iter().any(|a| a == "json"));
    assert_eq!(argv.iter().filter(|a| a.contains("rm -rf")).count(), 1);
}

#[test]
fn ffprobe_real_document() {
    assert_eq!(
        parse_ffprobe_json(REAL).unwrap(),
        MediaProbe {
            container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
            duration_sec: 3.0,
            bitrate_kbps: Some(264),
            video: Some(VideoInfo {
                codec: "h264".into(),
                width: 640,
                height: 360,
                fps: 30.0,
                rotation: Some(90),
                pixel_format: Some("yuv420p".into())
            }),
            audio: Some(AudioInfo {
                codec: "aac".into(),
                channels: 1,
                sample_rate: 44100
            }),
        }
    );
}

#[test]
fn ffprobe_edge_cases() {
    let zero = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"tags":{"rotate":"0"}}],"format":{"format_name":"mov","duration":"10"}}"#;
    let p = parse_ffprobe_json(zero).unwrap();
    assert_eq!(p.video.unwrap().rotation, None);
    assert!(p.audio.is_none());

    let cover = r#"{"streams":[{"codec_type":"video","codec_name":"mjpeg","width":300,"height":300,"disposition":{"attached_pic":1}},{"codec_type":"audio","codec_name":"mp3","channels":2,"sample_rate":"44100"}],"format":{"format_name":"mp3","duration":"200.5"}}"#;
    let p = parse_ffprobe_json(cover).unwrap();
    assert!(p.video.is_none());
    assert_eq!(p.audio.unwrap().codec, "mp3");
    assert_eq!(p.duration_sec, 200.5);

    let stream_dur = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":16,"height":16,"duration":"4.5"}],"format":{"format_name":"h264"}}"#;
    assert_eq!(parse_ffprobe_json(stream_dur).unwrap().duration_sec, 4.5);

    let legacy = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":16,"height":16,"tags":{"rotate":"270"}}],"format":{"format_name":"mov","duration":"1"}}"#;
    assert_eq!(
        parse_ffprobe_json(legacy).unwrap().video.unwrap().rotation,
        Some(270)
    );

    for bad in [
        "not json",
        "[]",
        "{}",
        r#"{"format":{"format_name":"mp4"},"streams":[{"codec_type":"video"}]}"#,
    ] {
        assert!(
            matches!(parse_ffprobe_json(bad), Err(MediaError::ProbeParse(_))),
            "{bad}"
        );
    }
    let junk_streams = r#"{"streams":[null,3],"format":{"format_name":"mp4","duration":"1"}}"#;
    assert!(parse_ffprobe_json(junk_streams).unwrap().video.is_none());

    let r = |s: &str| parse_rational(Some(&serde_json::Value::String(s.into())));
    assert!((r("30000/1001").unwrap() - 29.97).abs() < 0.001);
    assert_eq!(r("0/0"), None);
}

// ---------------------------------------------------------------- storyboard.ts

#[test]
fn storyboard_vtt_cues() {
    assert_eq!(vtt_timestamp(3661.5), "01:01:01.500");
    assert_eq!(vtt_timestamp(-1.0), "00:00:00.000");
    let vtt = storyboard_vtt(&StoryboardVttInput {
        duration_sec: 2.5,
        interval_sec: 1,
        cols: 2,
        rows: 2,
        sprite_width: 320,
        sprite_height: 180,
        sprite_url: "s.jpg",
    });
    assert_eq!(
        vtt,
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\ns.jpg#xywh=0,0,160,90\n\n00:00:01.000 --> 00:00:02.000\ns.jpg#xywh=160,0,160,90\n\n00:00:02.000 --> 00:00:02.500\ns.jpg#xywh=0,90,160,90\n"
    );
}

// NFX addition: every input is opened as a local file with a known demuxer.
#[test]
fn every_invocation_guards_its_input() {
    use nfx_media::argv::INPUT_GUARD;
    use nfx_media::probe::ffprobe_argv;
    let sb = storyboard_geometry(120.0).unwrap();
    let all = [
        rendition_argv("/in", "/out.mp4", &source(), &spec720(), 30.0, None).unwrap(),
        rendition_cmaf_argv(
            "/in",
            std::path::Path::new("/w"),
            &source(),
            &spec720(),
            30.0,
            None,
        )
        .unwrap(),
        thumbnail_argv("/in", "/t.jpg", 1.0, 640),
        placeholder_argv("/in", "/p.jpg", 1.0),
        storyboard_argv("/in", "/s.jpg", &sb),
        ffprobe_argv("/in"),
    ];
    for argv in &all {
        let input = argv
            .iter()
            .position(|a| a == "-i")
            .unwrap_or(argv.len() - 1);
        let guard = argv
            .windows(4)
            .position(|w| w == INPUT_GUARD)
            .unwrap_or_else(|| panic!("no input guard in {argv:?}"));
        assert!(guard < input, "the guard precedes the input: {argv:?}");
    }
}
