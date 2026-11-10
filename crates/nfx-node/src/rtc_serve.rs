//! Serving verified segments to WebRTC peers over p2p-media-loader's peer protocol
//! ([`crate::p2pml`]): one connection's upload queue and what it may ask for. Shared by the
//! bridge ([`crate::bridge`]: ICE lite, signaled by a tracker) and the mesh endpoint
//! ([`crate::mesh`]: full ICE, signaled over Nostr), so both serve under the same caps.
//!
//! Neither downloads from browsers: they serve from the node's content store, which
//! re-verifies every file on read, and ignore the segment data and announcements peers send.
//!
//! Per connection: requests are budgeted ([`PEER_BURST`], [`PEER_RATE`]; a peer over its
//! budget is dropped), queued bytes are capped ([`MAX_QUEUED`]; a peer that does not read is
//! dropped), and a new request cancels the upload in progress, as the protocol requires. Per
//! endpoint: a global request budget (over it, requests are answered `Absent`) and a small
//! cache of verified bytes.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use nfx_proto::hashlist::{HashList, Role};
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;

use crate::p2pml::{self, Command, Reassembler};
use crate::store::ContentStore;

/// An open connection that asks for nothing for this long is dropped.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Segment bytes per data-channel message.
const CHUNK: usize = 16 * 1024;
/// Bytes queued for one peer; beyond this it is dropped (it is not reading).
pub const MAX_QUEUED: usize = 16 << 20;
/// Verified segment bytes kept in memory, so repeated requests cost no re-read.
const CACHE_BYTES: usize = 64 << 20;
/// Requests per peer, and in total: a burst, then a steady rate. A player needs one
/// request at a time; a peer over its budget is dropped, and requests over the global
/// budget are answered `Absent`.
pub const PEER_BURST: f64 = 60.0;
pub const PEER_RATE: f64 = 20.0;
const GLOBAL_BURST: f64 = 400.0;
const GLOBAL_RATE: f64 = 200.0;

/// One rendition's swarm as served: its segments by external id (the position of each
/// `#EXTINF` segment in the VOD playlist, as p2p-media-loader-hlsjs numbers them), and the
/// ids held now (announced when a channel opens and whenever the set grows).
pub(crate) struct Swarm {
    pub segments: Vec<String>,
    pub loaded: Vec<u64>,
}

/// The renditions of a verified hash list that can be served from `store`, of those `only`
/// names (every one when `None`): each rendition id with its VOD segments' content names. A
/// rendition whose playlist is not in the store yet, or that is live or uses byte ranges, is
/// left out.
pub(crate) fn vod_renditions(
    list: &HashList,
    store: &dyn ContentStore,
    only: Option<&[String]>,
) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    for r in &list.renditions {
        if only.is_some_and(|ids| !ids.contains(&r.id)) {
            continue;
        }
        let Some(file) = list
            .files
            .iter()
            .find(|f| f.role == Role::Playlist && f.name == r.playlist)
        else {
            continue;
        };
        let Some(segments) = store
            .get(&file.sha256)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|text| vod_segments(&text))
        else {
            continue;
        };
        out.push((r.id.clone(), segments));
    }
    out
}

/// A VOD playlist's media segments, as content-name hashes, in the order hls.js numbers
/// them: the URI line after each `#EXTINF`. `None` for a live playlist (no
/// `#EXT-X-ENDLIST`, so ids would be sequence numbers) or one with byte ranges (a bridge
/// serves whole files).
pub(crate) fn vod_segments(text: &str) -> Option<Vec<String>> {
    let mut vod = false;
    let mut segments = Vec::new();
    let mut after_inf = false;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line == "#EXT-X-ENDLIST" {
            vod = true;
        } else if line.starts_with("#EXT-X-BYTERANGE") {
            return None;
        } else if line.starts_with("#EXTINF") {
            after_inf = true;
        } else if !line.starts_with('#') && after_inf {
            segments.push(line.split('.').next().unwrap_or(line).to_owned());
            after_inf = false;
        }
    }
    vod.then_some(segments)
}

/// The ids of `loaded` that one announcement can carry: p2p-media-loader's array holds at
/// most 255 blocks of 256, so ids beyond the 255th block are left out.
pub(crate) fn announceable(loaded: &[u64]) -> Vec<u64> {
    let mut blocks: Vec<u64> = Vec::new();
    loaded
        .iter()
        .copied()
        .filter(|id| {
            let block = id >> 8;
            if blocks.contains(&block) {
                true
            } else if blocks.len() < 255 {
                blocks.push(block);
                true
            } else {
                false
            }
        })
        .collect()
}

/// A datagram from `source`, as str0m input, arriving at `destination`: the local candidate
/// it was sent to (str0m answers connectivity checks only at a local candidate).
pub(crate) fn received(
    bytes: &[u8],
    source: SocketAddr,
    destination: SocketAddr,
    now: Instant,
) -> Option<Input<'_>> {
    Some(Input::Receive(
        now,
        Receive {
            proto: Protocol::Udp,
            source,
            destination,
            contents: bytes.try_into().ok()?,
        },
    ))
}

