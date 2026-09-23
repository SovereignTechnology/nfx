//! Canonical JSON (`canon`, NFX-11 §9): the serialization that NFX-defined signed
//! objects (gossip envelopes, vouchers) are hashed in.
//!
//! Received text is parsed into [`Value`], which **rejects** what the rule calls
//! non-canonicalizable (fractions, exponents, `-0`, integers outside ±(2^53 − 1),
//! duplicate keys, lone surrogates) instead of normalizing it. Output is written by
//! hand rather than through `serde_json::to_string`, so a workspace crate enabling
//! `serde_json/preserve_order` cannot silently change key order.

use core::fmt;
use std::collections::BTreeMap;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

use crate::{Error, Result};

/// Largest magnitude of an integer `canon` accepts (`2^53 − 1`).
pub const MAX_SAFE_INT: i64 = (1 << 53) - 1;

/// A JSON value in the `canon` domain. Objects are ordered by key code point,
/// which for Rust `String`s is plain `Ord` (UTF-8 byte order equals code-point order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    /// Parse received JSON text, rejecting anything non-canonicalizable.
    pub fn parse(text: &str) -> Result<Self> {
        serde_json::from_str(text).map_err(|e| Error::Canon(e.to_string()))
    }

    /// Convert from a `serde_json::Value` (e.g. a struct serialized with `serde_json::to_value`).
    pub fn from_json(value: &serde_json::Value) -> Result<Self> {
        Ok(match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(b) => Self::Bool(*b),
            serde_json::Value::Number(n) => Self::Int(checked_int(n)?),
            serde_json::Value::String(s) => Self::String(s.clone()),
            serde_json::Value::Array(items) => {
                Self::Array(items.iter().map(Self::from_json).collect::<Result<_>>()?)
            }
            serde_json::Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(k, v)| Ok((k.clone(), Self::from_json(v)?)))
                    .collect::<Result<_>>()?,
            ),
        })
    }

    /// The equivalent `serde_json::Value`, for handing to structural parsers.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Null => serde_json::Value::Null,
            Self::Bool(b) => serde_json::Value::Bool(*b),
            Self::Int(i) => serde_json::Value::from(*i),
            Self::String(s) => serde_json::Value::String(s.clone()),
            Self::Array(items) => {
                serde_json::Value::Array(items.iter().map(Self::to_json).collect())
            }
            Self::Object(map) => serde_json::Value::Object(
                map.iter().map(|(k, v)| (k.clone(), v.to_json())).collect(),
            ),
        }
    }

    /// The canonical text.
    #[must_use]
    pub fn to_canon(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self);
        out
    }

    #[must_use]
    pub fn as_object(&self) -> Option<&BTreeMap<String, Value>> {
        match self {
            Self::Object(map) => Some(map),
            _ => None,
        }
    }
}

/// `canon(parse(text))`: the canonical form of received text, or why it has none.
pub fn canonicalize(text: &str) -> Result<String> {
    Ok(Value::parse(text)?.to_canon())
}

fn checked_int(n: &serde_json::Number) -> Result<i64> {
    let value = n
        .as_i64()
        .ok_or_else(|| Error::Canon(format!("not an integer in range: {n}")))?;
    if value.unsigned_abs() > MAX_SAFE_INT.unsigned_abs() {
        return Err(Error::Canon(format!("integer out of range: {n}")));
    }
    Ok(value)
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(i) => out.push_str(&i.to_string()),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> core::result::Result<Self, D::Error> {
        deserializer.deserialize_any(CanonVisitor)
    }
}

struct CanonVisitor;

impl<'de> Visitor<'de> for CanonVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value in the canon domain")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> core::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> core::result::Result<Value, E> {
        if v.unsigned_abs() > MAX_SAFE_INT.unsigned_abs() {
            return Err(E::custom(format!("integer out of range: {v}")));
        }
        Ok(Value::Int(v))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> core::result::Result<Value, E> {
        let v = i64::try_from(v).map_err(|_| E::custom(format!("integer out of range: {v}")))?;
        self.visit_i64(v)
    }

    // serde_json routes fractions, exponents, `-0` and integers beyond 64 bits here.
    fn visit_f64<E: de::Error>(self, v: f64) -> core::result::Result<Value, E> {
        Err(E::custom(format!("non-integer number: {v}")))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> core::result::Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }

    fn visit_string<E: de::Error>(self, v: String) -> core::result::Result<Value, E> {
        Ok(Value::String(v))
    }

    fn visit_unit<E: de::Error>(self) -> core::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> core::result::Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> core::result::Result<Value, A::Error> {
        let mut out = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            if out.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            out.insert(key, value);
        }
        Ok(Value::Object(out))
    }
}
