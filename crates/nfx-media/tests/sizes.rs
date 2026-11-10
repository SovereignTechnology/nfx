//! Rendition sizes (`ladder.rs`): the sizes a source offers, the one-rendition default, and
//! a creator's `--renditions` choice, including 4K. A size is the short side of the picture
//! as displayed, so portrait sources get the same sizes as landscape ones.
//!
//! The `canonical_*` cases are the size rule's vectors, shared word for word with
//! nutflix-pear's `packages/core/src/media/ladder.ts` (its Studio offers the same sizes):
//! change both or neither.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_media::MediaError;
use nfx_media::argv::{rendition_cmaf_argv, rendition_dimensions};
use nfx_media::ladder::{
    Codec, Container, DEFAULT_HEIGHT, LADDER_TIERS, MAX_HEIGHT, RenditionSpec, Renditions,
    StoryboardGeometry, fit_short_side, offered, plan, rendition_at, source_size,
};
use nfx_media::probe::{AudioInfo, MediaProbe, VideoInfo};

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

/// A 16:9 source `height` lines tall.
fn wide(height: u32) -> MediaProbe {
    src(height * 16 / 9, height, None, 120.0)
}

/// A 9:16 source `width` pixels wide: the same size as `wide(width)`, standing up.
fn tall(width: u32) -> MediaProbe {
    src(width, width * 16 / 9, None, 120.0)
}

