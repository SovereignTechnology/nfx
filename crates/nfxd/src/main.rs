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
//!          [--seed <a>[#<id>,…]]… [--fetch <a>[#<id>,…]]… [--pull <a>[#<id>,…]]… [--origin <addr:port>]
//!          [--https-url <url>] [--embed-relay <addr:port> [--embed-relay-mesh] [--embed-relay-stun-ads] [--embed-relay-stun-port <port>] [--embed-relay-lookup]]
//!          [--embed-tracker <addr:port> [--bridge <ip:port> [--bridge-public <ip:port>] [--bridge-max-peers <n>] [--tracker-url <wss url>]]] [--namespace <ns>]…
//!          [--stun <ip:port> [--stun-public <ip:port>]]
//!          [--mesh-relay <wss url>… [--mesh-bind <ip:port> [--mesh-public <ip:port>]] [--mesh-stun <ip:port|host:port>]… [--mesh-max-peers <n>]
//!           [--mesh-stun-from-nostr=false]]
//!          [--allow-creator <hex>]… [--gossip [--gossip-peer <id>@<ip:port|relay-url>]…]
//!          [--rating-root <npub|hex> --general-relay <url>… [--rating-trusted <npub|hex>]…]
//! nfxd stun --bind <ip:port> [--public <ip:port>]
//!           [--announce --key <file> --relay <url>… --network <ns>…]   a STUN server, nothing else
//! ```
//!
//! `<a>` is a manifest address, `38504:<creator-hex>:<namespace>:<video-id>`, as
//! `publish` prints it. Secrets never reach the terminal: only public keys are printed.
//!
//! `key new` and `key show` print two lines, the hex public key and then the npub. A reader
//! may stop after the first (`nfxd key show f | head -n 1`): a closed stdout or stderr is
//! never a panic, and `run` keeps seeding when its status output goes away.
//!
//! An item may name the only renditions this node holds of it: `--seed <a>#720p`,
//! `--fetch <a>#720p,360p`, `--pull <a>#360p`, by the ids in the video's hash list
//! (`renditions[].id`; a video id never contains `#`). Without, it holds every rendition.
//! A fetch then takes the hash list, every playlist and the meta collection, and only those
//! renditions' inits and segments; a seed needs only those in the store. The origin serves
//! the other renditions' files as `404`, the bridge joins only the held renditions' swarms,
//! and beacons name only what is held (an iroh ticket per held rendition, the `webrtc` and
//! `https` endpoints' `renditions`, `chunks` as a count). An id the hash list lacks fails
//! that item, naming the ids it has. The choice is per item because rendition ids are per
//! video: each hash list names its own.
//!
//! `run` sends each video's beacon to every `--relay` every 30 s, within a share of each
//! relay (NFX-03 §7): at most 20 beacons a minute per relay, so past 10 videos the videos take
//! turns there, and a relay that answers `rate-limited:` or `blocked:` gets nothing for 1
//! minute, doubling to 30, until it accepts again. nfxd cannot tell a scoped relay from a
//! general one yet, so the share applies to every `--relay`.
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
//! `--embed-relay-mesh` lets the embedded relay carry NFX mesh signaling too (kind 25050 with
//! `i` = `nfx-mesh/1`, NFX-04 §1 as amended 2026-11-18): ephemeral, never stored, admitted
//! only after the checks a reader makes that need no session, the room proof included, and
//! rate-limited per sender. Pages and `--mesh-relay` endpoints may then name this relay for
//! signaling. A relay cannot tell which network or video a room is (kind 25050 carries no
//! `n`), so `--allow-creator` does not narrow it. Off by default.
//!
//! `--embed-relay-stun-ads` lets the embedded relay carry STUN service announcements too (kind
//! 33478, NFX-04 §1 as amended 2026-11-19, NFX-10 §1): an operator's signed note that a STUN
//! server serves some networks. Admitted only for the relay's own networks, after a reader's
//! checks (a global unicast server, an expiration at most 24 h on), 12 an hour per key and 1024
//! held at once, each kept until it expires; `--allow-creator` does not narrow them, since they
//! name no video. Off by default.
//!
//! `--embed-relay-lookup` lets the embedded relay carry seeder lookup too (kind 20465, NFX-17
//! §5): a viewer's ask and a seeder's answer, ephemeral, never stored, admitted only after full
//! verification, rate-limited. `--allow-creator` narrows it to those creators' videos. Off by
//! default.
//!
//! A node with a key answers seeder lookups (NFX-17 §3): when a viewer asks who seeds a video
//! it is announcing, it answers at once with its signed beacon, within a budget per viewer,
//! per video and overall. `--no-lookup` turns that off, and viewers then wait for the periodic
//! beacon.
//!
//! `--embed-relay-stun-port <port>` says in the embedded relay's NIP-11 document
//! (`nfx.stun_port`, NFX-04 §3 as amended 2026-11-24) that this host answers STUN Binding
//! requests on that UDP port, 1024 to 65535. Pages and nodes that signal through the relay then
//! ask it for their public mapping (NFX-10 §1): the relay sees their address on the WebSocket
//! anyway, so the STUN server learns only the port. They ask only a relay that lists kind
//! 25050, so it goes with `--embed-relay-mesh`, and they ask the host name of the relay's URL,
//! so it must answer where that name resolves (behind a TLS proxy, the proxy's host). nfxd does
//! not check that anything answers there: that is the operator's word. Run `--stun` (or `nfxd
//! stun`) on that port. Off by default.
//!
//! With `--state`, the embedded relay keeps the manifests it accepts in
//! `<state>/relay-manifests` (private to the user) and serves them again after a restart,
//! each re-verified and re-admitted under this run's flags: a creator no longer on
//! `--allow-creator` is not served. A deletion it honoured stays honoured. Only manifests are
//! kept, never beacons or signaling. Without `--state` they live in memory only.
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
//!
//! `--stun <ip:port>` answers STUN Binding requests (RFC 8489) on that UDP address, so a
//! network's web pages can name its own node in `iceServers` (`stun:<host>:<port>`) and
//! browsers learn their public mapping from it instead of a third party. Binding requests
//! only: no TURN, no authentication, at most 16 answers a second per source address (an
//! IPv6 /64), 256 per /24 or /48 and 4096 in all, and nothing about a client is logged. It
//! must see clients' source addresses as they are, so a DNAT may sit in front of it, a proxy
//! may not; on a host with several addresses, bind it to the one clients reach. Beacons
//! announce it as a `stun` endpoint (NFX-10 §1) when the bound address is public; behind a
//! DNAT, `--stun-public <ip:port>` names the public address to announce instead.
//!
//! `--mesh-relay <url>` (repeatable, 1 to 8) runs the mesh endpoint (NFX-10 §6): browsers find
//! this node in the rooms of the renditions it holds and fetch verified segments from it over
//! WebRTC, signaling only through those Nostr relays (general ones, `wss://`, or `ws://`, which
//! shows room keys and timing to the path; a scoped relay refuses kind 25050 unless it admits it,
//! NFX-04 §1, as `--embed-relay-mesh` makes nfxd's own), with no tracker
//! and no TURN. Its ICE agent is a full one, so it works behind a NAT: `--mesh-stun <ip:port>`
//! (repeatable, at most 4; a public node's `--stun`, say) names STUN servers that tell it its
//! public mapping. A `host:port` is resolved once at start, to an address of `--mesh-bind`'s
//! family; a name that does not resolve then is skipped with a note, and the node starts anyway,
//! so list more than one. The gateway is asked for a port when it can map one. `--mesh-bind`
//! fixes its UDP address (default: an ephemeral port, the host address the one the route out
//! leaves from); `--mesh-max-peers` caps its connections (default 16, at most 1024). Its
//! session key is fresh every run, never `--key`. Off by default. **Privacy:** joining a room
//! tells anyone who announces presence there this node's candidate addresses, its host
//! address and public mappings included, as a tracker's swarm would; relays see the room keys
//! (which the catalog maps back to videos) and who signals whom, never the SDP.
//!
//! The mesh endpoint learns STUN servers from Nostr too (NFX-10 §1), unless
//! `--mesh-stun-from-nostr=false`: on its `--mesh-relay`s it reads the beacons of the videos it
//! serves for their `stun` endpoints. After its own `--mesh-stun` it asks those that a beacon
//! signed by the video's creator names: global unicast, on a port of 1024 or above, at most 4
//! in all. A beacon signed by any other key adds none of these, however many keys name a
//! server, and STUN service announcements are not read. If no server it asks gives a mapping
//! (or it asks none), it also asks a server a seeder's beacon names, one per seeder and within
//! the 4, when that server's IP is among the candidates of a peer it is signaling with, for
//! that peer's connection only. Such a server learns this node's address; a mapping it
//! reports is offered only if it is global unicast, so one that lies costs a candidate,
//! nothing more.
//!
//! Behind a DNAT, where STUN cannot report the public address (the STUN server is the node's
//! own, which a UDP hairpin would need) and no gateway maps a port, `--mesh-public <ip:port>`
//! names the DNAT's public address and port, forwarded to `--mesh-bind`'s port, which must
//! then be fixed. It is offered as a host candidate and what arrives is taken as sent to it,
//! as with `--bridge-public`; then no candidate address that is not public is offered, so the
//! host's address behind the DNAT never reaches a peer. It must be a public unicast address of
//! `--mesh-bind`'s family. `--mesh-stun` stays optional beside it: a mapping that equals it is
//! offered once, one that is not public not at all.
//!
//! `nfxd stun` runs a STUN server and nothing else, for anyone who wants to give a network one:
//! no store, no videos, no iroh, the same Binding responder and rate limits as `--stun`, and
//! nothing about a client logged. `--bind` is the UDP address it answers on; on a host with
//! several addresses bind the one clients reach, and behind a DNAT name the public address as
//! `--public`. With `--announce`, it signs a STUN service announcement with `--key` (kind
//! 33478, NFX-10 §1: the public `ip:port` for each `--network`, 1 to 8, living 24 h) and sends
//! it to the `--relay`s (1 to 8) at once and every 12 h, so the people and operators of those
//! networks can find it over Nostr and configure it. No client asks it just because it is
//! announced. The announced address must be global unicast. **Privacy:** the operator learns
//! every client's IP address and when it asked, and the announcement ties the server's address
//! to the key, publicly.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use nfx_node::nostr::{Relays, sign_manifest};
use nfx_node::unix_now;
use nfx_proto::namespace::Namespace;
use nfxd::daemon::{Config, Daemon};
use nfxd::package::Package;
use nfxd::stun_server::{Announce, StunConfig, StunServer};
use nfxd::{Error, Result, key, status};
use nostr_sdk::prelude::ToBech32 as _;

