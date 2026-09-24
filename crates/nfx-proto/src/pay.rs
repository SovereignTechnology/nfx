//! pay/1 messages (NFX-07 §2): one JSON object per line, on the `nfx/pay/1` channel.
//!
//! This is the wire only: shapes and the §2 message rules. What a payment is worth, and
//! whether its token is good, is the payment engine's (NFX-07 §3), not this module's.
//! Objects follow the NFX-11 §9 value rules ([`crate::canon`]): no duplicate keys, no
//! fractions, no lone surrogates. Unknown fields are ignored; an unknown `t` is an
//! error. Vectors: `pay1.json`.

use std::collections::BTreeMap;

use serde_json::json;

use crate::canon::Value;
use crate::hex32::is_lower_hex;
use crate::namespace::VideoAddr;
use crate::{Error, Result};

/// The longest line, newline included.
pub const MAX_LINE_BYTES: usize = 32 * 1024;
/// Mints one quote may name.
pub const MAX_MINTS: usize = 16;
/// The longest `rej.detail`, in bytes.
pub const MAX_DETAIL_BYTES: usize = 1024;
/// The longest `rej.code`, in bytes.
pub const MAX_CODE_BYTES: usize = 64;
/// The largest integer: JavaScript peers read it exactly.
pub const MAX_INT: u64 = (1 << 53) - 1;
/// The deepest nesting; the message object is level 1.
pub const MAX_DEPTH: usize = 16;

/// What a deployment permits beyond the default rules.
#[derive(Debug, Clone, Copy, Default)]
pub struct ParseOptions {
    /// Accept `http://` mint URLs on a loopback host (tests only; NFX-07 §2).
    pub allow_loopback_http: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Hello(Hello),
    Quote(Quote),
    Pay(Pay),
    Ack(Ack),
    Rej(Rej),
}

/// Watcher → seeder: open a session for `video`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub video: VideoAddr,
    /// 32 lowercase hex characters.
    pub session: String,
}

/// Seeder → watcher: the binding price (sat per chunk), the only mints it takes, the
/// unpaid chunks it tolerates from one peer, and the account's position (NFX-07 §3), so
/// a watcher can resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub price_per_chunk: u64,
    pub mints: Vec<String>,
    pub window: u64,
    /// Chunks the seeder has admitted on this account.
    pub served: u64,
    /// The account's payment watermark.
    pub accepted_upto: u64,
    /// The face value accepted on this account.
    pub spent_total: u64,
}

/// Watcher → seeder: payment for chunks `(last acknowledged, upto_chunk]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pay {
    pub upto_chunk: u64,
    /// A NUT-00 token (`cashuA…`/`cashuB…`), unchecked here.
    pub token: String,
}

/// Seeder → watcher: the payment's swap completed, and the account is paid up to
/// `accepted_upto`; `spent_total` is the face value accepted so far on the account.
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
/// Build one from its wire form with [`RejCode::from_code`], so a known code is never an
/// `Other`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejCode {
    Underpaid,
    Overpaid,
    BadMint,
    BadToken,
    Spent,
    Banned,
    BadSession,
    MintUnavailable,
    BadLock,
    Stale,
    PaymentRequired,
    BadVoucher,
    UnknownVideo,
    RootMismatch,
    BelowFee,
    Other(String),
}

const CODES: &[(&str, RejCode)] = &[
    ("underpaid", RejCode::Underpaid),
    ("overpaid", RejCode::Overpaid),
    ("bad-mint", RejCode::BadMint),
    ("bad-token", RejCode::BadToken),
    ("spent", RejCode::Spent),
    ("banned", RejCode::Banned),
    ("bad-session", RejCode::BadSession),
    ("mint-unavailable", RejCode::MintUnavailable),
    ("bad-lock", RejCode::BadLock),
    ("stale", RejCode::Stale),
    ("payment-required", RejCode::PaymentRequired),
    ("bad-voucher", RejCode::BadVoucher),
    ("unknown-video", RejCode::UnknownVideo),
    ("root-mismatch", RejCode::RootMismatch),
    ("below-fee", RejCode::BelowFee),
];

