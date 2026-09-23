//! iroh-gossip presence envelopes (NFX-06 §4): signed by the seeder's nostr key over
//! `sha256(canon(body))`, where `body` is the message without `sig`.

use crate::beacon::BeaconContent;
use crate::canon;
use crate::event::{sign_digest, verify_digest};
use crate::hex32::is_lower_hex;
use crate::namespace::VideoAddr;
use crate::{Error, MAX_CLOCK_SKEW, Result, sha256};

/// Peers evict an entry older than this (2 × the 120 s beacon TTL).
pub const EVICT_AFTER: u64 = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Here,
    Bye,
}

impl Op {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Here => "here",
            Self::Bye => "bye",
        }
    }
}

/// A verified envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub op: Op,
    pub pubkey: String,
    pub beacon: BeaconContent,
    pub created_at: u64,
}

impl Envelope {
    /// Verify a received message for the swarm of `video` at time `now`.
    pub fn verify(wire: &str, video: &VideoAddr, now: u64) -> Result<Self> {
        let value = canon::Value::parse(wire)?;
        let mut body = value
            .as_object()
            .ok_or_else(|| bad("not an object"))?
            .clone();
        let sig = match body.remove("sig") {
            Some(canon::Value::String(s)) => s,
            _ => return Err(bad("`sig` must be a string")),
        };
        let pubkey = match body.get("pubkey") {
            Some(canon::Value::String(s)) if is_lower_hex(s, 64) => s.clone(),
            _ => return Err(bad("`pubkey` must be 64 lowercase hex")),
        };
        let digest = sha256(canon::Value::Object(body.clone()).to_canon().as_bytes());
        verify_digest(&pubkey, &digest, &sig)?;

        if body.get("v") != Some(&canon::Value::Int(1)) {
            return Err(bad("`v` must be 1"));
        }
        let op = match body.get("op") {
            Some(canon::Value::String(s)) if s == "here" => Op::Here,
            Some(canon::Value::String(s)) if s == "bye" => Op::Bye,
            _ => return Err(bad("`op` must be here or bye")),
        };
        let created_at = match body.get("created_at") {
            Some(canon::Value::Int(i)) => {
                u64::try_from(*i).map_err(|_| bad("negative `created_at`"))?
            }
            _ => return Err(bad("`created_at` must be an integer")),
        };
        if now.abs_diff(created_at) > MAX_CLOCK_SKEW {
            return Err(bad("`created_at` more than 15 min from now"));
        }
        let beacon = BeaconContent::from_json(
            &body
                .get("beacon")
                .ok_or_else(|| bad("missing `beacon`"))?
                .to_json(),
        )?;
        if &beacon.video != video {
            return Err(bad("beacon video does not belong to this topic's swarm"));
        }
        Ok(Self {
            op,
            pubkey,
            beacon,
            created_at,
        })
    }

    /// `true` once a peer should evict this entry (NFX-06 §4).
    #[must_use]
    pub fn is_stale(&self, now: u64) -> bool {
        now.saturating_sub(self.created_at) > EVICT_AFTER
    }

    /// Canonical body text (the signed bytes).
    pub fn canon_body(&self) -> Result<String> {
        let beacon =
            serde_json::to_value(&self.beacon).map_err(|e| Error::Gossip(e.to_string()))?;
        let body = serde_json::json!({
            "v": 1,
            "op": self.op.as_str(),
            "pubkey": self.pubkey,
            "beacon": beacon,
            "created_at": self.created_at,
        });
        Ok(canon::Value::from_json(&body)?.to_canon())
    }

    /// Sign with the seeder's raw secret key (deterministic BIP-340).
    pub fn sign(&self, seeder_secret: &[u8; 32]) -> Result<String> {
        let digest = sha256(self.canon_body()?.as_bytes());
        Ok(hex::encode(sign_digest(seeder_secret, &digest)?))
    }
}

fn bad(reason: &str) -> Error {
    Error::Gossip(reason.to_owned())
}
