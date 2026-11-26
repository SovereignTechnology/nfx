//! Which relays may hear this node's private addresses (NFX-03 §4 as amended 2026-11-26,
//! decision record 0114).
//!
//! A relay is [`RelayClass::Private`] when this node reaches it at an address of its own host
//! or of a network it is on directly ([`crate::node::is_local`]: loopback, private, shared
//! (CGNAT, which tailnets use), link-local or unique-local), such as its embedded relay or a
//! relay on the LAN or the tailnet. Such a relay may be told the node's private direct
//! addresses. Every other relay is [`RelayClass::Public`]: it is told only iroh relay URLs,
//! public addresses and the operator's external ones ([`crate::node::Node::addr_for`]).
//!
//! The class comes from the address each connection actually reached, read from its socket
//! ([`ClassifyingTransport`]), never from the URL's host name: a MagicDNS or LAN name can
//! resolve to a private address, and any name to a public one. A relay with no live
//! connection, one reached through a proxy, one with live connections of both classes (two
//! clients whose DNS answers differed) and one pinned public ([`RelayClasses::pin_public`]: an
//! embedded relay served on every interface) are public: what is not known fails closed.
//!
//! What a connection carries is checked too: an event marked private-only
//! ([`RelayClasses::mark_private_only`]) is refused on a connection to a public address, which
//! then closes. So an event routed to a relay while it was reached privately cannot leave on a
//! reconnection that reached a public address.
//!
//! The limit: a relay on loopback or a private address that is published to the internet (an
//! embedded relay behind a TLS proxy or a DNAT, a `ws://127.0.0.1` port forwarded to a remote
//! relay, a resolver that hands out private stand-in addresses for a VPN or a proxy) looks
//! private, and it then hears the private addresses. Such a node sets `public_addrs_only`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use async_wsocket::Message;
use async_wsocket::futures_util::{Sink, SinkExt as _, Stream, StreamExt as _};
use nostr_sdk::prelude::{Error as NostrError, Url};
use nostr_sdk::transport::websocket::{
    DefaultWebsocketTransport, WebSocketSink, WebSocketStream, WebSocketTransport,
};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as NativeMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream as NativeStream};

pub use crate::relay_share::key as relay_key;

/// Private-only event ids remembered at once; past this the oldest go. An id is checked only
/// while its event can still be queued for a connection (seconds), and a node marks about one
/// a beacon period per video.
pub const MAX_PRIVATE_ONLY: usize = 16_384;

/// The `User-Agent` of every relay connection: what nostr-sdk's own transport sends, so that
/// this node's connections through [`ClassifyingTransport`] look like those of its other
/// nostr-sdk clients (the lookup answerer, the mesh endpoint). A test fails when a nostr-sdk
/// upgrade changes it.
const USER_AGENT: &str = "nostr-sdk/0.45.6";

/// Who may read what is sent to a relay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelayClass {
    /// Reached at an address of this host or its own networks: may hear private addresses.
    Private,
    /// Anyone on the internet, as far as this node knows.
    Public,
}

/// The class of a relay reached at `peer`: private when [`crate::node::is_local`] holds.
#[must_use]
pub fn class_of(peer: &SocketAddr) -> RelayClass {
    if crate::node::is_local(peer.ip()) {
        RelayClass::Private
    } else {
        RelayClass::Public
    }
}

/// How a connection's peer address is classed. The default is [`class_of`], the only one meant
/// for use; a test gives another to treat a loopback relay as public.
#[derive(Clone)]
pub struct Classifier(Arc<dyn Fn(&SocketAddr) -> RelayClass + Send + Sync>);

impl Classifier {
    pub fn new(f: impl Fn(&SocketAddr) -> RelayClass + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    #[must_use]
    pub fn class(&self, peer: &SocketAddr) -> RelayClass {
        (self.0)(peer)
    }
}

impl Default for Classifier {
    fn default() -> Self {
        Self::new(class_of)
    }
}

impl fmt::Debug for Classifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Classifier")
    }
}

/// Relay URLs split by class, each kept as given.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Split {
    pub private: Vec<String>,
    pub public: Vec<String>,
}

/// Live connections to one relay, by class.
#[derive(Debug, Default, Clone, Copy)]
struct Live {
    private: usize,
    public: usize,
}

