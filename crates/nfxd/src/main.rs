//! `nfxd` — the headless NFX node.
//!
//! ```text
//! nfxd key new <file>                      create a key (mode 0600); prints the public key
//! nfxd key show <file>                     print a key file's public key
//! nfxd publish --key <file> --relay <url>… --package <dir> --title <text>
//!              [--description <md>] [--alt <text>] [--tag <t>]…
//! nfxd delete --key <file> --relay <url>… --a <a>…   withdraw your own videos (NFX-02 §6)
//! nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]… [--iroh-relay <url>]… [--iroh-relay-ca <pem>]… [--relay-only]
//!          [--iroh-bind <ip:port> [--iroh-external <ip:port>]…]
//!          [--seed <a>]… [--fetch <a>]… [--pull <a>]… [--origin <addr:port>]
//!          [--https-url <url>] [--embed-relay <addr:port>]
//!          [--embed-tracker <addr:port> [--bridge <ip:port> [--bridge-public <ip:port>] [--bridge-max-peers <n>] [--tracker-url <wss url>]]] [--namespace <ns>]…
//!          [--allow-creator <hex>]… [--gossip [--gossip-peer <id>@<ip:port|relay-url>]…]
//!          [--rating-root <npub|hex> --general-relay <url>… [--rating-trusted <npub|hex>]…]
//! ```
//!
//! `<a>` is a manifest address, `38504:<creator-hex>:<namespace>:<video-id>`, as
//! `publish` prints it. Secrets never reach the terminal: only public keys are printed.
//!
//! `--iroh-relay-ca` names a PEM file of CA certificates (at most 4 in all, 8 KiB each, 64 KiB
//! a file) that the `--iroh-relay`s' TLS may chain to, beside the compiled-in Mozilla roots:
//! for a network whose relays use a private CA, such as a test network. It changes which
//! relay certificates are trusted, never how peers authenticate each other.
//!
//! `--iroh-bind` binds the iroh endpoint's UDP socket to a fixed `ip:port` (`0.0.0.0:<port>`
//! for every interface) instead of a random port, so a NAT or a firewall can forward it. It
//! replaces the default socket of that address family only. `--iroh-external` (repeatable, at
//! most 4, needs `--iroh-bind`) names an address where internet peers reach that socket, such
//! as the public address of a DNAT in front of the host. It is advertised as given in tickets
//! and beacons, and with any set, `run` advertises no other direct address that is not public:
//! private, shared, loopback, link-local, unique-local, documentation and other special-purpose
//! addresses are left out, so a host's interface addresses behind the DNAT never reach a relay.
//! (Peers that are already connected still learn them from iroh's own NAT traversal.) Neither
//! works with `--relay-only`.
//!
//! An `--iroh-relay` is extra reachability, never a requirement: a node never stops seeding
//! for want of one. With `--iroh-external` it seeds at once. Without, it waits at most 60 s to
//! reach a relay first, so that its first beacons name it (meanwhile each video's state is
//! `AwaitingRelay`, naming the relay), then seeds without it and warns. Beacons are made from
//! the node's current address, so they name a relay as soon as it connects.
//!
//! With `--gossip`, `run` joins each video's gossip swarm (NFX-06 §4) through the seeders
//! relay beacons name and any `--gossip-peer`, and prints its own `gossip peer:` lines for
//! others to use. Gossip is off by default: iroh-gossip hands the addresses swarm members
//! advertise to the node's endpoint unfiltered, so any member can make the node contact
//! hosts of its choosing. A `--relay-only` node never gossips.
//!
//! With `--rating-root` (your own key), the seeders `run` pulls from are ordered by their
//! seeder ratings (NFX-16): those by you, the authors you follow and any
//! `--rating-trusted`, less those you mute, read hourly from the `--general-relay`s.
//! Scoped relays carry neither ratings nor follow lists. Off by default; ratings only
//! ever order seeders, and never change what this node grants anyone. Reading your own
//! lists tells those relays this node's address belongs to your key.
//!
//! `--embed-tracker` serves the NFX-10 browser mesh (plain `ws`), and `--bridge` joins it
//! as a native WebRTC peer. In public, put the tracker behind a TLS proxy (browsers need
//! `wss://`, and `--tracker-url` names that URL). A proxy on the same host must set
//! `X-Forwarded-For`: the tracker counts clients by it, and without it every client
//! shares the proxy's one allowance.
//!
//! The bridge's `--bridge` address is its only ICE candidate, so by default it must be one
//! browsers reach. Behind a DNAT, bind `--bridge` to the host's own address and give the
//! DNAT's public address as `--bridge-public`: browsers are told that one, and the bridge
//! takes what arrives as sent to it. `--bridge-max-peers` caps the browser connections it
//! holds at once (default 64, at most 1024). Each may queue 16 MiB of segments, so a small
//! host sets it lower; one video's swarm takes at most 16 of them, or all when the cap is
//! lower.

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
  nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]... [--iroh-relay <url>]... [--iroh-relay-ca <pem>]... [--relay-only] [--iroh-bind <ip:port> [--iroh-external <ip:port>]...] [--seed <a>]... [--fetch <a>]... [--pull <a>]... [--origin <addr:port>] [--https-url <url>] [--embed-relay <addr:port>] [--embed-tracker <addr:port> [--bridge <ip:port> [--bridge-public <ip:port>] [--bridge-max-peers <n>] [--tracker-url <wss url>]]] [--namespace <ns>]... [--allow-creator <hex>]... [--gossip [--gossip-peer <id>@<ip:port|relay-url>]...] [--rating-root <npub|hex> --general-relay <url>... [--rating-trusted <npub|hex>]...]";

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
            "iroh-relay-ca",
            "iroh-bind",
            "iroh-external",
            "seed",
            "fetch",
            "pull",
            "origin",
            "https-url",
            "embed-relay",
            "embed-tracker",
            "bridge",
            "bridge-public",
            "bridge-max-peers",
            "tracker-url",
            "namespace",
            "allow-creator",
            "gossip-peer",
            "rating-root",
            "rating-trusted",
            "general-relay",
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
    let (iroh_bind, iroh_external) = iroh_addrs(&f)?;
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
        iroh_relay_cas: relay_cas(&all(&f, "iroh-relay-ca"))?,
        relay_only,
        iroh_bind,
        iroh_external,
        seed: all(&f, "seed"),
        fetch: all(&f, "fetch"),
        pull: all(&f, "pull"),
        origin: addr("origin")?,
        https_url: one(&f, "https-url")?,
        embed_relay: addr("embed-relay")?,
        embed_tracker: addr("embed-tracker")?,
        bridge: addr("bridge")?,
        bridge_public: addr("bridge-public")?,
        bridge_max_peers: bridge_max_peers(&f)?,
        tracker_public_url: one(&f, "tracker-url")?,
        namespaces: all(&f, "namespace")
            .iter()
            .map(|n| Namespace::parse(n).map_err(Error::from))
            .collect::<Result<_>>()?,
        deletion_check_every: None,
        allow_creators: all(&f, "allow-creator"),
        gossip,
        gossip_peers: gossip_peers(&all(&f, "gossip-peer"))?,
        rating_root: one(&f, "rating-root")?
            .map(|v| pubkey_hex("rating-root", &v))
            .transpose()?,
        rating_trusted: all(&f, "rating-trusted")
            .iter()
            .map(|v| pubkey_hex("rating-trusted", v))
            .collect::<Result<_>>()?,
        general_relays: all(&f, "general-relay"),
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
        if let Some(public) = daemon.bridge_public.filter(|p| *p != addr) {
            eprintln!("bridge public: udp {public}");
        }
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

