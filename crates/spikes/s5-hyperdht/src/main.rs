//! Spike S5': the Rust peer, on peeroxide 1.7.3. Same CLI and wire as `node/peer.js`, so
//! `run-local.sh` and `nat/run.sh` can pair any two. The wire is NFX-12: `nfx/files/1`
//! (types 0 get, 1 data, 2 end, 3 missing) and `nfx/pay/1` (type 0, one JSON message) on
//! Protomux, channel id = the video address.
//!
//! ```text
//! s5-hyperdht serve --bootstrap H:P --seed S --bytes N [--allow HEX] [--relay HEX] [--timeout-ms T]
//! s5-hyperdht fetch --bootstrap H:P --seed S --peer HEX --sha HEX --bytes N
//!                   [--expect-refused] [--keepalive-ms K] [--idle-ms I] [--expect-closed]
//! ```
//!
//! What peeroxide 1.7.3 lacks shapes this file, and each gap is a finding of the spike:
//! - no listen API on peeroxide-dht: a server is a `peeroxide` swarm joined as server to the
//!   NFX-12 topic, which also announces `hash(peer key)`, where `connect(key)` looks;
//! - no firewall callback: `--allow` drops a connection after its handshake;
//! - no keepalive or timeout settings, and keepalives never reach the application:
//!   `--keepalive-ms` is ignored, and `--timeout-ms` counts Protomux messages only;
//! - Protomux queues are unbounded with no drain signal: the sender cannot cap what it has
//!   queued, so `pay_rtt_ms` measures how long a pay/1 message waits behind the file.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use libudx::UdxRuntime;
use peeroxide::{JoinOpts, SwarmConfig, SwarmConnection};
use peeroxide_dht::hyperdht::{self, HyperDhtConfig, KeyPair};
use peeroxide_dht::protomux::{Channel, ChannelEvent, Mux};
use peeroxide_dht::rpc::DhtConfig;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};

const NAMESPACE: &str = "nfx:regtest:1";
const VIDEO_ID: &str = "s5-spike-video";
const FRAME: usize = 65536;
const GET: u32 = 0;
const DATA: u32 = 1;
const END: u32 = 2;
const MISSING: u32 = 3;
const MSG: u32 = 0;

type Opts = HashMap<String, String>;

fn parse_args() -> Result<(String, Opts)> {
    let mut it = std::env::args().skip(1).peekable();
    let role = it.next().context("usage: s5-hyperdht serve|fetch …")?;
    let mut o = Opts::new();
    while let Some(k) = it.next() {
        let k = k
            .strip_prefix("--")
            .context("flags start with --")?
            .to_owned();
        match it.peek() {
            Some(v) if !v.starts_with("--") => {
                let v = it.next().expect("peeked");
                o.insert(k, v);
            }
            _ => {
                o.insert(k, "true".into());
            }
        }
    }
    Ok((role, o))
}

fn get<'a>(o: &'a Opts, k: &str) -> Result<&'a str> {
    o.get(k)
        .map(String::as_str)
        .with_context(|| format!("--{k} is required"))
}

fn num(o: &Opts, k: &str) -> Result<u64> {
    get(o, k)?
        .parse()
        .with_context(|| format!("--{k} is not a number"))
}

fn sha256(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

fn key32(hex_str: &str) -> Result<[u8; 32]> {
    let v = hex::decode(hex_str)?;
    v.try_into()
        .map_err(|_| anyhow!("expected 32 bytes of hex"))
}

fn key_pair(seed: &str) -> KeyPair {
    // The same derivation as the Node peer: DHT.keyPair(sha256(seed)), libsodium's seed key pair.
    KeyPair::from_seed(sha256(seed.as_bytes()))
}

fn video() -> String {
    format!("{NAMESPACE}:{VIDEO_ID}")
}

/// NFX-12 §3's per-video topic, the 32-byte digest.
fn topic() -> [u8; 32] {
    sha256(format!("nfx/1/hyper/{NAMESPACE}/{VIDEO_ID}").as_bytes())
}

/// Servers and clients alike are ephemeral DHT nodes, as Node's are by default: peeroxide's
/// default for a non-empty bootstrap list (`ephemeral: None`).
fn dht_config(o: &Opts) -> Result<HyperDhtConfig> {
    let mut dht = DhtConfig::default();
    dht.bootstrap = vec![get(o, "bootstrap")?.to_owned()];
    let mut config = HyperDhtConfig::default();
    config.dht = dht;
    Ok(config)
}

/// A file of `n` bytes: sha256 in counter mode over a fixed label, so no RNG is needed.
fn file_of(n: usize) -> (Vec<u8>, String) {
    let mut buf = Vec::with_capacity(n + 32);
    let mut i: u64 = 0;
    while buf.len() < n {
        buf.extend_from_slice(&sha256(&[b"s5-file".as_slice(), &i.to_le_bytes()].concat()));
        i += 1;
    }
    buf.truncate(n);
    let sha = hex::encode(sha256(&buf));
    (buf, sha)
}

fn u32le(n: u32) -> [u8; 4] {
    n.to_le_bytes()
}

fn req_of(data: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(..4)?.try_into().ok()?))
}

