//! LOCKED until the M2 security stage (docs/nfx/m2-plan.md, crates/ci/check-locked.sh).
//!
//! This will hold the pay/1 session state machine: window accounting and the pay
//! schedule over a transport. It is written against [`crate::session`] and must pass
//! [`crate::adversary`].
