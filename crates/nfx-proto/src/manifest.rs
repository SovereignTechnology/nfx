//! Kind-38504 video manifests (NFX-02): the parse/verify algorithm of §4.

use crate::event::Event;
use crate::hex32::{decode, is_https_url, is_lower_hex, parse_u64_strict};
use crate::namespace::{Namespace, VideoAddr};
use crate::{Error, KIND_MANIFEST, Result};

/// Tags that may appear at most once (NFX-02 §3 multiplicity rule).
const SINGLE_VALUED: &[&str] = &[
    "d",
    "n",
    "title",
    "published_at",
    "license",
    "root",
    "segs",
    "duration",
    "thumb",
    "price_hint",
    "key_price",
    "split",
    "mint",
    "cashu_key",
    "alt",
];
/// Required in both modes.
const REQUIRED: &[&str] = &["d", "n", "title", "published_at", "license", "root", "segs"];
/// Required when licensed, prohibited when open.
const LICENSED_ONLY: &[&str] = &["key_price", "split", "mint", "cashu_key", "free_seeder"];
const LICENSED_REQUIRED: &[&str] = &["key_price", "split", "mint", "cashu_key"];

/// A poster blob, content-addressed (NFX-05).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumb {
    pub sha256: String,
    pub mime: String,
}

/// Licensed-mode economics (NFX-02 §3, NFX-08).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseTerms {
    /// One-time price of the video key, in sats.
    pub key_price: u64,
    /// Seeder share in basis points; the creator gets the rest at redemption.
    pub split_bps: u16,
    /// The escrow mint (exactly one).
    pub mint: String,
    /// Compressed secp256k1 key the creator's share is P2PK-locked to.
    pub cashu_key: [u8; 33],
    /// Seeders that may obtain the key by voucher (x-only pubkeys, hex).
    pub free_seeders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum License {
    Open,
    Licensed(LicenseTerms),
}

/// A manifest that passed NFX-02 §4 in full.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub author: String,
    pub created_at: u64,
    pub addr: VideoAddr,
    pub title: String,
    pub published_at: u64,
    pub root: [u8; 32],
    pub segs: u64,
    pub duration: Option<u64>,
    pub thumb: Option<Thumb>,
    /// Advisory per-chunk price (open mode only).
    pub price_hint: Option<u64>,
    pub license: License,
    pub hashtags: Vec<String>,
    pub alt: Option<String>,
    /// Markdown description; never render HTML from it.
    pub description: String,
}

impl Manifest {
    /// Run NFX-02 §4. Any failure rejects the whole event.
    pub fn from_event(event: &Event) -> Result<Self> {
        if event.kind != KIND_MANIFEST {
            return Err(bad(format!("kind {} is not {KIND_MANIFEST}", event.kind)));
        }
        event.verify()?;

        for name in SINGLE_VALUED {
            event.single_tag(name).map_err(bad)?;
        }
        for name in REQUIRED {
            if event.single_tag(name).map_err(bad)?.is_none() {
                return Err(bad(format!("missing `{name}` tag")));
            }
        }
        // NFX-01 §3: exactly one `n`, and the `d` prefix must equal it.
        let namespace = Namespace::parse(required(event, "n")?)?;
        let addr = VideoAddr::parse(required(event, "d")?)?;
        if addr.namespace() != &namespace {
            return Err(bad("`d` namespace does not equal `n`".into()));
        }

        let root_hex = required(event, "root")?;
        let root =
            decode::<32>(root_hex).ok_or_else(|| bad("`root` is not 64 lowercase hex".into()))?;
        let segs = integer(event, "segs")?.unwrap_or(0);
        if segs == 0 {
            return Err(bad("`segs` must be >= 1".into()));
        }
        let published_at = integer(event, "published_at")?.unwrap_or(0);
        let duration = integer(event, "duration")?;
        let price_hint = integer(event, "price_hint")?;
        let thumb = match event.single_tag("thumb").map_err(bad)? {
            None => None,
            Some([sha256, mime, ..]) if is_lower_hex(sha256, 64) && !mime.is_empty() => {
                Some(Thumb {
                    sha256: sha256.clone(),
                    mime: mime.clone(),
                })
            }
            Some(_) => {
                return Err(bad(
                    "`thumb` must be 64 lowercase hex plus a MIME type".into()
                ));
            }
        };

        let license = match required(event, "license")? {
            "open" => {
                for name in LICENSED_ONLY {
                    if event.tag_values(name).next().is_some() {
                        return Err(bad(format!("`{name}` is prohibited in open mode")));
                    }
                }
                License::Open
            }
            "licensed" => {
                for name in LICENSED_REQUIRED {
                    required(event, name)?;
                }
                if price_hint.is_some() {
                    return Err(bad("`price_hint` is prohibited in licensed mode".into()));
                }
                License::Licensed(license_terms(event)?)
            }
            other => return Err(bad(format!("unknown license {other:?}"))),
        };

        Ok(Self {
            author: event.pubkey.clone(),
            created_at: event.created_at,
            addr,
            title: required(event, "title")?.to_owned(),
            published_at,
            root,
            segs,
            duration,
            thumb,
            price_hint,
            license,
            hashtags: event
                .tag_values("t")
                .filter_map(|v| v.first().cloned())
                .collect(),
            alt: one(event, "alt")?.map(str::to_owned),
            description: event.content.clone(),
        })
    }

