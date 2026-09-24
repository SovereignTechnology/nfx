//! The adversary suite for NFX-07 open-mode payments, written before the engine.
//!
//! Every scenario is generic over [`Harness`]. It runs against the mock now, and the M2
//! security stage runs it unchanged against the real engine with an in-process mint. A
//! scenario panics on failure. [`ALL`] lists them for a runner.
//!
//! Seeder duties (NFX-07 §3): exact amounts (short is `underpaid`, over is `overpaid`,
//! overflow is `underpaid`); only quoted mints (`bad-mint`); a spent token bans the
//! session (`spent`); a replay is `stale`; the window bounds unpaid service; every refusal
//! leaves the accounting untouched and the token unclaimed. Sessions are isolated.
//!
//! Viewer duties: pay only for what was received, and before the window runs out; refuse
//! quotes over the cap or without a held mint; stop on an inconsistent `ack` or any `rej`.

use nfx_proto::pay::{MAX_INT, Pay, RejCode};

use crate::session::{Harness, Seeder, Viewer};

/// Deliver up to `n` chunks while the seeder allows; how many were served.
fn deliver<S: Seeder>(s: &mut S, n: u64) -> u64 {
    let mut served = 0;
    while served < n && s.may_serve() {
        s.delivered();
        served += 1;
    }
    served
}

async fn refused<H: Harness>(h: &H, s: &mut H::Seeder, pay: &Pay, want: &RejCode) {
    let rej = s.pay(pay).await.expect_err("this payment must be refused");
    assert_eq!(&rej.code, want, "{:?}", rej.detail);
    h.settle().await;
    assert!(
        !h.claimed(&pay.token).await,
        "a refused token is not claimed"
    );
}

/// A session serves `window` unpaid chunks and then waits. An exact payment is
/// acknowledged, its token claimed, and the next window opens.
pub async fn exact_payment_opens_the_next_window<H: Harness>(h: &H) {
    let mut s = h.seeder(3, 4);
    assert_eq!(deliver(&mut s, 10), 4, "a window of 4");
    let token = h.token(12).await;
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("an exact payment");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 12));
    h.settle().await;
    assert!(h.claimed(&token).await);
    assert_eq!(deliver(&mut s, 10), 4, "the next window");
}

/// A payment short of the chunks claimed is `underpaid`.
pub async fn underpaid_is_refused<H: Harness>(h: &H) {
    let mut s = h.seeder(3, 4);
    deliver(&mut s, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(11).await,
    };
    refused(h, &mut s, &pay, &RejCode::Underpaid).await;
    assert!(!s.may_serve(), "still waiting: nothing was credited");
}

/// A payment above the chunks claimed is `overpaid`: never credit on a miscount.
pub async fn overpaid_is_refused<H: Harness>(h: &H) {
    let mut s = h.seeder(3, 4);
    deliver(&mut s, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(13).await,
    };
    refused(h, &mut s, &pay, &RejCode::Overpaid).await;
}

/// Proofs from a mint the seeder did not quote are `bad-mint`.
pub async fn a_foreign_mint_is_refused<H: Harness>(h: &H) {
    let mut s = h.seeder(3, 4);
    deliver(&mut s, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.foreign_token(12).await,
    };
    refused(h, &mut s, &pay, &RejCode::BadMint).await;
}

/// A `pay` at or below the last acknowledged chunk is `stale` and changes nothing.
pub async fn a_stale_pay_changes_nothing<H: Harness>(h: &H) {
    let mut s = h.seeder(2, 4);
    deliver(&mut s, 4);
    s.pay(&Pay {
        upto_chunk: 4,
        token: h.token(8).await,
    })
    .await
    .expect("the first payment");
    for upto in [4, 3] {
        let pay = Pay {
            upto_chunk: upto,
            token: h.token(2).await,
        };
        refused(h, &mut s, &pay, &RejCode::Stale).await;
    }
    deliver(&mut s, 4);
    let ack = s
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(8).await,
        })
        .await
        .expect("accounting is where it was");
    assert_eq!((ack.accepted_upto, ack.spent_total), (8, 16));
}

/// A claim so large that chunks × price overflows is `underpaid`, not a panic.
pub async fn an_overflowing_claim_is_underpaid<H: Harness>(h: &H) {
    let mut s = h.seeder(2, 4);
    deliver(&mut s, 4);
    let pay = Pay {
        upto_chunk: MAX_INT,
        token: h.token(8).await,
    };
    refused(h, &mut s, &pay, &RejCode::Underpaid).await;
}

/// A token already spent in another session bans this one, which then never serves
/// again, whatever it is paid.
pub async fn a_double_spend_bans_the_session<H: Harness>(h: &H) {
    let token = h.token(8).await;
    let mut first = h.seeder(2, 4);
    deliver(&mut first, 4);
    first
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("the first spend");
    let mut second = h.seeder(2, 4);
    assert_eq!(deliver(&mut second, 10), 4);
    // Refused at once, or acknowledged and banned once the swap fails (bounded by window).
    let _ = second
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await;
    h.settle().await;
    assert!(second.banned(), "a double spend bans the session");
    assert!(!second.may_serve());
    let _ = second
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(8).await,
        })
        .await;
    h.settle().await;
    assert!(
        second.banned() && !second.may_serve(),
        "bans are not lifted"
    );
    assert!(first.may_serve(), "the first session is unaffected");
}

