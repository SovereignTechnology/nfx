//! `nfxd` — the headless NFX node.
//!
//! ```text
//! nfxd key new <file>                      create a key (mode 0600); prints the public key
//! nfxd key show <file>                     print a key file's public key
//! nfxd publish --key <file> --relay <url>… --package <dir> --title <text>
//!              [--description <md>] [--alt <text>] [--tag <t>]…
//! nfxd delete --key <file> --relay <url>… --a <a>…   withdraw your own videos (NFX-02 §6)
//! nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]… [--iroh-relay <url>]… [--relay-only]
//!          [--seed <a>]… [--fetch <a>]… [--pull <a>]… [--origin <addr:port>]
//!          [--https-url <url>] [--embed-relay <addr:port>] [--embed-tracker <addr:port> [--bridge <ip:port> [--tracker-url <wss url>]]] [--namespace <ns>]…
//!          [--allow-creator <hex>]… [--gossip [--gossip-peer <id>@<ip:port|relay-url>]…]
//! ```
//!
//! `<a>` is a manifest address, `38504:<creator-hex>:<namespace>:<video-id>`, as
//! `publish` prints it. Secrets never reach the terminal: only public keys are printed.
//!
//! With `--gossip`, `run` joins each video's gossip swarm (NFX-06 §4) through the seeders
//! relay beacons name and any `--gossip-peer`, and prints its own `gossip peer:` lines for
//! others to use. Gossip is off by default: iroh-gossip hands the addresses swarm members
//! advertise to the node's endpoint unfiltered, so any member can make the node contact
//! hosts of its choosing. A `--relay-only` node never gossips.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use nfx_node::nostr::{Relays, sign_manifest};
use nfx_node::unix_now;
use nfx_proto::namespace::Namespace;
use nfxd::daemon::{Config, Daemon};
use nfxd::package::Package;
use nfxd::{Error, Result, key};
use nostr_sdk::prelude::ToBech32 as _;

const USAGE: &str = "usage:
  nfxd key new <file>
  nfxd key show <file>
  nfxd publish --key <file> --relay <url>... --package <dir> --title <text> [--description <md>] [--alt <text>] [--tag <t>]...
  nfxd delete --key <file> --relay <url>... --a <a>...
  nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]... [--iroh-relay <url>]... [--relay-only] [--seed <a>]... [--fetch <a>]... [--pull <a>]... [--origin <addr:port>] [--https-url <url>] [--embed-relay <addr:port>] [--embed-tracker <addr:port> [--bridge <ip:port> [--tracker-url <wss url>]]] [--namespace <ns>]... [--allow-creator <hex>]... [--gossip [--gossip-peer <id>@<ip:port|relay-url>]...]";

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("key") => key_cmd(&args[1..]),
        Some("publish") => publish(&args[1..]).await,
        Some("delete") => delete(&args[1..]).await,
        Some("run") => run(&args[1..]).await,
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Config(msg)) if msg == "usage" => usage(),
        Err(e) => {
            eprintln!("nfxd: {e}");
            ExitCode::FAILURE
        }
    }
}

fn bad_usage() -> Error {
    Error::Config("usage".into())
}

fn print_public(keys: &nostr_sdk::prelude::Keys) {
    let pk = keys.public_key();
    println!("{}", pk.to_hex());
    let Ok(npub) = pk.to_bech32();
    println!("{npub}");
}

fn key_cmd(args: &[String]) -> Result<()> {
    match args {
        [cmd, file] if cmd == "new" => print_public(&key::create(Path::new(file))?),
        [cmd, file] if cmd == "show" => print_public(&key::load(Path::new(file))?),
        _ => return Err(bad_usage()),
    }
    Ok(())
}

/// Flags: each `--name value`, repeatable; no positionals.
fn flags(args: &[String], known: &[&str]) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(name) = it.next() {
        let bare = name.strip_prefix("--").ok_or_else(bad_usage)?;
        if !known.contains(&bare) {
            return Err(bad_usage());
        }
        out.push((bare.to_owned(), it.next().ok_or_else(bad_usage)?.clone()));
    }
    Ok(out)
}