fn out(v: Value) {
    println!("{v}");
}

async fn channels(mux: &Mux) -> Result<(Channel, Channel)> {
    let id = Some(video().into_bytes());
    let pay = mux.create_channel("nfx/pay/1", id.clone(), None).await?;
    let files = mux.create_channel("nfx/files/1", id, None).await?;
    Ok((pay, files))
}

// ---- serve -----------------------------------------------------------------------------

async fn serve(o: Opts) -> Result<()> {
    let kp = key_pair(get(&o, "seed")?);
    let (buf, sha) = file_of(num(&o, "bytes")? as usize);
    let allow = o.get("allow").map(|a| key32(a)).transpose()?;
    let timeout_ms = o.get("timeout-ms").map(|t| t.parse::<u64>()).transpose()?;

    let mut config = SwarmConfig::default();
    config.key_pair = Some(kp.clone());
    config.dht = dht_config(&o)?;
    if let Some(relay) = o.get("relay") {
        config.relay_through = Some(key32(relay)?);
    }
    let (_task, swarm, mut conns) = peeroxide::spawn(config).await?;
    let mut join = JoinOpts::default();
    join.server = true;
    join.client = false;
    swarm.join(topic(), join).await?;
    swarm.flush().await?;
    out(
        json!({ "role": "serve", "impl": "rust", "peer": hex::encode(kp.public_key), "sha": sha,
                "bytes": buf.len() }),
    );

    let file = std::sync::Arc::new((buf, sha));
    while let Some(conn) = conns.recv().await {
        if allow.is_some_and(|a| a != *conn.remote_public_key()) {
            // No firewall callback in peeroxide: the handshake already happened.
            drop(conn);
            continue;
        }
        let file = file.clone();
        tokio::spawn(async move {
            if let Err(e) = on_connection(conn, &file.0, &file.1, timeout_ms).await {
                eprintln!("connection: {e:#}");
            }
        });
    }
    Ok(())
}

async fn on_connection(
    conn: SwarmConnection,
    buf: &[u8],
    sha: &str,
    timeout_ms: Option<u64>,
) -> Result<()> {
    let (mux, run) = Mux::new(conn.peer.stream);
    tokio::spawn(run);
    let (mut pay, mut files) = channels(&mux).await?;
    let idle = Duration::from_millis(timeout_ms.unwrap_or(u64::MAX / 4));
    loop {
        let event = tokio::select! {
            e = pay.recv() => e.map(|e| (true, e)),
            e = files.recv() => e.map(|e| (false, e)),
            _ = sleep(idle) => {
                // Only Protomux messages count: keepalives never reach the application.
                pay.close();
                files.close();
                return Ok(());
            }
        };
        let Some((is_pay, event)) = event else {
            return Ok(());
        };
        let ChannelEvent::Message { message_type, data } = event else {
            continue;
        };
        if is_pay {
            let m: Value = serde_json::from_slice(&data)?;
            let reply = match m["t"].as_str() {
                Some("hello") => json!({ "t": "quote", "price_per_chunk": 1,
                    "mints": ["https://mint.example"], "window": 8, "served": 0,
                    "accepted_upto": 0, "spent_total": 0 }),
                Some("pay") => json!({ "t": "ack", "accepted_upto": m["upto_chunk"],
                    "spent_total": m["upto_chunk"] }),
                _ => continue,
            };
            pay.send(MSG, reply.to_string().as_bytes())?;
        } else if message_type == GET {
            if data.len() != 36 {
                files.close();
                return Ok(());
            }
            let req = req_of(&data).expect("36 bytes");
            if hex::encode(&data[4..]) != sha {
                files.send(MISSING, &u32le(req))?;
                continue;
            }
            // Every frame is queued at once: peeroxide's Protomux has no drain signal.
            for chunk in buf.chunks(FRAME) {
                files.send(DATA, &[u32le(req).as_slice(), chunk].concat())?;
            }
            files.send(END, &u32le(req))?;
        }
    }
}

