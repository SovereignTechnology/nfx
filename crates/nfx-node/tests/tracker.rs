//! The NFX-10 tracker over real WebSockets, with p2p-media-loader 4.0.0's message shapes:
//! admission by verified hash list, offer and answer relay, and the refusals that
//! bittorrent-tracker lacks.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use n0_future::{SinkExt, StreamExt};
use nfx_node::tracker::{MAX_MESSAGE_BYTES, Tracker};
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tungstenite::Message;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
const WAIT: Duration = Duration::from_secs(5);

fn list() -> HashList {
    let h: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/hashlist.json")).unwrap();
    serde_json::from_value(h["hashlist"].clone()).unwrap()
}

fn sdp(kind: &str) -> Value {
    json!({ "type": kind, "sdp": "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" })
}

async fn send(ws: &mut Ws, v: &Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

async fn recv(ws: &mut Ws) -> Value {
    loop {
        match tokio::time::timeout(WAIT, ws.next()).await.unwrap() {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(t.as_str()).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected a message, got {other:?}"),
        }
    }
}

fn announce(info_hash: &str, peer_id: &str, offers: usize, event: Option<&str>) -> Value {
    let mut v = json!({
        "action": "announce",
        "info_hash": info_hash,
        "peer_id": peer_id,
        "numwant": offers,
        "uploaded": 0,
        "downloaded": 0,
        "offers": (0..offers)
            .map(|i| json!({ "offer": sdp("offer"), "offer_id": format!("offer{i:015}") }))
            .collect::<Vec<_>>(),
    });
    if let Some(e) = event {
        v["event"] = e.into();
    }
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_offers_and_answers_only_for_admitted_swarms() {
    let tracker = Arc::new(Tracker::new());
    let list = list();
    assert_eq!(tracker.admit(&list).unwrap(), 1);
    let video = VideoAddr::parse(&list.video).unwrap();
    let ih = video.web_tracker_infohash("720p");
    assert_eq!(ih.len(), 20);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(tracker.clone().serve(listener));
    let connect = || async { connect_async(url.as_str()).await.unwrap().0 };
    let (pa, pb) = ("-PM0400-aaaaaaaaaaaa", "-PM0400-bbbbbbbbbbbb");

    // A joins with one offer (nobody to give it to yet).
    let mut a = connect().await;
    send(&mut a, &announce(&ih, pa, 1, Some("started"))).await;
    let r = recv(&mut a).await;
    assert_eq!(r["action"], "announce");
    assert_eq!(r["interval"], 120);
    assert_eq!(r["incomplete"], 1);
    assert_eq!(r["info_hash"], ih.as_str());

    // B joins with two offers: A receives one of them, re-serialised, from B.
    let mut b = connect().await;
    send(&mut b, &announce(&ih, pb, 2, Some("started"))).await;
    assert_eq!(recv(&mut b).await["incomplete"], 2);
    let offer = recv(&mut a).await;
    assert_eq!(offer["peer_id"], pb);
    assert_eq!(offer["offer"], sdp("offer"));
    assert_eq!(offer["info_hash"], ih.as_str());
    let offer_id = offer["offer_id"].as_str().unwrap().to_owned();

    // A answers; B receives it from A. The answerer gets no reply.
    send(
        &mut a,
        &json!({
            "action": "announce", "info_hash": ih, "peer_id": pa,
            "to_peer_id": pb, "offer_id": offer_id, "answer": sdp("answer"),
        }),
    )
    .await;
    let answer = recv(&mut b).await;
    assert_eq!(answer["peer_id"], pa);
    assert_eq!(answer["offer_id"], offer_id.as_str());
    assert_eq!(answer["answer"], sdp("answer"));

    // Refusals, each answered with a failure while the socket stays usable.
    let failure = |v: &Value| v["failure reason"].as_str().unwrap_or_default().to_owned();
    let foreign = video.web_tracker_infohash("1080p");
    send(&mut a, &announce(&foreign, pa, 0, None)).await;
    assert!(failure(&recv(&mut a).await).contains("not an NFX swarm"));
    send(&mut a, &announce(&ih, "-PM0400-cccccccccccc", 0, None)).await;
    assert!(failure(&recv(&mut a).await).contains("differs"));
    let mut bad = announce(&ih, pa, 1, None);
    bad["offers"][0] = Value::Null; // crashes bittorrent-tracker 11.2.3
    send(&mut a, &bad).await;
    assert!(failure(&recv(&mut a).await).contains("invalid offer"));
    let mut html = announce(&ih, pa, 1, None);
    html["offers"][0]["offer"]["sdp"] = "<script>".into();
    send(&mut a, &html).await;
    assert!(failure(&recv(&mut a).await).contains("invalid offer"));
    send(&mut a, &announce(&ih, pa, 11, None)).await;
    assert!(failure(&recv(&mut a).await).contains("invalid offers"));
    send(&mut a, &json!({ "action": "scrape", "info_hash": ih })).await;
    assert!(failure(&recv(&mut a).await).contains("only announce"));

    // A browser that reconnects keeps its id: the newest socket with A's peer_id holds it.
    let mut c = connect().await;
    send(&mut c, &announce(&ih, pa, 0, Some("started"))).await;
    assert_eq!(recv(&mut c).await["incomplete"], 2);
    // A no longer holds it, so A's `stopped` removes nothing; C's does.
    send(&mut a, &announce(&ih, pa, 0, Some("stopped"))).await;
    assert_eq!(recv(&mut a).await["incomplete"], 2);
    send(&mut c, &announce(&ih, pa, 0, Some("stopped"))).await;
    assert_eq!(recv(&mut c).await["incomplete"], 1);
    assert_eq!(tracker.peers(&ih), 1);

    // Closing B's socket removes it.
    b.close(None).await.unwrap();
    for _ in 0..50 {
        if tracker.peers(&ih) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(tracker.peers(&ih), 0);

    // A message over the size cap closes the socket.
    let big = "x".repeat(MAX_MESSAGE_BYTES + 1);
    let _ = c.send(Message::text(big)).await;
    let closed = tokio::time::timeout(WAIT, async {
        loop {
            match c.next().await {
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "an oversized message closes the socket");

    // A deleted video's swarms are refused.
    tracker.forget(&list).unwrap();
    send(&mut a, &announce(&ih, pa, 0, None)).await;
    assert!(failure(&recv(&mut a).await).contains("not an NFX swarm"));

    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flood_of_messages_closes_the_socket() {
    let tracker = Arc::new(Tracker::new());
    tracker.admit(&list()).unwrap();
    let ih = VideoAddr::parse(&list().video)
        .unwrap()
        .web_tracker_infohash("720p");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(tracker.clone().serve(listener));
    let (mut ws, _) = connect_async(url.as_str()).await.unwrap();
    let msg = announce(&ih, "-PM0400-ffffffffffff", 0, None).to_string();
    let mut replies = 0;
    let mut closed = false;
    for _ in 0..200 {
        if ws.send(Message::text(msg.clone())).await.is_err() {
            closed = true;
            break;
        }
    }
    while let Ok(Some(m)) = tokio::time::timeout(WAIT, ws.next()).await {
        match m {
            Ok(Message::Text(_)) => replies += 1,
            Ok(Message::Close(_)) | Err(_) => {
                closed = true;
                break;
            }
            Ok(_) => {}
        }
    }
    assert!(closed, "the socket was closed");
    assert!(replies <= 61, "at most the burst was answered: {replies}");
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_local_socket_is_a_peer_like_any_other() {
    let tracker = Arc::new(Tracker::new());
    tracker.admit(&list()).unwrap();
    let ih = VideoAddr::parse(&list().video)
        .unwrap()
        .web_tracker_infohash("720p");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(tracker.clone().serve(listener));

    // The in-process peer (the bridge) joins; a browser then offers, and it answers.
    let (mut local, mut inbox) = tracker.local();
    let bridge = "-NX0100-bridgebridge";
    let joined: Value = serde_json::from_str(
        &local
            .send(&announce(&ih, bridge, 0, Some("started")).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(joined["incomplete"], 1);
    let (mut browser, _) = connect_async(url.as_str()).await.unwrap();
    let pb = "-PM0400-browserbrows";
    send(&mut browser, &announce(&ih, pb, 1, Some("started"))).await;
    assert_eq!(recv(&mut browser).await["incomplete"], 2);
    let offer: Value = serde_json::from_str(
        &tokio::time::timeout(WAIT, inbox.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(offer["peer_id"], pb);
    let answer = json!({
        "action": "announce", "info_hash": ih, "peer_id": bridge,
        "to_peer_id": pb, "offer_id": offer["offer_id"], "answer": sdp("answer"),
    });
    assert!(
        local.send(&answer.to_string()).is_none(),
        "no reply to an answer"
    );
    assert_eq!(recv(&mut browser).await["peer_id"], bridge);

    // A foreign swarm is refused to it as to anyone; dropping it leaves the swarm.
    let refused: Value = serde_json::from_str(
        &local
            .send(
                &announce(
                    &VideoAddr::parse(&list().video)
                        .unwrap()
                        .web_tracker_infohash("1080p"),
                    bridge,
                    0,
                    None,
                )
                .to_string(),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(
        refused["failure reason"]
            .as_str()
            .unwrap()
            .contains("not an NFX swarm")
    );
    // A network client cannot take the bridge's id over.
    let (mut thief, _) = connect_async(url.as_str()).await.unwrap();
    send(&mut thief, &announce(&ih, bridge, 0, Some("started"))).await;
    let r = recv(&mut thief).await;
    assert!(
        r["failure reason"]
            .as_str()
            .unwrap_or_default()
            .contains("in use"),
        "{r}"
    );
    drop(local);
    assert_eq!(tracker.peers(&ih), 1);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_client_gets_a_bounded_number_of_sockets() {
    let tracker = Arc::new(Tracker::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(tracker.clone().serve(listener));
    let mut open = Vec::new();
    for _ in 0..nfx_node::tracker::MAX_SOCKETS_PER_CLIENT {
        open.push(connect_async(url.as_str()).await.unwrap().0);
    }
    assert!(
        connect_async(url.as_str()).await.is_err(),
        "one over the cap"
    );
    // Closing one frees its slot.
    open.pop().unwrap().close(None).await.unwrap();
    let mut ok = false;
    for _ in 0..50 {
        if connect_async(url.as_str()).await.is_ok() {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "the slot came back");
    server.abort();
}

#[test]
fn ipv6_clients_are_counted_by_their_slash_64() {
    use nfx_node::limit::client_key;
    let a: std::net::IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
    let b: std::net::IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
    let c: std::net::IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(client_key(a), client_key(b));
    assert_ne!(client_key(a), client_key(c));
    let v4: std::net::IpAddr = "203.0.113.7".parse().unwrap();
    assert_eq!(client_key(v4), v4);
    let mapped: std::net::IpAddr = "::ffff:203.0.113.7".parse().unwrap();
    assert_eq!(client_key(mapped), v4);
}
