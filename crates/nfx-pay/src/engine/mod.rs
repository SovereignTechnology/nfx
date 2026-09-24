//! LOCKED until the M2 security stage (docs/nfx/m2-plan.md, crates/ci/check-locked.sh).
//!
//! This will hold the real seeder engine: NFX-07 §3 verification on CDK (exact amounts,
//! the quoted mints only, DLEQ), the asynchronous NUT-03 swap, and bans on a double
//! spend. It is written against [`crate::session`] and must pass [`crate::adversary`].