// ---- fetch -----------------------------------------------------------------------------

async fn fetch(o: Opts) -> Result<Value> {
    let kp = key_pair(get(&o, "seed")?);
    let peer = key32(get(&o, "peer")?)?;
    let rt = UdxRuntime::new()?;
    let (_task, dht, _server_rx) = hyperdht::spawn(&rt, dht_config(&o)?).await?;
    dht.bootstrapped().await?;

    let started = Instant::now();
    let conn = timeout(Duration::from_secs(60), dht.connect(&kp, peer, &rt)).await;
    let expect_refused = o.contains_key("expect-refused");
    let conn = match conn {
        Err(_) => return Ok(json!({ "ok": false, "error": "connect timed out after 60 s" })),
        Ok(Err(e)) if expect_refused => {
            return Ok(json!({ "ok": true, "refused": "handshake", "error": e.to_string() }));
        }
        Ok(Err(e)) => return Ok(json!({ "ok": false, "error": e.to_string() })),
        Ok(Ok(conn)) => conn,
    };
    let mut result = json!({
        "connect_ms": started.elapsed().as_millis() as u64,
        "remote_key_ok": conn.remote_public_key == peer,
        "remote_host": conn.remote_addr.map(|a| a.ip().to_string()),
    });
    let (mux, run) = Mux::new(conn.stream);
    tokio::spawn(run);
    let (mut pay, mut files) = channels(&mux).await?;

    if expect_refused {
        // A peer without a firewall callback refuses by dropping the connection after the
        // handshake; tell that apart from a server that kept it.
        // A server that kept the connection pairs the channel; one that dropped it never does.
        let opened = matches!(
            timeout(Duration::from_secs(5), pay.wait_opened()).await,
            Ok(Ok(_))
        );
        return Ok(merge(
            result,
            json!({ "ok": !opened,
            "refused": if opened { "no" } else { "after-handshake" } }),
        ));
    }

    if let Some(idle_ms) = o.get("idle-ms") {
        let idle = Duration::from_millis(idle_ms.parse()?);
        let expect_closed = o.contains_key("expect-closed");
        // peeroxide has no keepalive setting: --keepalive-ms is not applied.
        let closed = timeout(idle, async {
            loop {
                match pay.recv().await {
                    None | Some(ChannelEvent::Closed { .. }) => break true,
                    Some(_) => {}
                }
            }
        })
        .await
        .unwrap_or(false);
        return Ok(merge(
            result,
            json!({
                "ok": if expect_closed { closed } else { !closed },
                "keepalive_applied": false,
                "closed_during_idle": closed,
            }),
        ));
    }

    let bytes = num(&o, "bytes")?;
    let sha = get(&o, "sha")?.to_owned();
    pay.send(
        MSG,
        json!({ "t": "hello", "video": video(),
        "session": "0123456789abcdef0123456789abcdef" })
        .to_string()
        .as_bytes(),
    )?;
    wait_for(&mut pay, |t, _| t == "quote").await?;

    let t0 = Instant::now();
    files.send(GET, &[u32le(1).as_slice(), &hex::decode(&sha)?].concat())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut pay_sent: Option<Instant> = None;
    let mut pay_rtt_ms: Option<u64> = None;
    let mut transfer_ms: Option<u64> = None;
    let mut missing_ok = false;
    let send_pay = sleep(Duration::from_millis(50));
    tokio::pin!(send_pay);
    let mut pay_scheduled = true;
    let deadline = sleep(Duration::from_secs(120));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut send_pay, if pay_scheduled => {
                pay_scheduled = false;
                pay_sent = Some(Instant::now());
                pay.send(MSG, json!({ "t": "pay", "upto_chunk": 1, "token": "cashuBspike" })
                    .to_string().as_bytes())?;
            }
            e = pay.recv() => match e {
                Some(ChannelEvent::Message { data, .. }) => {
                    let m: Value = serde_json::from_slice(&data)?;
                    if m["t"] == "ack" {
                        pay_rtt_ms = pay_sent.map(|t| t.elapsed().as_millis() as u64);
                    }
                }
                Some(_) => {}
                None => bail!("pay channel closed"),
            },
            e = files.recv() => match e {
                Some(ChannelEvent::Message { message_type: DATA, data }) if req_of(&data) == Some(1) => {
                    received += (data.len() - 4) as u64;
                    if received > bytes {
                        return Ok(merge(result, json!({ "ok": false, "error": "more bytes than the size" })));
                    }
                    hasher.update(&data[4..]);
                }
                Some(ChannelEvent::Message { message_type: END, data }) if req_of(&data) == Some(1) => {
                    transfer_ms = Some(t0.elapsed().as_millis() as u64);
                    files.send(GET, &[u32le(2).as_slice(), &[0xab; 32]].concat())?;
                }
                Some(ChannelEvent::Message { message_type: MISSING, data }) if req_of(&data) == Some(2) => {
                    missing_ok = true;
                }
                Some(_) => {}
                None => bail!("files channel closed"),
            },
            _ = &mut deadline => break,
            _ = sleep(Duration::from_secs(1)) => {}
        }
        // Done once the file and the missing reply are in, and the pay/1 ack too (or 10 s
        // after the pay was sent, recorded as no round trip).
        let pay_settled =
            pay_rtt_ms.is_some() || pay_sent.is_some_and(|t| t.elapsed() > Duration::from_secs(10));
        if transfer_ms.is_some() && missing_ok && pay_settled {
            break;
        }
    }
    let ms = transfer_ms.unwrap_or(0).max(1);
    let sha_ok = hex::encode(hasher.finalize()) == sha;
    let key_ok = result["remote_key_ok"] == true;
    Ok(merge(
        result,
        json!({
            "ok": sha_ok && received == bytes && missing_ok && key_ok && transfer_ms.is_some(),
            "bytes": received,
            "sha_ok": sha_ok,
            "missing_ok": missing_ok,
            "ms": ms,
            "mbit_s": ((received as f64 * 8.0 / 1e6) / (ms as f64 / 1000.0) * 10.0).round() / 10.0,
            "pay_rtt_ms": pay_rtt_ms,
        }),
    ))
}