/// A size as the vectors write it: (label, video kbps, audio kbps).
type Size = (&'static str, u32, u32);

/// (label, video kbps, audio kbps) of each spec.
fn sizes(specs: &[RenditionSpec]) -> Vec<(String, u32, u32)> {
    specs
        .iter()
        .map(|s| (s.label.clone(), s.video_bitrate_kbps, s.audio_bitrate_kbps))
        .collect()
}

fn labels(specs: &[RenditionSpec]) -> Vec<&str> {
    specs.iter().map(|s| s.label.as_str()).collect()
}

fn owned(v: &[Size]) -> Vec<(String, u32, u32)> {
    v.iter()
        .map(|(l, a, b)| ((*l).to_owned(), *a, *b))
        .collect()
}

fn pick(list: &str) -> Renditions {
    Renditions::parse(list).unwrap()
}

fn planned(probe: &MediaProbe, list: &str) -> Vec<RenditionSpec> {
    plan(probe, &pick(list), None, Codec::H264)
        .unwrap()
        .renditions
}

fn refused(probe: &MediaProbe, renditions: &Renditions, max_height: Option<u32>) -> String {
    match plan(probe, renditions, max_height, Codec::H264) {
        Err(MediaError::Renditions(why)) => why,
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn canonical_tiers() {
    assert_eq!(
        LADDER_TIERS
            .iter()
            .map(|t| (
                t.label,
                t.short_side,
                t.video_bitrate_kbps,
                t.audio_bitrate_kbps
            ))
            .collect::<Vec<_>>(),
        [
            ("2160p", 2160, 16000, 128),
            ("1440p", 1440, 8000, 128),
            ("1080p", 1080, 5000, 128),
            ("720p", 720, 2500, 128),
            ("480p", 480, 1200, 128),
            ("360p", 360, 800, 96),
        ]
    );
    assert_eq!((DEFAULT_HEIGHT, MAX_HEIGHT), (720, 2160));
}

#[test]
fn canonical_vectors_h264_offered_then_default() {
    let all = [
        ("2160p", 16000, 128),
        ("1440p", 8000, 128),
        ("1080p", 5000, 128),
        ("720p", 2500, 128),
        ("480p", 1200, 128),
        ("360p", 800, 96),
    ];
    let cases: [(u32, &[Size], &str); 6] = [
        (2160, &all, "720p"),
        (
            1000,
            &[
                ("720p", 2500, 128),
                ("480p", 1200, 128),
                ("360p", 800, 96),
                ("1000p", 4444, 128),
            ],
            "720p",
        ),
        (
            576,
            &[("480p", 1200, 128), ("360p", 800, 96), ("576p", 1720, 128)],
            "576p",
        ),
        (480, &[("480p", 1200, 128), ("360p", 800, 96)], "480p"),
        (240, &[("240p", 533, 96)], "240p"),
        (4320, &all, "720p"),
    ];
    for (size, want, default) in cases {
        // Landscape and portrait sources of one size offer the same sizes.
        for probe in [wide(size), tall(size)] {
            let got = offered(&probe, None, Codec::H264).unwrap();
            assert_eq!(sizes(&got), owned(want), "offered for {size}");
            let plan = plan(&probe, &Renditions::Default, None, Codec::H264).unwrap();
            assert_eq!(labels(&plan.renditions), [default], "default for {size}");
            // The default is one of the offered sizes, with the same bitrates.
            assert!(got.contains(&plan.renditions[0]), "{size}");
        }
    }
}

#[test]
fn canonical_vectors_other_codecs() {
    let vp9 = rendition_at(2160, Codec::Vp9);
    assert_eq!(
        (
            vp9.video_bitrate_kbps,
            vp9.audio_bitrate_kbps,
            vp9.container
        ),
        (11200, 128, Container::Webm)
    );
    let av1 = rendition_at(2160, Codec::Av1);
    assert_eq!(
        (av1.video_bitrate_kbps, av1.container),
        (8800, Container::Mp4)
    );
    // Off a tier: vk first, then the codec's scale, never below 200 kbps.
    assert_eq!(rendition_at(1000, Codec::Vp9).video_bitrate_kbps, 3111); // 4444 × 0.7
    assert_eq!(rendition_at(240, Codec::Vp9).video_bitrate_kbps, 373); // 533 × 0.7
    assert_eq!(rendition_at(240, Codec::Av1).video_bitrate_kbps, 293); // 533 × 0.55
    assert_eq!(rendition_at(100, Codec::H264).video_bitrate_kbps, 222);
    assert_eq!(rendition_at(100, Codec::Av1).video_bitrate_kbps, 200); // 122, floored
    // Every offered size of a codec carries it, and VP9's container.
    assert!(
        offered(&wide(2160), None, Codec::Vp9)
            .unwrap()
            .iter()
            .all(|r| r.codec == Codec::Vp9 && r.container == Container::Webm)
    );
}

#[test]
fn bitrates_between_tiers_are_interpolated_and_tiers_are_exact() {
    // 1440p–2160p, 1080p–1440p, 720p–1080p and 480p–720p, each at a midpoint.
    assert_eq!(rendition_at(1800, Codec::H264).video_bitrate_kbps, 12000);
    assert_eq!(rendition_at(1260, Codec::H264).video_bitrate_kbps, 6500);
    assert_eq!(rendition_at(900, Codec::H264).video_bitrate_kbps, 3750);
    assert_eq!(rendition_at(600, Codec::H264).video_bitrate_kbps, 1850);
    // 360p–480p: audio is 128 above 360 lines, 96 at and below it.
    let r = rendition_at(420, Codec::H264);
    assert_eq!((r.video_bitrate_kbps, r.audio_bitrate_kbps), (1000, 128));
    assert_eq!(rendition_at(362, Codec::H264).audio_bitrate_kbps, 128);
    assert_eq!(rendition_at(358, Codec::H264).audio_bitrate_kbps, 96);
    for t in &LADDER_TIERS {
        let r = rendition_at(t.short_side, Codec::H264);
        assert_eq!(
            (
                r.label.as_str(),
                r.short_side,
                r.video_bitrate_kbps,
                r.audio_bitrate_kbps
            ),
            (
                t.label,
                t.short_side,
                t.video_bitrate_kbps,
                t.audio_bitrate_kbps
            )
        );
    }
    // Sizes are made even: an odd one rounds down, never below 2.
    assert_eq!(rendition_at(721, Codec::H264).label, "720p");
    assert_eq!(rendition_at(135, Codec::H264).label, "134p");
    assert_eq!(rendition_at(1, Codec::H264).short_side, 2);
}

#[test]
fn the_source_size_is_its_short_side_as_displayed_even_and_capped() {
    assert_eq!(source_size(&wide(1080), None).unwrap(), 1080);
    assert_eq!(source_size(&tall(1080), None).unwrap(), 1080);
    assert_eq!(source_size(&src(720, 720, None, 1.0), None).unwrap(), 720);
    assert_eq!(
        source_size(&src(3840, 1080, None, 1.0), None).unwrap(),
        1080
    );
    assert_eq!(source_size(&src(200, 135, None, 1.0), None).unwrap(), 134);
    assert_eq!(source_size(&src(135, 200, None, 1.0), None).unwrap(), 134);
    assert_eq!(source_size(&wide(4320), None).unwrap(), 2160);
    assert_eq!(source_size(&tall(4320), None).unwrap(), 2160);
    assert_eq!(source_size(&wide(1080), Some(721)).unwrap(), 720);
    assert_eq!(source_size(&tall(1080), Some(721)).unwrap(), 720);
    // A phone video stored landscape with a 90° rotation is portrait as displayed: 1080
    // on its short side, as if it had been stored standing up.
    let rotated = src(1920, 1080, Some(90), 1.0);
    assert_eq!(source_size(&rotated, None).unwrap(), 1080);
    assert_eq!(
        labels(&offered(&rotated, None, Codec::H264).unwrap()),
        ["1080p", "720p", "480p", "360p"]
    );
}

/// A portrait vector: width and height as displayed, the sizes offered, the default, and
/// the default's width and height.
type Portrait = (u32, u32, &'static [&'static str], &'static str, u32, u32);

#[test]
fn canonical_vectors_portrait_the_short_side_is_the_size() {
    let cases: [Portrait; 5] = [
        (
            1080,
            1920,
            &["1080p", "720p", "480p", "360p"],
            "720p",
            720,
            1280,
        ),
        (
            2160,
            3840,
            &["2160p", "1440p", "1080p", "720p", "480p", "360p"],
            "720p",
            720,
            1280,
        ),
        (576, 1024, &["480p", "360p", "576p"], "576p", 576, 1024),
        (
            1000,
            1778,
            &["720p", "480p", "360p", "1000p"],
            "720p",
            720,
            1280,
        ),
        (240, 426, &["240p"], "240p", 240, 426),
    ];
    for (w, h, want, default, dw, dh) in cases {
        let probe = src(w, h, None, 60.0);
        assert_eq!(
            labels(&offered(&probe, None, Codec::H264).unwrap()),
            want,
            "{w}x{h}"
        );
        let plan = plan(&probe, &Renditions::Default, None, Codec::H264).unwrap();
        assert_eq!(labels(&plan.renditions), [default], "{w}x{h}");
        assert_eq!(
            rendition_dimensions(&probe, &plan.renditions[0]).unwrap(),
            (dw, dh),
            "{w}x{h}"
        );
    }
    // The same file rotated: 1920x1080 stored, 90°, is 1080x1920 displayed.
    let rotated = src(1920, 1080, Some(90), 60.0);
    let plan = plan(&rotated, &Renditions::Default, None, Codec::H264).unwrap();
    assert_eq!(
        rendition_dimensions(&rotated, &plan.renditions[0]).unwrap(),
        (720, 1280)
    );
    // A portrait 4K rendition, picked.
    let uhd = src(2160, 3840, None, 60.0);
    let got = planned(&uhd, "2160p");
    assert_eq!(rendition_dimensions(&uhd, &got[0]).unwrap(), (2160, 3840));
}

#[test]
fn fit_short_side_scales_the_short_side_keeping_aspect_and_even() {
    assert_eq!(fit_short_side((1920, 1080), 720), (1280, 720));
    assert_eq!(fit_short_side((1080, 1920), 720), (720, 1280));
    assert_eq!(fit_short_side((720, 720), 360), (360, 360));
    assert_eq!(fit_short_side((1080, 1920), 361), (360, 640));
    assert_eq!(fit_short_side((1000, 1778), 1000), (1000, 1778));
    assert_eq!(fit_short_side((3, 4), 361), (360, 480));
}

#[test]
fn the_default_is_one_rendition_720p_or_the_source_size() {
    let plan = plan(&wide(1080), &Renditions::Default, None, Codec::H264).unwrap();
    assert_eq!(
        plan.renditions,
        [RenditionSpec {
            label: "720p".into(),
            short_side: 720,
            video_bitrate_kbps: 2500,
            audio_bitrate_kbps: 128,
            codec: Codec::H264,
            container: Container::Mp4,
        }]
    );
    for (size, want) in [
        (2160, "720p"),
        (721, "720p"),
        (720, "720p"),
        (719, "718p"),
        (480, "480p"),
        (360, "360p"),
        (240, "240p"),
        (135, "134p"),
    ] {
        assert_eq!(planned_default(&wide(size), None), [want], "{size}");
        assert_eq!(planned_default(&tall(size), None), [want], "{size}");
    }
    // --max-height caps the source: the default never exceeds it.
    assert_eq!(planned_default(&wide(1080), Some(500)), ["500p"]);
    assert_eq!(planned_default(&wide(1080), Some(1440)), ["720p"]);
    assert_eq!(Renditions::default(), Renditions::Default);
}

fn planned_default(probe: &MediaProbe, max_height: Option<u32>) -> Vec<String> {
    plan(probe, &Renditions::Default, max_height, Codec::H264)
        .unwrap()
        .renditions
        .into_iter()
        .map(|r| r.label)
        .collect()
}

#[test]
fn a_creator_picks_any_size_the_source_offers() {
    let uhd = wide(2160);
    // Each tier alone, 4K included.
    for t in &LADDER_TIERS {
        let got = planned(&uhd, t.label);
        assert_eq!(labels(&got), [t.label]);
        assert_eq!(got[0].video_bitrate_kbps, t.video_bitrate_kbps);
    }
    assert_eq!(labels(&planned(&uhd, "1080p,360p")), ["1080p", "360p"]);
    // The old three-size ladder.
    assert_eq!(
        labels(&planned(&uhd, "1080p,720p,360p")),
        ["1080p", "720p", "360p"]
    );
    assert_eq!(
        labels(&planned(&wide(1080), "1080p,720p,360p")),
        ["1080p", "720p", "360p"]
    );
    // Planned tallest first, whatever order they are named in.
    assert_eq!(
        labels(&planned(&uhd, "360p,2160p,720p")),
        ["2160p", "720p", "360p"]
    );
    // A source's own size, alone or beside tiers.
    let odd = wide(1000);
    assert_eq!(
        sizes(&planned(&odd, "1000p")),
        owned(&[("1000p", 4444, 128)])
    );
    assert_eq!(labels(&planned(&odd, "360p,1000p")), ["1000p", "360p"]);
    assert_eq!(labels(&planned(&wide(240), "240p")), ["240p"]);
    // 2160p from a taller source: nothing above 2160 lines is made.
    assert_eq!(labels(&planned(&wide(4320), "2160p")), ["2160p"]);
}

#[test]
fn a_size_the_source_does_not_offer_is_refused_naming_those_it_does() {
    let why = refused(&wide(1080), &pick("2160p"), None);
    assert!(why.contains("2160p is not offered"), "{why}");
    assert!(why.contains("never upscales"), "{why}");
    assert!(why.ends_with("offered 1080p, 720p, 480p, 360p"), "{why}");
    // Portrait the same: 1080 wide offers no 1440p, however tall it stands.
    let why = refused(&tall(1080), &pick("1440p"), None);
    assert!(why.ends_with("offered 1080p, 720p, 480p, 360p"), "{why}");
    // The old ladder from a 720-line source: 1080p is larger than it.
    let why = refused(&wide(720), &pick("1080p,720p,360p"), None);
    assert!(why.starts_with("1080p is not offered"), "{why}");
    // A size that is neither a tier nor the source's own.
    let why = refused(&wide(1000), &pick("900p"), None);
    assert!(why.ends_with("offered 720p, 480p, 360p, 1000p"), "{why}");
    let why = refused(&wide(240), &pick("360p"), None);
    assert!(why.ends_with("offered 240p"), "{why}");
    // Nothing above 2160 lines, whatever the source.
    let why = refused(&wide(4320), &pick("4320p"), None);
    assert!(why.starts_with("4320p is not offered"), "{why}");
    // --max-height caps what is offered.
    let why = refused(&wide(1080), &pick("1080p"), Some(720));
    assert!(why.ends_with("offered 720p, 480p, 360p"), "{why}");
    // Nothing named, or a size named twice (both only reachable from code: parse refuses them).
    let why = refused(&wide(1080), &Renditions::Sizes(vec![]), None);
    assert_eq!(why, "no size named");
    let twice = Renditions::Sizes(vec!["720p".into(), "720p".into()]);
    assert_eq!(refused(&wide(1080), &twice, None), "720p is named twice");
}

#[test]
fn the_size_list_is_parsed_strictly() {
    assert_eq!(pick("720p"), Renditions::Sizes(vec!["720p".into()]));
    assert_eq!(
        pick("1080p,720p,360p"),
        Renditions::Sizes(vec!["1080p".into(), "720p".into(), "360p".into()])
    );
    assert_eq!(pick("1000p"), Renditions::Sizes(vec!["1000p".into()]));
    for bad in [
        "",
        "720",
        "p",
        "0p",
        "0720p",
        "720p,",
        ",720p",
        "720p, 360p",
        " 720p",
        "720P",
        "-720p",
        "4k",
        "1080i",
        "720p,720p",
        "+720p",
        "99999999999p",
    ] {
        match Renditions::parse(bad) {
            Err(MediaError::Renditions(_)) => {}
            other => panic!("{bad:?}: {other:?}"),
        }
    }
}

#[test]
fn audio_only_input_is_refused() {
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
        plan(&audio_only, &Renditions::Default, None, Codec::H264),
        Err(MediaError::NoVideoStream(_))
    ));
    assert!(matches!(
        offered(&audio_only, None, Codec::H264),
        Err(MediaError::NoVideoStream(_))
    ));
}

#[test]
fn a_plan_has_thumbnails_and_a_storyboard() {
    let plan = plan(
        &src(1920, 1080, None, 100.0),
        &Renditions::Default,
        None,
        Codec::H264,
    )
    .unwrap();
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
}

fn opt<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.iter()
        .position(|a| a == flag)
        .and_then(|i| argv.get(i + 1))
        .map(String::as_str)
}

