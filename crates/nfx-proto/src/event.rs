//! Nostr events (NIP-01) as NFX uses them: id recomputation, BIP-340 verification,
//! deterministic signing, and strict tag lookup.

use k256::schnorr::signature::hazmat::{PrehashSigner, PrehashVerifier};
use k256::schnorr::{Signature, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::hex32::{decode, is_lower_hex};
use crate::{Error, Result, sha256};

/// A signed Nostr event. Parsed from JSON as-is; call [`Event::verify`] before trusting it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

impl Event {
    /// Build and sign an event with a raw secret key.
    ///
    /// Signing is deterministic BIP-340 with a zero `aux_rand` (k256's `PrehashSigner`),
    /// which is what the test vectors use. Deterministic nonces are safe, but real user
    /// keys belong in a proper signer (NIP-46, nostr-sdk); this exists for vectors,
    /// tests and throwaway testnet keys.
    pub fn sign(
        secret_key: &[u8; 32],
        created_at: u64,
        kind: u16,
        tags: Vec<Vec<String>>,
        content: String,
    ) -> Result<Self> {
        let sk = SigningKey::from_bytes(&(*secret_key).into())
            .map_err(|_| Error::Event("invalid secret key".into()))?;
        let pubkey = hex::encode(sk.verifying_key().to_bytes());
        let mut event = Self {
            id: String::new(),
            pubkey,
            created_at,
            kind,
            tags,
            content,
            sig: String::new(),
        };
        let id = event.compute_id();
        event.id = hex::encode(id);
        event.sig = hex::encode(sign_digest(secret_key, &id)?);
        Ok(event)
    }

    /// `sha256` of the NIP-01 serialization `[0, pubkey, created_at, kind, tags, content]`.
    #[must_use]
    pub fn compute_id(&self) -> [u8; 32] {
        let serialized = serde_json::to_string(&(
            0u8,
            &self.pubkey,
            self.created_at,
            self.kind,
            &self.tags,
            &self.content,
        ))
        .expect("serializing strings and integers cannot fail");
        sha256(serialized.as_bytes())
    }

    /// Check the id against the serialization and the BIP-340 signature against `pubkey`.
    pub fn verify(&self) -> Result<()> {
        let id: [u8; 32] =
            decode(&self.id).ok_or_else(|| Error::Event("id is not 64 lowercase hex".into()))?;
        if id != self.compute_id() {
            return Err(Error::Event(
                "id does not match the NIP-01 serialization".into(),
            ));
        }
        if !is_lower_hex(&self.pubkey, 64) {
            return Err(Error::Event("pubkey is not 64 lowercase hex".into()));
        }
        verify_digest(&self.pubkey, &id, &self.sig)
    }

    /// Values (everything after the name) of every tag called `name`.
    pub fn tag_values<'a>(&'a self, name: &str) -> impl Iterator<Item = &'a [String]> {
        self.tags
            .iter()
            .filter(move |t| t.first().is_some_and(|n| n == name))
            .map(|t| &t[1..])
    }

    /// The single tag called `name`: `Ok(None)` if absent, an error if it appears twice
    /// or carries no value.
    pub fn single_tag<'a>(
        &'a self,
        name: &str,
    ) -> core::result::Result<Option<&'a [String]>, String> {
        let mut found = self.tag_values(name);
        let first = found.next();
        if found.next().is_some() {
            return Err(format!("duplicate `{name}` tag"));
        }
        match first {
            Some([]) => Err(format!("`{name}` tag has no value")),
            other => Ok(other),
        }
    }
}

/// BIP-340 signature over a 32-byte digest (deterministic, zero `aux_rand`).
pub fn sign_digest(secret_key: &[u8; 32], digest: &[u8; 32]) -> Result<[u8; 64]> {
    let sk = SigningKey::from_bytes(&(*secret_key).into())
        .map_err(|_| Error::Event("invalid secret key".into()))?;
    let sig: Signature = sk.sign_prehash(digest).map_err(|_| Error::Signature)?;
    Ok(sig.to_bytes())
}

/// Verify a BIP-340 signature (128 lowercase hex) by an x-only pubkey (64 lowercase hex)
/// over a 32-byte digest.
pub fn verify_digest(pubkey_hex: &str, digest: &[u8; 32], sig_hex: &str) -> Result<()> {
    let pubkey: [u8; 32] = decode(pubkey_hex).ok_or(Error::Signature)?;
    let sig: [u8; 64] = decode(sig_hex).ok_or(Error::Signature)?;
    let vk = VerifyingKey::from_bytes(&pubkey.into()).map_err(|_| Error::Signature)?;
    let sig = Signature::from_bytes(&sig).map_err(|_| Error::Signature)?;
    vk.verify_prehash(digest, &sig)
        .map_err(|_| Error::Signature)
}

/// The x-only public key (64 lowercase hex) of a secret key.
pub fn public_key_hex(secret_key: &[u8; 32]) -> Result<String> {
    let sk = SigningKey::from_bytes(&(*secret_key).into())
        .map_err(|_| Error::Event("invalid secret key".into()))?;
    Ok(hex::encode(sk.verifying_key().to_bytes()))
}
