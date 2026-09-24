//! Package a source file as NFX-05 content: L8's ladder encoded to CMAF by ffmpeg, every
//! output file content-addressed into a store directory, playlists rewritten to content
//! names (NFX-05 §3), and the hash list assembled and self-verified with `nfx-proto`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use nfx_proto::hashlist::{FileEntry, HashList, Rendition, Role, verify_file};
use nfx_proto::namespace::VideoAddr;
use nfx_proto::sha256;

use crate::argv::{THUMBNAIL_WIDTH, rendition_cmaf_argv, rendition_dimensions, thumbnail_argv};
use crate::ladder::{Codec, GOP_SECONDS, LadderPlan, RenditionSpec, plan_ladder};
use crate::mp4::init_codecs;
use crate::probe::{ffprobe_argv, parse_ffprobe_json};
use crate::{MediaError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
}

/// Runs ffmpeg/ffprobe. Always a direct spawn with an argv vector, never a shell.
pub trait Runner {
    /// Run `tool` with `args`; return stdout, or an error carrying stderr.
    fn run(&self, tool: Tool, args: &[String]) -> Result<Vec<u8>>;
}

/// Runs the binaries at the given paths (or found on `PATH`).
#[derive(Debug, Clone)]
pub struct SystemRunner {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Default for SystemRunner {
    fn default() -> Self {
        Self {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
        }
    }
}

impl Runner for SystemRunner {
    fn run(&self, tool: Tool, args: &[String]) -> Result<Vec<u8>> {
        let program = match tool {
            Tool::Ffmpeg => &self.ffmpeg,
            Tool::Ffprobe => &self.ffprobe,
        };
        let out = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(MediaError::Tool(format!(
            "{} exited with {}: {tail}",
            program.display(),
            out.status
        )))
    }
}

#[derive(Debug, Clone)]
pub struct PackageOptions {
    pub video: VideoAddr,
    pub max_height: Option<u32>,
    /// x264 preset (L8 default `medium`).
    pub preset: Option<String>,
    /// Add L8's first thumbnail candidate as role `thumb`.
    pub thumbnail: bool,
}

/// A packaged video: the hash list, its bytes (whose sha256 is `root`) and the plan.
#[derive(Debug, Clone)]
pub struct Packaged {
    pub root: [u8; 32],
    pub hash_list: HashList,
    pub hash_list_bytes: Vec<u8>,
    pub plan: LadderPlan,
}

impl Packaged {
    #[must_use]
    pub fn root_hex(&self) -> String {
        hex::encode(self.root)
    }

