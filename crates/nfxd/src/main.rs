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
//!          [--https-url <url>] [--embed-relay <addr:port>] [--namespace <ns>]…
//! ```
//!
//! `<a>` is a manifest address, `38504:<creator-hex>:<namespace>:<video-id>`, as
//! `publish` prints it. Secrets never reach the terminal: only public keys are printed.

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
  nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]... [--iroh-relay <url>]... [--relay-only] [--seed <a>]... [--fetch <a>]... [--pull <a>]... [--origin <addr:port>] [--https-url <url>] [--embed-relay <addr:port>] [--namespace <ns>]...";

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
    // The one flag without a value.
    let relay_only = args.iter().any(|a| a == "--relay-only");
    let args: Vec<String> = args
        .iter()
        .filter(|a| *a != "--relay-only")
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
            "namespace",
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
        namespaces: all(&f, "namespace")
            .iter()
            .map(|n| Namespace::parse(n).map_err(Error::from))
            .collect::<Result<_>>()?,
        deletion_check_every: None,
        internal_origin: false,
    };
    let daemon = Daemon::start(cfg).await?;
    if let Some(url) = &daemon.relay_url {
        eprintln!("embedded relay: {url}");
    }
    if let Some(addr) = daemon.origin_addr {
        eprintln!("origin: http://{addr}/");
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