    /// `root` as lowercase hex.
    #[must_use]
    pub fn root_hex(&self) -> String {
        hex::encode(self.root)
    }

    /// The NIP-01 address of this manifest, as beacons carry it in their `a` tag.
    #[must_use]
    pub fn a_tag(&self) -> String {
        format!("{KIND_MANIFEST}:{}:{}", self.author, self.addr)
    }

    /// The NFX-02 §3 tags, in the table's order: the publisher side of [`Self::from_event`].
    /// A kind-38504 event with these tags and `description` as its content parses back to
    /// an equal manifest (up to `author` and `created_at`, which come from the signing).
    #[must_use]
    pub fn tags(&self) -> Vec<Vec<String>> {
        fn t(name: &str, values: &[&str]) -> Vec<String> {
            std::iter::once(name)
                .chain(values.iter().copied())
                .map(str::to_owned)
                .collect()
        }
        let mut tags = vec![
            t("d", &[&self.addr.to_string()]),
            t("n", &[&self.addr.namespace().to_string()]),
            t("title", &[&self.title]),
            t("published_at", &[&self.published_at.to_string()]),
            t(
                "license",
                &[match self.license {
                    License::Open => "open",
                    License::Licensed(_) => "licensed",
                }],
            ),
            t("root", &[&self.root_hex()]),
            t("segs", &[&self.segs.to_string()]),
        ];
        if let Some(duration) = self.duration {
            tags.push(t("duration", &[&duration.to_string()]));
        }
        if let Some(thumb) = &self.thumb {
            tags.push(t("thumb", &[&thumb.sha256, &thumb.mime]));
        }
        if let Some(price_hint) = self.price_hint {
            tags.push(t("price_hint", &[&price_hint.to_string()]));
        }
        if let License::Licensed(terms) = &self.license {
            tags.push(t("key_price", &[&terms.key_price.to_string()]));
            tags.push(t("split", &[&terms.split_bps.to_string()]));
            tags.push(t("mint", &[&terms.mint]));
            tags.push(t("cashu_key", &[&hex::encode(terms.cashu_key)]));
            for seeder in &terms.free_seeders {
                tags.push(t("free_seeder", &[seeder]));
            }
        }
        for hashtag in &self.hashtags {
            tags.push(t("t", &[hashtag]));
        }
        if let Some(alt) = &self.alt {
            tags.push(t("alt", &[alt]));
        }
        tags
    }
}

fn one<'a>(event: &'a Event, name: &str) -> Result<Option<&'a str>> {
    Ok(event.single_tag(name).map_err(bad)?.map(|v| v[0].as_str()))
}

fn required<'a>(event: &'a Event, name: &str) -> Result<&'a str> {
    one(event, name)?.ok_or_else(|| bad(format!("missing `{name}` tag")))
}

fn integer(event: &Event, name: &str) -> Result<Option<u64>> {
    one(event, name)?
        .map(|v| {
            parse_u64_strict(v).ok_or_else(|| bad(format!("`{name}` is not an integer: {v:?}")))
        })
        .transpose()
}

fn license_terms(event: &Event) -> Result<LicenseTerms> {
    let key_price = integer(event, "key_price")?.unwrap_or(0);
    let split = integer(event, "split")?.unwrap_or(0);
    let split_bps = u16::try_from(split)
        .ok()
        .filter(|s| *s <= 10_000)
        .ok_or_else(|| bad(format!("`split` {split} is outside [0,10000]")))?;
    let mint = required(event, "mint")?;
    if !is_https_url(mint) {
        return Err(bad("`mint` must be an https URL".into()));
    }
    let cashu_key = decode::<33>(required(event, "cashu_key")?)
        .filter(|k| matches!(k[0], 0x02 | 0x03))
        .filter(|k| k256::PublicKey::from_sec1_bytes(k).is_ok())
        .ok_or_else(|| bad("`cashu_key` is not a valid compressed secp256k1 point".into()))?;
    let mut free_seeders = Vec::new();
    for values in event.tag_values("free_seeder") {
        match values.first() {
            Some(pk) if is_lower_hex(pk, 64) => free_seeders.push(pk.clone()),
            _ => return Err(bad("`free_seeder` must be 64 lowercase hex".into())),
        }
    }
    Ok(LicenseTerms {
        key_price,
        split_bps,
        mint: mint.to_owned(),
        cashu_key,
        free_seeders,
    })
}

fn bad(reason: String) -> Error {
    Error::Manifest(reason)
}