/// The CA certificates of every `--iroh-relay-ca` file, at most `MAX_RELAY_CAS` in all. A file
/// is checked for size before it is read; errors name the file and the rule, never its content.
fn relay_cas(files: &[String]) -> Result<Vec<nfx_node::node::CertificateDer<'static>>> {
    use nfx_node::node::{MAX_RELAY_CA_PEM, MAX_RELAY_CAS, relay_cas_from_pem};
    let mut out = Vec::new();
    for file in files {
        let bad = |why: String| Error::Config(format!("--iroh-relay-ca {file}: {why}"));
        let meta = std::fs::metadata(file).map_err(|e| bad(e.kind().to_string()))?;
        if !meta.is_file() {
            return Err(bad("not a regular file".into()));
        }
        if meta.len() > MAX_RELAY_CA_PEM as u64 {
            return Err(bad("over 64 KiB".into()));
        }
        let pem = std::fs::read(file).map_err(|e| bad(e.kind().to_string()))?;
        let cas = relay_cas_from_pem(&pem).map_err(|e| bad(e.to_string()))?;
        out.extend(cas);
        if out.len() > MAX_RELAY_CAS {
            return Err(bad("more than 4 certificates in all".into()));
        }
    }
    Ok(out)
}

/// `--iroh-bind ip:port` (once) and `--iroh-external ip:port` (repeatable). Only the form is
/// checked here; `Daemon::start` checks that the daemon can use them.
fn iroh_addrs(
    f: &[(String, String)],
) -> Result<(Option<std::net::SocketAddr>, Vec<std::net::SocketAddr>)> {
    let parse = |name: &str, v: &str| -> Result<std::net::SocketAddr> {
        v.parse()
            .map_err(|_| Error::Config(format!("--{name} {v}: not an ip:port")))
    };
    let bind = one(f, "iroh-bind")?
        .map(|v| parse("iroh-bind", &v))
        .transpose()?;
    let external = all(f, "iroh-external")
        .iter()
        .map(|v| parse("iroh-external", v))
        .collect::<Result<_>>()?;
    Ok((bind, external))
}

