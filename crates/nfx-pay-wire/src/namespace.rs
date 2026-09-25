//! Namespaces, video addresses and the identifiers derived from them
//! (NFX-01 §2, NFX-06 §4, NFX-10 §2, NFX-12 §3).

use core::fmt;

use base64::Engine as _;
use sha1::{Digest as _, Sha1};

use crate::{Error, Result, sha256};

/// The only wire token (NFX-01 §2). `nutflix:*` namespaces are void.
pub const TOKEN: &str = "nfx";

/// `nfx:<network>:<specver>`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Namespace {
    network: String,
    specver: u64,
}

impl Namespace {
    /// Parse and validate a namespace. Rejects every other token, uppercase, leading
    /// zeros in `specver`, and network names outside `[a-z0-9-]{2,32}`.
    pub fn parse(s: &str) -> Result<Self> {
        let err = || Error::Namespace(s.to_owned());
        let mut parts = s.split(':');
        let (Some(token), Some(network), Some(specver), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(err());
        };
        if token != TOKEN {
            return Err(err());
        }
        if !(2..=32).contains(&network.len())
            || !network
                .bytes()
                .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
        {
            return Err(err());
        }
        let specver = crate::hex32::parse_u64_strict(specver).ok_or_else(err)?;
        Ok(Self {
            network: network.to_owned(),
            specver,
        })
    }

    #[must_use]
    pub fn network(&self) -> &str {
        &self.network
    }

    #[must_use]
    pub fn specver(&self) -> u64 {
        self.specver
    }
}

impl fmt::Display for Namespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{TOKEN}:{}:{}", self.network, self.specver)
    }
}

/// `[a-z0-9][a-z0-9-]{6,62}` (NFX-02 §2).
pub fn validate_video_id(id: &str) -> Result<()> {
    let bytes = id.as_bytes();
    let ok = (7..=63).contains(&bytes.len())
        && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
        && bytes
            .iter()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(Error::VideoId(id.to_owned()))
    }
}

/// `<namespace>:<video-id>`: the `d` tag, the hash list's `video`, the beacon's `video`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VideoAddr {
    namespace: Namespace,
    video_id: String,
}

impl VideoAddr {
    pub fn new(namespace: Namespace, video_id: &str) -> Result<Self> {
        validate_video_id(video_id)?;
        Ok(Self {
            namespace,
            video_id: video_id.to_owned(),
        })
    }

    pub fn parse(s: &str) -> Result<Self> {
        let (ns, id) = s
            .rsplit_once(':')
            .ok_or_else(|| Error::VideoId(s.to_owned()))?;
        Self::new(Namespace::parse(ns)?, id)
    }

    #[must_use]
    pub fn namespace(&self) -> &Namespace {
        &self.namespace
    }

    #[must_use]
    pub fn video_id(&self) -> &str {
        &self.video_id
    }

    /// iroh-gossip topic: `sha256("nfx/1/swarm/" + namespace + "/" + video-id)` (NFX-06 §4).
    #[must_use]
    pub fn swarm_topic(&self) -> [u8; 32] {
        sha256(format!("nfx/1/swarm/{}/{}", self.namespace, self.video_id).as_bytes())
    }

    /// Browser-mesh stream swarm ID of one rendition (NFX-10 §2):
    /// `nfx/1/web/<namespace>:<video-id>/<rendition-id>`.
    #[must_use]
    pub fn web_stream_swarm_id(&self, rendition_id: &str) -> String {
        format!("nfx/1/web/{self}/{rendition_id}")
    }

    /// The tracker infohash for that swarm: `base64(sha1(id)[0..15])`, 20 ASCII characters,
    /// exactly what p2p-media-loader v4 announces (`computeInfoHash`, NFX-10 §2). SHA-1 only
    /// names a meeting place here; nothing is verified with it.
    #[must_use]
    pub fn web_tracker_infohash(&self, rendition_id: &str) -> String {
        let digest = Sha1::digest(self.web_stream_swarm_id(rendition_id).as_bytes());
        base64::engine::general_purpose::STANDARD.encode(&digest[..15])
    }

    /// Hyperswarm topic: `sha256("nfx/1/hyper/" + namespace + "/" + video-id)` (NFX-12 §3).
    #[must_use]
    pub fn hyper_topic(&self) -> [u8; 32] {
        sha256(format!("nfx/1/hyper/{}/{}", self.namespace, self.video_id).as_bytes())
    }
}

impl fmt::Display for VideoAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.namespace, self.video_id)
    }
}
