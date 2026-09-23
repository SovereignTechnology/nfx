//! Free-seeder vouchers (NFX-08 §5): `sig = BIP-340(creator, sha256(canon(voucher)))`.

use serde::Serialize;

use crate::canon;
use crate::event::{sign_digest, verify_digest};
use crate::hex32::is_lower_hex;
use crate::manifest::{License, Manifest};
use crate::namespace::{Namespace, VideoAddr};
use crate::{Error, Result, sha256};

pub const VOUCHER_TYPE: &str = "nfx-voucher";

/// A voucher's fields. Serializing it gives the object that is canonicalized and signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Voucher {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(serialize_with = "display")]
    pub network: Namespace,
    #[serde(serialize_with = "display")]
    pub video: VideoAddr,
    pub seeder: String,
    pub not_after: u64,
}

fn display<T: core::fmt::Display, S: serde::Serializer>(
    v: &T,
    s: S,
) -> core::result::Result<S::Ok, S::Error> {
    s.collect_str(v)
}

impl Voucher {
    #[must_use]
    pub fn new(video: VideoAddr, seeder: String, not_after: u64) -> Self {
        Self {
            v: 1,
            kind: VOUCHER_TYPE.to_owned(),
            network: video.namespace().clone(),
            video,
            seeder,
            not_after,
        }
    }

    /// `canon(voucher)`.
    pub fn canon(&self) -> Result<String> {
        let json = serde_json::to_value(self).map_err(|e| Error::Voucher(e.to_string()))?;
        Ok(canon::Value::from_json(&json)?.to_canon())
    }

    /// `sha256(canon(voucher))`, the digest the creator signs.
    pub fn digest(&self) -> Result<[u8; 32]> {
        Ok(sha256(self.canon()?.as_bytes()))
    }

    /// Sign with the creator's raw secret key (deterministic BIP-340; see [`Event::sign`](crate::event::Event::sign)).
    pub fn sign(&self, creator_secret: &[u8; 32]) -> Result<String> {
        Ok(hex::encode(sign_digest(creator_secret, &self.digest()?)?))
    }

    /// Everything a mint checks before releasing a key against a voucher (NFX-08 §5), at
    /// time `now`, for the manifest that names the requested `root`:
    ///
    /// - the signature is by the manifest's author, over `sha256(canon(received object))`
    ///   (the *received* object is re-canonicalized; the sender's layout is never trusted);
    /// - the fields are well formed, `network` matches `video`, and it has not expired;
    /// - it names this manifest's video, which is licensed, and `seeder` is one of its
    ///   `free_seeder`s;
    /// - `presenter`, the pubkey that NIP-98-signed the license request, **is** `seeder`,
    ///   so a leaked voucher is useless to anyone else.
    ///
    /// There is deliberately no public signature-only check, which would let a caller
    /// forget the manifest or presenter binding.
    pub fn verify(
        wire: &str,
        sig_hex: &str,
        manifest: &Manifest,
        presenter: &str,
        now: u64,
    ) -> Result<Self> {
        let voucher = Self::verify_signed_fields(wire, sig_hex, &manifest.author, now)?;
        voucher.check_against(manifest)?;
        if presenter != voucher.seeder {
            return Err(bad("voucher must be presented by its seeder (NIP-98)"));
        }
        Ok(voucher)
    }

    fn verify_signed_fields(
        wire: &str,
        sig_hex: &str,
        creator_pubkey: &str,
        now: u64,
    ) -> Result<Self> {
        let value = canon::Value::parse(wire)?;
        let digest = sha256(value.to_canon().as_bytes());
        verify_digest(creator_pubkey, &digest, sig_hex)?;
        let obj = value.as_object().ok_or_else(|| bad("not an object"))?;
        let int = |k: &str| match obj.get(k) {
            Some(canon::Value::Int(i)) => {
                u64::try_from(*i).map_err(|_| bad(&format!("`{k}` is negative")))
            }
            _ => Err(bad(&format!("`{k}` must be an integer"))),
        };
        let string = |k: &str| match obj.get(k) {
            Some(canon::Value::String(s)) => Ok(s.clone()),
            _ => Err(bad(&format!("`{k}` must be a string"))),
        };
        if int("v")? != 1 {
            return Err(bad("`v` must be 1"));
        }
        if string("type")? != VOUCHER_TYPE {
            return Err(bad("`type` must be nfx-voucher"));
        }
        let network = Namespace::parse(&string("network")?)?;
        let video = VideoAddr::parse(&string("video")?)?;
        if video.namespace() != &network {
            return Err(bad("`network` does not equal the namespace of `video`"));
        }
        let seeder = string("seeder")?;
        if !is_lower_hex(&seeder, 64) {
            return Err(bad("`seeder` is not 64 lowercase hex"));
        }
        let not_after = int("not_after")?;
        if not_after <= now {
            return Err(bad("expired"));
        }
        Ok(Self {
            v: 1,
            kind: VOUCHER_TYPE.to_owned(),
            network,
            video,
            seeder,
            not_after,
        })
    }

    fn check_against(&self, manifest: &Manifest) -> Result<()> {
        if self.video != manifest.addr {
            return Err(bad("voucher names a different video"));
        }
        match &manifest.license {
            License::Licensed(terms) if terms.free_seeders.contains(&self.seeder) => Ok(()),
            License::Licensed(_) => Err(bad("seeder is not a free_seeder of this manifest")),
            License::Open => Err(bad("vouchers only apply to licensed manifests")),
        }
    }
}

fn bad(reason: &str) -> Error {
    Error::Voucher(reason.to_owned())
}
