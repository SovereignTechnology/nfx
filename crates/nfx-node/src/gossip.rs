//! Presence on a video's gossip swarm (NFX-06 §4): signed envelopes, verified on receipt.
//! Gossip only says "here"; bytes never travel over it.

use iroh::EndpointAddr;
use iroh_gossip::TopicId;
use iroh_gossip::api::{Event, GossipReceiver, GossipSender};
use n0_future::StreamExt;
use nfx_proto::Verified;
use nfx_proto::canon;
use nfx_proto::gossip::Envelope;
use nfx_proto::namespace::VideoAddr;

use crate::node::Node;
use crate::{NodeError, Result};

/// The wire form of a signed envelope: the canonical body plus `sig`.
pub fn envelope_wire(envelope: &Envelope, seeder_secret: &[u8; 32]) -> Result<String> {
    let sig = envelope.sign(seeder_secret)?;
    let mut value = canon::Value::parse(&envelope.canon_body()?)?;
    let canon::Value::Object(map) = &mut value else {
        return Err(NodeError::Collection("canon body is not an object".into()));
    };
    map.insert("sig".into(), canon::Value::String(sig));
    Ok(value.to_canon())
}

pub struct Swarm {
    video: VideoAddr,
    sender: GossipSender,
    receiver: GossipReceiver,
    /// Messages that failed verification (counted, never surfaced as presence).
    pub rejected: u64,
}

impl Node {
    /// Join `video`'s swarm topic, bootstrapping from `peers`: each is dialled only at the
    /// addresses [`Node::trusted`] keeps, and a peer with none left is skipped.
    ///
    /// Refused on a relay-only node. iroh-gossip passes the addresses peers advertise in
    /// the swarm straight to the endpoint, and iroh dials any relay URL it is given, so a
    /// swarm member could make the node contact a relay host of its choosing and learn
    /// the IP address that relay-only mode exists to hide.
    pub async fn join_swarm(&self, video: &VideoAddr, peers: Vec<EndpointAddr>) -> Result<Swarm> {
        if self.relay_only() {
            return Err(NodeError::Transport(
                "a relay-only node does not join gossip swarms".into(),
            ));
        }
        let bootstrap = peers
            .iter()
            .filter(|p| self.learn_addr(p))
            .map(|p| p.id)
            .collect::<Vec<_>>();
        let topic = TopicId::from_bytes(video.swarm_topic());
        let (sender, receiver) = self
            .gossip()
            .subscribe(topic, bootstrap)
            .await
            .map_err(NodeError::transport)?
            .split();
        Ok(Swarm {
            video: video.clone(),
            sender,
            receiver,
            rejected: 0,
        })
    }
}

/// The sending half of a [`Swarm`].
pub struct Announcer {
    sender: GossipSender,
}

impl Announcer {
    pub async fn announce(&self, wire: &str) -> Result<()> {
        self.sender
            .broadcast(wire.to_owned().into_bytes().into())
            .await
            .map_err(NodeError::transport)
    }
}

/// The receiving half of a [`Swarm`].
pub struct Listener {
    video: VideoAddr,
    receiver: GossipReceiver,
    /// Messages that failed verification (counted, never surfaced as presence).
    pub rejected: u64,
}

impl Listener {
    /// The next envelope that verifies for this video at the time it arrives; others are
    /// dropped and counted. `None` when the swarm closes.
    pub async fn next_envelope(&mut self) -> Option<Verified<Envelope>> {
        while let Some(event) = self.receiver.next().await {
            let Ok(Event::Received(msg)) = event else {
                continue;
            };
            match std::str::from_utf8(&msg.content)
                .ok()
                .and_then(|w| Envelope::verify(w, &self.video, crate::unix_now()).ok())
            {
                Some(env) => return Some(env),
                None => self.rejected += 1,
            }
        }
        None
    }
}

impl Swarm {
    /// Separate the halves, so one task can announce while another listens.
    #[must_use]
    pub fn split(self) -> (Announcer, Listener) {
        (
            Announcer {
                sender: self.sender,
            },
            Listener {
                video: self.video,
                receiver: self.receiver,
                rejected: self.rejected,
            },
        )
    }

    /// Wait until at least one neighbour is connected.
    pub async fn joined(&mut self) -> Result<()> {
        self.receiver.joined().await.map_err(NodeError::transport)
    }

    pub async fn announce(&self, wire: &str) -> Result<()> {
        self.sender
            .broadcast(wire.to_owned().into_bytes().into())
            .await
            .map_err(NodeError::transport)
    }

    /// The next envelope that verifies for this video at time `now`. Envelopes that fail
    /// verification are dropped and counted in [`Swarm::rejected`]. `None` when the swarm
    /// closes.
    pub async fn next_envelope(&mut self, now: u64) -> Option<Verified<Envelope>> {
        while let Some(event) = self.receiver.next().await {
            let Ok(Event::Received(msg)) = event else {
                continue;
            };
            match std::str::from_utf8(&msg.content)
                .ok()
                .and_then(|w| Envelope::verify(w, &self.video, now).ok())
            {
                Some(env) => return Some(env),
                None => self.rejected += 1,
            }
        }
        None
    }
}
