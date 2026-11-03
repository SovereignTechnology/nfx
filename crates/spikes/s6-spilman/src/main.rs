//! Spike S6 (ADR 0104 §5): would Cashu Spilman payment channels make a good second NFX pay rail
//! (NFX-15) next to NFX-07's per-payment bearer tokens?
//!
//! `cargo run --release` runs everything and prints a markdown report on stdout (progress goes to
//! stderr). The whole scenario runs twice: against the mint's default keyset (`input_fee_ppk` 0)
//! and after rotating to a keyset charging 100 ppk, so that fees are real and not all zero.
//!
//! **Which mint each step uses.** Every step talks to `cashu_service::simulation::LocalMint`: a
//! genuine CDK 0.18 mint (SQLite storage, NUT-03 swaps, NUT-09 restore, NUT-11 P2PK with SIG_ALL and
//! locktime, NUT-12 DLEQ) on loopback HTTP, with only Lightning simulated. The spike reaches it
//! through a second HTTP front on the same `Arc<Mint>` that counts requests (`meter.rs`). The fake
//! signing mint of `cashu-service/tests/spilman_channel_capacity.rs` is not used by any step.
//!
//! The money code is nostr-vpn's, called the way its buyer and seller call it:
//! - watcher (buyer): `CashuWalletService::open_streaming_route_cashu_spilman_channel`,
//!   `FileSpilmanPaymentSigner::create_streaming_route_payment`,
//!   `restore_streaming_route_cashu_spilman_refund_with_wallet`;
//! - seeder (seller): `FileSpilmanPaymentReceiver` (`process_streaming_route_cashu_payment_with_receiver`,
//!   `close_cashu_spilman_channel`), then `import_payment_proofs`.
//!
//! The NFX-07 baseline uses plain CDK 0.18 wallets, because cashu-service's `send_payment_token`
//! adds the receiver's input fee to the token (`include_fee: true`), while NFX-07 §2 requires the
//! face value to equal `chunks × price` and makes fees the seeder's.
//!
//! Spike code: no secret here is real. Keys and seeds are generated per run in a temp dir and
//! never printed.

mod meter;

use std::cell::Cell;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::Engine as _;
use cashu::nuts::nut00::KnownMethod;
use cashu::nuts::nut02::KeySetVersion;
use cashu::nuts::{
    BlindedMessage, CurrencyUnit, Id, Keys, KeysResponse, KeysetResponse, PaymentMethod, Proof,
    SecretKey, SwapRequest, Token,
};
use cashu::Amount;
use cashu_service::simulation::{IssuerMode, LocalMint, PaymentNetwork, VirtualClock};
use cashu_service::{
    fetch_spilman_keyset_info_json_with_client, load_or_create_cashu_spilman_sender_key,
    process_streaming_route_cashu_payment_with_receiver,
    restore_streaming_route_cashu_spilman_refund_with_wallet, spilman_client_store_path,
    CashuSpilmanPaymentReceiver as _, CashuWalletService, FileSpilmanClientStorage,
    FileSpilmanPaymentReceiver, FileSpilmanPaymentReceiverConfig, FileSpilmanPaymentSigner,
    SharedSpilmanClientStoreLock, StreamingRouteBalanceUpdate, StreamingRouteCashuPaymentKind,
    StreamingRouteCashuPaymentRequest, StreamingRouteChannelOpen,
    StreamingRouteOpenCashuSpilmanChannelFromWalletRequest, StreamingRoutePaymentEnvelope,
    StreamingRoutePaymentPayload,
};
use cdk::amount::SplitTarget;
use cdk::wallet::{ReceiveOptions, SendOptions, Wallet};
use cdk_spilman::{
    ChannelParameters, ClientChannelFunding, ClientStorage as _, EstablishedChannel,
    SpilmanChannelSender,
};
use meter::{Meter, Snapshot};
use serde_json::{json, Value};

/// Files streamed per rail (task: N = 500).
const FILES: u64 = 500;
/// NFX-07 `price_per_chunk`, sat.
const PRICE: u64 = 1;
/// NFX-07 `window`.
const WINDOW: u64 = 8;
/// The watcher pays once half the window is unpaid, rounded up (NFX-07 §2, §3a): ⌈8/2⌉ = 4.
const PAY_EVERY: u64 = WINDOW.div_ceil(2);
const WATCHER_MINT_SAT: u64 = 2000;
const BEARER_WALLET_SAT: u64 = 600;
const CAPACITY_A: u64 = 600;
const CAPACITY_B: u64 = 50;
/// Channel B's lifetime. The mint checks NUT-11 locktime against its wall clock, so the spike
/// waits it out (cashu 0.18 `nuts/nut11/mod.rs:291`, `util/mod.rs:20-25`).
const EXPIRY_B_SECS: u64 = 20;

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970")
        .as_secs()
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

fn us(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e6
}

fn pctl(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("no NaN"));
    let rank = ((p / 100.0) * sorted.len() as f64).ceil().max(1.0) as usize;
    sorted[rank.min(sorted.len()) - 1]
}

fn sum(values: &[f64]) -> f64 {
    values.iter().sum()
}

fn e<E: std::fmt::Display>(error: E) -> anyhow::Error {
    anyhow!("{error}")
}

/// Rebuild a channel from the watcher's stored funding (used for the crypto-only timings and the
/// early-refund control). The channel secret is never printed.
fn established(funding: &ClientChannelFunding) -> Result<EstablishedChannel> {
    let keyset = cdk_spilman::parse_keyset_info_from_json(&funding.keyset_info_json).map_err(e)?;
    let secret: [u8; 32] = hex::decode(&funding.channel_secret_hex)?
        .try_into()
        .map_err(|_| anyhow!("channel secret length"))?;
    let params =
        ChannelParameters::from_json_with_channel_secret(&funding.params_json, keyset, secret)?;
    let proofs: Vec<Proof> = serde_json::from_str(&funding.funding_proofs_json)?;
    EstablishedChannel::new(params, proofs)
}

fn stored_funding(watcher_dir: &Path, channel_id: &str) -> Result<ClientChannelFunding> {
    let (storage, _errors) =
        FileSpilmanClientStorage::load(spilman_client_store_path(watcher_dir)).map_err(e)?;
    storage
        .get_funding(channel_id)
        .cloned()
        .context("channel funding missing from the watcher's store")
}