fn all(flags: &[(String, String)], name: &str) -> Vec<String> {
    flags
        .iter()
        .filter(|(n, _)| n == name)
        .map(|(_, v)| v.clone())
        .collect()
}

fn one(flags: &[(String, String)], name: &str) -> Result<Option<String>> {
    match all(flags, name).as_slice() {
        [] => Ok(None),
        [v] => Ok(Some(v.clone())),
        _ => Err(Error::Config(format!("--{name} given twice"))),
    }
}

fn required(flags: &[(String, String)], name: &str) -> Result<String> {
    one(flags, name)?.ok_or_else(|| Error::Config(format!("--{name} is required")))
}

async fn publish(args: &[String]) -> Result<()> {
    let f = flags(
        args,
        &[
            "key",
            "relay",
            "package",
            "title",
            "description",
            "alt",
            "tag",
        ],
    )?;
    let keys = key::load(Path::new(&required(&f, "key")?))?;
    let relays = all(&f, "relay");
    if relays.is_empty() {
        return Err(Error::Config("--relay is required".into()));
    }
    let package = Package::open(Path::new(&required(&f, "package")?))?;
    let now = unix_now();
    let manifest = package.manifest(
        &required(&f, "title")?,
        &one(&f, "description")?.unwrap_or_default(),
        one(&f, "alt")?.as_deref(),
        &all(&f, "tag"),
        now,
    )?;
    let (event, manifest) = sign_manifest(&keys, &manifest, now).await?;
    let relays = Relays::connect(&relays, Duration::from_secs(10)).await?;
    let accepted = relays.publish(&event).await;
    relays.shutdown().await;
    let accepted = accepted?;
    eprintln!("published to {accepted} relay(s)");
    println!("{}", manifest.a_tag());
    Ok(())
}

async fn delete(args: &[String]) -> Result<()> {
    let f = flags(args, &["key", "relay", "a"])?;
    let keys = key::load(Path::new(&required(&f, "key")?))?;
    let relays = all(&f, "relay");
    let addresses = all(&f, "a");
    if relays.is_empty() || addresses.is_empty() {
        return Err(Error::Config("--relay and --a are required".into()));
    }
    // Refused unless every address is the key's own manifest (NFX-02 §6).
    let event = nfx_node::nostr::sign_deletion(&keys, &addresses, unix_now()).await?;
    let relays = Relays::connect(&relays, Duration::from_secs(10)).await?;
    let accepted = relays.publish(&event).await;
    relays.shutdown().await;
    eprintln!("deletion accepted by {} relay(s)", accepted?);
    Ok(())
}

