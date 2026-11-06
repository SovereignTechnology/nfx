//! Seeder ratings (NFX-16) read through a real general relay (nostr-sdk's in-process
//! relay): the user's newest follow and mute lists decide who is admitted, and only
//! admitted authors' ratings for the namespace come back.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::time::Duration;

use nfx_node::nostr::Relays;
use nfx_node::unix_now;
use nfx_proto::event::Event;
use nfx_proto::rating::{Admitted, KIND_FOLLOWS, KIND_MUTES, score};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

fn secret(v: &Value, who: &str) -> [u8; 32] {
    let hex = v["secret_keys_DO_NOT_USE"][who].as_str().unwrap();
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex, &mut out).unwrap();
    out
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap().to_string())
        .collect()
}

/// The event moved `delta` seconds later (its time, its `created_at` fact and its
/// `expiration`), re-signed by its author. A relay drops NIP-40-expired events, and the
/// vectors are dated in the past.
fn shifted(event: &Event, delta: u64, secret: &[u8; 32]) -> Event {
    let tags = event
        .tags
        .iter()
        .map(|t| match t.as_slice() {
            [name, at] if name == "created_at" || name == "expiration" => {
                vec![
                    name.clone(),
                    (at.parse::<u64>().unwrap() + delta).to_string(),
                ]
            }
            _ => t.clone(),
        })
        .collect();
    Event::sign(
        secret,
        event.created_at + delta,
        event.kind,
        tags,
        event.content.clone(),
    )
    .unwrap()
}

fn list(secret: &[u8; 32], kind: u16, created_at: u64, pubkeys: &[String]) -> Event {
    let tags = pubkeys
        .iter()
        .map(|p| vec!["p".to_string(), p.clone()])
        .collect();
    Event::sign(secret, created_at, kind, tags, String::new()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn ratings_come_only_from_the_users_circle() {
    let v: Value = serde_json::from_str(include_str!(
        "../../../spec/test-vectors/ratings-scoring.json"
    ))
    .unwrap();
    let ns = v["namespace"].as_str().unwrap();
    let root = v["root"].as_str().unwrap().to_string();
    let (follows, trusted, muted) = (strs(&v["follows"]), strs(&v["trusted"]), strs(&v["muted"]));
    let names: BTreeMap<String, String> = v["pubkeys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, pk)| (pk.as_str().unwrap().to_string(), name.clone()))
        .collect();
    let stranger = v["pubkeys"]["stranger"].as_str().unwrap().to_string();

    let now = unix_now();
    let delta = now - v["now"].as_u64().unwrap();
    let ratings: Vec<Event> = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let event: Event = serde_json::from_value(e["event"].clone()).unwrap();
            let who = &names[&event.pubkey];
            shifted(&event, delta, &secret(&v, who))
        })
        .collect();

    let relay = nostr_sdk::prelude::LocalRelay::builder().build();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let relays = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();

    let me = secret(&v, "watcher");
    // An older follow list that also names the stranger: the newest list wins.
    let mut older = follows.clone();
    older.push(stranger.clone());
    for event in [
        list(&me, KIND_FOLLOWS, now - 100, &older),
        list(&me, KIND_FOLLOWS, now - 10, &follows),
        list(&me, KIND_MUTES, now - 10, &muted),
        // Someone else's follow list naming the stranger is not the user's.
        list(
            &secret(&v, "stranger"),
            KIND_FOLLOWS,
            now,
            std::slice::from_ref(&stranger),
        ),
    ] {
        relays.publish(&event).await.unwrap();
    }
    // The stale vector is past its NIP-40 expiration and the future one is far ahead: a
    // relay may refuse either, and neither counts anyway.
    for event in &ratings {
        let _ = relays.publish(event).await;
    }

    let inputs = relays
        .rating_inputs(&root, &trusted, ns, now, WAIT)
        .await
        .unwrap();
    let want_admitted = Admitted::new(
        &root,
        follows.iter().map(String::as_str),
        trusted.iter().map(String::as_str),
        muted.iter().map(String::as_str),
    );
    assert_eq!(inputs.admitted, want_admitted);
    assert!(!inputs.admitted.contains(&stranger));
    assert!(!inputs.admitted.contains(&muted[0]));
    assert!(
        inputs
            .events
            .iter()
            .all(|e| inputs.admitted.contains(&e.pubkey)),
        "only admitted authors' ratings are returned"
    );

    // What comes back scores exactly as the whole set does offline: nothing that counts
    // was lost, and nothing that does not count changed the result.
    let got = score(&inputs.events, ns, now, &inputs.admitted);
    let offline = score(&ratings, ns, now, &want_admitted);
    assert_eq!(got.scores, offline.scores);
    assert_eq!(got.scores.len(), 3, "all three seeders are rated");

    // With no relay connected the answer is an error, never "no ratings".
    let offline_relays = Relays::connect(
        &["ws://127.0.0.1:9".to_string()],
        Duration::from_millis(200),
    )
    .await
    .unwrap();
    assert!(
        offline_relays
            .rating_inputs(&root, &trusted, ns, now, WAIT)
            .await
            .is_err()
    );
}
