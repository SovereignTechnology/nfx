//! `nutflixd stun`: a STUN server and nothing else, so anyone can run one for a network (NFX-10
//! §1). No store, no videos, no iroh: the Binding responder of [`crate::stun`] (RFC 8489
//! Binding only, no TURN, no authentication, rate-limited per source, per prefix and in all,
//! and nothing about a client is logged) on one UDP socket.
//!
//! With an [`Announce`], it also publishes a STUN service announcement (kind 33478, signed
//! by the operator's key) to the given Nostr relays: the server's public `ip:port` (`d`) for
//! each network (`n`), living [`MAX_TTL`] (24 h) and signed again every [`REANNOUNCE_EVERY`]
//! (12 h), sooner ([`ANNOUNCE_RETRY`]) when no relay took it. The announcements are a
//! directory: the people and operators of those networks find the server through Nostr and
//! may configure it (a page's own STUN servers, a node's `--mesh-stun`, a creator's beacon);
//! no client asks a server only because it is announced (NFX-10 §1). On stop nothing is
//! withdrawn: the last announcement expires within 24 h, and a client that asks a server that
//! is gone loses one candidate, nothing more.
//!
//! **Privacy.** Every client that asks learns nothing but its own address; the operator
//! learns each client's IP address and when it asked. The announcement names the server's
//! address and ties it to the operator's key, publicly.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use nfx_node::mesh::relay_url_problem;
use nfx_node::nostr::{Relays, sign_stun_announcement};
use nfx_node::unix_now;
use nfx_proto::namespace::Namespace;
use nfx_proto::stun::{MAX_NETWORKS, MAX_TTL, REANNOUNCE_EVERY, usable};
use nostr_sdk::prelude::Keys;
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

use crate::{Error, Result};

/// How long after a failed announcement it is tried again.
pub const ANNOUNCE_RETRY: Duration = Duration::from_secs(300);
/// Relays an announcement goes to, at most.
pub const MAX_ANNOUNCE_RELAYS: usize = 8;
/// How long the relays get to connect, each time.
const RELAY_TIMEOUT: Duration = Duration::from_secs(10);

/// Whom to tell, and as whom. (No `Debug`: it holds the operator's key.)
#[derive(Clone)]
pub struct Announce {
    /// The operator's key: it signs every announcement.
    pub keys: Keys,
    /// Nostr relays, 1 to [`MAX_ANNOUNCE_RELAYS`] (`wss://`, or `ws://`).
    pub relays: Vec<String>,
    /// The networks served, 1 to [`MAX_NETWORKS`], distinct.
    pub networks: Vec<Namespace>,
}

/// What `nutflixd stun` runs.
#[derive(Clone)]
pub struct StunConfig {
    /// The UDP address to answer on.
    pub bind: SocketAddr,
    /// The address clients reach it at, when it is not `bind` (a DNAT in front): announced
    /// instead. A global unicast `ip:port`.
    pub public: Option<SocketAddr>,
    /// Announce it over Nostr. `None`: a STUN server and nothing else.
    pub announce: Option<Announce>,
    pub limits: crate::stun::Limits,
}

/// The last announcement relays took.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Announced {
    pub created_at: u64,
    pub expiration: u64,
    /// How many relays took it.
    pub relays: usize,
}

/// A running `nutflixd stun`.
pub struct StunServer {
    addr: SocketAddr,
    public: Option<SocketAddr>,
    announced: Arc<Mutex<Option<Announced>>>,
    failure: Arc<Mutex<Option<String>>>,
    tasks: Vec<JoinHandle<()>>,
}