const USAGE: &str = "usage:
  nfxd key new <file>
  nfxd key show <file>
  nfxd publish --key <file> --relay <url>... --package <dir> --title <text> [--description <md>] [--alt <text>] [--tag <t>]...
  nfxd delete --key <file> --relay <url>... --a <a>...
  nfxd run [--key <file>] --store <dir> [--state <dir>] [--relay <url>]... [--iroh-relay <url>]... [--iroh-relay-ca <pem>]... [--relay-only] [--iroh-bind <ip:port> [--iroh-external <ip:port>]...] [--seed <a>[#<id>,...]]... [--fetch <a>[#<id>,...]]... [--pull <a>[#<id>,...]]... [--origin <addr:port>] [--https-url <url>] [--embed-relay <addr:port> [--embed-relay-mesh] [--embed-relay-stun-ads] [--embed-relay-stun-port <port>] [--embed-relay-lookup]] [--embed-tracker <addr:port> [--bridge <ip:port> [--bridge-public <ip:port>] [--bridge-max-peers <n>] [--tracker-url <wss url>]]] [--namespace <ns>]... [--allow-creator <hex>]... [--gossip [--gossip-peer <id>@<ip:port|relay-url>]...] [--rating-root <npub|hex> --general-relay <url>... [--rating-trusted <npub|hex>]...] [--stun <ip:port> [--stun-public <ip:port>]] [--mesh-relay <wss url>... [--mesh-bind <ip:port> [--mesh-public <ip:port>]] [--mesh-stun <ip:port|host:port>]... [--mesh-max-peers <n>] [--mesh-stun-from-nostr=false]]
  nfxd stun --bind <ip:port> [--public <ip:port>] [--announce --key <file> --relay <url>... --network <ns>...]

  --mesh-relay runs the mesh endpoint (NFX-10 §6): browsers meet this node in the rooms of
  the renditions it holds, signaling only through those Nostr relays, and fetch verified
  segments over WebRTC with full ICE, through NATs (--mesh-stun: STUN servers for the public
  mapping; --mesh-public: behind a DNAT, its public address, forwarded to --mesh-bind's fixed
  port, offered instead of any address that is not public). Off by default. Privacy: joining
  a room tells anyone who announces presence there this node's candidate addresses, public
  ones included.

  It also learns STUN servers from Nostr (NFX-10 §1): after --mesh-stun, those a beacon
  signed by the video's own creator names (global unicast, port 1024 or above, at most 4 in
  all), and, if no server it asks gives a mapping, a seeder's server at the address of a
  peer it signals with. Never one only an announcement names. --mesh-stun-from-nostr=false
  turns that off.

  --embed-relay-mesh lets the embedded relay carry that signaling (kind 25050, nfx-mesh/1)
  too: ephemeral, room proof checked, rate-limited per sender. Off by default.
  --embed-relay-stun-ads lets it carry STUN service announcements (kind 33478) for its
  networks: checked, rate-limited per key, kept until they expire. Off by default.
  --embed-relay-lookup lets it carry seeder lookup (kind 20465): a viewer's ask and a seeder's
  answer, verified, rate-limited, never stored. Off by default.
  --no-lookup stops this node answering viewers who ask who seeds a video; they then wait for
  its periodic beacon.
  --embed-relay-stun-port <port> (1024 to 65535) says in the relay's NIP-11 document
  (nfx.stun_port) that the host of its URL answers STUN on that UDP port, so pages that
  signal through it (with --embed-relay-mesh) ask it: the relay already sees their address.
  nfxd does not check that anything answers there: run --stun on that port. Off by default.
  With --state, the embedded relay keeps the manifests it accepts in <state>/relay-manifests
  and serves them after a restart, re-verified and re-admitted under this run's flags. Only
  manifests are kept. Without --state they live in memory only.

  stun runs a STUN server and nothing else (RFC 8489 Binding only, rate-limited, nothing about
  a client logged) on --bind; --public names the address clients reach behind a DNAT. With
  --announce it signs, with --key, an announcement of that address for each --network and
  sends it to the --relays now and every 12 h (it lives 24 h): a directory entry people and
  operators read, which no client uses on its own. Privacy: the operator learns every
  client's IP address.";

fn usage() -> ExitCode {
    status!("{USAGE}");
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
        Some("stun") => stun(&args[1..]).await,
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Config(msg)) if msg == "usage" => usage(),
        Err(e) => {
            status!("nfxd: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `--mesh-stun` values: `ip:port`, or `host:port` with a DNS name, resolved once here, at
/// start (decision record 0111). A name that does not resolve within 5 s, or has no address of
/// `--mesh-bind`'s family, is skipped with a note: a STUN server's DNS never stops the node.
/// `check_mesh` then checks the addresses as it checks literal ones.
async fn mesh_stun(values: &[String], mesh: bool, v4: bool) -> Result<Vec<std::net::SocketAddr>> {
    use nfx_node::mesh::MAX_STUN;
    if values.len() > MAX_STUN {
        return Err(Error::Config(format!("--mesh-stun: at most {MAX_STUN}")));
    }
    let mut out = Vec::with_capacity(values.len());
    for v in values {
        if let Ok(a) = v.parse() {
            out.push(a);
            continue;
        }
        let Some((host, port)) = stun_name(v) else {
            return Err(Error::Config(format!(
                "--mesh-stun {v}: not an ip:port or host:port"
            )));
        };
        if !mesh {
            // `check_mesh` says why; resolving first would only delay it.
            return Err(Error::Config("--mesh-stun needs --mesh-relay".into()));
        }
        let found = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::lookup_host((host, port)),
        )
        .await;
        match found {
            Ok(Ok(mut addrs)) => match addrs.find(|a| a.is_ipv4() == v4) {
                Some(a) => out.push(a),
                None => {
                    status!("nfxd: --mesh-stun {v}: no address of --mesh-bind's family; skipped")
                }
            },
            _ => status!("nfxd: --mesh-stun {v}: does not resolve now; skipped"),
        }
    }
    Ok(out)
}

/// `host:port` where host is a DNS name with a dot (labels of lowercase letters, digits and
/// inner hyphens) and port is 1 to 65535 in plain digits.
fn stun_name(v: &str) -> Option<(&str, u16)> {
    let (host, port) = v.rsplit_once(':')?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u16 = port.parse().ok().filter(|p| *p != 0)?;
    let label = |l: &str| {
        (1..=63).contains(&l.len())
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    (host.len() <= 253 && host.contains('.') && host.split('.').all(label)).then_some((host, port))
}

fn bad_usage() -> Error {
    Error::Config("usage".into())
}

/// Writes `lines` to `out`. A reader that has gone away (`nfxd key show f | head -n 1`) is a
/// normal end, not a failure: it already took what it wanted. Any other write error, such as
/// a full disk, is returned.
fn write_lines(out: &mut impl std::io::Write, lines: &[&str]) -> std::io::Result<()> {
    let written = lines
        .iter()
        .try_for_each(|line| writeln!(out, "{line}"))
        .and_then(|()| out.flush());
    match written {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

fn print_lines(lines: &[&str]) -> Result<()> {
    Ok(write_lines(&mut std::io::stdout().lock(), lines)?)
}

fn print_public(keys: &nostr_sdk::prelude::Keys) -> Result<()> {
    let pk = keys.public_key();
    let Ok(npub) = pk.to_bech32();
    print_lines(&[pk.to_hex().as_str(), npub.as_str()])
}

fn key_cmd(args: &[String]) -> Result<()> {
    match args {
        [cmd, file] if cmd == "new" => print_public(&key::create(Path::new(file))?),
        [cmd, file] if cmd == "show" => print_public(&key::load(Path::new(file))?),
        _ => Err(bad_usage()),
    }
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
    status!("published to {accepted} relay(s)");
    print_lines(&[manifest.a_tag().as_ref()])
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
    status!("deletion accepted by {} relay(s)", accepted?);
    Ok(())
}

async fn run(args: &[String]) -> Result<()> {
    // The flags without a value.
    let relay_only = args.iter().any(|a| a == "--relay-only");
    let gossip = args.iter().any(|a| a == "--gossip");
    let embed_relay_mesh = args.iter().any(|a| a == "--embed-relay-mesh");
    let embed_relay_stun_ads = args.iter().any(|a| a == "--embed-relay-stun-ads");
    let embed_relay_lookup = args.iter().any(|a| a == "--embed-relay-lookup");
    let no_lookup = args.iter().any(|a| a == "--no-lookup");
    // On by default; `--mesh-stun-from-nostr=true` says so, `=false` turns it off.
    let no_mesh_stun_from_nostr = args.iter().any(|a| a == "--mesh-stun-from-nostr=false");
    let bare = [
        "--relay-only",
        "--gossip",
        "--embed-relay-mesh",
        "--embed-relay-stun-ads",
        "--embed-relay-lookup",
        "--no-lookup",
        "--mesh-stun-from-nostr=false",
        "--mesh-stun-from-nostr=true",
    ];
    if args
        .iter()
        .filter(|a| a.starts_with("--mesh-stun-from-nostr"))
        .count()
        > 1
    {
        return Err(Error::Config("--mesh-stun-from-nostr given twice".into()));
    }
    let args: Vec<String> = args
        .iter()
        .filter(|a| !bare.contains(&a.as_str()))
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
            "embed-relay-stun-port",
            "embed-tracker",
            "bridge",
            "bridge-public",
            "bridge-max-peers",
            "tracker-url",
            "stun",
            "stun-public",
            "mesh-relay",
            "mesh-bind",
            "mesh-stun",
            "mesh-max-peers",
            "mesh-public",
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
    let (seed, fetch, pull, renditions) = items(&f)?;
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
        seed,
        fetch,
        pull,
        renditions,
        origin: addr("origin")?,
        https_url: one(&f, "https-url")?,
        embed_relay: addr("embed-relay")?,
        embed_tracker: addr("embed-tracker")?,
        bridge: addr("bridge")?,
        bridge_public: addr("bridge-public")?,
        bridge_max_peers: bridge_max_peers(&f)?,
        tracker_public_url: one(&f, "tracker-url")?,
        stun: addr("stun")?,
        stun_public: addr("stun-public")?,
        mesh_relays: all(&f, "mesh-relay"),
        mesh_bind: addr("mesh-bind")?,
        mesh_stun: mesh_stun(
            &all(&f, "mesh-stun"),
            !all(&f, "mesh-relay").is_empty(),
            addr("mesh-bind")?.is_none_or(|b| b.is_ipv4()),
        )
        .await?,
        mesh_max_peers: count(&f, "mesh-max-peers")?,
        mesh_public: ip_port(&f, "mesh-public")?,
        namespaces: all(&f, "namespace")
            .iter()
            .map(|n| Namespace::parse(n).map_err(Error::from))
            .collect::<Result<_>>()?,
        deletion_check_every: None,
        allow_creators: all(&f, "allow-creator"),
        embed_relay_mesh,
        embed_relay_stun_ads,
        embed_relay_lookup,
        no_lookup,
        embed_relay_stun_port: port(&f, "embed-relay-stun-port")?,
        no_mesh_stun_from_nostr,
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
        keep_on_request: false,
        no_portmapper: false,
        // An operator's seeder publishes what it has, as before; `--iroh-external` narrows it.
        public_addrs_only: false,
    };
    let daemon = Daemon::start(cfg).await?;
    if let Some(url) = &daemon.relay_url {
        status!("embedded relay: {url}");
    }
    if let Some(addr) = daemon.origin_addr {
        status!("origin: http://{addr}/");
    }
    if let Some(url) = &daemon.tracker_url {
        status!("embedded tracker: {url}");
    }
    if let Some(addr) = daemon.bridge_addr {
        status!("bridge: udp {addr}");
        if let Some(public) = daemon.bridge_public.filter(|p| *p != addr) {
            status!("bridge public: udp {public}");
        }
    }
    if let Some(addr) = daemon.stun_addr {
        status!("stun: udp {addr}");
        match daemon.stun_public {
            Some(public) if public != addr => status!("stun public: udp {public}"),
            Some(_) => {}
            None => status!(
                "stun: not announced in beacons (no address a browser can reach; see --stun-public)"
            ),
        }
    }
    if let (Some(addr), Some(session)) = (daemon.mesh_addr, &daemon.mesh_session) {
        status!("mesh: udp {addr}, session {session}");
        if let Some(public) = daemon.mesh_public {
            status!("mesh public: udp {public} (offered as a host candidate)");
        }
    }
    if gossip {
        let me = daemon.node().addr();
        for t in &me.addrs {
            match t {
                iroh::TransportAddr::Ip(ip) => status!("gossip peer: {}@{ip}", me.id),
                iroh::TransportAddr::Relay(url) => status!("gossip peer: {}@{url}", me.id),
                _ => {}
            }
        }
    }
    let mut last = std::collections::BTreeMap::new();
    let mut last_mesh = None;
    // The number of the last mesh connection that never opened and was printed.
    let mut last_failure = 0;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    // SIGTERM (a service manager's stop) ends the run as SIGINT does: the mesh's rooms hear a
    // `disconnect`, and the relays and the node close.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            _ = tick.tick() => {
                let now = daemon.state();
                for (a, s) in &now {
                    if last.get(a) != Some(s) {
                        status!("{a}: {s:?}");
                    }
                }
                last = now;
                let mesh_now = daemon.mesh_status();
                if let Some(s) = &mesh_now {
                    for line in link_failure_lines(&s.failures, &mut last_failure) {
                        status!("{line}");
                    }
                }
                let mesh = mesh_now.map(|s| mesh_line(&s));
                if mesh != last_mesh {
                    if let Some(line) = &mesh {
                        status!("{line}");
                    }
                    last_mesh = mesh;
                }
            }
        }
    }
    daemon.shutdown().await;
    Ok(())
}

/// `nfxd stun`: a STUN server, announced over Nostr with `--announce`.
async fn stun(args: &[String]) -> Result<()> {
    let announce = args.iter().any(|a| a == "--announce");
    let args: Vec<String> = args
        .iter()
        .filter(|a| *a != "--announce")
        .cloned()
        .collect();
    let f = flags(&args, &["bind", "public", "key", "relay", "network"])?;
    let bind = ip_port(&f, "bind")?.ok_or_else(|| Error::Config("--bind is required".into()))?;
    let public = ip_port(&f, "public")?;
    let (relays, networks) = (all(&f, "relay"), all(&f, "network"));
    let announce = if announce {
        Some(Announce {
            keys: key::load(Path::new(&required(&f, "key")?))?,
            relays,
            networks: networks
                .iter()
                .map(|n| Namespace::parse(n).map_err(Error::from))
                .collect::<Result<_>>()?,
        })
    } else {
        if one(&f, "key")?.is_some() || !relays.is_empty() || !networks.is_empty() {
            return Err(Error::Config(
                "--key, --relay and --network need --announce".into(),
            ));
        }
        None
    };
    let server = StunServer::start(StunConfig {
        bind,
        public,
        announce,
        limits: nfxd::stun::Limits::default(),
    })
    .await?;
    let addr = server.local_addr();
    status!("stun: udp {addr}");
    match server.public_addr() {
        Some(p) if p != addr => status!("stun public: udp {p}"),
        Some(_) => {}
        None => status!(
            "stun: no global unicast address to name (see --public); clients that are told this one can use it"
        ),
    }
    let (mut last, mut last_failure) = (None, None);
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            _ = tick.tick() => {
                let now = server.announced();
                if now != last
                    && let (Some(a), Some(public)) = (now, server.public_addr())
                {
                    status!(
                        "stun: announced {public} to {} relay(s), until {}",
                        a.relays, a.expiration
                    );
                }
                last = now;
                let failure = server.announce_failure();
                if failure != last_failure
                    && let Some(why) = &failure
                {
                    status!("stun: announcing failed ({why}); trying again in 5 min");
                }
                last_failure = failure;
            }
        }
    }
    server.shutdown();
    Ok(())
}