/// Fresh plain blinded outputs worth `amount` on `keyset_json`, as (outputs, secrets JSON).
fn plain_outputs(amount: u64, keyset_json: &str) -> Result<(Vec<BlindedMessage>, String)> {
    let made: Value =
        serde_json::from_str(&cdk_spilman::create_plain_blinded_messages(amount, keyset_json).map_err(e)?)?;
    let outputs: Vec<BlindedMessage> = serde_json::from_value(made["blinded_messages"].clone())?;
    Ok((outputs, made["secrets_with_blinding"].to_string()))
}

/// The stage-2 swap: spend channel close proofs (P2PK-locked to a party's stage-2 key, witness
/// attached by the library) into plain proofs. nostr-vpn imports the witnessed proofs and spends
/// them later; the spike swaps them at once to prove the mint accepts them. Returns
/// (plain proofs JSON, fee, net).
async fn stage2_sweep(
    http: &reqwest::Client,
    mint_url: &str,
    keyset_json: &str,
    proofs_json: &str,
) -> Result<(String, u64, u64)> {
    let proofs: Vec<Proof> = serde_json::from_str(proofs_json)?;
    if proofs.is_empty() {
        return Ok(("[]".to_string(), 0, 0));
    }
    let keyset = cdk_spilman::parse_keyset_info_from_json(keyset_json).map_err(e)?;
    let gross: u64 = proofs.iter().map(|p| u64::from(p.amount)).sum();
    let fee = (keyset.input_fee_ppk * proofs.len() as u64).div_ceil(1000);
    let net = gross.checked_sub(fee).context("proofs do not cover the swap fee")?;
    let (outputs, secrets) = plain_outputs(net, keyset_json)?;
    let request = SwapRequest::new(proofs, outputs);
    let response = http
        .post(format!("{mint_url}/v1/swap"))
        .json(&request)
        .send()
        .await?;
    let status = response.status();
    let body: Value = response.json().await?;
    ensure!(status.is_success(), "stage-2 swap refused: {status} {body}");
    let plain =
        cdk_spilman::construct_proofs(&body["signatures"].to_string(), &secrets, keyset_json)
            .map_err(e)?;
    Ok((plain, fee, net))
}

/// A plain CDK 0.18 wallet on its own SQLite file, client-side rate limiting off (see report).
async fn cdk_wallet(path: &Path, mint_url: &str) -> Result<Wallet> {
    let db = cdk_sqlite::WalletSqliteDatabase::new(path.to_path_buf()).await?;
    let mut seed = [0u8; 64];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut seed);
    let wallet = Wallet::new(mint_url, CurrencyUnit::Sat, Arc::new(db), seed, None)?;
    wallet.disable_rate_limiting();
    Ok(wallet)
}

#[derive(Debug, Default)]
struct Pass {
    fee_ppk: u64,
    // channel A
    fund_a: Snapshot,
    fund_a_ms: f64,
    open_msg_bytes: usize,
    open_verify_ms: f64,
    sign_us: Vec<f64>,
    verify_us: Vec<f64>,
    sign_core_us: Vec<f64>,
    verify_core_us: Vec<f64>,
    upd_payment_bytes: u64,
    upd_ndjson_bytes: u64,
    stream_calls: u64,
    close: Snapshot,
    close_ms: f64,
    receiver_net: u64,
    receiver_sweep: Snapshot,
    change: Snapshot,
    change_net: u64,
    // channel B
    refund_b: Snapshot,
    // bearer
    bearer_watcher: Snapshot,
    bearer_seeder: Snapshot,
    bearer_setup: Snapshot,
    send_us: Vec<f64>,
    check_us: Vec<f64>,
    swap_us: Vec<f64>,
    pay_line_bytes: u64,
    ack_line_bytes: u64,
    seeder_net: u64,
}

impl Pass {
    /// Mint calls one channel costs from funding to the watcher's change back (step 2 + 4),
    /// without the seeder's deferred stage-2 swap (that one merges into its next spend).
    fn channel_calls(&self) -> u64 {
        self.fund_a.total() + self.close.total() + self.change.total()
    }
    /// Same, if the seeder handed the watcher its change proofs instead of NUT-09 probing.
    fn channel_calls_without_probing(&self) -> u64 {
        self.fund_a.total() + self.close.total() + self.change.ok_swaps() as u64
    }
    /// Every fee one channel costs: funding, close, both stage-2 swaps.
    fn channel_fees(&self) -> u64 {
        self.fund_a.fees() + self.close.fees() + self.change.fees() + self.receiver_sweep.fees()
    }
    fn bearer_calls(&self) -> u64 {
        self.bearer_watcher.total() + self.bearer_seeder.total()
    }
    fn bearer_fees(&self) -> u64 {
        self.bearer_watcher.fees() + self.bearer_seeder.fees()
    }
}

/// Smallest file count at which `ceil(n / PAY_EVERY)` bearer payments cost at least `fixed`.
fn break_even(fixed: f64, per_pay: f64) -> Option<u64> {
    if per_pay <= 0.0 {
        return None;
    }
    (1..=100_000u64).find(|n| n.div_ceil(PAY_EVERY) as f64 * per_pay >= fixed)
}