/// A viewer that never pays gets exactly `window` chunks.
pub async fn an_unpaid_window_stops_serving<H: Harness>(h: &H) {
    let mut s = h.seeder(1, 8);
    assert_eq!(deliver(&mut s, 100), 8);
    assert_eq!(deliver(&mut s, 100), 0);
}

/// A payment in one session credits no other.
pub async fn sessions_are_isolated<H: Harness>(h: &H) {
    let mut a = h.seeder(1, 2);
    let mut b = h.seeder(1, 2);
    deliver(&mut a, 2);
    deliver(&mut b, 2);
    a.pay(&Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    })
    .await
    .expect("a pays");
    assert!(a.may_serve());
    assert!(!b.may_serve(), "b is still unpaid");
}

/// A viewer pays only for chunks it has received, and once per acknowledgement.
pub async fn a_viewer_pays_only_for_what_it_received<H: Harness>(h: &H) {
    let mut s = h.seeder(2, 4);
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("an acceptable quote");
    assert!(v.due().await.unwrap().is_none(), "nothing received yet");
    for _ in 0..2 {
        s.delivered();
        v.received();
    }
    let pay = v.due().await.unwrap().expect("half the window is due");
    assert_eq!(pay.upto_chunk, 2, "never ahead of what was received");
    s.delivered();
    v.received();
    assert!(
        v.due().await.unwrap().is_none(),
        "one payment in flight at a time"
    );
    let ack = s.pay(&pay).await.expect("the viewer paid exactly");
    assert_eq!(ack.spent_total, 4);
    v.ack(&ack).expect("a consistent ack");
}

/// A viewer refuses a quote over its price cap, or one naming no mint it holds.
pub async fn a_viewer_refuses_quotes_it_cannot_honour<H: Harness>(h: &H) {
    let mut v = h.viewer(2);
    assert!(v.quote(h.seeder(3, 8).quote()).is_err(), "over the cap");
    let mut elsewhere = h.seeder(1, 8).quote().clone();
    elsewhere.mints = vec!["https://unknown-mint.example".into()];
    assert!(v.quote(&elsewhere).is_err(), "no mint it holds");
}

/// A viewer stops paying a seeder whose `ack` does not match the payment.
pub async fn a_viewer_stops_on_an_inconsistent_ack<H: Harness>(h: &H) {
    let mut s = h.seeder(1, 2);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    s.delivered();
    v.received();
    let pay = v.due().await.unwrap().expect("due");
    let mut ack = s.pay(&pay).await.unwrap();
    ack.accepted_upto -= 1;
    assert!(v.ack(&ack).is_err());
    assert!(v.stopped());
    v.received();
    assert!(v.due().await.unwrap().is_none(), "no more payments");
}

/// A viewer stops paying a seeder that refused it.
pub async fn a_viewer_stops_after_a_refusal<H: Harness>(h: &H) {
    let mut s = h.seeder(1, 2);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    deliver(&mut s, 1);
    v.received();
    let rej = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.foreign_token(1).await,
        })
        .await
        .unwrap_err();
    v.rej(&rej);
    assert!(v.stopped());
    v.received();
    assert!(v.due().await.unwrap().is_none());
}

/// An honest pair streams a whole video without the seeder ever stalling, and the total
/// paid is exactly chunks × price.
pub async fn an_honest_pair_streams_a_whole_video<H: Harness>(h: &H) {
    let (chunks, price) = (100, 2);
    let mut s = h.seeder(price, 8);
    let mut v = h.viewer(price);
    v.quote(s.quote()).unwrap();
    let mut spent = 0;
    for _ in 0..chunks {
        assert!(
            s.may_serve(),
            "an honest viewer never makes the seeder stall"
        );
        s.delivered();
        v.received();
        if let Some(pay) = v.due().await.unwrap() {
            let ack = s.pay(&pay).await.expect("honest payments are accepted");
            v.ack(&ack).unwrap();
            spent = ack.spent_total;
        }
    }
    if let Some(pay) = v.last_pay().await.unwrap() {
        let ack = s.pay(&pay).await.expect("the tail is paid");
        v.ack(&ack).unwrap();
        spent = ack.spent_total;
    }
    h.settle().await;
    assert_eq!(spent, chunks * price);
    assert!(!v.stopped() && !s.banned());
}

/// Every scenario, by name.
pub const ALL: &[&str] = &[
    "exact_payment_opens_the_next_window",
    "underpaid_is_refused",
    "overpaid_is_refused",
    "a_foreign_mint_is_refused",
    "a_stale_pay_changes_nothing",
    "an_overflowing_claim_is_underpaid",
    "a_double_spend_bans_the_session",
    "an_unpaid_window_stops_serving",
    "sessions_are_isolated",
    "a_viewer_pays_only_for_what_it_received",
    "a_viewer_refuses_quotes_it_cannot_honour",
    "a_viewer_stops_on_an_inconsistent_ack",
    "a_viewer_stops_after_a_refusal",
    "an_honest_pair_streams_a_whole_video",
];
