//! LOCKED until the M2 security stage (docs/nfx/m2-plan.md, crates/ci/check-locked.sh).
//!
//! This will hold the pay/1 transport glue: the `nfx/pay/1` ALPN on the node's
//! endpoint, and the per-session window gate on blob serving (NFX-07 §2-3).