async fn run_pass(fee_ppk: u64, out: &mut String) -> Result<Pass> {
    let mut pass = Pass {
        fee_ppk,
        ..Default::default()
    };
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    let watcher_dir = root.join("watcher");
    let seller_dir = root.join("seeder");
    let ctx = "{}".to_string();

    // ---- The mint: LocalMint (real CDK, fake Lightning), plus the counting front ----------------
    let clock = Arc::new(VirtualClock::new(unix_now()));
    let network = PaymentNetwork::new(600 + fee_ppk, 0, clock.clone());
    let lightning = network.orchestrator_funding();
    let local = LocalMint::start(
        root,
        network.clone(),
        format!("s6-ppk{fee_ppk}"),
        IssuerMode::Withdrawable,
    )
    .await?;
    let mint = local.mint().clone();
    let default_keyset = local.active_sat_keyset().context("LocalMint has no sat keyset")?;
    let mut amounts: Vec<u64> = mint
        .keyset(&default_keyset)
        .context("default keyset")?
        .keys
        .iter()
        .map(|(amount, _)| u64::from(*amount))
        .collect();
    amounts.sort_unstable();
    if fee_ppk > 0 {
        let v2 = matches!(default_keyset.get_version(), KeySetVersion::Version01);
        mint.rotate_keyset(CurrencyUnit::Sat, amounts.clone(), fee_ppk, v2, None)
            .await?;
    }
    let meter = Arc::new(Meter::default());
    let mint_url = meter::serve_front(mint.clone(), meter.clone()).await?;
    let http = reqwest::Client::new();
    let keyset_json =
        fetch_spilman_keyset_info_json_with_client(&http, &mint_url, "sat", None).await?;
    let keyset = cdk_spilman::parse_keyset_info_from_json(&keyset_json).map_err(e)?;
    ensure!(keyset.input_fee_ppk == fee_ppk, "active keyset has the wrong fee");

    writeln!(out, "\n## Pass: `input_fee_ppk` = {fee_ppk}\n")?;
    writeln!(
        out,
        "Mint: `LocalMint` (CDK 0.18.0, SQLite, simulated Lightning) behind the counting front. \
         Active sat keyset `{}`, {} denominations ({}..{}), input fee {fee_ppk} ppk{}.\n",
        keyset.keyset_id,
        amounts.len(),
        amounts.first().unwrap_or(&0),
        amounts.last().unwrap_or(&0),
        if fee_ppk > 0 {
            " (rotated in with `Mint::rotate_keyset` before any wallet existed)"
        } else {
            " (the LocalMint default)"
        }
    )?;
    let base = meter.snapshot();

    // ---- Step 1: mint 2000 sat into the watcher's wallet (real mint) ----------------------------
    eprintln!("[ppk {fee_ppk}] step 1: fund watcher");
    let s = meter.snapshot();
    let t = Instant::now();
    let watcher = CashuWalletService::open_file_backed(&watcher_dir).await?;
    let quote = watcher.create_topup_quote(&mint_url, WATCHER_MINT_SAT).await?;
    lightning.settle_external(&quote.payment_request).map_err(e)?;
    let overview = watcher.load_wallet_overview(true).await?;
    ensure!(overview.warnings.is_empty(), "funding warnings: {:?}", overview.warnings);
    let balance = watcher.load_mint_balance(&mint_url).await?.balance_sat;
    ensure!(balance == WATCHER_MINT_SAT, "watcher holds {balance}, expected {WATCHER_MINT_SAT}");
    let step1 = meter.snapshot().delta(&s);
    writeln!(out, "### 1. Watcher funding (real mint)\n")?;
    writeln!(
        out,
        "- Minted {WATCHER_MINT_SAT} sat via a bolt11 quote paid on the simulated network, in {:.0} ms.\n- Mint calls: {}.\n",
        ms(t),
        step1.describe()
    )?;

    // ---- Step 2: channel A, capacity 600, expiry now + 3 h (real mint) --------------------------
    eprintln!("[ppk {fee_ppk}] step 2: channel A");
    let s = meter.snapshot();
    let receiver = FileSpilmanPaymentReceiver::load_with_keyset_refresh(
        &seller_dir,
        FileSpilmanPaymentReceiverConfig::new([mint_url.clone()]),
    )
    .await
    .map_err(e)?;
    let seeder_setup = meter.snapshot().delta(&s);

    let expiry_a = unix_now() + 3 * 3600;
    let s = meter.snapshot();
    let t = Instant::now();
    let opened = watcher
        .open_streaming_route_cashu_spilman_channel(StreamingRouteOpenCashuSpilmanChannelFromWalletRequest {
            mint_url: mint_url.clone(),
            receiver_pubkey_hex: receiver.receiver_pubkey_hex().to_string(),
            capacity_sat: CAPACITY_A,
            expiry_unix: expiry_a,
            max_amount_per_output: 0,
            unit: "sat".into(),
            opening_paid_msat: 0,
            keyset_id: None,
            keyset_info_json: None,
            client_request_id: Some("s6-channel-a".into()),
            route_created_at_unix: Some(unix_now()),
        })
        .await?;
    pass.fund_a_ms = ms(t);
    pass.fund_a = meter.snapshot().delta(&s);
    let chan_a = opened.channel.channel_id.clone();
    let funding_proofs = opened
        .channel
        .payment
        .funding_proofs
        .as_ref()
        .and_then(Value::as_array)
        .map_or(0, Vec::len);

    // The first message on the wire carries the parameters and the funding proofs.
    let open_envelope = StreamingRoutePaymentEnvelope::new(
        "nfx-s6",
        &chan_a,
        "watcher",
        "seeder",
        unix_now(),
        StreamingRoutePaymentPayload::ChannelOpen(StreamingRouteChannelOpen {
            mint_url: mint_url.clone(),
            unit: "sat".into(),
            capacity: opened.channel.capacity,
            expires_unix: expiry_a,
            receiver_pubkey_hex: opened.channel.receiver_pubkey_hex.clone(),
            paid_msat: 0,
            payment: opened.channel.payment.clone(),
        }),
    );
    pass.open_msg_bytes = serde_json::to_vec(&open_envelope)?.len();
    let open_payment_bytes = serde_json::to_vec(&opened.channel.payment)?.len();

    // The seeder checks keyset, DLEQ, total and terms offline, and registers the channel.
    let s = meter.snapshot();
    let t = Instant::now();
    let received_open: StreamingRoutePaymentEnvelope =
        serde_json::from_slice(&serde_json::to_vec(&open_envelope)?)?;
    let StreamingRoutePaymentPayload::ChannelOpen(open) = received_open.payload else {
        bail!("not a channel open");
    };
    process_streaming_route_cashu_payment_with_receiver(
        &receiver, &open.payment, &chan_a, "sat", 0, CAPACITY_A, true, &ctx,
    )
    .map_err(e)?;
    pass.open_verify_ms = ms(t);
    ensure!(meter.snapshot().delta(&s).total() == 0, "funding check contacted the mint");

    writeln!(out, "### 2. Channel A: fund (real mint)\n")?;
    writeln!(
        out,
        "- Seeder start (`FileSpilmanPaymentReceiver::load_with_keyset_refresh`): mint calls {}.",
        seeder_setup.describe()
    )?;
    writeln!(
        out,
        "- `open_streaming_route_cashu_spilman_channel`, capacity {CAPACITY_A} sat, expiry now + 3 h: \
         **{:.0} ms**, mint calls **{}**; mint-side handling {:.0} ms.",
        pass.fund_a_ms,
        pass.fund_a.describe(),
        pass.fund_a.server_ms
    )?;
    writeln!(
        out,
        "- Funding token {} sat (wallet send fee {} sat), channel capacity {} sat, {} funding proofs; \
         swap fees kept by the mint in this step: {} sat.",
        opened.channel.funding_token_amount,
        opened.wallet_send.send_fee_sat,
        opened.channel.capacity,
        funding_proofs,
        pass.fund_a.fees()
    )?;
    writeln!(
        out,
        "- Opening message (params + funding proofs): payment JSON {open_payment_bytes} B; in nostr-vpn's \
         envelope {} B. The seeder's offline funding check took {:.1} ms with 0 mint calls.\n",
        pass.open_msg_bytes, pass.open_verify_ms
    )?;

    // ---- Step 3: 500 per-file updates, signed and verified offline (no mint) --------------------
    eprintln!("[ppk {fee_ppk}] step 3: stream {FILES} updates");
    let signer = FileSpilmanPaymentSigner::load(&watcher_dir).map_err(e)?;
    let s = meter.snapshot();
    let mut upd_b64_bytes = 0u64;
    let mut upd_env_bytes = 0u64;
    let mut early_payment = None;
    let mut last_payment = None;
    let mut first_sizes = (0usize, 0usize, 0usize);
    let mut last_sizes = (0usize, 0usize, 0usize);
    for file in 1..=FILES {
        let paid_msat = file * PRICE * 1000;
        let t = Instant::now();
        let signed = signer
            .create_streaming_route_payment(StreamingRouteCashuPaymentRequest {
                kind: StreamingRouteCashuPaymentKind::BalanceUpdate,
                channel_id: chan_a.clone(),
                unit: "sat".into(),
                paid_msat,
                previous_paid_msat: paid_msat - PRICE * 1000,
                capacity_sat: CAPACITY_A,
            })
            .map_err(e)?;
        pass.sign_us.push(us(t));

        let payment_json = serde_json::to_vec(&signed.payment)?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&payment_json);
        let envelope = StreamingRoutePaymentEnvelope::new(
            "nfx-s6",
            &chan_a,
            "watcher",
            "seeder",
            unix_now(),
            StreamingRoutePaymentPayload::BalanceUpdate(StreamingRouteBalanceUpdate {
                delivered_units: file,
                amount_due_msat: paid_msat,
                paid_msat,
                payment: signed.payment.clone(),
            }),
        );
        let envelope_json = serde_json::to_vec(&envelope)?;
        // A modelled NFX-15 NDJSON line: the channel is implied by the session.
        let ndjson = format!(
            "{}\n",
            json!({"t": "bal", "balance": signed.payment.balance, "sig": signed.payment.signature})
        );
        pass.upd_payment_bytes += payment_json.len() as u64;
        upd_b64_bytes += b64.len() as u64;
        upd_env_bytes += envelope_json.len() as u64;
        pass.upd_ndjson_bytes += ndjson.len() as u64;
        let sizes = (payment_json.len(), b64.len(), envelope_json.len());
        if file == 1 {
            first_sizes = sizes;
        }
        if file == 10 {
            early_payment = Some(signed.payment.clone());
        }
        last_sizes = sizes;
        last_payment = Some(signed.payment.clone());

        // Seeder: decode what arrived and verify it offline before serving file `file`.
        let t = Instant::now();
        let arrived: StreamingRoutePaymentEnvelope = serde_json::from_slice(&envelope_json)?;
        let StreamingRoutePaymentPayload::BalanceUpdate(update) = arrived.payload else {
            bail!("not a balance update");
        };
        let checked = process_streaming_route_cashu_payment_with_receiver(
            &receiver,
            &update.payment,
            &chan_a,
            "sat",
            update.paid_msat,
            CAPACITY_A,
            false,
            &ctx,
        )
        .map_err(e)?;
        pass.verify_us.push(us(t));
        ensure!(
            checked.receiver.balance >= file * PRICE,
            "the seeder would refuse file {file}"
        );
    }
    let stream = meter.snapshot().delta(&s);
    pass.stream_calls = stream.total();
    ensure!(pass.stream_calls == 0, "the mint was contacted while streaming: {}", stream.describe());
    drop(signer);

    // Replay control: resend the genuine update for file 10 after file 500, and a forged one
    // (balance 10 with the file-500 signature). Step 4's close at 500 shows what the seeder kept.
    let early_payment = early_payment.context("no early update")?;
    let replayed = process_streaming_route_cashu_payment_with_receiver(
        &receiver, &early_payment, &chan_a, "sat", 10 * PRICE * 1000, CAPACITY_A, false, &ctx,
    );
    let mut forged = last_payment.context("no last update")?;
    forged.balance = 10 * PRICE;
    let forged = receiver.validate_cashu_spilman_payment(&forged, &ctx);
    let replay = format!(
        "the genuine update for file 10, resent after file {FILES}, was {}; an update claiming \
         balance 10 under the file-{FILES} signature was {}. The seeder's store only moves its \
         balance up (`configurable_host/storage.rs:375-389`), and the close below settles at {}.",
        match &replayed {
            Ok(v) => format!("accepted as a no-op (validated balance {})", v.receiver.balance),
            Err(error) => format!("refused (`{}`)", error.chars().take(60).collect::<String>()),
        },
        match &forged {
            Ok(_) => "ACCEPTED (unexpected)".to_string(),
            Err(error) => format!("refused (`{}`)", error.chars().take(60).collect::<String>()),
        },
        FILES * PRICE
    );

    // Crypto only: the same signatures without the durable stores either side.
    let funding_a = stored_funding(&watcher_dir, &chan_a)?;
    let sender_key = load_or_create_cashu_spilman_sender_key(&watcher_dir).map_err(e)?;
    let sender = SpilmanChannelSender::new(
        SecretKey::from_hex(&sender_key.secret_hex)?,
        established(&funding_a)?,
    );
    let verifier = established(&funding_a)?;
    for balance in 1..=FILES {
        let t = Instant::now();
        let (update, _) = sender.create_signed_balance_update(balance * PRICE)?;
        pass.sign_core_us.push(us(t));
        let t = Instant::now();
        update.verify_sender_signature(&verifier)?;
        pass.verify_core_us.push(us(t));
    }

    writeln!(out, "### 3. Stream {FILES} per-file updates, 1 sat each (no mint)\n")?;
    writeln!(
        out,
        "| | median | p95 | total for {FILES} |\n|---|---:|---:|---:|\n\
         | sign, nostr-vpn path (`FileSpilmanPaymentSigner`, durable JSON store write) | {:.0} µs | {:.0} µs | {:.1} ms |\n\
         | verify, nostr-vpn path (decode + `process_streaming_route_cashu_payment_with_receiver`, SQLite write) | {:.0} µs | {:.0} µs | {:.1} ms |\n\
         | sign, crypto only (`SpilmanChannelSender::create_signed_balance_update`) | {:.0} µs | {:.0} µs | {:.1} ms |\n\
         | verify, crypto only (`BalanceUpdateMessage::verify_sender_signature`) | {:.0} µs | {:.0} µs | {:.1} ms |\n",
        pctl(&pass.sign_us, 50.0), pctl(&pass.sign_us, 95.0), sum(&pass.sign_us) / 1e3,
        pctl(&pass.verify_us, 50.0), pctl(&pass.verify_us, 95.0), sum(&pass.verify_us) / 1e3,
        pctl(&pass.sign_core_us, 50.0), pctl(&pass.sign_core_us, 95.0), sum(&pass.sign_core_us) / 1e3,
        pctl(&pass.verify_core_us, 50.0), pctl(&pass.verify_core_us, 95.0), sum(&pass.verify_core_us) / 1e3,
    )?;
    writeln!(
        out,
        "- One update on the wire (file 1 / file {FILES}): payment JSON {} / {} B; base64 (the \
         `X-Cashu-Channel` header form) {} / {} B; nostr-vpn envelope {} / {} B; modelled NFX-15 \
         NDJSON line `{{\"t\":\"bal\",\"balance\":N,\"sig\":…}}` ≈ {} B.",
        first_sizes.0, last_sizes.0, first_sizes.1, last_sizes.1, first_sizes.2, last_sizes.2,
        pass.upd_ndjson_bytes / FILES
    )?;
    writeln!(
        out,
        "- Totals for {FILES} updates: payment JSON {} B, base64 {} B, envelope {} B, NDJSON {} B.",
        pass.upd_payment_bytes, upd_b64_bytes, upd_env_bytes, pass.upd_ndjson_bytes
    )?;
    writeln!(
        out,
        "- **Mint calls while streaming: {}** (counter delta over all {FILES} sign + verify rounds).",
        pass.stream_calls
    )?;
    writeln!(out, "- Replay control: {replay}\n")?;

    // ---- Step 4: the seeder closes A alone at the mint; both sides recover (real mint) ----------
    eprintln!("[ppk {fee_ppk}] step 4: close A");
    let s = meter.snapshot();
    let t = Instant::now();
    let closed = receiver.close_cashu_spilman_channel(&chan_a).await.map_err(e)?;
    pass.close_ms = ms(t);
    pass.close = meter.snapshot().delta(&s);
    let close_swap = pass
        .close
        .swaps
        .iter()
        .find(|swap| swap.status == 200)
        .context("no accepted close swap")?
        .clone();
    ensure!(closed.closed_amount == FILES * PRICE, "closed at {}", closed.closed_amount);

    // Seeder's stage 2: spend the receiver proofs, then import the result (nostr-vpn imports the
    // witnessed proofs and defers this swap to its next spend).
    let s = meter.snapshot();
    let (plain, _fee, net) =
        stage2_sweep(&http, &mint_url, &keyset_json, &closed.receiver_proofs_json).await?;
    pass.receiver_sweep = meter.snapshot().delta(&s);
    pass.receiver_net = net;
    let seeder_wallet = CashuWalletService::open_file_backed(&seller_dir).await?;
    seeder_wallet.import_payment_proofs(&mint_url, "sat", &plain).await?;

    // Watcher's change: nostr-vpn's refund worker (NUT-09 restore of the sender outputs, sign for
    // stage 2), with the import step doing the stage-2 swap first.
    let s = meter.snapshot();
    let t = Instant::now();
    let lock = SharedSpilmanClientStoreLock::acquire(spilman_client_store_path(&watcher_dir))
        .map_err(e)?;
    let mut contacted = false;
    let swept = Cell::new((0u64, 0u64));
    let (http_ref, keyset_ref, watcher_ref, swept_ref) = (&http, &keyset_json, &watcher, &swept);
    let change = restore_streaming_route_cashu_spilman_refund_with_wallet(
        &watcher_dir,
        &chan_a,
        lock,
        &mut contacted,
        move |mint, unit, proofs_json| async move {
            let (plain, fee, net) = stage2_sweep(http_ref, &mint, keyset_ref, &proofs_json).await?;
            swept_ref.set((fee, net));
            Ok::<u64, anyhow::Error>(
                watcher_ref.import_payment_proofs(&mint, &unit, &plain).await?.amount_sat,
            )
        },
    )
    .await?;
    let change_ms = ms(t);
    pass.change = meter.snapshot().delta(&s);
    pass.change_net = swept.get().1;
    ensure!(change.complete, "watcher change recovery incomplete");

    writeln!(out, "### 4. Seeder closes A alone; both sides collect (real mint)\n")?;
    writeln!(
        out,
        "- `close_cashu_spilman_channel` (unilateral, latest balance {}): **{:.0} ms**, mint calls **{}**.",
        closed.closed_amount,
        pass.close_ms,
        pass.close.describe()
    )?;
    writeln!(
        out,
        "- The mint **accepted** the close swap: HTTP {}, {} inputs → {} outputs, first input carried \
         **{} signatures** (watcher + seeder, SIG_ALL); fee {} sat.",
        close_swap.status,
        close_swap.inputs,
        close_swap.outputs,
        close_swap.first_input_sigs,
        close_swap.in_sat - close_swap.out_sat
    )?;
    writeln!(
        out,
        "- Split after stage 1: receiver {} sat, sender {} sat (total {}).",
        closed.receiver_sum, closed.sender_sum, closed.total_value
    )?;
    writeln!(
        out,
        "- Seeder stage 2 (spend its proofs into plain ones): accepted, mint calls {}, fee {} sat → \
         **{} sat net for a balance of {}** (balance minus fees: the stage fees come out of the \
         watcher's funding, so the seeder nets the balance).",
        pass.receiver_sweep.describe(),
        pass.receiver_sweep.fees(),
        pass.receiver_net,
        closed.closed_amount
    )?;
    writeln!(
        out,
        "- Watcher change (`restore_streaming_route_cashu_spilman_refund_with_wallet`): {:.0} ms, \
         mint calls **{}**; recovered {} sat nominal, {} sat after its stage-2 swap (fee {} sat), \
         imported {} sat.\n",
        change_ms,
        pass.change.describe(),
        change.recovered_amount_sat,
        pass.change_net,
        swept.get().0,
        change.imported_amount_sat
    )?;

    // ---- Step 5: channel B, no updates, sender refunds alone after expiry (real mint) -----------
    eprintln!("[ppk {fee_ppk}] step 5: channel B");
    let expiry_b = unix_now() + EXPIRY_B_SECS;
    let s = meter.snapshot();
    let opened_b = watcher
        .open_streaming_route_cashu_spilman_channel(StreamingRouteOpenCashuSpilmanChannelFromWalletRequest {
            mint_url: mint_url.clone(),
            receiver_pubkey_hex: receiver.receiver_pubkey_hex().to_string(),
            capacity_sat: CAPACITY_B,
            expiry_unix: expiry_b,
            max_amount_per_output: 0,
            unit: "sat".into(),
            opening_paid_msat: 0,
            keyset_id: None,
            keyset_info_json: None,
            client_request_id: Some("s6-channel-b".into()),
            route_created_at_unix: Some(unix_now()),
        })
        .await?;
    let fund_b = meter.snapshot().delta(&s);
    let chan_b = opened_b.channel.channel_id.clone();
    process_streaming_route_cashu_payment_with_receiver(
        &receiver,
        &opened_b.channel.payment,
        &chan_b,
        "sat",
        0,
        CAPACITY_B,
        true,
        &ctx,
    )
    .map_err(e)?;

    // Control: before expiry the watcher's refund key alone must not move the funds.
    let funding_b = stored_funding(&watcher_dir, &chan_b)?;
    let channel_b = established(&funding_b)?;
    let gross_b: u64 = channel_b.funding_proofs.iter().map(|p| u64::from(p.amount)).sum();
    let fee_b = (keyset.input_fee_ppk * channel_b.funding_proofs.len() as u64).div_ceil(1000);
    let (outputs, _) = plain_outputs(gross_b - fee_b, &keyset_json)?;
    let mut early = SwapRequest::new(channel_b.funding_proofs.clone(), outputs);
    early.sign_sig_all(
        channel_b
            .params
            .get_sender_blinded_secret_key_for_stage1_refund(&SecretKey::from_hex(
                &sender_key.secret_hex,
            )?)?,
    )?;
    let response = http
        .post(format!("{mint_url}/v1/swap"))
        .json(&early)
        .send()
        .await?;
    let early_status = response.status().as_u16();
    let early_body: Value = response.json().await.unwrap_or(Value::Null);
    ensure!(early_status != 200, "the mint accepted a refund before expiry");
    let early_code = early_body.get("code").cloned().unwrap_or(Value::Null);
    let early_detail = early_body
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>();

    // Wait out the locktime on the wall clock (the mint's clock), then refund alone.
    let t = Instant::now();
    while unix_now() <= expiry_b + 1 {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let waited = t.elapsed().as_secs_f64();
    let s = meter.snapshot();
    let lock = SharedSpilmanClientStoreLock::acquire(spilman_client_store_path(&watcher_dir))
        .map_err(e)?;
    let refund = restore_streaming_route_cashu_spilman_refund_with_wallet(
        &watcher_dir,
        &chan_b,
        lock,
        &mut contacted,
        move |mint, unit, proofs_json| async move {
            Ok::<u64, anyhow::Error>(
                watcher_ref
                    .import_payment_proofs(&mint, &unit, &proofs_json)
                    .await?
                    .amount_sat,
            )
        },
    )
    .await?;
    pass.refund_b = meter.snapshot().delta(&s);
    let refund_swap = pass
        .refund_b
        .swaps
        .iter()
        .find(|swap| swap.status == 200)
        .context("no accepted refund swap")?
        .clone();
    ensure!(refund.complete && refund.imported_amount_sat > 0, "refund failed: {refund:?}");

    writeln!(out, "### 5. Channel B: no updates, the watcher refunds alone after expiry (real mint)\n")?;
    writeln!(
        out,
        "- Funded capacity {CAPACITY_B} sat (token {} sat), expiry now + {EXPIRY_B_SECS} s; mint calls {}.",
        opened_b.channel.funding_token_amount,
        fund_b.describe()
    )?;
    writeln!(
        out,
        "- Control before expiry: a swap of the funding proofs signed by the watcher's refund key \
         alone was **refused** by the mint (HTTP {early_status}, code {early_code}, \"{early_detail}\")."
    )?;
    writeln!(
        out,
        "- Clock: the simulation's `VirtualClock` drives only the fake Lightning network. CDK checks \
         NUT-11 locktime against the mint's wall clock (`cashu-0.18.0/src/nuts/nut11/mod.rs:291` \
         calls `util::unix_time()`, `src/util/mod.rs:20-25`), and cashu-service's refund worker \
         reads `SystemTime::now()` too. So the spike used a {EXPIRY_B_SECS} s expiry and slept \
         {waited:.1} s."
    )?;
    writeln!(
        out,
        "- After expiry: the refund swap was **accepted** (HTTP {}, first input {} signature, \
         {} → {} sat, fee {} sat); recovered {} sat, imported {} sat. Mint calls {}.\n",
        refund_swap.status,
        refund_swap.first_input_sigs,
        refund_swap.in_sat,
        refund_swap.out_sat,
        refund_swap.in_sat - refund_swap.out_sat,
        refund.recovered_amount_sat,
        refund.imported_amount_sat,
        pass.refund_b.describe()
    )?;

    // ---- Step 6: NFX-07 bearer baseline: 500 files, price 1, window 8 (real mint) ---------------
    eprintln!("[ppk {fee_ppk}] step 6: bearer baseline");
    let bearer_watcher = cdk_wallet(&root.join("bearer-watcher.sqlite"), &mint_url).await?;
    let bearer_seeder = cdk_wallet(&root.join("bearer-seeder.sqlite"), &mint_url).await?;
    let quote = bearer_watcher
        .mint_quote(
            PaymentMethod::Known(KnownMethod::Bolt11),
            Some(Amount::from(BEARER_WALLET_SAT)),
            None,
            None,
        )
        .await?;
    lightning.settle_external(&quote.request).map_err(e)?;
    bearer_watcher.check_mint_quote_status(&quote.id).await?;
    bearer_watcher
        .mint(&quote.id, SplitTarget::default(), None)
        .await?;

    // Seeder start: keyset listing and keys, cached for the DLEQ checks (NFX-07 §3 step 3).
    let s = meter.snapshot();
    let listing: KeysetResponse = http
        .get(format!("{mint_url}/v1/keysets"))
        .send()
        .await?
        .json()
        .await?;
    let all_keys: KeysResponse = http
        .get(format!("{mint_url}/v1/keys"))
        .send()
        .await?
        .json()
        .await?;
    let keys_by_id: HashMap<Id, Keys> = all_keys
        .keysets
        .into_iter()
        .map(|set| (set.id, set.keys))
        .collect();
    pass.bearer_setup = meter.snapshot().delta(&s);

    let mut token_bytes = Vec::new();
    let mut proofs_per_token = Vec::new();
    let mut first_pay_seeder_calls = String::new();
    let watcher_before = meter.snapshot();
    let mut watcher_part = Snapshot::default();
    let mut seeder_part = Snapshot::default();
    for pay in 1..=FILES / PAY_EVERY {
        let upto = pay * PAY_EVERY;
        let face = PAY_EVERY * PRICE;
        // Watcher: an unlocked token of exactly `face` sat (fees are the seeder's, NFX-07 §2).
        let s = meter.snapshot();
        let t = Instant::now();
        let prepared = bearer_watcher
            .prepare_send(
                Amount::from(face),
                SendOptions {
                    include_fee: false,
                    ..Default::default()
                },
            )
            .await?;
        let token = prepared.confirm(None).await?;
        pass.send_us.push(us(t));
        merge(&mut watcher_part, &meter.snapshot().delta(&s));
        let token_string = token.to_string();
        let pay_line = format!(
            "{}\n",
            json!({"t": "pay", "upto_chunk": upto, "token": token_string})
        );
        ensure!(pay_line.len() <= 32 * 1024, "pay line over 32 KiB");
        pass.pay_line_bytes += pay_line.len() as u64;
        token_bytes.push(token_string.len() as f64);

        // Seeder: NFX-07 §3 steps 1-4 (structure, mint, DLEQ, face value), offline.
        let t = Instant::now();
        let line: Value = serde_json::from_str(pay_line.trim_end())?;
        let encoded = line["token"].as_str().context("token")?;
        let parsed = Token::from_str(encoded)?;
        ensure!(parsed.unit() == Some(CurrencyUnit::Sat), "bad-token: unit");
        ensure!(
            parsed.mint_url()?.to_string().trim_end_matches('/') == mint_url,
            "bad-mint"
        );
        ensure!(parsed.spending_conditions()?.is_empty(), "bad-token: locked");
        let proofs = parsed.proofs(&listing.keysets)?;
        ensure!(!proofs.is_empty() && proofs.len() <= 64, "bad-token: proof count");
        let mut value = 0u64;
        for proof in &proofs {
            let key = keys_by_id
                .get(&proof.keyset_id)
                .and_then(|keys| keys.amount_key(proof.amount))
                .context("bad-token: unknown key")?;
            ensure!(proof.dleq.is_some(), "bad-token: no DLEQ");
            proof.verify_dleq(key)?;
            value += u64::from(proof.amount);
        }
        ensure!(value == face, "face value {value}, expected {face}");
        pass.check_us.push(us(t));
        proofs_per_token.push(proofs.len() as f64);

        // Seeder: swap, then acknowledge (§3 step 5).
        let s = meter.snapshot();
        let t = Instant::now();
        let got = bearer_seeder
            .receive(encoded, ReceiveOptions::default())
            .await?;
        pass.swap_us.push(us(t));
        let seeder_delta = meter.snapshot().delta(&s);
        if pay == 1 {
            first_pay_seeder_calls = seeder_delta.describe();
        }
        merge(&mut seeder_part, &seeder_delta);
        pass.seeder_net += u64::from(got);
        let ack = format!(
            "{}\n",
            json!({"t": "ack", "accepted_upto": upto, "spent_total": upto * PRICE})
        );
        pass.ack_line_bytes += ack.len() as u64;
    }
    let all_bearer = meter.snapshot().delta(&watcher_before);
    ensure!(
        all_bearer.total() == watcher_part.total() + seeder_part.total(),
        "unattributed mint calls in the bearer loop"
    );
    pass.bearer_watcher = watcher_part;
    pass.bearer_seeder = seeder_part;
    let pays = FILES / PAY_EVERY;

    writeln!(out, "### 6. NFX-07 bearer baseline: {FILES} files, price {PRICE}, window {WINDOW} (real mint)\n")?;
    writeln!(
        out,
        "- {pays} `pay`s of {} sat (one every {PAY_EVERY} files), each an unlocked `cashuB` token \
         the seeder checks (structure, mint, DLEQ, face value) and swaps before its `ack`.",
        PAY_EVERY * PRICE
    )?;
    writeln!(
        out,
        "- Seeder start (keyset listing + keys): mint calls {}.",
        pass.bearer_setup.describe()
    )?;
    writeln!(
        out,
        "- Watcher sends: mint calls {} (splits of larger proofs), fees {} sat; send median {:.0} µs, p95 {:.0} µs.",
        pass.bearer_watcher.describe(),
        pass.bearer_watcher.fees(),
        pctl(&pass.send_us, 50.0),
        pctl(&pass.send_us, 95.0)
    )?;
    writeln!(
        out,
        "- Seeder swaps: mint calls **{}** (first `pay`: {first_pay_seeder_calls}); \
         **swap latency median {:.1} ms, p95 {:.1} ms** (in-process mint on loopback: no network \
         round trip); fees **{} sat**; the seeder netted {} of {} sat.",
        pass.bearer_seeder.describe(),
        pctl(&pass.swap_us, 50.0) / 1e3,
        pctl(&pass.swap_us, 95.0) / 1e3,
        pass.bearer_seeder.fees(),
        pass.seeder_net,
        FILES * PRICE
    )?;
    writeln!(
        out,
        "- Seeder checks before the swap: median {:.0} µs, p95 {:.0} µs.",
        pctl(&pass.check_us, 50.0),
        pctl(&pass.check_us, 95.0)
    )?;
    writeln!(
        out,
        "- Token size: median {:.0} B, max {:.0} B ({:.1} proofs per token on average); `pay` lines \
         {} B and `ack` lines {} B in total.\n",
        pctl(&token_bytes, 50.0),
        pctl(&token_bytes, 100.0),
        sum(&proofs_per_token) / proofs_per_token.len() as f64,
        pass.pay_line_bytes,
        pass.ack_line_bytes
    )?;

    // ---- Conservation ---------------------------------------------------------------------------
    let watcher_left = watcher.load_mint_balance(&mint_url).await?.balance_sat;
    let seeder_got = seeder_wallet.load_mint_balance(&mint_url).await?.balance_sat;
    let bearer_watcher_left = u64::from(bearer_watcher.total_balance().await?);
    let bearer_seeder_got = u64::from(bearer_seeder.total_balance().await?);
    let all = meter.snapshot().delta(&base);
    let minted = WATCHER_MINT_SAT + BEARER_WALLET_SAT;
    let held = watcher_left + seeder_got + bearer_watcher_left + bearer_seeder_got;
    writeln!(
        out,
        "Conservation: minted {minted} sat = wallets {held} (watcher {watcher_left}, seeder \
         {seeder_got}, bearer watcher {bearer_watcher_left}, bearer seeder {bearer_seeder_got}) + \
         fees {} {}. Mint calls in this pass: {}.\n",
        all.fees(),
        if minted == held + all.fees() { "✓" } else { "✗ (see note)" },
        all.total()
    )?;
    drop(local);
    Ok(pass)
}

