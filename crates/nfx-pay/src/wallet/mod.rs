//! LOCKED until the M2 security stage (docs/nfx/m2-plan.md, crates/ci/check-locked.sh).
//!
//! This will hold the viewer wallet: proof selection and storage, spending exact
//! amounts, and the key file. Proofs are never kept in plaintext. It pays only with
//! proofs of its own, and writes down each swap's NUT-13 seed and counters before sending
//! it (NFX-07 §3a). It is written against [`crate::session`] and must pass
//! [`crate::adversary`].