pub(crate) struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    pub(crate) fn new(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            at: now,
        }
    }

    pub(crate) fn take(&mut self, now: Instant, burst: f64, rate: f64) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() * rate).min(burst);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// Verified segment bytes by sha256, least recently used out first.
#[derive(Default)]
struct Cache {
    entries: HashMap<String, (Bytes, u64)>,
    bytes: usize,
    tick: u64,
}

impl Cache {
    fn get(&mut self, sha: &str, store: &dyn ContentStore) -> Option<Bytes> {
        self.tick += 1;
        if let Some((b, t)) = self.entries.get_mut(sha) {
            *t = self.tick;
            return Some(b.clone());
        }
        let b = Bytes::from(store.get(sha).ok()?);
        if b.len() > CACHE_BYTES / 4 {
            return Some(b);
        }
        while self.bytes + b.len() > CACHE_BYTES {
            let Some(old) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((ob, _)) = self.entries.remove(&old) {
                self.bytes -= ob.len();
            }
        }
        self.bytes += b.len();
        self.entries.insert(sha.to_owned(), (b.clone(), self.tick));
        Some(b)
    }
}

/// One WebRTC connection with a remote peer in one swarm, and what it has queued.
pub(crate) struct Conn {
    pub rtc: Rtc,
    /// The swarm's key: its tracker infohash (bridge) or its room key (mesh).
    pub swarm: String,
    /// The remote peer: its tracker peer id (bridge) or its session key (mesh).
    pub remote: String,
    pub channel: Option<ChannelId>,
    reassembler: Reassembler,
    /// Messages to send, each tagged with the upload (request id) it belongs to.
    out: VecDeque<(Option<u64>, Bytes)>,
    queued: usize,
    upload: Option<u64>,
    budget: Bucket,
    pub wake: Instant,
    pub born: Instant,
    pub active: Instant,
    pub dead: bool,
    /// Segment requests answered with data.
    pub served: u64,
}

impl Conn {
    pub(crate) fn new(rtc: Rtc, swarm: String, remote: String, now: Instant) -> Self {
        Self {
            rtc,
            swarm,
            remote,
            channel: None,
            reassembler: Reassembler::default(),
            out: VecDeque::new(),
            queued: 0,
            upload: None,
            budget: Bucket::new(PEER_BURST, now),
            wake: now,
            born: now,
            active: now,
            dead: false,
            served: 0,
        }
    }
}

/// What every connection of one endpoint shares: its socket, the store it serves from, the
/// verified-bytes cache and the global request budget.
pub(crate) struct Uploader {
    pub socket: Arc<UdpSocket>,
    pub store: Arc<dyn ContentStore + Send + Sync>,
    cache: Cache,
    budget: Bucket,
}

impl Uploader {
    pub(crate) fn new(
        socket: Arc<UdpSocket>,
        store: Arc<dyn ContentStore + Send + Sync>,
        now: Instant,
    ) -> Self {
        Self {
            socket,
            store,
            cache: Cache::default(),
            budget: Bucket::new(GLOBAL_BURST, now),
        }
    }

    /// The ids of `segments` the store holds now.
    pub(crate) fn loaded(&self, segments: &[String]) -> Vec<u64> {
        segments
            .iter()
            .enumerate()
            .filter(|(_, sha)| self.store.has(sha))
            .map(|(i, _)| i as u64)
            .collect()
    }

