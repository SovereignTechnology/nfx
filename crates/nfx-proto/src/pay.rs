//! pay/1 messages (NFX-07 §2): one JSON object per line, on the `nfx/pay/1` channel.
//!
//! This is the wire only: shapes and the §2 message rules. What a payment is worth, and
//! whether its token is good, is the payment engine's (NFX-07 §3), not this module's.
//! Unknown fields are ignored; an unknown `t` is an error. Vectors: `pay1.json`.

use serde_json::{Map, Value, json};

use crate::hex32::{is_https_url, is_lower_hex};
use crate::namespace::VideoAddr;
use crate::{Error, Result};

/// The longest line, newline included.
pub const MAX_LINE_BYTES: usize = 32 * 1024;
/// Mints one quote may name.
pub const MAX_MINTS: usize = 16;
/// The longest `rej.detail`, in bytes.
pub const MAX_DETAIL_BYTES: usize = 1024;
/// The largest integer: JavaScript peers read it exactly.
pub const MAX_INT: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Hello(Hello),
    Quote(Quote),
    Pay(Pay),
    Ack(Ack),
    Rej(Rej),
}

/// Watcher → seeder: open accounting for `video` under `session`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub video: VideoAddr,
    /// 32 lowercase hex characters.
    pub session: String,
}

/// Seeder → watcher: the binding price, the only mints it takes, and the unpaid chunks it
/// tolerates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub price_per_chunk: u64,
    pub mints: Vec<String>,
    pub window: u64,
}

/// Watcher → seeder: payment for chunks `(last acknowledged, upto_chunk]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pay {
    pub upto_chunk: u64,
    /// A NUT-00 token (`cashuA…`/`cashuB…`), unchecked here.
    pub token: String,
}

/// Seeder → watcher: payment accepted up to `accepted_upto`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ack {
    pub accepted_upto: u64,
    pub spent_total: u64,
}

/// Seeder → watcher: a payment or request refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rej {
    pub code: RejCode,
    pub detail: Option<String>,
}

/// NFX-11 §6. Codes this version does not know are kept, as clients must tolerate them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejCode {
    Underpaid,
    Overpaid,
    BadMint,
    Spent,
    BadLock,
    Stale,
    PaymentRequired,
    BadVoucher,
    UnknownVideo,
    RootMismatch,
    BelowFee,
    Other(String),
}

impl RejCode {
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Underpaid => "underpaid",
            Self::Overpaid => "overpaid",
            Self::BadMint => "bad-mint",
            Self::Spent => "spent",
            Self::BadLock => "bad-lock",
            Self::Stale => "stale",
            Self::PaymentRequired => "payment-required",
            Self::BadVoucher => "bad-voucher",
            Self::UnknownVideo => "unknown-video",
            Self::RootMismatch => "root-mismatch",
            Self::BelowFee => "below-fee",
            Self::Other(s) => s,
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "underpaid" => Self::Underpaid,
            "overpaid" => Self::Overpaid,
            "bad-mint" => Self::BadMint,
            "spent" => Self::Spent,
            "bad-lock" => Self::BadLock,
            "stale" => Self::Stale,
            "payment-required" => Self::PaymentRequired,
            "bad-voucher" => Self::BadVoucher,
            "unknown-video" => Self::UnknownVideo,
            "root-mismatch" => Self::RootMismatch,
            "below-fee" => Self::BelowFee,
            other => Self::Other(other.to_owned()),
        }
    }
}

fn bad(why: &str) -> Error {
    Error::Pay(why.to_owned())
}

fn int(obj: &Map<String, Value>, name: &str) -> Result<u64> {
    let v = obj
        .get(name)
        .ok_or_else(|| bad(&format!("missing {name}")))?;
    match v.as_u64() {
        Some(n) if n <= MAX_INT && !v.is_f64() => Ok(n),
        Some(_) => Err(bad("integers at most 2^53-1")),
        None => Err(bad("integers only, non-negative")),
    }
}

fn string<'a>(obj: &'a Map<String, Value>, name: &str) -> Result<&'a str> {
    obj.get(name)
        .ok_or_else(|| bad(&format!("missing {name}")))?
        .as_str()
        .ok_or_else(|| bad(&format!("{name} must be a string")))
}