/// The `--seed`, `--fetch` and `--pull` items, each `<a>` or `<a>#<id>[,<id>…]`: their
/// addresses, and the renditions named for each that names some. An address named with
/// renditions may be named only once in all.
#[allow(clippy::type_complexity)]
fn items(
    f: &[(String, String)],
) -> Result<(
    Vec<String>,
    Vec<String>,
    Vec<String>,
    std::collections::BTreeMap<String, Vec<String>>,
)> {
    let mut renditions = std::collections::BTreeMap::new();
    let mut lists: [Vec<String>; 3] = Default::default();
    for (flag, list) in ["seed", "fetch", "pull"].into_iter().zip(&mut lists) {
        for v in all(f, flag) {
            let (a, ids) = item(flag, &v)?;
            if let Some(ids) = ids {
                renditions.insert(a.clone(), ids);
            }
            list.push(a);
        }
    }
    let [seed, fetch, pull] = lists;
    for a in renditions.keys() {
        if seed
            .iter()
            .chain(&fetch)
            .chain(&pull)
            .filter(|x| *x == a)
            .count()
            > 1
        {
            return Err(Error::Config(format!(
                "{a}: named more than once; name it once, with its renditions"
            )));
        }
    }
    Ok((seed, fetch, pull, renditions))
}

