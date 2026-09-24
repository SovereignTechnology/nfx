//! NFX-07 open-mode payments: watchers pay seeders per chunk in Cashu ecash.
//!
//! - [`session`]: the contracts. [`session::Seeder`] and [`session::Viewer`] are one
//!   side each of a pay/1 session; [`session::Harness`] is what the adversary suite needs.
//! - [`mock`]: a mock mint network and honest mock engines. They are an executable reading
//!   of NFX-07 §3, and what the transports are built against until the real engine exists.
//! - [`adversary`]: the adversary suite, written before the engine (M2.0), and run against
//!   the mock now and the real engine in the M2 security stage.
//!
//! **Locked** (`docs/nfx/m2-plan.md`, enforced by `crates/ci/check-locked.sh`):
//! [`engine`], [`wallet`] and [`protocol`] hold no implementation until the M2 security
//! stage. That stage is one serial session whose diffs to these paths sovtech reads.
//! Their pinned contents change only with that review.

pub mod adversary;
pub mod engine;
pub mod mock;
pub mod protocol;
pub mod session;
pub mod wallet;
