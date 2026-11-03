//! A counting HTTP front for the in-process CDK mint.
//!
//! `cashu_service::simulation::LocalMint::start` serves a real CDK 0.18 mint (SQLite, simulated
//! Lightning) on loopback, but offers no hook to count requests. The spike therefore serves the
//! *same* `Arc<cdk::mint::Mint>` a second time, through `cdk_axum::create_mint_router` wrapped in
//! the middleware below, and points every wallet, channel and seeder at this second URL. The mint
//! logic, keys and database are the LocalMint's; only the HTTP listener differs.
//!
//! Every request is counted by route. `POST /v1/swap` bodies are parsed so that each swap's input
//! count, input and output totals and the number of signatures on its first input are recorded.
//! A swap's fee is `inputs − outputs`, which the mint enforces (NUT-02), so fee numbers in the
//! report are the mint's own, not a model.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Result;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct SwapRecord {
    pub inputs: usize,
    pub outputs: usize,
    pub in_sat: u64,
    pub out_sat: u64,
    pub status: u16,
    /// Signatures in the first input's witness: 2 for a Spilman SIG_ALL 2-of-2 close.
    pub first_input_sigs: usize,
    pub server_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub calls: BTreeMap<String, u64>,
    pub swaps: Vec<SwapRecord>,
    pub req_bytes: u64,
    pub resp_bytes: u64,
    /// Time the mint spent answering (handler time, measured in the middleware).
    pub server_ms: f64,
}

impl Snapshot {
    pub fn total(&self) -> u64 {
        self.calls.values().sum()
    }

    /// Fees the mint kept on successful swaps (inputs minus outputs).
    pub fn fees(&self) -> u64 {
        self.swaps
            .iter()
            .filter(|s| s.status == 200)
            .map(|s| s.in_sat.saturating_sub(s.out_sat))
            .sum()
    }

    pub fn ok_swaps(&self) -> usize {
        self.swaps.iter().filter(|s| s.status == 200).count()
    }

    pub fn delta(&self, before: &Snapshot) -> Snapshot {
        let mut calls = BTreeMap::new();
        for (route, n) in &self.calls {
            let d = n - before.calls.get(route).copied().unwrap_or(0);
            if d > 0 {
                calls.insert(route.clone(), d);
            }
        }
        Snapshot {
            calls,
            swaps: self.swaps[before.swaps.len()..].to_vec(),
            req_bytes: self.req_bytes - before.req_bytes,
            resp_bytes: self.resp_bytes - before.resp_bytes,
            server_ms: self.server_ms - before.server_ms,
        }
    }

    /// "5 (POST /v1/swap ×2, GET /v1/keysets ×1, …)"
    pub fn describe(&self) -> String {
        if self.calls.is_empty() {
            return "0".to_string();
        }
        let parts: Vec<String> = self
            .calls
            .iter()
            .map(|(route, n)| format!("`{route}` ×{n}"))
            .collect();
        format!("{} ({})", self.total(), parts.join(", "))
    }
}

#[derive(Debug, Default)]
pub struct Meter {
    state: Mutex<Snapshot>,
}

impl Meter {
    pub fn snapshot(&self) -> Snapshot {
        self.state.lock().expect("meter lock").clone()
    }
}

const KNOWN_SEGMENTS: &[&str] = &[
    "v1", "keys", "keysets", "swap", "mint", "melt", "quote", "bolt11", "bolt12", "info",
    "restore", "checkstate", "ws",
];

fn route_key(method: &str, path: &str) -> String {
    let normalized: Vec<&str> = path
        .split('/')
        .map(|segment| {
            if segment.is_empty() || KNOWN_SEGMENTS.contains(&segment) {
                segment
            } else {
                "{id}"
            }
        })
        .collect();
    format!("{method} {}", normalized.join("/"))
}

fn parse_swap(body: &[u8]) -> Option<SwapRecord> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let inputs = value.get("inputs")?.as_array()?;
    let outputs = value.get("outputs")?.as_array()?;
    let amount = |v: &Value| v.get("amount").and_then(Value::as_u64).unwrap_or(0);
    let first_input_sigs = inputs
        .first()
        .and_then(|input| input.get("witness"))
        .and_then(|witness| match witness {
            Value::String(s) => serde_json::from_str::<Value>(s).ok(),
            other => Some(other.clone()),
        })
        .and_then(|w| w.get("signatures").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0);
    Some(SwapRecord {
        inputs: inputs.len(),
        outputs: outputs.len(),
        in_sat: inputs.iter().map(amount).sum(),
        out_sat: outputs.iter().map(amount).sum(),
        status: 0,
        first_input_sigs,
        server_ms: 0.0,
    })
}

async fn meter_mw(State(meter): State<Arc<Meter>>, req: Request, next: Next) -> Response {
    let key = route_key(req.method().as_str(), req.uri().path());
    if req.uri().path().starts_with("/v1/ws") {
        // Websocket upgrades cannot be buffered; count and pass through.
        *meter
            .state
            .lock()
            .expect("meter lock")
            .calls
            .entry(key)
            .or_default() += 1;
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 64 << 20).await.unwrap_or_default();
    let swap = if key == "POST /v1/swap" {
        parse_swap(&bytes)
    } else {
        None
    };
    let started = Instant::now();
    let response = next
        .run(Request::from_parts(parts, Body::from(bytes.clone())))
        .await;
    let server_ms = started.elapsed().as_secs_f64() * 1e3;
    let status = response.status().as_u16();
    let (rparts, rbody) = response.into_parts();
    let rbytes = axum::body::to_bytes(rbody, 64 << 20).await.unwrap_or_default();
    {
        let mut state = meter.state.lock().expect("meter lock");
        *state.calls.entry(key).or_default() += 1;
        state.req_bytes += bytes.len() as u64;
        state.resp_bytes += rbytes.len() as u64;
        state.server_ms += server_ms;
        if let Some(mut record) = swap {
            record.status = status;
            record.server_ms = server_ms;
            state.swaps.push(record);
        }
    }
    Response::from_parts(rparts, Body::from(rbytes))
}

/// Serve `mint` on a fresh loopback port behind the counting middleware. Returns the URL.
pub async fn serve_front(mint: Arc<cdk::mint::Mint>, meter: Arc<Meter>) -> Result<String> {
    let router = cdk_axum::create_mint_router(mint, vec!["bolt11".to_string()])
        .await?
        .layer(axum::middleware::from_fn_with_state(meter, meter_mw));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(url)
}
