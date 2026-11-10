//! NIP-44 v2 encryption, the payload format of NFX-10 §6's offers and answers.
//!
//! secp256k1 ECDH and ChaCha20 come from RustCrypto (`k256`, `chacha20`). HMAC-SHA256 and
//! HKDF are written out here over `sha2`, because RustCrypto's `hmac` would turn on a feature
//! of `digest` that the money crates' pinned dependency closure does not have
//! (`crates/ci/locked-compiled.txt`). Both are checked against RFC 4231 and RFC 5869, and
//! the whole scheme against cases from the official NIP-44 vectors
//! (`spec/test-vectors/mesh-signal.json`).
//!
//! Pure like the rest of the crate: the caller supplies the 32-byte nonce, which MUST be
//! fresh and random for every message.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20::ChaCha20;
use chacha20::cipher::{KeyIvInit, StreamCipher};
use k256::ProjectivePoint;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::schnorr::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// The HKDF salt of NIP-44 v2.
const SALT: &[u8] = b"nip44-v2";
/// Plaintext bounds, in bytes.
pub const MIN_PLAINTEXT: usize = 1;
pub const MAX_PLAINTEXT: usize = 65535;
/// Payload bounds: base64 characters, then decoded bytes.
const PAYLOAD_LEN: core::ops::RangeInclusive<usize> = 132..=87472;
const DATA_LEN: core::ops::RangeInclusive<usize> = 99..=65603;

/// HMAC-SHA256 (RFC 2104) of the concatenation of `parts`.
#[must_use]
pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    for p in parts {
        inner.update(p);
    }
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// HKDF-SHA256 extract (RFC 5869 §2.2).
#[must_use]
pub fn hkdf_extract(salt: &[u8], ikm: &[u8]) -> [u8; 32] {
    hmac_sha256(salt, &[ikm])
}

/// HKDF-SHA256 expand (RFC 5869 §2.3) to `N` bytes, `N` at most 255 × 32.
#[must_use]
pub fn hkdf_expand<const N: usize>(prk: &[u8; 32], info: &[u8]) -> [u8; N] {
    const { assert!(N <= 255 * 32) };
    let mut out = [0u8; N];
    let mut t: [u8; 32] = [0; 32];
    for (i, chunk) in out.chunks_mut(32).enumerate() {
        let counter = [u8::try_from(i + 1).expect("N <= 255 * 32")];
        t = if i == 0 {
            hmac_sha256(prk, &[info, &counter])
        } else {
            hmac_sha256(prk, &[&t, info, &counter])
        };
        chunk.copy_from_slice(&t[..chunk.len()]);
    }
    out
}

/// The conversation key between `secret_key` and the x-only `public_key` (64 lowercase hex):
/// HKDF-extract(salt "nip44-v2", the unhashed x coordinate of their ECDH point). The same
/// from both sides.
pub fn conversation_key(secret_key: &[u8; 32], public_key_hex: &str) -> Result<[u8; 32]> {
    let sk =
        SigningKey::from_bytes(&(*secret_key).into()).map_err(|_| nip44("invalid secret key"))?;
    let pk: [u8; 32] = crate::hex32::decode(public_key_hex)
        .ok_or_else(|| nip44("public key is not 64 lowercase hex"))?;
    let vk = VerifyingKey::from_bytes(&pk.into()).map_err(|_| nip44("not a public key"))?;
    let shared =
        (ProjectivePoint::from(*vk.as_affine()) * sk.as_nonzero_scalar().as_ref()).to_affine();
    Ok(hkdf_extract(SALT, &shared.x()))
}

/// The per-message keys: ChaCha20 key, ChaCha20 nonce and HMAC key.
#[must_use]
pub fn message_keys(
    conversation_key: &[u8; 32],
    nonce: &[u8; 32],
) -> ([u8; 32], [u8; 12], [u8; 32]) {
    let okm: [u8; 76] = hkdf_expand(conversation_key, nonce);
    let mut key = [0u8; 32];
    let mut chacha_nonce = [0u8; 12];
    let mut hmac_key = [0u8; 32];
    key.copy_from_slice(&okm[..32]);
    chacha_nonce.copy_from_slice(&okm[32..44]);
    hmac_key.copy_from_slice(&okm[44..76]);
    (key, chacha_nonce, hmac_key)
}

/// The padded length of a plaintext of `len` bytes.
#[must_use]
pub fn calc_padded_len(len: usize) -> usize {
    if len <= 32 {
        return 32;
    }
    let next_power = 1usize << (usize::BITS - (len - 1).leading_zeros());
    let chunk = if next_power <= 256 {
        32
    } else {
        next_power / 8
    };
    chunk * ((len - 1) / chunk + 1)
}

fn chacha20(key: &[u8; 32], nonce: &[u8; 12], buf: &mut [u8]) {
    let mut cipher = ChaCha20::new(&(*key).into(), &(*nonce).into());
    cipher.apply_keystream(buf);
}

