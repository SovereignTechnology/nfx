//! Connection admission for the node's TCP servers (the origin and the scoped relay).
//!
//! Every accepted connection holds a [`ConnGuard`] for its whole life, WebSocket upgrades
//! included. A global cap keeps file descriptors for the rest of the process (iroh, the
//! other server), and a per-address cap stops one host from taking them all. Loopback is
//! exempt from the per-address cap only: a reverse proxy on the same host arrives from
//! there, and must enforce its own per-client limits.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Default total connections per server.
pub const MAX_CONNECTIONS: usize = 1024;
/// Default connections per remote address.
pub const MAX_PER_ADDRESS: usize = 32;

#[derive(Debug)]
pub struct ConnLimits {
    total: Arc<Semaphore>,
    per_address: Mutex<HashMap<IpAddr, usize>>,
    max_per_address: usize,
}

/// Held for the life of one connection; releases its slots on drop.
#[derive(Debug)]
pub struct ConnGuard {
    _permit: OwnedSemaphorePermit,
    ip: Option<IpAddr>,
    limits: Arc<ConnLimits>,
}

impl ConnLimits {
    #[must_use]
    pub fn new(max_total: usize, max_per_address: usize) -> Arc<Self> {
        Arc::new(Self {
            total: Arc::new(Semaphore::new(max_total)),
            per_address: Mutex::new(HashMap::new()),
            max_per_address,
        })
    }

    /// Admit a connection from `peer`, or refuse it (the caller drops the socket).
    #[must_use]
    pub fn admit(self: &Arc<Self>, peer: SocketAddr) -> Option<ConnGuard> {
        let permit = self.total.clone().try_acquire_owned().ok()?;
        let ip = peer.ip().to_canonical();
        let counted = (!ip.is_loopback()).then_some(ip);
        if let Some(ip) = counted {
            let mut per = self
                .per_address
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let n = per.entry(ip).or_insert(0);
            if *n >= self.max_per_address {
                return None;
            }
            *n += 1;
        }
        Some(ConnGuard {
            _permit: permit,
            ip: counted,
            limits: self.clone(),
        })
    }
}

impl Default for ConnLimits {
    fn default() -> Self {
        Self {
            total: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            per_address: Mutex::new(HashMap::new()),
            max_per_address: MAX_PER_ADDRESS,
        }
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        if let Some(ip) = self.ip {
            let mut per = self
                .limits
                .per_address
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(n) = per.get_mut(&ip) {
                *n -= 1;
                if *n == 0 {
                    per.remove(&ip);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn caps_are_global_and_per_address_and_released_on_drop() {
        let limits = ConnLimits::new(3, 2);
        let a: SocketAddr = "203.0.113.1:1".parse().unwrap();
        let b: SocketAddr = "203.0.113.2:1".parse().unwrap();
        let lo: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let a1 = limits.admit(a).unwrap();
        let _a2 = limits.admit(a).unwrap();
        assert!(limits.admit(a).is_none(), "per-address cap");
        let _b1 = limits.admit(b).unwrap();
        assert!(limits.admit(lo).is_none(), "global cap, loopback included");
        drop(a1);
        assert!(limits.admit(lo).is_some(), "slots come back on drop");

        // An IPv4-mapped IPv6 peer is the same host (the global cap is out of the way here).
        let roomy = ConnLimits::new(100, 2);
        let mapped: SocketAddr = "[::ffff:203.0.113.1]:1".parse().unwrap();
        let _m1 = roomy.admit(a).unwrap();
        let _m2 = roomy.admit(mapped).unwrap();
        assert!(
            roomy.admit(a).is_none(),
            "IPv4-mapped counts as the same host"
        );
    }
}