#[test]
fn a_2160p_rendition_encodes_at_3840x2160_with_its_rates_and_no_pinned_level() {
    let uhd = src(3840, 2160, None, 60.0);
    let spec = rendition_at(2160, Codec::H264);
    let dir = std::path::Path::new("/w/2160p");
    let argv = rendition_cmaf_argv("/in", dir, &uhd, &spec, 30.0, None).unwrap();
    for (flag, want) in [
        ("-c:v", "libx264"),
        ("-profile:v", "high"),
        ("-vf", "scale=3840:2160"),
        ("-b:v", "16000k"),
        ("-maxrate", "24000k"),
        ("-bufsize", "32000k"),
        ("-b:a", "128k"),
        ("-g", "60"),
        ("-hls_segment_filename", "/w/2160p/seg_%05d.m4s"),
    ] {
        assert_eq!(opt(&argv, flag), Some(want), "{flag}");
    }
    // x264 picks the level from the size and rate (5.1 for 2160p30): none is pinned.
    assert!(!argv.iter().any(|a| a == "-level" || a == "-level:v"));
    assert_eq!(rendition_dimensions(&uhd, &spec).unwrap(), (3840, 2160));
    // A source's own size off the tiers keeps its aspect, even.
    let odd = src(1778, 1000, None, 60.0);
    let own = rendition_at(1000, Codec::H264);
    assert_eq!(rendition_dimensions(&odd, &own).unwrap(), (1778, 1000));
    let argv = rendition_cmaf_argv(
        "/in",
        std::path::Path::new("/w/1000p"),
        &odd,
        &own,
        30.0,
        None,
    )
    .unwrap();
    assert_eq!(opt(&argv, "-b:v"), Some("4444k"));
}