impl StunServer {
    /// Bind and serve; with [`StunConfig::announce`], announce at once and every 12 h. Refused
    /// before anything is sent: a `public` address that is not global unicast, and an
    /// announcement with no global unicast address to name (see `public`), no relay or more
    /// than 8, a relay URL that is not `wss://` or `ws://`, or not 1 to 8 distinct networks.
    pub async fn start(cfg: StunConfig) -> Result<Self> {
        if let Some(public) = cfg.public
            && !usable(&public.to_string())
        {
            return Err(Error::Config(format!(
                "--public {public}: not a global unicast ip:port"
            )));
        }
        if let Some(a) = &cfg.announce {
            check_announce(a)?;
        }
        let socket = UdpSocket::bind(cfg.bind).await?;
        let addr = socket.local_addr()?;
        // Without --public, the bound address is the one clients reach, if it is global
        // unicast: a loopback, private or wildcard one would mean nothing to them.
        let public = cfg
            .public
            .or_else(|| Some(addr).filter(|a| usable(&a.to_string())));
        let announced = Arc::new(Mutex::new(None));
        let failure = Arc::new(Mutex::new(None));
        let mut tasks = Vec::new();
        if let Some(a) = cfg.announce {
            let Some(public) = public else {
                return Err(Error::Config(format!(
                    "--announce: {addr} is not a global unicast address; name the one clients reach with --public"
                )));
            };
            tasks.push(tokio::spawn(announce_every(
                a,
                public.to_string(),
                announced.clone(),
                failure.clone(),
            )));
        }
        tasks.push(tokio::spawn(crate::stun::serve(socket, cfg.limits)));
        Ok(Self {
            addr,
            public,
            announced,
            failure,
            tasks,
        })
    }

    /// The UDP address it answers on.
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The address it is announced at (`public`, or the bound one when it is global
    /// unicast); `None` when it has none.
    #[must_use]
    pub fn public_addr(&self) -> Option<SocketAddr> {
        self.public
    }

    /// The last announcement relays took, if any.
    #[must_use]
    pub fn announced(&self) -> Option<Announced> {
        *self
            .announced
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Why the last attempt to announce failed, until one succeeds.
    #[must_use]
    pub fn announce_failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Stop answering and announcing.
    pub fn shutdown(&self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Drop for StunServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn check_announce(a: &Announce) -> Result<()> {
    if a.relays.is_empty() || a.relays.len() > MAX_ANNOUNCE_RELAYS {
        return Err(Error::Config(format!(
            "--announce needs 1 to {MAX_ANNOUNCE_RELAYS} --relay"
        )));
    }
    if let Some((url, why)) = a
        .relays
        .iter()
        .find_map(|u| relay_url_problem(u).map(|why| (u, why)))
    {
        return Err(Error::Config(format!("--relay {url}: {why}")));
    }
    let mut seen = Vec::new();
    for n in &a.networks {
        if seen.contains(&n) {
            return Err(Error::Config(format!("--network {n}: given twice")));
        }
        seen.push(n);
    }
    if a.networks.is_empty() || a.networks.len() > MAX_NETWORKS {
        return Err(Error::Config(format!(
            "--announce needs 1 to {MAX_NETWORKS} --network"
        )));
    }
    Ok(())
}

/// Announce `addr` now and every [`REANNOUNCE_EVERY`], or after [`ANNOUNCE_RETRY`] when no
/// relay took it.
async fn announce_every(
    a: Announce,
    addr: String,
    announced: Arc<Mutex<Option<Announced>>>,
    failure: Arc<Mutex<Option<String>>>,
) {
    loop {
        let wait = match announce_once(&a, &addr).await {
            Ok(done) => {
                *announced.lock().unwrap_or_else(PoisonError::into_inner) = Some(done);
                *failure.lock().unwrap_or_else(PoisonError::into_inner) = None;
                Duration::from_secs(REANNOUNCE_EVERY)
            }
            Err(e) => {
                *failure.lock().unwrap_or_else(PoisonError::into_inner) = Some(e.to_string());
                ANNOUNCE_RETRY
            }
        };
        tokio::time::sleep(wait).await;
    }
}

async fn announce_once(a: &Announce, addr: &str) -> Result<Announced> {
    let now = unix_now();
    let event = sign_stun_announcement(&a.keys, addr, &a.networks, now, MAX_TTL).await?;
    let relays = Relays::connect(&a.relays, RELAY_TIMEOUT).await?;
    let took = relays.publish(&event).await;
    relays.shutdown().await;
    Ok(Announced {
        created_at: now,
        expiration: now + MAX_TTL,
        relays: took?,
    })
}
