//! A value that passed its NFX verification, as a type.
//!
//! [`Manifest`](crate::manifest::Manifest), [`Beacon`](crate::beacon::Beacon) and
//! [`Envelope`](crate::gossip::Envelope) have public fields, so holding one proves
//! nothing: anyone can build one by hand. Holding a [`Verified`] one does. Only this
//! crate's verifying constructors make one (`Manifest::from_event`, `Beacon::from_event`,
//! `Envelope::verify`), so code that must act only on verified data takes `&Verified<T>`.
//! It reads like `T` through `Deref`; [`Verified::into_inner`] gives the plain value up,
//! and with it the proof.

use core::ops::Deref;

use serde::{Serialize, Serializer};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified<T>(T);

impl<T> Verified<T> {
    /// Only for this crate's verifiers.
    pub(crate) fn new(value: T) -> Self {
        Self(value)
    }

    /// The plain value; it no longer carries the proof.
    #[must_use]
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> Deref for Verified<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> AsRef<T> for Verified<T> {
    fn as_ref(&self) -> &T {
        &self.0
    }
}

impl<T: PartialEq> PartialEq<T> for Verified<T> {
    fn eq(&self, other: &T) -> bool {
        self.0 == *other
    }
}

/// Serialises as the value itself. There is deliberately no `Deserialize`: parsing proves
/// nothing, so a `Verified` never comes from untrusted bytes except through a verifier.
impl<T: Serialize> Serialize for Verified<T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}