/// `--bridge-max-peers N`, a count; `Daemon::start` checks its range.
fn bridge_max_peers(f: &[(String, String)]) -> Result<Option<usize>> {
    one(f, "bridge-max-peers")?
        .map(|v| {
            v.parse()
                .map_err(|_| Error::Config(format!("--bridge-max-peers {v}: not a number")))
        })
        .transpose()
}

/// A public key given as an npub or 64 hex digits, as 64 lowercase hex. The error never
/// repeats the value: it may be a secret key given by mistake.
fn pubkey_hex(flag: &str, v: &str) -> Result<String> {
    key::public_hex(v).map_err(|why| Error::Config(format!("--{flag}: {why}")))
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
    use super::{bridge_max_peers, flags, gossip_peers, iroh_addrs, pubkey_hex, relay_cas};

    fn ca_pem() -> String {
        use base64::Engine as _;
        let (certs, _) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
        let b64 = base64::engine::general_purpose::STANDARD.encode(certs[0].as_ref());
        let lines: Vec<String> = b64
            .as_bytes()
            .chunks(64)
            .map(|c| String::from_utf8(c.to_vec()).unwrap())
            .collect();
        format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            lines.join("\n")
        )
    }

    fn file(name: &str, text: &str) -> String {
        let dir = std::env::temp_dir().join(format!("nfxd-relay-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        path.to_str().unwrap().to_owned()
    }

    #[test]
    fn iroh_relay_ca_files_are_read_capped_and_never_echoed() {
        let pem = ca_pem();
        assert_eq!(relay_cas(&[file("one.pem", &pem)]).unwrap().len(), 1);
        assert!(relay_cas(&[]).unwrap().is_empty());
        // At most 4 in all, across files.
        let three = file("three.pem", &pem.repeat(3));
        let two = file("two.pem", &pem.repeat(2));
        let err = relay_cas(&[three.clone(), two]).unwrap_err().to_string();
        assert!(err.contains("more than 4"), "{err}");
        assert_eq!(relay_cas(&[three, file("1.pem", &pem)]).unwrap().len(), 4);
        // Size first: a big file is refused before it is read.
        let big = file("big.pem", &"x".repeat(64 * 1024 + 1));
        let err = relay_cas(&[big]).unwrap_err().to_string();
        assert!(
            err.contains("over 64 KiB") && err.contains("--iroh-relay-ca"),
            "{err}"
        );
        // A key block, a missing file, a directory: refused, the content never repeated.
        // The label is built at run time: a literal key block would trip secret scanners.
        let label = ["PRIVATE", "KEY"].join(" ");
        let keyed = file(
            "key.pem",
            &format!("{pem}-----BEGIN {label}-----\nc2VjcmV0LWtleQ==\n-----END {label}-----\n"),
        );
        let err = relay_cas(&[keyed]).unwrap_err().to_string();
        assert!(err.contains("not a CERTIFICATE"), "{err}");
        assert!(!err.contains("c2VjcmV0"), "the content leaked: {err}");
        assert!(relay_cas(&["/nonexistent/ca.pem".into()]).is_err());
        let dir = std::env::temp_dir().to_str().unwrap().to_owned();
        let err = relay_cas(&[dir]).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{err}");
    }

    #[test]
    fn rating_keys_are_npubs_or_hex_and_come_out_as_hex() {
        use nostr_sdk::prelude::ToBech32 as _;
        let keys = nostr_sdk::prelude::Keys::generate();
        let hex = keys.public_key().to_hex();
        let npub = keys.public_key().to_bech32().unwrap();
        assert_eq!(pubkey_hex("rating-root", &npub).unwrap(), hex);
        assert_eq!(pubkey_hex("rating-root", &hex).unwrap(), hex);
        for bad in ["", "npub1nope", &hex[..63], "nsec1abc"] {
            let err = pubkey_hex("rating-root", bad).unwrap_err().to_string();
            assert!(err.contains("--rating-root"), "{bad}: {err}");
        }
        // A secret key given by mistake is named as one and never repeated.
        let nsec = keys.secret_key().to_bech32().unwrap();
        for secret in [nsec.clone(), format!("nostr:{nsec}")] {
            let err = pubkey_hex("rating-root", &secret).unwrap_err().to_string();
            assert!(err.contains("secret key"), "{err}");
            assert!(!err.contains(&nsec[5..]), "the nsec is repeated: {err}");
        }
        assert_eq!(nfxd::key::npub(&hex).as_deref(), Some(npub.as_str()));
        assert_eq!(nfxd::key::npub("nope"), None);
    }

    #[test]
    fn iroh_bind_and_external_addresses_parse_and_externals_repeat() {
        let args = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        let known = ["iroh-bind", "iroh-external"];
        let f = flags(
            &args(&[
                "--iroh-bind",
                "0.0.0.0:7843",
                "--iroh-external",
                "203.0.113.7:7843",
                "--iroh-external",
                "[2001:db8::7]:7843",
            ]),
            &known,
        )
        .unwrap();
        let sa = |s: &str| s.parse::<std::net::SocketAddr>().unwrap();
        let (bind, external) = iroh_addrs(&f).unwrap();
        assert_eq!(bind, Some(sa("0.0.0.0:7843")));
        assert_eq!(external, [sa("203.0.113.7:7843"), sa("[2001:db8::7]:7843")]);
        // Neither given: iroh's defaults.
        assert_eq!(iroh_addrs(&[]).unwrap(), (None, vec![]));
        for (flag, bad) in [
            ("iroh-bind", "7843"),
            ("iroh-bind", ":7843"),
            ("iroh-bind", "localhost:7843"),
            ("iroh-bind", "0.0.0.0:65536"),
            ("iroh-external", "203.0.113.7"),
            ("iroh-external", "relay.example:7843"),
            ("iroh-external", "2001:db8::7:7843"),
            ("iroh-external", "udp://203.0.113.7:7843"),
        ] {
            let name = format!("--{flag}");
            let f = flags(&args(&[name.as_str(), bad]), &known).unwrap();
            let err = iroh_addrs(&f).unwrap_err().to_string();
            assert_eq!(err, format!("--{flag} {bad}: not an ip:port"));
        }
        // One bind address; a flag needs its value.
        let f = flags(
            &args(&["--iroh-bind", "0.0.0.0:1", "--iroh-bind", "0.0.0.0:2"]),
            &known,
        )
        .unwrap();
        let err = iroh_addrs(&f).unwrap_err().to_string();
        assert!(err.contains("--iroh-bind given twice"), "{err}");
        assert!(flags(&args(&["--iroh-external"]), &known).is_err());
    }

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

    #[test]
    fn bridge_max_peers_is_a_count_given_once() {
        let args = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        let known = ["bridge-max-peers"];
        let f = flags(&args(&["--bridge-max-peers", "16"]), &known).unwrap();
        assert_eq!(bridge_max_peers(&f).unwrap(), Some(16));
        assert_eq!(bridge_max_peers(&[]).unwrap(), None);
        for bad in ["", "sixteen", "-1", "1.5", "16 "] {
            let f = flags(&args(&["--bridge-max-peers", bad]), &known).unwrap();
            let err = bridge_max_peers(&f).unwrap_err().to_string();
            assert_eq!(err, format!("--bridge-max-peers {bad}: not a number"));
        }
        let f = flags(
            &args(&["--bridge-max-peers", "8", "--bridge-max-peers", "9"]),
            &known,
        )
        .unwrap();
        let err = bridge_max_peers(&f).unwrap_err().to_string();
        assert!(err.contains("given twice"), "{err}");
        assert!(flags(&args(&["--bridge-max-peers"]), &known).is_err());
    }
}
