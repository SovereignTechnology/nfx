//! The adversary suite for NFX-07 open-mode payments, written before the engine.
//!
//! Every scenario is generic over [`Harness`]. It runs against the mock now, and the M2
//! security stage runs it unchanged against the real engine with an in-process mint. A
//! scenario panics on failure.
//!
//! **Run it with [`adversary_suite!`](crate::adversary_suite)**, which emits one test per
//! scenario from the list kept here: a runner cannot choose a subset. The list is pinned
//! with the locked paths, so weakening the suite is a reviewed change.

use nfx_proto::pay::{Ack, Pay, Rej, RejCode};

use crate::session::{BadToken, Harness, SeederEngine, SeederSession, Viewer};

/// Every scenario, one `#[tokio::test]` each, against the harness `$h` builds.
#[macro_export]
macro_rules! adversary_suite {
    ($h:expr) => {
        $crate::adversary_suite!(@each $h;
            exact_payment_opens_the_next_window,
            underpaid_is_refused_and_credits_nothing,
            overpaid_is_refused_and_credits_nothing,
            foreign_and_lookalike_mints_are_refused,
            bad_tokens_are_refused,
            a_stale_pay_changes_nothing,
            an_overflowing_claim_is_underpaid,
            a_double_spend_bans_the_peer,
            a_banned_peer_stays_banned,
            a_new_hello_continues_the_account,
            a_session_id_is_bound_to_its_peer,
            service_waits_for_confirmed_swaps,
            a_mint_outage_is_not_a_ban,
            every_request_counts_whole_or_not,
            only_the_sessions_video_is_admitted,
            an_unpaid_window_stops_serving,
            a_global_cap_bounds_free_service,
            prepayment_extends_service_exactly,
            peers_are_isolated,
            a_viewer_pays_for_every_request_and_no_more,
            a_viewer_refuses_quotes_it_cannot_honour,
            a_viewer_stops_on_a_wrong_or_unsolicited_ack,
            a_viewer_reclaims_a_refused_payment,
            a_viewer_reclaims_an_unacknowledged_payment,
            an_honest_pair_streams_a_whole_video,
        );
    };
    (@each $h:expr; $($name:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $name() {
                $crate::adversary::$name(&$h).await;
            }
        )*
    };
}

type Session<H> = <<H as Harness>::Engine as SeederEngine>::Session;

fn open<H: Harness>(h: &H, e: &H::Engine, peer: u8) -> Session<H> {
    e.hello(&h.peer(peer), &h.hello()).expect("a hello")
}

/// Admit up to `n` requests for distinct files, starting at file `from`; how many were.
fn serve<H: Harness>(h: &H, s: &mut Session<H>, from: u16, n: u16) -> u64 {
    (from..from + n).filter(|i| s.admit(&h.chunk(*i))).count() as u64
}

async fn refused<H: Harness>(h: &H, s: &mut Session<H>, pay: &Pay, want: &RejCode) {
    let rej = s.pay(pay).await.expect_err("this payment must be refused");
    assert_eq!(&rej.code, want, "{:?}", rej.detail);
    assert!(
        !h.claimed(&pay.token).await,
        "a refused token is not claimed"
    );
    assert_eq!(serve(h, s, 900, 1), 0, "a refusal credits nothing");
}

/// A peer is served `window` chunks unpaid, then waits. An exact payment is acknowledged,
/// its token claimed, and the next window opens.
pub async fn exact_payment_opens_the_next_window<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 10), 4, "a window of 4");
    let token = h.token(12).await;
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("an exact payment");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 12));
    assert!(h.claimed(&token).await);
    assert_eq!(serve(h, &mut s, 10, 10), 4, "the next window");
}

/// Short of the chunks claimed is `underpaid`, and credits nothing.
pub async fn underpaid_is_refused_and_credits_nothing<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(11).await,
    };
    refused(h, &mut s, &pay, &RejCode::Underpaid).await;
}

/// Above the chunks claimed is `overpaid`: never credit on a miscount.
pub async fn overpaid_is_refused_and_credits_nothing<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(13).await,
    };
    refused(h, &mut s, &pay, &RejCode::Overpaid).await;
}

/// Only a mint whose URL is exactly a quoted one is accepted: a foreign mint, and
/// lookalikes of the quoted URL, are `bad-mint`.
pub async fn foreign_and_lookalike_mints_are_refused<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let m = h.mint();
    let lookalikes = [
        "https://other-mint.example".to_owned(),
        format!("{m}.attacker.example"),
        format!("{m}/"),
        format!("{m}:443"),
        m.to_uppercase(),
    ];
    for url in lookalikes {
        let pay = Pay {
            upto_chunk: 4,
            token: h.token_at(&url, 12).await,
        };
        refused(h, &mut s, &pay, &RejCode::BadMint).await;
    }
}

