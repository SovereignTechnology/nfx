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

    // Another socket cannot take over A's peer_id while A is connected.
    let mut c = connect().await;
    send(&mut c, &announce(&ih, pa, 0, Some("started"))).await;
    assert!(failure(&recv(&mut c).await).contains("in use"));

    // A still works after all that, and `stopped` takes it out of the swarm.
    send(&mut a, &announce(&ih, pa, 0, Some("stopped"))).await;
    assert_eq!(recv(&mut a).await["incomplete"], 1);
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
