//! Strict lowercase-hex helpers. NFX writes every key, hash and signature as
//! lowercase hex; uppercase or mixed case is rejected, never normalized.

pub(crate) fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn decode<const N: usize>(s: &str) -> Option<[u8; N]> {
    if !is_lower_hex(s, N * 2) {
        return None;
    }
    let mut out = [0u8; N];
    hex::decode_to_slice(s, &mut out).ok()?;
    Some(out)
}

/// ASCII-decimal unsigned integer: no sign, no leading zeros (except `"0"`), ≤ 2^64 − 1
/// (NFX-02 §3).
pub(crate) fn parse_u64_strict(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 20 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    s.parse().ok()
}

/// An `https://` URL with a non-empty host, no userinfo, and no whitespace or control
/// characters. Deliberately minimal: NFX only needs to refuse other schemes, empty
/// hosts, and `https://trusted.example@other.example`-style lookalikes.
pub(crate) fn is_https_url(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
        && !authority.contains('@')
        && !s.chars().any(|c| c.is_whitespace() || c.is_control())
}