impl RejCode {
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Other(s) => s,
            known => CODES
                .iter()
                .find(|(_, c)| c == known)
                .map_or("", |(s, _)| s),
        }
    }

    /// The code for its wire form: a known code, or `Other` for one this version does not
    /// know.
    #[must_use]
    pub fn from_code(s: &str) -> Self {
        CODES
            .iter()
            .find(|(c, _)| *c == s)
            .map_or_else(|| Self::Other(s.to_owned()), |(_, code)| code.clone())
    }
}

fn bad(why: &str) -> Error {
    Error::Pay(why.to_owned())
}

type Object = BTreeMap<String, Value>;

fn int(obj: &Object, name: &str) -> Result<u64> {
    match obj.get(name) {
        None => Err(bad(&format!("missing {name}"))),
        Some(Value::Int(i)) => match u64::try_from(*i) {
            Ok(n) if n <= MAX_INT => Ok(n),
            Ok(_) => Err(bad("integers at most 2^53-1")),
            Err(_) => Err(bad("integers only, non-negative")),
        },
        Some(_) => Err(bad("integers only, non-negative")),
    }
}

fn string<'a>(obj: &'a Object, name: &str) -> Result<&'a str> {
    match obj.get(name) {
        None => Err(bad(&format!("missing {name}"))),
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(bad(&format!("{name} must be a string"))),
    }
}

/// A mint URL (NFX-07 §2): printable ASCII without space, `\` or `@`; `https://`, a host
/// (`[A-Za-z0-9.-]`, or an IPv6 literal in brackets), an optional port 1 to 65535, then
/// nothing or a `/`, `?` or `#` and anything printable. Or, when the deployment allows
/// it, `http://` on a loopback host.
fn mint_url_ok(u: &str, opts: ParseOptions) -> bool {
    if !u
        .bytes()
        .all(|b| (0x21..=0x7e).contains(&b) && b != b'\\' && b != b'@')
    {
        return false;
    }
    let (rest, loopback_only) = if let Some(rest) = u.strip_prefix("https://") {
        (rest, false)
    } else if let Some(rest) = u.strip_prefix("http://")
        && opts.allow_loopback_http
    {
        (rest, true)
    } else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, after) = if authority.starts_with('[') {
        let Some(close) = authority.find(']') else {
            return false;
        };
        let inner = &authority[1..close];
        if !(2..=45).contains(&inner.len())
            || !inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return false;
        }
        authority.split_at(close + 1)
    } else {
        let host = authority.split(':').next().unwrap_or("");
        if !(1..=253).contains(&host.len())
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            return false;
        }
        authority.split_at(host.len())
    };
    if !after.is_empty() {
        let Some(port) = after.strip_prefix(':') else {
            return false;
        };
        if !(1..=5).contains(&port.len())
            || !port.bytes().all(|b| b.is_ascii_digit())
            || !port.parse::<u32>().is_ok_and(|p| (1..=65535).contains(&p))
        {
            return false;
        }
    }
    !loopback_only || matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// A NUT-00 token: `cashuA` or `cashuB`, then base64 (standard or URL-safe).
fn token_ok(t: &str) -> bool {
    let Some(body) = t
        .strip_prefix("cashuA")
        .or_else(|| t.strip_prefix("cashuB"))
    else {
        return false;
    };
    !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'=' | b'+' | b'/' | b'-'))
}