/// Encrypt `plaintext` (1 to 65535 bytes of UTF-8) with `nonce`: the base64 payload.
pub fn encrypt(conversation_key: &[u8; 32], plaintext: &str, nonce: &[u8; 32]) -> Result<String> {
    let pt = plaintext.as_bytes();
    if !(MIN_PLAINTEXT..=MAX_PLAINTEXT).contains(&pt.len()) {
        return Err(nip44("plaintext must be 1 to 65535 bytes"));
    }
    let (key, chacha_nonce, hmac_key) = message_keys(conversation_key, nonce);
    let len = u16::try_from(pt.len()).expect("checked above");
    let mut padded = vec![0u8; 2 + calc_padded_len(pt.len())];
    padded[..2].copy_from_slice(&len.to_be_bytes());
    padded[2..2 + pt.len()].copy_from_slice(pt);
    chacha20(&key, &chacha_nonce, &mut padded);
    let mac = hmac_sha256(&hmac_key, &[nonce, &padded]);
    let mut data = Vec::with_capacity(1 + 32 + padded.len() + 32);
    data.push(2);
    data.extend_from_slice(nonce);
    data.extend_from_slice(&padded);
    data.extend_from_slice(&mac);
    Ok(B64.encode(data))
}

/// Decrypt a base64 payload: version 2 only, the MAC checked (in constant time) before
/// anything is decrypted, then the padding.
pub fn decrypt(conversation_key: &[u8; 32], payload: &str) -> Result<String> {
    if payload.starts_with('#') {
        return Err(nip44("unknown version"));
    }
    if !PAYLOAD_LEN.contains(&payload.len()) {
        return Err(nip44("payload size"));
    }
    let data = B64
        .decode(payload)
        .map_err(|_| nip44("payload is not base64"))?;
    if !DATA_LEN.contains(&data.len()) {
        return Err(nip44("payload size"));
    }
    if data[0] != 2 {
        return Err(nip44("unknown version"));
    }
    let nonce: [u8; 32] = data[1..33].try_into().expect("length checked");
    let (ciphertext, mac) = data[33..].split_at(data.len() - 33 - 32);
    let (key, chacha_nonce, hmac_key) = message_keys(conversation_key, &nonce);
    let expected = hmac_sha256(&hmac_key, &[&nonce, ciphertext]);
    if expected
        .iter()
        .zip(mac)
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        != 0
    {
        return Err(nip44("invalid MAC"));
    }
    let mut padded = ciphertext.to_vec();
    chacha20(&key, &chacha_nonce, &mut padded);
    let len = usize::from(u16::from_be_bytes([padded[0], padded[1]]));
    if len == 0 || padded.len() != 2 + calc_padded_len(len) {
        return Err(nip44("invalid padding"));
    }
    String::from_utf8(padded[2..2 + len].to_vec()).map_err(|_| nip44("plaintext is not UTF-8"))
}

fn nip44(reason: &str) -> Error {
    Error::Event(format!("nip44: {reason}"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn hmac_matches_rfc_4231() {
        assert_eq!(
            hex::encode(hmac_sha256(&[0x0b; 20], &[b"Hi There"])),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        // A key longer than the block is hashed first; parts are concatenated.
        assert_eq!(
            hex::encode(hmac_sha256(
                &[0xaa; 131],
                &[
                    b"Test Using Larger Than Block-Size Key",
                    b" - Hash Key First"
                ]
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn hkdf_matches_rfc_5869() {
        let salt: Vec<u8> = (0..13).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let prk = hkdf_extract(&salt, &[0x0b; 22]);
        assert_eq!(
            hex::encode(prk),
            "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
        );
        let okm: [u8; 42] = hkdf_expand(&prk, &info);
        assert_eq!(
            hex::encode(okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn round_trip_and_tamper() {
        let a = [7u8; 32];
        let b = [9u8; 32];
        let pk_b = crate::event::public_key_hex(&b).unwrap();
        let pk_a = crate::event::public_key_hex(&a).unwrap();
        let ck = conversation_key(&a, &pk_b).unwrap();
        assert_eq!(ck, conversation_key(&b, &pk_a).unwrap());
        for len in [1, 31, 32, 33, 255, 256, 257, 4000, 65535] {
            let text = "x".repeat(len);
            let p = encrypt(&ck, &text, &[3; 32]).unwrap();
            assert_eq!(decrypt(&ck, &p).unwrap(), text);
        }
        assert!(encrypt(&ck, "", &[3; 32]).is_err());
        assert!(encrypt(&ck, &"x".repeat(65536), &[3; 32]).is_err());
        let p = encrypt(&ck, "hello", &[3; 32]).unwrap();
        let mut raw = B64.decode(&p).unwrap();
        for at in [0, 1, 40, raw.len() - 1] {
            raw[at] ^= 1;
            assert!(decrypt(&ck, &B64.encode(&raw)).is_err(), "byte {at}");
            raw[at] ^= 1;
        }
        assert!(decrypt(&[1; 32], &p).is_err());
    }
}