#[derive(Default)]
struct PrivateOnly {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

struct Inner {
    classify: Classifier,
    live: Mutex<HashMap<String, Live>>,
    /// Relays public whatever address they are reached at ([`RelayClasses::pin_public`]).
    pinned: Mutex<HashSet<String>>,
    private_only: Mutex<PrivateOnly>,
}

/// The class of each relay, from the connections a [`ClassifyingTransport`] made, and the
/// events that must never cross a public connection. Cheap to clone: clones share one table,
/// so several clients (each built with [`RelayClasses::transport`]) can count together.
#[derive(Clone)]
pub struct RelayClasses(Arc<Inner>);

impl Default for RelayClasses {
    fn default() -> Self {
        Self::new(Classifier::default())
    }
}

impl fmt::Debug for RelayClasses {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let live = self.0.live.lock().unwrap_or_else(PoisonError::into_inner);
        f.debug_struct("RelayClasses")
            .field("relays", &live.len())
            .finish_non_exhaustive()
    }
}

impl RelayClasses {
    #[must_use]
    pub fn new(classify: Classifier) -> Self {
        Self(Arc::new(Inner {
            classify,
            live: Mutex::new(HashMap::new()),
            pinned: Mutex::new(HashSet::new()),
            private_only: Mutex::new(PrivateOnly::default()),
        }))
    }

    /// The transport to build a nostr-sdk client with
    /// (`ClientBuilder::websocket_transport`), so that its connections count here.
    #[must_use]
    pub fn transport(&self) -> ClassifyingTransport {
        ClassifyingTransport {
            classes: self.clone(),
        }
    }

    /// Take the relay at `url` for a public one whatever address it is reached at: a relay this
    /// host serves on every interface (an embedded relay bound to `0.0.0.0`) is reached at
    /// loopback, yet anyone who can reach the host can read it.
    pub fn pin_public(&self, url: &str) {
        self.0
            .pinned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(relay_key(url));
    }

    fn pinned(&self, key: &str) -> bool {
        self.0
            .pinned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(key)
    }

    /// The class of the relay at `url`, in any spelling ([`relay_key`]): private only while it
    /// has a live connection, every live connection to it reached a private address, and it is
    /// not pinned public ([`RelayClasses::pin_public`]).
    #[must_use]
    pub fn class(&self, url: &str) -> RelayClass {
        let key = relay_key(url);
        if self.pinned(&key) {
            return RelayClass::Public;
        }
        let live = self.0.live.lock().unwrap_or_else(PoisonError::into_inner);
        match live.get(&key) {
            Some(l) if l.private > 0 && l.public == 0 => RelayClass::Private,
            _ => RelayClass::Public,
        }
    }

    /// `urls` split by [`RelayClasses::class`], each kept as given and in order.
    pub fn partition(&self, urls: impl IntoIterator<Item = String>) -> Split {
        let mut split = Split::default();
        for url in urls {
            match self.class(&url) {
                RelayClass::Private => split.private.push(url),
                RelayClass::Public => split.public.push(url),
            }
        }
        split
    }

    /// Never let the event `id` (64 hex) cross a connection to a public address: it names
    /// private addresses. The newest [`MAX_PRIVATE_ONLY`] ids are kept.
    pub fn mark_private_only(&self, id: &str) {
        let mut p = self
            .0
            .private_only
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if p.ids.insert(id.to_owned()) {
            p.order.push_back(id.to_owned());
        }
        while p.order.len() > MAX_PRIVATE_ONLY {
            if let Some(old) = p.order.pop_front() {
                p.ids.remove(&old);
            }
        }
    }