/// A `rej.detail` a log or a screen can show as it is: at most 1 KiB of printable ASCII,
/// which has no invisible or reordering characters to hide in.
fn detail_ok(d: &str) -> bool {
    d.len() <= MAX_DETAIL_BYTES && d.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// Container nesting: the message object is level 1, scalars add nothing.
fn depth(v: &Value) -> usize {
    match v {
        Value::Object(o) => 1 + o.values().map(depth).max().unwrap_or(0),
        Value::Array(a) => 1 + a.iter().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

fn code_ok(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= MAX_CODE_BYTES
        && c.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Message {
    /// Parse one line (without its newline) under the default rules.
    pub fn parse(line: &str) -> Result<Self> {
        Self::parse_with(line, ParseOptions::default())
    }

    /// Parse one line (without its newline).
    pub fn parse_with(line: &str, opts: ParseOptions) -> Result<Self> {
        if line.len() + 1 > MAX_LINE_BYTES {
            return Err(bad("a line is at most 32 KiB"));
        }
        let value = Value::parse(line).map_err(|_| bad("not JSON under NFX-11 §9"))?;
        if depth(&value) > MAX_DEPTH {
            return Err(bad("nested deeper than 16 levels"));
        }
        let Value::Object(obj) = value else {
            return Err(bad("not an object"));
        };
        match string(&obj, "t")? {
            "hello" => {
                let video = VideoAddr::parse(string(&obj, "video")?)
                    .map_err(|_| bad("video is an NFX address"))?;
                let session = string(&obj, "session")?;
                if !is_lower_hex(session, 32) {
                    return Err(bad("session is 32 lowercase hex"));
                }
                Ok(Self::Hello(Hello {
                    video,
                    session: session.to_owned(),
                }))
            }
            "quote" => {
                let price_per_chunk = int(&obj, "price_per_chunk")?;
                let window = int(&obj, "window")?;
                if price_per_chunk == 0 {
                    return Err(bad("price_per_chunk >= 1"));
                }
                if window < 2 {
                    return Err(bad("window >= 2"));
                }
                let Some(Value::Array(mints)) = obj.get("mints") else {
                    return Err(bad("mints is 1 to 16 URLs"));
                };
                if mints.is_empty() || mints.len() > MAX_MINTS {
                    return Err(bad("mints is 1 to 16 URLs"));
                }
                let mints = mints
                    .iter()
                    .map(|m| match m {
                        Value::String(u) if mint_url_ok(u, opts) => Ok(u.clone()),
                        _ => Err(bad("mint must be an https URL (NFX-07 §2)")),
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(Self::Quote(Quote {
                    price_per_chunk,
                    mints,
                    window,
                    served: int(&obj, "served")?,
                    accepted_upto: int(&obj, "accepted_upto")?,
                    spent_total: int(&obj, "spent_total")?,
                }))
            }
            "pay" => {
                let upto_chunk = int(&obj, "upto_chunk")?;
                if upto_chunk == 0 {
                    return Err(bad("upto_chunk >= 1"));
                }
                let token = string(&obj, "token")?;
                if !token_ok(token) {
                    return Err(bad("token is a NUT-00 token"));
                }
                Ok(Self::Pay(Pay {
                    upto_chunk,
                    token: token.to_owned(),
                }))
            }
            "ack" => Ok(Self::Ack(Ack {
                accepted_upto: int(&obj, "accepted_upto")?,
                spent_total: int(&obj, "spent_total")?,
            })),
            "rej" => {
                let code = string(&obj, "code")?;
                if !code_ok(code) {
                    return Err(bad("code is 1 to 64 of [a-z0-9-]"));
                }
                let detail = match obj.get("detail") {
                    None => None,
                    Some(Value::String(d)) if detail_ok(d) => Some(d.clone()),
                    Some(_) => {
                        return Err(bad("detail is at most 1 KiB of printable ASCII"));
                    }
                };
                Ok(Self::Rej(Rej {
                    code: RejCode::from_code(code),
                    detail,
                }))
            }
            _ => Err(bad("unknown t")),
        }
    }

    /// The message as one line (without the newline), refused if the default reader
    /// would refuse it (NFX-07 §2).
    pub fn to_line(&self) -> Result<String> {
        self.to_line_with(ParseOptions::default())
    }

    /// The message as one line, refused if a reader with `opts` would refuse it.
    pub fn to_line_with(&self, opts: ParseOptions) -> Result<String> {
        let line = match self {
            Self::Hello(h) => {
                json!({"t": "hello", "video": h.video.to_string(), "session": h.session})
            }
            Self::Quote(q) => json!({
                "t": "quote",
                "price_per_chunk": q.price_per_chunk,
                "mints": q.mints,
                "window": q.window,
                "served": q.served,
                "accepted_upto": q.accepted_upto,
                "spent_total": q.spent_total,
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
        .to_string();
        let back = Self::parse_with(&line, opts)?;
        if &back != self {
            return Err(bad("the message does not survive its own reader"));
        }
        Ok(line)
    }
}