async fn run(args: &[String]) -> Result<()> {
    // The flags without a value.
    let relay_only = args.iter().any(|a| a == "--relay-only");
    let gossip = args.iter().any(|a| a == "--gossip");
    let args: Vec<String> = args
        .iter()
        .filter(|a| *a != "--relay-only" && *a != "--gossip")
        .cloned()
        .collect();
    let args = args.as_slice();
    let f = flags(
        args,
        &[
            "key",
            "store",
            "state",
            "relay",
            "iroh-relay",
            "seed",
            "fetch",
            "pull",
            "origin",
            "https-url",
            "embed-relay",
            "embed-tracker",
            "bridge",
            "tracker-url",
            "namespace",
            "allow-creator",
            "gossip-peer",
        ],
    )?;
    let addr = |name: &str| -> Result<Option<std::net::SocketAddr>> {
        one(&f, name)?
            .map(|v| {
                v.parse()
                    .map_err(|_| Error::Config(format!("--{name}: not an addr:port")))
            })
            .transpose()
    };
    let cfg = Config {
        keys: one(&f, "key")?
            .map(|p| key::load(Path::new(&p)))
            .transpose()?,
        store: PathBuf::from(required(&f, "store")?),
        state: one(&f, "state")?.map(PathBuf::from),
        relays: all(&f, "relay"),
        iroh_relays: all(&f, "iroh-relay")
            .iter()
            .map(|u| {
                u.parse()
                    .map_err(|_| Error::Config(format!("--iroh-relay {u}: not a URL")))
            })
            .collect::<Result<_>>()?,
        relay_only,
        seed: all(&f, "seed"),
        fetch: all(&f, "fetch"),
        pull: all(&f, "pull"),
        origin: addr("origin")?,
        https_url: one(&f, "https-url")?,
        embed_relay: addr("embed-relay")?,
        embed_tracker: addr("embed-tracker")?,
        bridge: addr("bridge")?,
        tracker_public_url: one(&f, "tracker-url")?,
        namespaces: all(&f, "namespace")
            .iter()
            .map(|n| Namespace::parse(n).map_err(Error::from))
            .collect::<Result<_>>()?,
        deletion_check_every: None,
        allow_creators: all(&f, "allow-creator"),
        gossip,
        gossip_peers: gossip_peers(&all(&f, "gossip-peer"))?,
        internal_origin: false,
        // `run` seeds only what `--seed` names, and a seeder may use the portmapper.
        seed_watched: false,
        no_portmapper: false,
    };
    let daemon = Daemon::start(cfg).await?;
    if let Some(url) = &daemon.relay_url {
        eprintln!("embedded relay: {url}");
    }
    if let Some(addr) = daemon.origin_addr {
        eprintln!("origin: http://{addr}/");
    }
    if let Some(url) = &daemon.tracker_url {
        eprintln!("embedded tracker: {url}");
    }
    if let Some(addr) = daemon.bridge_addr {
        eprintln!("bridge: udp {addr}");
    }
    if gossip {
        let me = daemon.node().addr();
        for t in &me.addrs {
            match t {
                iroh::TransportAddr::Ip(ip) => eprintln!("gossip peer: {}@{ip}", me.id),
                iroh::TransportAddr::Relay(url) => eprintln!("gossip peer: {}@{url}", me.id),
                _ => {}
            }
        }
    }
    let mut last = std::collections::BTreeMap::new();
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = tick.tick() => {
                let now = daemon.state();
                for (a, s) in &now {
                    if last.get(a) != Some(s) {
                        eprintln!("{a}: {s:?}");
                    }
                }
                last = now;
            }
        }
    }
    daemon.shutdown().await;
    Ok(())
}

/// `--gossip-peer ID@ADDR`, where `ADDR` is `ip:port` or an iroh relay URL; repeat the flag
/// for more addresses of the same peer. `nfxd run` prints its own in this form.
fn gossip_peers(values: &[String]) -> Result<Vec<iroh::EndpointAddr>> {
    let mut peers: Vec<iroh::EndpointAddr> = Vec::new();
    for v in values {
        let bad = |why: &str| Error::Config(format!("--gossip-peer {v}: {why}"));
        let (id, at) = v
            .split_once('@')
            .ok_or_else(|| bad("expected ENDPOINT_ID@ADDR"))?;
        let id: iroh::EndpointId = id.parse().map_err(|_| bad("not an endpoint id"))?;
        let addr = if at.contains("://") {
            iroh::TransportAddr::Relay(at.parse().map_err(|_| bad("not a relay URL"))?)
        } else {
            iroh::TransportAddr::Ip(at.parse().map_err(|_| bad("not ip:port"))?)
        };
        match peers.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.addrs.insert(addr);
            }
            None => peers.push(iroh::EndpointAddr::from_parts(id, [addr])),
        }
    }
    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::gossip_peers;

    #[test]
    fn gossip_peers_merge_by_id_and_refuse_what_they_cannot_parse() {
        let id = iroh::SecretKey::from([7u8; 32]).public();
        let peers = gossip_peers(&[
            format!("{id}@127.0.0.1:4433"),
            format!("{id}@https://relay.example/"),
        ])
        .unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].addrs.len(), 2);
        for bad in [
            id.to_string(),
            format!("{id}@localhost"),
            format!("{id}@ftp:/x"),
            "not-an-id@127.0.0.1:1".to_owned(),
        ] {
            let err = gossip_peers(std::slice::from_ref(&bad))
                .unwrap_err()
                .to_string();
            assert!(err.contains("--gossip-peer"), "{bad}: {err}");
        }
    }
}