async fn wait_for(ch: &mut Channel, want: impl Fn(&str, &Value) -> bool) -> Result<Value> {
    let found = timeout(Duration::from_secs(30), async {
        while let Some(e) = ch.recv().await {
            if let ChannelEvent::Message { data, .. } = e {
                let m: Value = serde_json::from_slice(&data)?;
                if want(m["t"].as_str().unwrap_or(""), &m) {
                    return Ok(m);
                }
            }
        }
        bail!("channel closed")
    })
    .await;
    found.map_err(|_| anyhow!("no answer in 30 s"))?
}

fn merge(mut a: Value, b: Value) -> Value {
    if let (Some(a), Value::Object(b)) = (a.as_object_mut(), b) {
        a.extend(b);
    }
    a
}

#[tokio::main]
async fn main() {
    let (role, o) = match parse_args() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("{e:#}");
            std::process::exit(2);
        }
    };
    let result = match role.as_str() {
        "serve" => serve(o).await.map(|()| None),
        "fetch" => fetch(o).await.map(Some),
        other => Err(anyhow!("unknown role {other}")),
    };
    match result {
        Ok(None) => {}
        Ok(Some(v)) => {
            let ok = v["ok"] == true;
            out(merge(json!({ "role": "fetch", "impl": "rust" }), v));
            std::process::exit(if ok { 0 } else { 1 });
        }
        Err(e) => {
            out(json!({ "role": role, "impl": "rust", "ok": false, "error": format!("{e:#}") }));
            std::process::exit(1);
        }
    }
}