    #[must_use]
    pub fn segs(&self) -> u64 {
        self.hash_list.files.len() as u64
    }
}

/// Write `bytes` into the store under its sha256 (atomically; idempotent).
fn put(store: &Path, bytes: &[u8]) -> Result<String> {
    let name = hex::encode(sha256(bytes));
    let dest = store.join(&name);
    if dest.is_file() && verify_file(&name, &fs::read(&dest)?).is_ok() {
        return Ok(name);
    }
    let tmp = store.join(format!(".tmp-{name}-{}", std::process::id()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &dest)?;
    Ok(name)
}

/// A plain file name that ffmpeg wrote into its own output directory.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        && !name.starts_with('.')
}

struct EncodedRendition {
    entry: Rendition,
    playlist: FileEntry,
    media: Vec<FileEntry>,
    durations: Vec<u64>,
}

fn encode_rendition(
    input: &str,
    source_plan: &LadderPlan,
    spec: &RenditionSpec,
    work: &Path,
    store: &Path,
    runner: &dyn Runner,
    preset: Option<&str>,
) -> Result<EncodedRendition> {
    let probe = &source_plan.source;
    let fps = probe.video.as_ref().map_or(0.0, |v| v.fps);
    let dir = work.join(&spec.label);
    fs::create_dir_all(&dir)?;
    runner.run(
        Tool::Ffmpeg,
        &rendition_cmaf_argv(input, &dir, probe, spec, fps, preset)?,
    )?;

    let init_bytes = fs::read(dir.join("init.mp4"))?;
    let init_sha = put(store, &init_bytes)?;
    let codecs = init_codecs(&init_bytes)?.join(",");
    let mut media = vec![FileEntry {
        name: format!("init-{}.mp4", spec.label),
        role: Role::Init,
        sha256: init_sha.clone(),
        size: init_bytes.len() as u64,
        dur_ms: None,
    }];

    let text = fs::read_to_string(dir.join("index.m3u8"))?;
    let mut lines = Vec::new();
    let mut pending_ms: Option<u64> = None;
    let mut durations = Vec::new();
    let mut peak_bps: u64 = 0;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            if !rest.contains("URI=\"init.mp4\"") {
                return Err(MediaError::Package(format!(
                    "unexpected EXT-X-MAP {rest:?}"
                )));
            }
            lines.push(format!("#EXT-X-MAP:URI=\"{init_sha}.mp4\""));
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let secs: f64 = rest
                .trim_end_matches(',')
                .split(',')
                .next()
                .unwrap_or("")
                .parse()
                .map_err(|_| MediaError::Package(format!("bad EXTINF {line:?}")))?;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let ms = (secs * 1000.0).round() as u64;
            if ms == 0 {
                return Err(MediaError::Package("zero-length segment".into()));
            }
            pending_ms = Some(ms);
            lines.push(line.to_owned());
        } else if !line.is_empty() && !line.starts_with('#') {
            if !plain_name(line) {
                return Err(MediaError::Package(format!(
                    "segment name {line:?} is not a plain file name"
                )));
            }
            let dur_ms = pending_ms
                .take()
                .ok_or_else(|| MediaError::Package("segment without EXTINF".into()))?;
            let bytes = fs::read(dir.join(line))?;
            let sha = put(store, &bytes)?;
            peak_bps = peak_bps.max((bytes.len() as u64 * 8 * 1000).div_ceil(dur_ms));
            media.push(FileEntry {
                name: format!("{}-{line}", spec.label),
                role: Role::Segment,
                sha256: sha.clone(),
                size: bytes.len() as u64,
                dur_ms: Some(dur_ms),
            });
            durations.push(dur_ms);
            lines.push(format!("{sha}.m4s"));
        } else {
            lines.push(line.to_owned());
        }
    }
    if durations.is_empty() || !text.contains("#EXT-X-ENDLIST") {
        return Err(MediaError::Package(format!(
            "{}: incomplete playlist",
            spec.label
        )));
    }
    let mut playlist_text = lines.join("\n");
    playlist_text.push('\n');
    let playlist_sha = put(store, playlist_text.as_bytes())?;
    let (w, h) = rendition_dimensions(probe, spec)?;
    let playlist_name = format!("r{}.m3u8", spec.label);
    Ok(EncodedRendition {
        entry: Rendition {
            id: spec.label.clone(),
            playlist: playlist_name.clone(),
            bandwidth: peak_bps,
            codecs: Some(codecs),
            resolution: Some(format!("{w}x{h}")),
        },
        playlist: FileEntry {
            name: playlist_name,
            role: Role::Playlist,
            sha256: playlist_sha,
            size: playlist_text.len() as u64,
            dur_ms: None,
        },
        media,
        durations,
    })
}