/// `https://…`, or `http://` on a loopback host (tests).
fn mint_url_ok(u: &str) -> bool {
    if is_https_url(u) {
        return true;
    }
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| {
            u.strip_prefix(p)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        })
        && !u
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '@')
}

impl Message {
    /// Parse one line (without its newline).
    pub fn parse(line: &str) -> Result<Self> {
        if line.len() + 1 > MAX_LINE_BYTES {
            return Err(bad("a line is at most 32 KiB"));
        }
        let value: Value = serde_json::from_str(line).map_err(|_| bad("not JSON"))?;
        let obj = value.as_object().ok_or_else(|| bad("not an object"))?;
        match string(obj, "t")? {
            "hello" => {
                let video = VideoAddr::parse(string(obj, "video")?)
                    .map_err(|_| bad("video is an NFX address"))?;
                let session = string(obj, "session")?;
                if !is_lower_hex(session, 32) {
                    return Err(bad("session is 32 lowercase hex"));
                }
                Ok(Self::Hello(Hello {
                    video,
                    session: session.to_owned(),
                }))
            }
            "quote" => {
                let price_per_chunk = int(obj, "price_per_chunk")?;
                let window = int(obj, "window")?;
                if price_per_chunk == 0 {
                    return Err(bad("price_per_chunk >= 1"));
                }
                if window == 0 {
                    return Err(bad("window >= 1"));
                }
                let mints = obj
                    .get("mints")
                    .and_then(Value::as_array)
                    .ok_or_else(|| bad("mints is 1 to 16 URLs"))?;
                if mints.is_empty() || mints.len() > MAX_MINTS {
                    return Err(bad("mints is 1 to 16 URLs"));
                }
                let mints = mints
                    .iter()
                    .map(|m| match m.as_str() {
                        Some(u) if mint_url_ok(u) => Ok(u.to_owned()),
                        _ => Err(bad("mint must be https (or loopback http)")),
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(Self::Quote(Quote {
                    price_per_chunk,
                    mints,
                    window,
                }))
            }
            "pay" => {
                let upto_chunk = int(obj, "upto_chunk")?;
                if upto_chunk == 0 {
                    return Err(bad("upto_chunk >= 1"));
                }
                let token = string(obj, "token")?;
                if !(token.starts_with("cashuA") || token.starts_with("cashuB")) {
                    return Err(bad("token is a NUT-00 token"));
                }
                Ok(Self::Pay(Pay {
                    upto_chunk,
                    token: token.to_owned(),
                }))
            }
            "ack" => Ok(Self::Ack(Ack {
                accepted_upto: int(obj, "accepted_upto")?,
                spent_total: int(obj, "spent_total")?,
            })),
            "rej" => {
                let code = RejCode::parse(string(obj, "code")?);
                let detail = match obj.get("detail") {
                    None => None,
                    Some(Value::String(d)) if d.len() <= MAX_DETAIL_BYTES => Some(d.clone()),
                    Some(_) => return Err(bad("detail at most 1 KiB")),
                };
                Ok(Self::Rej(Rej { code, detail }))
            }
            _ => Err(bad("unknown t")),
        }
    }

    /// The message as one line (without the newline).
    #[must_use]
    pub fn to_line(&self) -> String {
        match self {
            Self::Hello(h) => {
                json!({"t": "hello", "video": h.video.to_string(), "session": h.session})
            }
            Self::Quote(q) => json!({
                "t": "quote",
                "price_per_chunk": q.price_per_chunk,
                "mints": q.mints,
                "window": q.window,
            }),
            Self::Pay(p) => json!({"t": "pay", "upto_chunk": p.upto_chunk, "token": p.token}),
            Self::Ack(a) => {
                json!({"t": "ack", "accepted_upto": a.accepted_upto, "spent_total": a.spent_total})
            }
            Self::Rej(r) => match &r.detail {
                Some(d) => json!({"t": "rej", "code": r.code.as_str(), "detail": d}),
                None => json!({"t": "rej", "code": r.code.as_str()}),
            },
        }
        .to_string()
    }
}