/// One item, `<a>` or `<a>#<id>[,<id>…]`: 1 or more distinct ids, none empty, none `meta`
/// (reserved, NFX-03 §4), none with `#` or white space in it. The address itself is checked
/// by `Daemon::start`, the ids against the video's hash list once it is known.
fn item(flag: &str, v: &str) -> Result<(String, Option<Vec<String>>)> {
    let Some((a, list)) = v.split_once('#') else {
        return Ok((v.to_owned(), None));
    };
    let bad = |why: String| Error::Config(format!("--{flag} {v}: {why}"));
    let mut ids: Vec<String> = Vec::new();
    for id in list.split(',') {
        if id.is_empty() {
            return Err(bad("an empty rendition id".into()));
        }
        if id == nfx_proto::hashlist::RESERVED_RENDITION_ID
            || id.contains('#')
            || id.chars().any(char::is_whitespace)
        {
            return Err(bad(format!("{id:?} is not a rendition id")));
        }
        if ids.iter().any(|x| x == id) {
            return Err(bad(format!("rendition {id} named twice")));
        }
        ids.push(id.to_owned());
    }
    Ok((a.to_owned(), Some(ids)))
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

/// One line of what the mesh endpoint is doing, printed when it changes.
fn mesh_line(s: &nfx_node::mesh::MeshStatus) -> String {
    format!(
        "mesh: {} room(s), candidates [{}]{}, {} open, {} connecting; offers {}, answers {}, opened {}, failed {}, segments served {}; stun [{}]",
        s.rooms,
        s.candidates.join(", "),
        if s.gathered { "" } else { " (gathering)" },
        s.open,
        s.connecting,
        s.offers,
        s.answers,
        s.opened,
        s.failed,
        s.served,
        s.stun.join(", "),
    )
}

/// One line for each mesh connection in `failures` that was not printed yet (`seen` is the
/// number of the last one that was), oldest first: how it started, how far it got and the
/// kinds of candidate each side named. Counted kinds only, never an address: a peer may be a
/// viewer. A gap in the numbers says how many the endpoint's short list let go before the
/// next look.
fn link_failure_lines(failures: &[nfx_node::mesh::LinkFailure], seen: &mut u64) -> Vec<String> {
    let mut out = Vec::new();
    let printed = *seen;
    for f in failures.iter().filter(|f| f.seq > printed) {
        if f.seq > *seen + 1 {
            out.push(format!(
                "mesh: {} earlier link(s) that never opened are not listed",
                f.seq - *seen - 1
            ));
        }
        out.push(format!(
            "mesh: link {} never opened ({}) after {} s; we {}; our candidates [{}], theirs [{}]",
            f.seq,
            f.stage,
            f.after_secs,
            if f.offerer { "offered" } else { "answered" },
            f.local,
            f.remote,
        ));
        *seen = f.seq;
    }
    out
}

/// `--NAME N`, a count; `Daemon::start` checks its range.
fn count(f: &[(String, String)], name: &str) -> Result<Option<usize>> {
    one(f, name)?
        .map(|v| {
            v.parse()
                .map_err(|_| Error::Config(format!("--{name} {v}: not a number")))
        })
        .transpose()
}

/// `--NAME PORT`, a UDP or TCP port, given at most once; `Daemon::start` checks its range.
fn port(f: &[(String, String)], name: &str) -> Result<Option<u16>> {
    one(f, name)?
        .map(|v| {
            v.parse()
                .map_err(|_| Error::Config(format!("--{name} {v}: not a port")))
        })
        .transpose()
}

/// `--NAME ip:port`, given at most once. Only the form is checked here; `Daemon::start`
/// checks that the daemon can use it.
fn ip_port(f: &[(String, String)], name: &str) -> Result<Option<std::net::SocketAddr>> {
    one(f, name)?
        .map(|v| {
            v.parse()
                .map_err(|_| Error::Config(format!("--{name} {v}: not an ip:port")))
        })
        .transpose()
}

/// `--bridge-max-peers N`, a count; `Daemon::start` checks its range.
fn bridge_max_peers(f: &[(String, String)]) -> Result<Option<usize>> {
    count(f, "bridge-max-peers")
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
    use super::{
        bridge_max_peers, flags, gossip_peers, ip_port, iroh_addrs, items, link_failure_lines,
        mesh_stun, port, pubkey_hex, relay_cas, stun_name, write_lines,
    };
    use nfx_node::mesh::{FailStage, LinkFailure};

    fn failure(seq: u64, stage: FailStage, offerer: bool) -> LinkFailure {
        LinkFailure {
            seq,
            offerer,
            stage,
            after_secs: 15,
            local: "host 1".into(),
            remote: "host 1, srflx 1".into(),
        }
    }

    #[test]
    fn each_link_that_never_opened_is_printed_once_with_its_stage_and_no_address() {
        let list = [
            failure(1, FailStage::NoAnswer, true),
            failure(2, FailStage::NoIcePair, false),
        ];
        let mut seen = 0;
        let lines = link_failure_lines(&list, &mut seen);
        assert_eq!(seen, 2);
        assert_eq!(
            lines,
            [
                "mesh: link 1 never opened (no answer) after 15 s; we offered; our candidates [host 1], theirs [host 1, srflx 1]",
                "mesh: link 2 never opened (no ICE pair) after 15 s; we answered; our candidates [host 1], theirs [host 1, srflx 1]",
            ]
        );
        assert!(
            link_failure_lines(&list, &mut seen).is_empty(),
            "printed once"
        );
        // Numbers 3 and 4 fell out of the endpoint's short list before the next look.
        let more = [failure(5, FailStage::NoDtls, true)];
        let lines = link_failure_lines(&more, &mut seen);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            "mesh: 2 earlier link(s) that never opened are not listed"
        );
        assert!(lines[1].starts_with("mesh: link 5 never opened (ICE up, no DTLS)"));
        assert_eq!(seen, 5);
        // Nothing that looks like an address: one colon (after `mesh`) and no dot.
        for l in &lines {
            assert!(l.matches(':').count() == 1 && !l.contains('.'), "{l}");
        }
    }

    /// Takes `left` bytes, then fails every write with `kind`.
    struct FailsAfter {
        left: usize,
        kind: std::io::ErrorKind,
        got: Vec<u8>,
    }

    impl std::io::Write for FailsAfter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.left == 0 {
                return Err(self.kind.into());
            }
            let n = buf.len().min(self.left);
            self.got.extend_from_slice(&buf[..n]);
            self.left -= n;
            Ok(n)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_reader_that_left_ends_the_output_and_other_write_errors_are_returned() {
        let mut out = FailsAfter {
            left: 6,
            kind: std::io::ErrorKind::BrokenPipe,
            got: Vec::new(),
        };
        write_lines(&mut out, &["first", "second"]).unwrap();
        assert_eq!(out.got, b"first\n");

        let mut out = FailsAfter {
            left: 6,
            kind: std::io::ErrorKind::StorageFull,
            got: Vec::new(),
        };
        let e = write_lines(&mut out, &["first", "second"]).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::StorageFull);
    }

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
    fn items_name_their_held_renditions_after_a_hash() {
        let args = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        let known = ["seed", "fetch", "pull"];
        let a = "38504:aa:nfx:testnet:1:video-a";
        let b = "38504:bb:nfx:testnet:1:video-b";
        let c = "38504:cc:nfx:testnet:1:video-c";
        let f = flags(
            &args(&[
                "--seed",
                &format!("{a}#720p"),
                "--fetch",
                &format!("{b}#1080p,360p"),
                "--pull",
                c,
                "--seed",
                "38504:dd:nfx:testnet:1:video-d",
            ]),
            &known,
        )
        .unwrap();
        let (seed, fetch, pull, renditions) = items(&f).unwrap();
        assert_eq!(seed, [a, "38504:dd:nfx:testnet:1:video-d"]);
        assert_eq!((fetch, pull), (vec![b.to_owned()], vec![c.to_owned()]));
        assert_eq!(
            renditions.into_iter().collect::<Vec<_>>(),
            [
                (a.to_owned(), vec!["720p".to_owned()]),
                (b.to_owned(), vec!["1080p".to_owned(), "360p".to_owned()]),
            ]
        );
        // Ids are not checked against a hash list here: any non-empty one but `meta`.
        let f = flags(&args(&["--pull", &format!("{c}#audio-hi,r1")]), &known).unwrap();
        assert_eq!(items(&f).unwrap().3[c], ["audio-hi", "r1"]);
        for (flag, value, why) in [
            ("seed", format!("{a}#"), "an empty rendition id"),
            ("seed", format!("{a}#720p,"), "an empty rendition id"),
            ("fetch", format!("{a}#,720p"), "an empty rendition id"),
            (
                "fetch",
                format!("{a}#meta"),
                "\"meta\" is not a rendition id",
            ),
            (
                "pull",
                format!("{a}#720p#360p"),
                "\"720p#360p\" is not a rendition id",
            ),
            (
                "seed",
                format!("{a}#720p, 360p"),
                "\" 360p\" is not a rendition id",
            ),
            (
                "seed",
                format!("{a}#720p,720p"),
                "rendition 720p named twice",
            ),
        ] {
            let name = format!("--{flag}");
            let f = flags(&args(&[name.as_str(), &value]), &known).unwrap();
            let err = items(&f).unwrap_err().to_string();
            assert_eq!(err, format!("--{flag} {value}: {why}"));
        }
        // A video with renditions is named once, so there is one answer to what it holds.
        for twice in [
            ["--seed", &format!("{a}#720p"), "--fetch", a],
            [
                "--seed",
                &format!("{a}#720p"),
                "--seed",
                &format!("{a}#360p"),
            ],
        ] {
            let f = flags(&args(&twice), &known).unwrap();
            let err = items(&f).unwrap_err().to_string();
            assert!(err.contains("named more than once"), "{err}");
        }
        // Without renditions, as before: the same address may come twice.
        let f = flags(&args(&["--seed", a, "--fetch", a]), &known).unwrap();
        assert!(items(&f).unwrap().3.is_empty());
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

    #[test]
    fn mesh_public_is_one_ip_and_port() {
        let args = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        let known = ["mesh-public"];
        let sa = |s: &str| s.parse::<std::net::SocketAddr>().unwrap();
        for v in ["203.0.113.7:7845", "[2001:db8::7]:7845"] {
            let f = flags(&args(&["--mesh-public", v]), &known).unwrap();
            assert_eq!(ip_port(&f, "mesh-public").unwrap(), Some(sa(v)));
        }
        assert_eq!(ip_port(&[], "mesh-public").unwrap(), None);
        // Only the form here: whether the daemon can use it is `Daemon::start`'s to check.
        for bad in [
            "203.0.113.7",
            ":7845",
            "relay.example:7845",
            "2001:db8::7:7845",
            "203.0.113.7:65536",
            "udp://203.0.113.7:7845",
        ] {
            let f = flags(&args(&["--mesh-public", bad]), &known).unwrap();
            let err = ip_port(&f, "mesh-public").unwrap_err().to_string();
            assert_eq!(err, format!("--mesh-public {bad}: not an ip:port"));
        }
        let f = flags(
            &args(&[
                "--mesh-public",
                "203.0.113.7:1",
                "--mesh-public",
                "203.0.113.7:2",
            ]),
            &known,
        )
        .unwrap();
        let err = ip_port(&f, "mesh-public").unwrap_err().to_string();
        assert!(err.contains("--mesh-public given twice"), "{err}");
        assert!(flags(&args(&["--mesh-public"]), &known).is_err());
    }

    #[test]
    fn embed_relay_stun_port_is_one_port() {
        let args = |s: &[&str]| s.iter().map(ToString::to_string).collect::<Vec<_>>();
        let name = "embed-relay-stun-port";
        let known = [name];
        for (v, want) in [("3478", 3478), ("1024", 1024), ("65535", 65535)] {
            let f = flags(&args(&["--embed-relay-stun-port", v]), &known).unwrap();
            assert_eq!(port(&f, name).unwrap(), Some(want));
        }
        assert_eq!(port(&[], name).unwrap(), None);
        // Only the form here: `Daemon::start` refuses one below 1024.
        let f = flags(&args(&["--embed-relay-stun-port", "53"]), &known).unwrap();
        assert_eq!(port(&f, name).unwrap(), Some(53));
        for bad in ["", "65536", "-1", "3478.0", "udp:3478", "1.1.1.1:3478"] {
            let f = flags(&args(&["--embed-relay-stun-port", bad]), &known).unwrap();
            let err = port(&f, name).unwrap_err().to_string();
            assert_eq!(err, format!("--embed-relay-stun-port {bad}: not a port"));
        }
        let f = flags(
            &args(&[
                "--embed-relay-stun-port",
                "3478",
                "--embed-relay-stun-port",
                "3479",
            ]),
            &known,
        )
        .unwrap();
        let err = port(&f, name).unwrap_err().to_string();
        assert!(err.contains("--embed-relay-stun-port given twice"), "{err}");
        assert!(flags(&args(&["--embed-relay-stun-port"]), &known).is_err());
    }

    #[test]
    fn stun_name_takes_a_dns_name_and_a_port() {
        assert_eq!(
            stun_name("stun.cloudflare.com:3478"),
            Some(("stun.cloudflare.com", 3478))
        );
        assert_eq!(
            stun_name("stun.l.google.com:19302"),
            Some(("stun.l.google.com", 19302))
        );
        for bad in [
            "localhost:3478",
            "stun.example.com",
            "stun.example.com:",
            "stun.example.com:0",
            "stun.example.com:+3478",
            "stun.example.com:70000",
            "Stun.example.com:3478",
            "-stun.example.com:3478",
            "stun..example.com:3478",
            "stun_x.example.com:3478",
            "user@stun.example.com:3478",
            "[::1]:3478",
        ] {
            assert_eq!(stun_name(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn mesh_stun_keeps_literals_and_skips_a_name_that_does_not_resolve() {
        let v = |xs: &[&str]| xs.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
        let got = mesh_stun(&v(&["192.0.2.1:3478", "nfx-test.invalid:3478"]), true, true)
            .await
            .unwrap();
        assert_eq!(got, vec!["192.0.2.1:3478".parse().unwrap()]);
        let err = mesh_stun(&v(&["stun x:1"]), true, true).await.unwrap_err();
        assert!(
            err.to_string().contains("not an ip:port or host:port"),
            "{err}"
        );
        let err = mesh_stun(&v(&["stun.example.com:3478"]), false, true)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("--mesh-stun needs --mesh-relay"),
            "{err}"
        );
        let five = v(&[
            "192.0.2.1:1",
            "192.0.2.1:2",
            "192.0.2.1:3",
            "192.0.2.1:4",
            "192.0.2.1:5",
        ]);
        let err = mesh_stun(&five, true, true).await.unwrap_err();
        assert!(err.to_string().contains("at most 4"), "{err}");
    }
}