/// A token of the wrong unit, of two mints, with locked proofs, with a bad DLEQ, or not a
/// token at all is `bad-token`.
pub async fn bad_tokens_are_refused<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    for kind in [
        BadToken::WrongUnit,
        BadToken::TwoMints,
        BadToken::Locked,
        BadToken::BadDleq,
        BadToken::Garbage,
    ] {
        let pay = Pay {
            upto_chunk: 4,
            token: h.bad_token(kind, 12).await,
        };
        refused(h, &mut s, &pay, &RejCode::BadToken).await;
    }
}

/// A `pay` at or below the last acknowledged chunk is `stale` and changes nothing.
pub async fn a_stale_pay_changes_nothing<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    s.pay(&Pay {
        upto_chunk: 4,
        token: h.token(8).await,
    })
    .await
    .expect("the first payment");
    assert_eq!(serve(h, &mut s, 4, 4), 4);
    for upto in [4, 3] {
        let pay = Pay {
            upto_chunk: upto,
            token: h.token(2).await,
        };
        refused(h, &mut s, &pay, &RejCode::Stale).await;
    }
    let ack = s
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(8).await,
        })
        .await
        .expect("the accounting is where it was");
    assert_eq!((ack.accepted_upto, ack.spent_total), (8, 16));
}

/// A claim whose price overflows (chunks × price beyond 2^53−1, here beyond 2^64) is
/// `underpaid`, whatever a wrapped product would say.
pub async fn an_overflowing_claim_is_underpaid<H: Harness>(h: &H) {
    let e = h.engine(4096, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: (1 << 52) + 1,
        token: h.token(4096).await,
    };
    refused(h, &mut s, &pay, &RejCode::Underpaid).await;
}

/// Proofs already spent, even re-encoded or combined with fresh ones, are `spent` and ban
/// the peer. Other peers are unaffected.
pub async fn a_double_spend_bans_the_peer<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let token = h.token(8).await;
    let mut first = open(h, &e, 1);
    serve(h, &mut first, 0, 4);
    first
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("the first spend");
    let mut second = open(h, &e, 2);
    serve(h, &mut second, 0, 4);
    let rej = second
        .pay(&Pay {
            upto_chunk: 4,
            token: h.reencode(&token).await,
        })
        .await
        .expect_err("re-encoded, the proofs are still spent");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(second.banned());
    assert_eq!(serve(h, &mut second, 10, 4), 0);

    let spent_part = h.token(4).await;
    assert!(h.steal(&spent_part).await);
    let mut third = open(h, &e, 3);
    serve(h, &mut third, 0, 4);
    let rej = third
        .pay(&Pay {
            upto_chunk: 4,
            token: h.combine(&h.token(4).await, &spent_part).await,
        })
        .await
        .expect_err("one spent proof spoils the token");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(third.banned());
    assert_eq!(
        serve(h, &mut first, 4, 4),
        4,
        "the first peer is unaffected"
    );
}

/// A banned peer is refused (`banned`) whatever it pays, its valid token unclaimed, and
/// cannot open a new session.
pub async fn a_banned_peer_stays_banned<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let token = h.token(8).await;
    assert!(h.steal(&token).await, "someone else spent it");
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let _ = s
        .pay(&Pay {
            upto_chunk: 4,
            token,
        })
        .await;
    assert!(s.banned());
    let honest = Pay {
        upto_chunk: 4,
        token: h.token(8).await,
    };
    let rej = s.pay(&honest).await.expect_err("a banned peer is refused");
    assert_eq!(rej.code, RejCode::Banned);
    assert!(
        !h.claimed(&honest.token).await,
        "and its payment is not taken"
    );
    assert!(
        s.banned() && serve(h, &mut s, 10, 1) == 0,
        "bans are not lifted"
    );
    let again = e.hello(&h.peer(1), &h.hello());
    assert!(
        matches!(
            again,
            Err(Rej {
                code: RejCode::Banned,
                ..
            })
        ),
        "no new session for a banned peer"
    );
}

/// A new `hello` continues the peer's account: it never opens a fresh window.
pub async fn a_new_hello_continues_the_account<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    let mut again = open(h, &e, 1);
    assert_eq!(
        serve(h, &mut again, 4, 4),
        0,
        "the unpaid window carries over"
    );
}