    /// Whether `msg` is an `EVENT` message whose event is marked private-only.
    fn carries_private_only(&self, msg: &Message) -> bool {
        let p = self
            .0
            .private_only
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if p.ids.is_empty() {
            return false;
        }
        let Some(text) = msg.as_text() else {
            return false;
        };
        let Ok(serde_json::Value::Array(parts)) = serde_json::from_str(text) else {
            return false;
        };
        parts.first().and_then(serde_json::Value::as_str) == Some("EVENT")
            && parts
                .get(1)
                .and_then(|e| e.get("id"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|id| p.ids.contains(id))
    }

    /// Count a new connection to `key` of `class` until both halves are dropped, and guard
    /// what it sends.
    fn hold(
        &self,
        key: String,
        class: RelayClass,
        sink: WebSocketSink,
        stream: WebSocketStream,
    ) -> (WebSocketSink, WebSocketStream) {
        {
            let mut live = self.0.live.lock().unwrap_or_else(PoisonError::into_inner);
            let l = live.entry(key.clone()).or_default();
            match class {
                RelayClass::Private => l.private += 1,
                RelayClass::Public => l.public += 1,
            }
        }
        let conn = Arc::new(Conn {
            classes: self.clone(),
            key,
            class,
        });
        let sink: WebSocketSink = Box::pin(Guarded {
            inner: sink,
            conn: conn.clone(),
        });
        let stream: WebSocketStream = Box::pin(Held {
            inner: stream,
            _conn: conn,
        });
        (sink, stream)
    }
}

/// One live connection, counted in its relay's [`Live`] until dropped.
struct Conn {
    classes: RelayClasses,
    key: String,
    class: RelayClass,
}

impl Drop for Conn {
    fn drop(&mut self) {
        let mut live = self
            .classes
            .0
            .live
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(l) = live.get_mut(&self.key) {
            match self.class {
                RelayClass::Private => l.private = l.private.saturating_sub(1),
                RelayClass::Public => l.public = l.public.saturating_sub(1),
            }
            if l.private == 0 && l.public == 0 {
                live.remove(&self.key);
            }
        }
    }
}

/// A connection's sending half: a private-only event is refused on a public connection.
struct Guarded {
    inner: WebSocketSink,
    conn: Arc<Conn>,
}

impl Sink<Message> for Guarded {
    type Error = NostrError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready_unpin(cx)
    }

    fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        if self.conn.class == RelayClass::Public && self.conn.classes.carries_private_only(&item) {
            return Err(NostrError::transport(
                "an event that names private addresses, on a connection to a public address",
            ));
        }
        self.inner.start_send_unpin(item)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_flush_unpin(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_close_unpin(cx)
    }
}

/// A connection's receiving half, holding its count.
struct Held {
    inner: WebSocketStream,
    _conn: Arc<Conn>,
}

impl Stream for Held {
    type Item = Result<Message, NostrError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.poll_next_unpin(cx)
    }
}

/// nostr-sdk's websocket transport, but with the TCP connection made here, so that the
/// address it reached classes the relay ([`RelayClasses`]). The handshake is the one
/// nostr-sdk's default makes: `tokio-tungstenite`'s, with the same TLS and the same
/// `User-Agent`. Through a proxy, it is nostr-sdk's own, and the relay is public.
#[derive(Debug, Clone)]
pub struct ClassifyingTransport {
    classes: RelayClasses,
}

type Connected = Result<(WebSocketSink, WebSocketStream), NostrError>;

impl WebSocketTransport for ClassifyingTransport {
    fn support_ping(&self) -> bool {
        true
    }

    fn connect<'a>(
        &'a self,
        url: &'a Url,
        proxy: Option<SocketAddr>,
    ) -> Pin<Box<dyn Future<Output = Connected> + Send + 'a>> {
        Box::pin(async move {
            let key = relay_key(url.as_str());
            if proxy.is_some() {
                // The socket reaches the proxy, not the relay.
                let (sink, stream) = DefaultWebsocketTransport.connect(url, proxy).await?;
                return Ok(self.classes.hold(key, RelayClass::Public, sink, stream));
            }
            let host = url
                .host_str()
                .ok_or_else(|| NostrError::transport("relay URL without a host"))?;
            let port = url
                .port_or_known_default()
                .ok_or_else(|| NostrError::transport("relay URL without a port"))?;
            let tcp: TcpStream = tokio_happy_eyeballs::connect(format!("{host}:{port}"))
                .await
                .map_err(NostrError::transport)?;
            let class = match tcp.peer_addr() {
                Ok(peer) if !self.classes.pinned(&key) => self.classes.0.classify.class(&peer),
                _ => RelayClass::Public,
            };
            let mut request = url
                .as_str()
                .into_client_request()
                .map_err(NostrError::transport)?;
            request
                .headers_mut()
                .insert("user-agent", HeaderValue::from_static(USER_AGENT));
            let (ws, _) = Box::pin(tokio_tungstenite::client_async_tls(request, tcp))
                .await
                .map_err(NostrError::transport)?;
            let (tx, rx) = ws.split();
            let sink: WebSocketSink = Box::pin(NativeSink(tx));
            let stream: WebSocketStream = Box::pin(rx.filter_map(|m| {
                std::future::ready(match m {
                    Ok(m) => from_native(m).map(Ok),
                    Err(e) => Some(Err(NostrError::transport(e))),
                })
            }));
            Ok(self.classes.hold(key, class, sink, stream))
        })
    }
}