fn merge(into: &mut Snapshot, delta: &Snapshot) {
    for (route, n) in &delta.calls {
        *into.calls.entry(route.clone()).or_default() += n;
    }
    into.swaps.extend(delta.swaps.iter().cloned());
    into.req_bytes += delta.req_bytes;
    into.resp_bytes += delta.resp_bytes;
    into.server_ms += delta.server_ms;
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let started = Instant::now();
    let mut out = String::new();
    writeln!(out, "# Spike S6 report: Spilman channels vs NFX-07 bearer payments\n")?;
    writeln!(
        out,
        "{FILES} files at {PRICE} sat; NFX-07 window {WINDOW} (a `pay` every {PAY_EVERY} files); \
         channel A capacity {CAPACITY_A} sat, expiry 3 h; channel B capacity {CAPACITY_B} sat, \
         expiry {EXPIRY_B_SECS} s. Versions: nvpn-cdk-spilman 0.17.7, nvpn-cashu-service 0.4.11, \
         CDK/cashu 0.18.0. Every step uses the real in-process CDK mint (`LocalMint`); none needed \
         the fake signing mint."
    )?;
    let mut passes = Vec::new();
    for fee_ppk in [0u64, 100] {
        passes.push(run_pass(fee_ppk, &mut out).await?);
    }

    writeln!(out, "## Comparison for {FILES} files\n")?;
    for pass in &passes {
        let ch_cpu = (sum(&pass.sign_us) + sum(&pass.verify_us)) / 1e3;
        let ch_cpu_core = (sum(&pass.sign_core_us) + sum(&pass.verify_core_us)) / 1e3;
        let be_cpu = (sum(&pass.send_us) + sum(&pass.check_us) + sum(&pass.swap_us)) / 1e3;
        writeln!(out, "### `input_fee_ppk` = {}\n", pass.fee_ppk)?;
        writeln!(out, "| | channel (Spilman) | bearer (NFX-07) |\n|---|---:|---:|")?;
        writeln!(
            out,
            "| mint calls | {} (fund {}, close {}, change {}) + {} deferred (seeder stage 2) | {} (seeder {}, watcher {}) + {} seeder start |",
            pass.channel_calls(),
            pass.fund_a.total(),
            pass.close.total(),
            pass.change.total(),
            pass.receiver_sweep.total(),
            pass.bearer_calls(),
            pass.bearer_seeder.total(),
            pass.bearer_watcher.total(),
            pass.bearer_setup.total()
        )?;
        writeln!(
            out,
            "| mint calls if the seeder hands the watcher its change (no NUT-09 probing) | {} | — |",
            pass.channel_calls_without_probing()
        )?;
        writeln!(
            out,
            "| bytes to and from the mint | {} | {} |",
            pass.fund_a.req_bytes + pass.fund_a.resp_bytes + pass.close.req_bytes + pass.close.resp_bytes
                + pass.change.req_bytes + pass.change.resp_bytes + pass.receiver_sweep.req_bytes
                + pass.receiver_sweep.resp_bytes,
            pass.bearer_watcher.req_bytes + pass.bearer_watcher.resp_bytes
                + pass.bearer_seeder.req_bytes + pass.bearer_seeder.resp_bytes
        )?;
        writeln!(
            out,
            "| peer wire, watcher → seeder | {} B (open {} + {FILES} updates {}); NFX-15 NDJSON model: {} | {} B ({} `pay` lines) |",
            pass.open_msg_bytes as u64 + pass.upd_payment_bytes,
            pass.open_msg_bytes,
            pass.upd_payment_bytes,
            pass.open_msg_bytes as u64 + pass.upd_ndjson_bytes,
            pass.pay_line_bytes,
            FILES / PAY_EVERY
        )?;
        writeln!(
            out,
            "| peer wire, seeder → watcher | per-update ack not modelled | {} B (`ack` lines) |",
            pass.ack_line_bytes
        )?;
        writeln!(
            out,
            "| time in the payment path | {:.0} ms sign + verify ({:.0} ms crypto only) + fund {:.0} ms + close {:.0} ms | {:.0} ms send + check + swap |",
            ch_cpu, ch_cpu_core, pass.fund_a_ms, pass.close_ms, be_cpu
        )?;
        writeln!(
            out,
            "| fees | {} sat (fund {}, close {}, stage 2: watcher {} + seeder {}) | {} sat (seeder {}, watcher {}) |",
            pass.channel_fees(),
            pass.fund_a.fees(),
            pass.close.fees(),
            pass.change.fees(),
            pass.receiver_sweep.fees(),
            pass.bearer_fees(),
            pass.bearer_seeder.fees(),
            pass.bearer_watcher.fees()
        )?;
        writeln!(
            out,
            "| mint in the hot loop | no: 0 calls in {FILES} updates | yes: one swap per `pay` before its `ack` |\n"
        )?;

        let pays = (FILES / PAY_EVERY) as f64;
        let calls_per_pay = pass.bearer_calls() as f64 / pays;
        let fee_per_pay = pass.bearer_fees() as f64 / pays;
        let be = |fixed: u64, per: f64| {
            break_even(fixed as f64, per)
                .map_or("never".to_string(), |n| format!("**{n} files**"))
        };
        writeln!(
            out,
            "Break-even (files at which the bearer rail has cost as much as one channel's funding \
             and close; bearer measured at {calls_per_pay:.2} mint calls and {fee_per_pay:.2} sat \
             per `pay`):\n"
        )?;
        writeln!(
            out,
            "- mint calls, nostr-vpn as is ({} per channel): {}",
            pass.channel_calls(),
            be(pass.channel_calls(), calls_per_pay)
        )?;
        writeln!(
            out,
            "- mint calls, change handed over instead of probed ({} per channel): {}",
            pass.channel_calls_without_probing(),
            be(pass.channel_calls_without_probing(), calls_per_pay)
        )?;
        writeln!(
            out,
            "- fees ({} sat per channel): {}\n",
            pass.channel_fees(),
            if pass.channel_fees() == 0 && fee_per_pay == 0.0 {
                "both rails pay 0 sat at this mint".to_string()
            } else {
                be(pass.channel_fees(), fee_per_pay)
            }
        )?;
    }
    writeln!(out, "Run time: {:.1} s.", started.elapsed().as_secs_f64())?;
    print!("{out}");
    Ok(())
}