/// Package `input` into `store` (a directory of `<sha256>` files), using `work` for
/// ffmpeg's scratch output. Returns only after the result passes the NFX-05 consumer
/// checks (hash list against root, every file against its sha256, every playlist against
/// the content-name rule).
pub fn package(
    input: &Path,
    store: &Path,
    work: &Path,
    runner: &dyn Runner,
    opts: &PackageOptions,
) -> Result<Packaged> {
    // ffmpeg reads protocol prefixes (`concat:`, `http:`, …) in input names, so pin the
    // input to the file protocol on an absolute path to a regular file.
    let input = input.canonicalize()?;
    if !input.is_file() {
        return Err(MediaError::Package("input is not a regular file".into()));
    }
    let input_arg = format!(
        "file:{}",
        input
            .to_str()
            .ok_or_else(|| MediaError::Package("input path is not UTF-8".into()))?
    );
    fs::create_dir_all(store)?;
    fs::create_dir_all(work)?;
    let (store, work) = (store.canonicalize()?, work.canonicalize()?);

    let probe = parse_ffprobe_json(&String::from_utf8_lossy(
        &runner.run(Tool::Ffprobe, &ffprobe_argv(&input_arg))?,
    ))?;
    let plan = plan_ladder(&probe, opts.max_height, Codec::H264)?;
    let preset = opts.preset.as_deref();

    let mut encoded = Vec::new();
    for spec in &plan.renditions {
        encoded.push(encode_rendition(
            &input_arg, &plan, spec, &work, &store, runner, preset,
        )?);
    }
    // NFX-05 §1: one GOP grid for every rendition, so switches are seamless.
    if let Some((first, rest)) = encoded.split_first() {
        if rest.iter().any(|e| e.durations != first.durations) {
            return Err(MediaError::Package(
                "segment durations differ across renditions".into(),
            ));
        }
        let gop_ms = u64::from(GOP_SECONDS) * 1000;
        if first.durations[..first.durations.len() - 1]
            .iter()
            .any(|d| *d != gop_ms)
        {
            return Err(MediaError::Package(format!(
                "segments are not {GOP_SECONDS} s"
            )));
        }
    }

    let mut master = String::from("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    for e in &encoded {
        let r = &e.entry;
        master.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={},CODECS=\"{}\"\n{}.m3u8\n",
            r.bandwidth,
            r.resolution.as_deref().unwrap_or_default(),
            r.codecs.as_deref().unwrap_or_default(),
            e.playlist.sha256
        ));
    }
    let mut files = vec![FileEntry {
        name: "master.m3u8".into(),
        role: Role::PlaylistMaster,
        sha256: put(&store, master.as_bytes())?,
        size: master.len() as u64,
        dur_ms: None,
    }];
    files.extend(encoded.iter().map(|e| e.playlist.clone()));
    for e in &encoded {
        files.extend(e.media.iter().cloned());
    }
    if opts.thumbnail {
        let thumb = work.join("thumb.jpg");
        let at = plan.thumbnail_times.first().copied().unwrap_or(0.0);
        runner.run(
            Tool::Ffmpeg,
            &thumbnail_argv(
                &input_arg,
                thumb.to_str().unwrap_or_default(),
                at,
                THUMBNAIL_WIDTH,
            ),
        )?;
        let bytes = fs::read(&thumb)?;
        files.push(FileEntry {
            name: "thumb.jpg".into(),
            role: Role::Thumb,
            sha256: put(&store, &bytes)?,
            size: bytes.len() as u64,
            dur_ms: None,
        });
    }

    let hash_list = HashList {
        v: 1,
        video: opts.video.to_string(),
        files,
        renditions: encoded.into_iter().map(|e| e.entry).collect(),
    };
    let hash_list_bytes = hash_list.render();
    let root_hex = put(&store, &hash_list_bytes)?;
    let root = sha256(&hash_list_bytes);
    debug_assert_eq!(hex::encode(root), root_hex);

    // Self-check exactly as a consumer would (NFX-05 §§2–4).
    let verified = HashList::verify(
        &fs::read(store.join(&root_hex))?,
        &root,
        &opts.video,
        hash_list.files.len() as u64,
    )?;
    for f in &verified.files {
        let bytes = fs::read(store.join(&f.sha256))?;
        verify_file(&f.sha256, &bytes)?;
        if matches!(f.role, Role::PlaylistMaster | Role::Playlist) {
            verified.check_playlist(&bytes)?;
        }
    }
    Ok(Packaged {
        root,
        hash_list,
        hash_list_bytes,
        plan,
    })
}