/// A session id belongs to the peer that first used it, and one peer holds a bounded
/// number of sessions (`bad-session`).
pub async fn a_session_id_is_bound_to_its_peer<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let hello = h.hello();
    e.hello(&h.peer(1), &hello).expect("the owner");
    let other = e.hello(&h.peer(2), &hello);
    assert!(
        matches!(
            other,
            Err(Rej {
                code: RejCode::BadSession,
                ..
            })
        ),
        "another peer's session id"
    );
    let capped = (0..64).any(|_| {
        matches!(
            e.hello(&h.peer(3), &h.hello()),
            Err(Rej {
                code: RejCode::BadSession,
                ..
            })
        )
    });
    assert!(capped, "sessions per peer are capped");
}

/// Service stops at `window` beyond the last **confirmed** payment, however many
/// payments are acknowledged while their swaps are pending.
pub async fn service_waits_for_confirmed_swaps<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    h.hold_swaps();
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    for round in 1..=5u64 {
        s.pay(&Pay {
            upto_chunk: 4 * round,
            token: h.token(4).await,
        })
        .await
        .expect("acknowledged, not yet confirmed");
        assert_eq!(
            serve(h, &mut s, 100, 1),
            0,
            "no service on unconfirmed credit"
        );
    }
    h.release_swaps().await;
    assert_eq!(
        serve(h, &mut s, 200, 100),
        20,
        "confirmed: 20 paid + 4 window - 4 served"
    );
}

/// A mint that cannot be reached is not a ban: the payment stays unconfirmed until the
/// swap goes through.
pub async fn a_mint_outage_is_not_a_ban<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    h.mint_outage(true);
    let _ = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await;
    assert!(!s.banned(), "an outage is not the payer's fault");
    assert_eq!(serve(h, &mut s, 10, 1), 0, "but it confirms nothing");
    h.mint_outage(false);
    h.release_swaps().await;
    assert!(!s.banned());
    assert_eq!(
        serve(h, &mut s, 20, 10),
        4,
        "confirmed once the mint is back"
    );
}

/// Every admitted request counts, even for the same file again (a ranged or aborted
/// request): the window is not a count of distinct files.
pub async fn every_request_counts_whole_or_not<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let same = h.chunk(0);
    let admitted = (0..10).filter(|_| s.admit(&same)).count();
    assert_eq!(admitted, 4);
}

/// A file of another video is not admitted, and costs the window nothing.
pub async fn only_the_sessions_video_is_admitted<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    assert!(!s.admit(&h.foreign_chunk()));
    assert_eq!(serve(h, &mut s, 0, 10), 4);
}

/// A peer that never pays gets exactly `window` chunks.
pub async fn an_unpaid_window_stops_serving<H: Harness>(h: &H) {
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 100), 8);
    assert_eq!(serve(h, &mut s, 100, 100), 0);
}

/// Identities are free, so a global cap bounds unpaid service across all peers.
pub async fn a_global_cap_bounds_free_service<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 10);
    let served: u64 = (1..=5u8)
        .map(|p| {
            let mut s = open(h, &e, p);
            serve(h, &mut s, 0, 10)
        })
        .sum();
    assert_eq!(served, 10);
}

/// Paying ahead extends service by exactly the chunks paid.
pub async fn prepayment_extends_service_exactly<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let ack = s
        .pay(&Pay {
            upto_chunk: 6,
            token: h.token(6).await,
        })
        .await
        .expect("a pre-payment");
    assert_eq!(ack.accepted_upto, 6);
    assert_eq!(serve(h, &mut s, 0, 100), 10);
}

/// One peer's payment credits no other.
pub async fn peers_are_isolated<H: Harness>(h: &H) {
    let e = h.engine(1, 2, 1000);
    let mut a = open(h, &e, 1);
    let mut b = open(h, &e, 2);
    serve(h, &mut a, 0, 2);
    serve(h, &mut b, 0, 2);
    a.pay(&Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    })
    .await
    .expect("a pays");
    assert_eq!(serve(h, &mut a, 2, 1), 1);
    assert_eq!(serve(h, &mut b, 2, 1), 0, "b is still unpaid");
}