type NativeSplit = async_wsocket::futures_util::stream::SplitSink<
    NativeStream<MaybeTlsStream<TcpStream>>,
    NativeMessage,
>;

/// The sending half of a tungstenite connection, in nostr-sdk's message and error types.
struct NativeSink(NativeSplit);

impl Sink<Message> for NativeSink {
    type Error = NostrError;

    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_ready_unpin(cx).map_err(NostrError::transport)
    }

    fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        self.0
            .start_send_unpin(NativeMessage::from(item))
            .map_err(NostrError::transport)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_flush_unpin(cx).map_err(NostrError::transport)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.0.poll_close_unpin(cx).map_err(NostrError::transport)
    }
}

/// A received tungstenite message as nostr-sdk takes it. A raw frame is never read.
fn from_native(msg: NativeMessage) -> Option<Message> {
    Some(match msg {
        NativeMessage::Text(text) => Message::Text(text.to_string()),
        NativeMessage::Binary(data) => Message::Binary(data.to_vec()),
        NativeMessage::Ping(data) => Message::Ping(data.to_vec()),
        NativeMessage::Pong(data) => Message::Pong(data.to_vec()),
        NativeMessage::Close(frame) => Message::Close(frame.map(Into::into)),
        NativeMessage::Frame(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::time::Duration;

    use tokio::io::AsyncReadExt as _;
    use tokio::net::TcpListener;

    use super::*;

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    /// The two halves of a connection that sends nowhere and receives nothing.
    fn idle() -> (WebSocketSink, WebSocketStream) {
        use async_wsocket::futures_util::{sink, stream};
        let tx = sink::drain::<Message>()
            .sink_map_err(|e: std::convert::Infallible| -> NostrError { match e {} });
        let rx = stream::empty::<Result<Message, NostrError>>();
        (Box::pin(tx), Box::pin(rx))
    }

    #[test]
    fn a_relay_on_this_host_or_its_own_networks_is_private_and_any_other_is_public() {
        for private in [
            "127.0.0.1:7447",
            "127.8.9.10:7447",
            "[::1]:7447",
            "10.1.2.3:443",
            "172.16.0.1:443",
            "172.31.255.254:443",
            "192.168.1.20:443",
            "100.64.0.1:443",
            "100.127.255.254:443",
            "169.254.10.20:443",
            "[fe80::1]:443",
            "[fd7a:115c:a1e0::1]:443",
            "[fc00::5]:443",
            // An IPv4-mapped address is read as its IPv4 address.
            "[::ffff:192.168.1.20]:443",
        ] {
            assert_eq!(class_of(&sa(private)), RelayClass::Private, "{private}");
            // Never a relay that is private by this test and public by the beacon's.
            assert!(!crate::node::is_public(&sa(private)), "{private}");
        }
        for public in [
            "8.8.8.8:443",
            "[2001:4860:4860::8888]:443",
            "[::ffff:8.8.8.8]:443",
            "172.32.0.1:443",
            "100.128.0.1:443",
            "192.169.0.1:443",
            // Neither local nor public: a relay reached at one may be anywhere, so it is
            // public. Documentation and benchmarking blocks (a proxy's stand-in addresses),
            // NAT64 (an IPv6-only network reaching a public IPv4 relay), 6to4, Teredo, the
            // unspecified and multicast addresses.
            "192.0.2.10:443",
            "198.51.100.10:443",
            "203.0.113.10:443",
            "198.18.0.1:443",
            "[64:ff9b::808:808]:443",
            "[2002:c000:204::1]:443",
            "[2001:0:4136:e378:8000:63bf:3fff:fdd2]:443",
            "0.0.0.0:443",
            "[::]:443",
            "224.0.0.1:443",
            "[2001:db8::1]:443",
        ] {
            assert_eq!(class_of(&sa(public)), RelayClass::Public, "{public}");
        }
    }

    #[test]
    fn a_relay_never_connected_is_public_and_one_with_both_kinds_of_connection_too() {
        let classes = RelayClasses::default();
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Public);
        assert_eq!(classes.class("not a url"), RelayClass::Public);
        let up = |class| {
            let (sink, stream) = idle();
            classes.hold(relay_key("ws://127.0.0.1:7447/"), class, sink, stream)
        };
        let private = up(RelayClass::Private);
        // Any spelling of the URL.
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Private);
        assert_eq!(classes.class("WS://127.0.0.1:7447/"), RelayClass::Private);
        let public = up(RelayClass::Public);
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Public);
        drop(public);
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Private);
        // A connection is counted until both of its halves are gone.
        let (sink, stream) = private;
        drop(sink);
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Private);
        drop(stream);
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Public);
    }

    #[test]
    fn a_relay_pinned_public_is_public_however_it_is_reached() {
        let classes = RelayClasses::default();
        let (sink, stream) = idle();
        let _conn = classes.hold(
            relay_key("ws://127.0.0.1:7447"),
            RelayClass::Private,
            sink,
            stream,
        );
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Private);
        classes.pin_public("ws://127.0.0.1:7447/");
        assert_eq!(classes.class("ws://127.0.0.1:7447"), RelayClass::Public);
        assert!(
            classes
                .partition(["ws://127.0.0.1:7447".to_owned()])
                .private
                .is_empty()
        );
    }

    #[test]
    fn urls_are_split_by_class_in_order_as_given() {
        let classes = RelayClasses::default();
        let (s, r) = idle();
        let _a = classes.hold(relay_key("ws://127.0.0.1:1"), RelayClass::Private, s, r);
        let (s, r) = idle();
        let _b = classes.hold(relay_key("ws://10.0.0.1:2"), RelayClass::Private, s, r);
        let (s, r) = idle();
        let _c = classes.hold(relay_key("wss://relay.example"), RelayClass::Public, s, r);
        let urls = [
            "wss://relay.example/",
            "ws://127.0.0.1:1/",
            "wss://never.example",
            "ws://10.0.0.1:2",
        ]
        .map(String::from);
        assert_eq!(
            classes.partition(urls),
            Split {
                private: vec!["ws://127.0.0.1:1/".into(), "ws://10.0.0.1:2".into()],
                public: vec!["wss://relay.example/".into(), "wss://never.example".into()],
            }
        );
    }

    #[test]
    fn only_an_event_marked_private_only_is_caught_and_the_oldest_marks_go_first() {
        let classes = RelayClasses::default();
        let id = |n: usize| format!("{n:064x}");
        let event = |n: usize| Message::Text(format!(r#"["EVENT",{{"id":"{}","kind":1}}]"#, id(n)));
        assert!(!classes.carries_private_only(&event(1)));
        classes.mark_private_only(&id(1));
        assert!(classes.carries_private_only(&event(1)));
        assert!(classes.carries_private_only(&Message::Text(format!(
            r#"[ "EVENT" , {{ "kind": 1, "id": "{}" }} ]"#,
            id(1)
        ))));
        assert!(!classes.carries_private_only(&event(2)));
        // Not an EVENT, or not JSON: never caught.
        for other in [
            format!(r#"["REQ","{}",{{}}]"#, id(1)),
            format!(r#"["CLOSE","{}"]"#, id(1)),
            format!("not json {}", id(1)),
        ] {
            assert!(!classes.carries_private_only(&Message::Text(other)));
        }
        for n in 2..=MAX_PRIVATE_ONLY + 1 {
            classes.mark_private_only(&id(n));
        }
        assert!(!classes.carries_private_only(&event(1)), "the oldest went");
        assert!(classes.carries_private_only(&event(2)));
        assert!(classes.carries_private_only(&event(MAX_PRIVATE_ONLY + 1)));
    }

    /// A kind-1 event signed with a key made at run time.
    fn note(text: &str) -> nfx_proto::event::Event {
        let keys = nostr_sdk::prelude::Keys::generate();
        nfx_proto::event::Event::sign(
            &keys.secret_key().to_secret_bytes(),
            crate::unix_now(),
            1,
            vec![],
            text.to_owned(),
        )
        .unwrap()
    }

    /// Whether the relay at `url` holds the event `id`.
    async fn holds(url: &str, id: &str) -> bool {
        use nostr_sdk::prelude as ns;
        let client = ns::Client::default();
        client.add_relay(url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        let filter = ns::Filter::new().id(ns::EventId::from_hex(id).unwrap());
        let found = client
            .fetch_events(filter)
            .timeout(Duration::from_secs(3))
            .await
            .unwrap();
        client.shutdown().await;
        !found.is_empty()
    }

    /// A relay on loopback, through the real classifier and through one that calls every
    /// address public: an event marked private-only leaves only on the private connection.
    #[tokio::test]
    async fn a_private_only_event_never_leaves_on_a_connection_to_a_public_address() {
        use crate::nostr::Relays;
        let relay = nostr_sdk::prelude::LocalRelay::builder().build();
        relay.run().await.unwrap();
        let url = relay.url().await.to_string();
        let urls = std::slice::from_ref(&url);
        let wait = Duration::from_secs(10);
        let private = Relays::connect(urls, wait).await.unwrap();
        assert_eq!(private.classes().class(&url), RelayClass::Private);
        let public = Relays::connect_with(
            urls,
            wait,
            RelayClasses::new(Classifier::new(|_| RelayClass::Public)),
        )
        .await
        .unwrap();
        assert_eq!(public.classes().class(&url), RelayClass::Public);

        // An unmarked event goes out on either.
        let plain = note("plain");
        let sent = public.publish_to(&plain, urls).await.unwrap();
        assert!(sent.values().all(Result::is_ok), "{sent:?}");
        // A private-only one is not even tried on a relay that is public...
        let named = note("names a private address");
        let sent = public.publish_private(&named, urls).await.unwrap();
        assert!(sent.values().all(Result::is_err), "{sent:?}");
        // ...and sent there anyway, the public connection refuses to carry it.
        let sent = public.publish_to(&named, urls).await.unwrap();
        assert!(sent.values().all(Result::is_err), "{sent:?}");
        assert!(holds(&url, &plain.id).await);
        assert!(!holds(&url, &named.id).await, "it reached the relay");
        // The private connection carries it.
        let sent = private.publish_private(&named, urls).await.unwrap();
        assert!(sent.values().all(Result::is_ok), "{sent:?}");
        assert!(holds(&url, &named.id).await);
        private.shutdown().await;
        public.shutdown().await;
    }

    /// The `User-Agent` header of the first request on `listener`.
    async fn user_agent_of(listener: &TcpListener) -> Option<String> {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0u8; 4096];
        let mut len = 0;
        while len < request.len() && !request[..len].ends_with(b"\r\n\r\n") {
            let read = stream.read(&mut request[len..]).await.unwrap();
            if read == 0 {
                break;
            }
            len += read;
        }
        String::from_utf8_lossy(&request[..len])
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("user-agent")
                    .then(|| value.trim().to_owned())
            })
    }

    #[tokio::test]
    async fn the_handshake_says_what_nostr_sdks_own_transport_says() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
        let theirs = tokio::spawn(async move {
            let ua = user_agent_of(&listener).await;
            (listener, ua)
        });
        assert!(DefaultWebsocketTransport.connect(&url, None).await.is_err());
        let (listener, theirs) = theirs.await.unwrap();
        let ours = tokio::spawn(async move { user_agent_of(&listener).await });
        let classes = RelayClasses::default();
        assert!(classes.transport().connect(&url, None).await.is_err());
        let ours = ours.await.unwrap();
        assert!(theirs.is_some());
        assert_eq!(
            ours, theirs,
            "nostr-sdk's User-Agent changed: update relay_class::USER_AGENT"
        );
        // A handshake that failed is no connection.
        assert_eq!(classes.class(url.as_str()), RelayClass::Public);
    }
}