    /// Drain the connection's output and write what the channel accepts. str0m refuses a
    /// write while its send buffer is full; the rest waits for network input (the peer's
    /// acknowledgements), which is what frees the buffer. `swarm` is the connection's.
    pub(crate) fn pump(&mut self, p: &mut Conn, swarm: Option<&Swarm>, now: Instant) {
        loop {
            loop {
                match p.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        p.wake = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        let _ = self.socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(e)) => self.event(p, e, swarm, now),
                    Err(_) => {
                        p.dead = true;
                        return;
                    }
                }
            }
            if p.dead {
                return;
            }
            let (Some(id), Some((_, msg))) = (p.channel, p.out.front()) else {
                return;
            };
            match p.rtc.channel(id).map(|mut c| c.write(true, msg)) {
                Some(Ok(true)) => {
                    if let Some((_, m)) = p.out.pop_front() {
                        p.queued -= m.len();
                    }
                }
                Some(Ok(false)) => return,
                _ => {
                    p.dead = true;
                    return;
                }
            }
        }
    }

    /// Close a dead connection, letting the close go out rather than leave the peer to time
    /// out.
    pub(crate) fn close(&self, p: &mut Conn) {
        p.rtc.disconnect();
        while let Ok(out) = p.rtc.poll_output() {
            match out {
                Output::Transmit(t) => {
                    let _ = self.socket.try_send_to(&t.contents, t.destination);
                }
                Output::Timeout(_) => break,
                Output::Event(_) => {}
            }
        }
    }

    fn event(&mut self, p: &mut Conn, e: Event, swarm: Option<&Swarm>, now: Instant) {
        match e {
            // One data channel per connection: a second open is ignored.
            Event::ChannelOpen(id, _) if p.channel.is_none() => {
                p.channel = Some(id);
                p.active = now;
                let loaded = swarm.map(|s| announceable(&s.loaded)).unwrap_or_default();
                queue(
                    p,
                    None,
                    &Command::Announcement {
                        loaded,
                        loading: vec![],
                    },
                );
            }
            Event::ChannelData(d) if Some(d.id) == p.channel => {
                // Raw segment data would only follow a request of ours, and nothing here
                // makes one: it is ignored.
                if !p2pml::is_command_chunk(&d.data) {
                    return;
                }
                match p.reassembler.feed(&d.data) {
                    Err(_) => p.dead = true,
                    Ok(None) => {}
                    Ok(Some(cmd)) => self.command(p, cmd, swarm, now),
                }
            }
            Event::ChannelClose(id) if Some(id) == p.channel => p.dead = true,
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => p.dead = true,
            _ => {}
        }
    }

    fn command(&mut self, p: &mut Conn, cmd: Command, swarm: Option<&Swarm>, now: Instant) {
        match cmd {
            Command::Request { id, request, from } => {
                p.active = now;
                if !p.budget.take(now, PEER_BURST, PEER_RATE) {
                    p.dead = true;
                    return;
                }
                // One upload per peer: a new request cancels the one in progress first.
                cancel(p);
                let sha = usize::try_from(id)
                    .ok()
                    .and_then(|i| swarm?.segments.get(i).cloned());
                let bytes = match sha {
                    Some(sha) if self.budget.take(now, GLOBAL_BURST, GLOBAL_RATE) => {
                        self.cache.get(&sha, &*self.store)
                    }
                    _ => None,
                };
                let from = usize::try_from(from).unwrap_or(usize::MAX);
                match bytes {
                    Some(bytes) if from <= bytes.len() => {
                        let data = bytes.slice(from..);
                        p.upload = Some(request);
                        p.served += 1;
                        let tag = Some(request);
                        queue(
                            p,
                            tag,
                            &Command::Data {
                                id,
                                request,
                                size: data.len() as u64,
                            },
                        );
                        for chunk in p2pml::data_chunks(&data, CHUNK) {
                            let at = chunk.as_ptr() as usize - data.as_ptr() as usize;
                            push(p, tag, data.slice(at..at + chunk.len()));
                        }
                        queue(p, tag, &Command::Completed { id, request });
                    }
                    _ => queue(p, None, &Command::Absent { id, request }),
                }
            }
            Command::Cancel { request, .. } => {
                p.active = now;
                if p.upload == Some(request) {
                    cancel(p);
                }
            }
            // Nothing here downloads, so announcements and transfers are not for it.
            Command::Announcement { .. }
            | Command::Data { .. }
            | Command::Completed { .. }
            | Command::Absent { .. } => {}
        }
    }
}

/// Drop the queued messages of the upload in progress.
fn cancel(p: &mut Conn) {
    if let Some(old) = p.upload.take() {
        let mut freed = 0;
        p.out.retain(|(tag, m)| {
            let keep = *tag != Some(old);
            if !keep {
                freed += m.len();
            }
            keep
        });
        p.queued -= freed;
    }
}

fn push(p: &mut Conn, tag: Option<u64>, m: Bytes) {
    p.queued += m.len();
    p.out.push_back((tag, m));
    if p.queued > MAX_QUEUED {
        p.dead = true;
    }
}

/// Queue `cmd` on `p`, as part of the upload `tag` (`None`: no upload's).
pub(crate) fn queue(p: &mut Conn, tag: Option<u64>, cmd: &Command) {
    match p2pml::encode(cmd) {
        Ok(msgs) => {
            for m in msgs {
                push(p, tag, Bytes::from(m));
            }
        }
        Err(_) => p.dead = true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_numbered_as_hls_js_numbers_them() {
        let vod = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n\
                   #EXTINF:2.0,\naaa.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nbbb.m4s\n\
                   stray.m4s\n#EXT-X-ENDLIST\n";
        assert_eq!(vod_segments(vod), Some(vec!["aaa".into(), "bbb".into()]));
        assert_eq!(vod_segments("#EXTM3U\n#EXTINF:2,\na.m4s\n"), None, "live");
        assert_eq!(
            vod_segments("#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\na.m4s\n#EXT-X-ENDLIST\n"),
            None,
            "byte ranges"
        );
    }

    #[test]
    fn announcements_stay_within_255_blocks() {
        let ids: Vec<u64> = (0..300u64).map(|b| b * 256).collect();
        let a = announceable(&ids);
        assert_eq!(a.len(), 255);
        assert!(
            p2pml::encode(&Command::Announcement {
                loaded: a,
                loading: vec![]
            })
            .is_ok()
        );
    }
}