/// A viewer pays for every chunk it requested, never ahead, one payment at a time.
pub async fn a_viewer_pays_for_every_request_and_no_more<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("an acceptable quote");
    assert!(v.due().await.unwrap().is_none(), "nothing requested yet");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("half the window is due");
    assert_eq!(pay.upto_chunk, 2, "never ahead of what was requested");
    v.requested();
    assert!(
        v.due().await.unwrap().is_none(),
        "one payment in flight at a time"
    );
    let ack = s.pay(&pay).await.expect("the viewer paid exactly");
    assert_eq!(ack.spent_total, 4);
    v.ack(&ack).expect("a consistent ack");
}

/// A viewer refuses a quote over its cap, one naming no mint it holds, and a second
/// quote in the same session.
pub async fn a_viewer_refuses_quotes_it_cannot_honour<H: Harness>(h: &H) {
    let mut v = h.viewer(2);
    assert!(
        v.quote(
            h.engine(3, 8, 1000)
                .hello(&h.peer(1), &h.hello())
                .unwrap()
                .quote()
        )
        .is_err()
    );
    let mut elsewhere = h
        .engine(1, 8, 1000)
        .hello(&h.peer(1), &h.hello())
        .unwrap()
        .quote()
        .clone();
    elsewhere.mints = vec!["https://unknown-mint.example".into()];
    assert!(v.quote(&elsewhere).is_err(), "no mint it holds");
    let fair = h
        .engine(1, 8, 1000)
        .hello(&h.peer(1), &h.hello())
        .unwrap()
        .quote()
        .clone();
    v.quote(&fair).expect("a fair quote");
    let mut dearer = fair.clone();
    dearer.price_per_chunk = 2;
    assert!(v.quote(&dearer).is_err(), "one quote per session");
}

/// A viewer stops paying a seeder whose `ack` is unsolicited, or does not match the
/// payment's `accepted_upto` or `spent_total`.
pub async fn a_viewer_stops_on_a_wrong_or_unsolicited_ack<H: Harness>(h: &H) {
    let mut unsolicited = h.viewer(1);
    unsolicited
        .quote(
            h.engine(1, 2, 1000)
                .hello(&h.peer(1), &h.hello())
                .unwrap()
                .quote(),
        )
        .unwrap();
    assert!(
        unsolicited
            .ack(&Ack {
                accepted_upto: 0,
                spent_total: 0
            })
            .is_err()
    );
    assert!(unsolicited.stopped());
    for tamper in [
        |a: &mut Ack| a.accepted_upto -= 1,
        |a: &mut Ack| a.spent_total += 1,
    ] {
        let e = h.engine(1, 2, 1000);
        let mut s = open(h, &e, 1);
        let mut v = h.viewer(1);
        v.quote(s.quote()).unwrap();
        assert!(s.admit(&h.chunk(0)));
        v.requested();
        let pay = v.due().await.unwrap().expect("due");
        let mut ack = s.pay(&pay).await.unwrap();
        tamper(&mut ack);
        assert!(v.ack(&ack).is_err());
        assert!(v.stopped());
        v.requested();
        assert!(v.due().await.unwrap().is_none(), "no more payments");
    }
}

/// A viewer reclaims the proofs of a refused payment, so a seeder that refuses and then
/// claims gets nothing.
pub async fn a_viewer_reclaims_a_refused_payment<H: Harness>(h: &H) {
    let e = h.engine(1, 2, 1000);
    let s = open(h, &e, 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    v.rej(&Rej {
        code: RejCode::Spent,
        detail: None,
    })
    .await;
    assert!(v.stopped());
    assert!(
        !h.steal(&pay.token).await,
        "the refused proofs were taken back"
    );
}

/// A viewer reclaims a payment that is never acknowledged.
pub async fn a_viewer_reclaims_an_unacknowledged_payment<H: Harness>(h: &H) {
    let e = h.engine(1, 2, 1000);
    let s = open(h, &e, 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    v.timeout().await;
    assert!(v.stopped());
    assert!(
        !h.steal(&pay.token).await,
        "the unacknowledged proofs were taken back"
    );
}

/// An honest pair streams a whole video without the seeder ever stalling, and the total
/// paid is exactly chunks × price.
pub async fn an_honest_pair_streams_a_whole_video<H: Harness>(h: &H) {
    let (chunks, price) = (100u16, 2);
    let e = h.engine(price, 8, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(price);
    v.quote(s.quote()).unwrap();
    let mut spent = 0;
    for i in 0..chunks {
        assert!(
            s.admit(&h.chunk(i)),
            "an honest viewer never makes the seeder stall"
        );
        v.requested();
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
    assert_eq!(spent, u64::from(chunks) * price);
    assert!(!v.stopped() && !s.banned());
}
