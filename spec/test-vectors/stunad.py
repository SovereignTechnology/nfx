"""STUN servers named over Nostr (NFX-10 §1): the reference reader of STUN service
announcements (kind 33478) and the reference selection rules, and the vectors they classify.

`read_announcement` is NFX-10 §1's validity check of an announcement, `usable` the check of
an address a client may take from Nostr, and `select` the rules by which a client picks its
STUN servers. Every vector's verdict below is checked against them when the vectors are
generated.
"""

import hashlib
import ipaddress
import json
import re

KIND = 33478
MAX_TTL = 24 * 60 * 60
MAX_NETWORKS = 8
MAX_SERVERS = 4
FUTURE_SKEW = 15 * 60
CREATED_AT = 1_790_000_000
NOW = CREATED_AT + 10

NAMESPACE_RE = re.compile(r"nfx:[a-z0-9-]{2,32}:(0|[1-9][0-9]{0,19})")
UINT = re.compile(r"0|[1-9][0-9]*")


class Invalid(Exception):
    pass


def canonical_addr(text: str):
    """(ip, port) when `text` is an ip:port in the canonical form of the beacon `stun`
    endpoint (NFX-10 §1), else None: IPv4 dotted decimal, or a bracketed RFC 5952 IPv6
    address with no zone that does not carry IPv4 (mapped, or the deprecated ::a.b.c.d);
    a port of 1 to 65535 written as a plain decimal."""
    if text.startswith("["):
        host, sep, port = text[1:].partition("]:")
        if not sep:
            return None
        try:
            ip = ipaddress.IPv6Address(host)
        except ValueError:
            return None
        if "%" in host or ip.ipv4_mapped is not None or int(ip) >> 32 == 0:
            return None
    else:
        host, sep, port = text.rpartition(":")
        if not sep:
            return None
        try:
            ip = ipaddress.IPv4Address(host)
        except ValueError:
            return None
    if str(ip) != host or not UINT.fullmatch(port) or not 1 <= int(port) <= 65535:
        return None
    return ip, int(port)


def global_unicast(ip) -> bool:
    """NFX-10 §1: an address that points a client nowhere local, and that routes somewhere:
    the documentation blocks (RFC 5737, RFC 3849) are refused too."""
    if ip.version == 6:
        return (int(ip) >> 125) == 1 and (int(ip) >> 96) != 0x20010DB8  # 2000::/3, not 2001:db8::/32
    a, b, c, _ = ip.packed
    return not (a == 0 or a == 10 or a == 127 or a >= 224
                or (a == 100 and 64 <= b <= 127)
                or (a == 169 and b == 254)
                or (a == 172 and 16 <= b <= 31)
                or (a == 192 and b == 168)
                or (a == 192 and b == 0 and c in (0, 2))
                or (a == 198 and b in (18, 19))
                or (a == 198 and b == 51 and c == 100)
                or (a == 203 and b == 0 and c == 113))


def usable(addr: str) -> bool:
    parsed = canonical_addr(addr)
    return parsed is not None and global_unicast(parsed[0])


def verify_sig(event) -> bool:
    """The NIP-01 id and the BIP-340 signature."""
    from coincurve import PublicKeyXOnly
    ser = json.dumps([0, event["pubkey"], event["created_at"], event["kind"], event["tags"],
                      event["content"]], separators=(",", ":"), ensure_ascii=False).encode()
    digest = hashlib.sha256(ser).digest()
    if digest.hex() != event["id"]:
        return False
    try:
        return PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(bytes.fromhex(event["sig"]), digest)
    except Exception:
        return False


def is_namespace(text: str) -> bool:
    """NFX-01 §2: nfx:<network>:<specver>, network [a-z0-9-]{2,32}, specver a u64 decimal."""
    return NAMESPACE_RE.fullmatch(text) is not None and int(text.rsplit(":", 1)[1]) < 2**64


def single(event, name):
    found = [t for t in event["tags"] if t and t[0] == name]
    if not found:
        raise Invalid(f"missing `{name}`")
    if len(found) > 1:
        raise Invalid(f"duplicate `{name}`")
    if len(found[0]) < 2:
        raise Invalid(f"`{name}` has no value")
    return found[0][1]


def read_announcement(event, now):
    """NFX-10 §1: {operator, addr, networks, created_at, expiration} or Invalid."""
    if event["kind"] != KIND:
        raise Invalid("wrong kind")
    if not verify_sig(event):
        raise Invalid("bad signature")
    addr = single(event, "d")
    parsed = canonical_addr(addr)
    if parsed is None:
        raise Invalid("`d` is not an ip:port in canonical form")
    if not global_unicast(parsed[0]):
        raise Invalid("`d` is not global unicast")
    networks = []
    for t in event["tags"]:
        if t and t[0] == "n":
            if len(t) < 2:
                raise Invalid("`n` has no value")
            if not is_namespace(t[1]):
                raise Invalid("`n` is not a namespace")
            if t[1] in networks:
                raise Invalid("`n` repeated")
            networks.append(t[1])
    if not 1 <= len(networks) <= MAX_NETWORKS:
        raise Invalid("1 to 8 `n`")
    exp_text = single(event, "expiration")
    if not UINT.fullmatch(exp_text) or len(exp_text) > 20:
        raise Invalid("bad `expiration`")
    expiration = int(exp_text)
    created_at = event["created_at"]
    if expiration <= created_at:
        raise Invalid("`expiration` not after `created_at`")
    if expiration - created_at > MAX_TTL:
        raise Invalid("`expiration` more than 24 h after `created_at`")
    if created_at > now + FUTURE_SKEW:
        raise Invalid("`created_at` more than 15 min ahead")
    if expiration <= now:
        raise Invalid("expired")
    if event["content"] != "":
        raise Invalid("content not empty")
    return {"operator": event["pubkey"], "addr": addr, "networks": networks,
            "created_at": created_at, "expiration": expiration}


def select(own, named, maximum=MAX_SERVERS):
    """NFX-10 §1: the client's own servers first; then usable named servers that are not its
    own, ranked by distinct keys (ties: first named); a server named by one key only when
    the client has none of its own and no named server has two keys; at most `maximum`."""
    out = []
    for s in own:
        if len(out) < maximum and s not in out:
            out.append(s)
    ranked = {}  # dicts keep insertion order: first named first
    for key, addr in named:
        if not usable(addr) or addr in own:
            continue
        ranked.setdefault(addr, set()).add(key)
    order = sorted(ranked.items(), key=lambda kv: -len(kv[1]))  # stable
    corroborated = bool(order) and len(order[0][1]) >= 2
    lone_ok = not own and not corroborated
    for addr, keys in order:
        if len(out) >= maximum:
            break
        if len(keys) >= 2 or lone_ok:
            out.append(addr)
    return out


def stunad_vectors(keypair, nostr_event) -> dict:
    """NFX-10 §1 vectors. `keypair(seed)` and `nostr_event(sk, kind, tags, content,
    created_at)` are generate.py's helpers."""
    operator = keypair("nfx-test-vector/stun-operator")
    secret = hashlib.sha256(b"nfx-test-vector/stun-operator").hexdigest()

    def tags(d="1.1.1.1:3478", networks=("nfx:mainnet:1",), ttl=MAX_TTL,
             created_at=CREATED_AT):
        return ([["d", d]] + [["n", n] for n in networks]
                + [["expiration", str(created_at + ttl)]])

    def event(t, created_at=CREATED_AT, content="", kind=KIND):
        return nostr_event(operator, kind, t, content, created_at)

    eight = [f"nfx:net-{i}:1" for i in range(1, 9)]
    valid = [
        ("ipv4-one-network", "what nfxd stun --announce sends: 24 h, one network", event(tags())),
        ("ipv6-two-networks", "a bracketed IPv6 server for two networks, 12 h",
         event(tags(d="[2606:4700::1111]:3478", networks=("nfx:mainnet:1", "nfx:testnet:1"),
                    ttl=MAX_TTL // 2))),
        ("eight-networks-unknown-tag", "8 networks, the most; a tag readers do not know",
         event(tags(d="1.0.0.1:19302", networks=eight) + [["x-future", "ignored"]])),
        ("one-minute", "a short life is allowed", event(tags(ttl=60))),
        ("signed-ahead", "created_at 15 min ahead of now, the most allowed",
         event(tags(created_at=NOW + FUTURE_SKEW), created_at=NOW + FUTURE_SKEW)),
    ]
    valid_out = []
    for name, reason, ev in valid:
        valid_out.append({"name": name, "reason": reason, "event": ev,
                          "reads_as": read_announcement(ev, NOW)})

    def with_tag(name, *values):
        return [t if t[0] != name else [name, *values] for t in tags()]

    def without(name):
        return [t for t in tags() if t[0] != name]

    bad_sig = event(tags())
    bad_sig = dict(bad_sig, sig=bad_sig["sig"][:-2] + ("00" if bad_sig["sig"][-2:] != "00" else "01"))
    invalid = [
        ("wrong-kind", "kind 33478 only", event(tags(), kind=33477)),
        ("bad-signature", "the NIP-01 signature must verify", bad_sig),
        ("d-missing", "exactly one d", event(without("d"))),
        ("d-twice", "exactly one d", event(tags() + [["d", "1.0.0.1:3478"]])),
        ("d-private", "global unicast only", event(with_tag("d", "192.168.1.2:3478"))),
        ("d-loopback", "global unicast only", event(with_tag("d", "127.0.0.1:3478"))),
        ("d-shared", "global unicast only (100.64/10)", event(with_tag("d", "100.64.0.1:3478"))),
        ("d-link-local", "global unicast only", event(with_tag("d", "169.254.1.1:3478"))),
        ("d-multicast", "global unicast only", event(with_tag("d", "224.0.0.1:3478"))),
        ("d-broadcast", "global unicast only", event(with_tag("d", "255.255.255.255:3478"))),
        ("d-ipv6-unique-local", "global unicast only (2000::/3)", event(with_tag("d", "[fd00::1]:3478"))),
        ("d-ipv6-link-local", "global unicast only (2000::/3)", event(with_tag("d", "[fe80::1]:3478"))),
        ("d-documentation-ipv4", "a documentation address routes nowhere (RFC 5737)",
         event(with_tag("d", "203.0.113.10:3478"))),
        ("d-documentation-ipv6", "a documentation address routes nowhere (RFC 3849)",
         event(with_tag("d", "[2001:db8::1]:3478"))),
        ("d-hostname", "an IP address, not a name", event(with_tag("d", "stun.example:3478"))),
        ("d-url", "an address, not a stun: URL", event(with_tag("d", "stun:1.1.1.1:3478"))),
        ("d-no-port", "ip:port", event(with_tag("d", "1.1.1.1"))),
        ("d-port-zero", "the port is not 0", event(with_tag("d", "1.1.1.1:0"))),
        ("d-ipv4-leading-zero", "canonical text form", event(with_tag("d", "1.1.1.01:3478"))),
        ("d-ipv6-uppercase", "RFC 5952: lowercase", event(with_tag("d", "[2606:4700::AAAA]:3478"))),
        ("d-ipv4-mapped", "IPv4 is never written inside IPv6", event(with_tag("d", "[::ffff:1.1.1.1]:3478"))),
        ("n-missing", "1 to 8 n", event(without("n"))),
        ("n-nine", "1 to 8 n", event(tags(networks=eight + ["nfx:net-9:1"]))),
        ("n-repeated", "distinct n", event(tags(networks=("nfx:mainnet:1", "nfx:mainnet:1")))),
        ("n-not-a-namespace", "each n is a namespace (NFX-01 §2)", event(with_tag("n", "nutflix:mainnet:1"))),
        ("n-no-value", "each n has a value", event(with_tag("n"))),
        ("expiration-missing", "exactly one expiration", event(without("expiration"))),
        ("expiration-twice", "exactly one expiration",
         event(tags() + [["expiration", str(CREATED_AT + 60)]])),
        ("expiration-not-decimal", "a plain decimal", event(with_tag("expiration", f"{CREATED_AT + 60}.0"))),
        ("expiration-leading-zero", "a plain decimal", event(with_tag("expiration", f"0{CREATED_AT + 60}"))),
        ("expiration-at-created-at", "after created_at", event(tags(ttl=0))),
        ("expiration-over-24h", "at most 24 h after created_at", event(tags(ttl=MAX_TTL + 1))),
        ("expired", "expiration after now", event(tags(ttl=10))),
        ("created-at-far-ahead", "created_at at most 15 min ahead of now",
         event(tags(ttl=60, created_at=NOW + FUTURE_SKEW + 1), created_at=NOW + FUTURE_SKEW + 1)),
        ("content-not-empty", "empty content", event(tags(), content="free STUN!")),
    ]
    invalid_out = []
    for name, reason, ev in invalid:
        try:
            read_announcement(ev, NOW)
        except Invalid:
            invalid_out.append({"name": name, "reason": reason, "event": ev})
            continue
        raise AssertionError(f"stun-announcement invalid case {name} reads as valid")

    # ---- selection (NFX-10 §1) ----
    # Global unicast addresses that route (no traffic is ever sent to them by a vector).
    x, y, z = "1.1.1.1:3478", "1.0.0.1:3478", "8.8.8.8:3478"
    own_a = "9.9.9.9:3478"
    six = [f"1.1.1.{i}:3478" for i in range(11, 17)]
    documentation = ["192.0.2.1:3478", "198.51.100.7:3478", "203.0.113.10:3478",
                     "[2001:db8::1]:3478", "[2001:db8:ffff::1]:3478"]
    refused = ["10.0.0.1:3478", "127.0.0.1:3478", "192.168.1.1:3478", "100.64.0.1:3478",
               "169.254.1.1:3478", "172.16.0.1:3478", "192.0.0.1:3478", "198.18.0.1:3478",
               "224.0.0.1:3478", "255.255.255.255:3478", "0.0.0.0:3478", "[::1]:3478",
               "[fe80::1]:3478", "[fd00::1]:3478", "[ff02::1]:3478",
               "1.1.1.01:3478", "[::ffff:1.1.1.1]:3478", "1.1.1.1:0",
               "stun.example:3478", "stun:1.1.1.1:3478"] + documentation
    cases = [
        ("nothing", "no server of its own and none named", [], [], []),
        ("own-only", "its own servers, as given", [own_a, x], [], [own_a, x]),
        ("own-repeated", "its own servers, each once", [own_a, own_a], [], [own_a]),
        ("own-over-max", "at most 4 in all, its own first",
         six[:5], [], six[:4]),
        ("lone-key-alone", "a server named by one key, when nothing better exists", [],
         [["k1", x]], [x]),
        ("lone-key-twice", "a key counts once, however often it names a server", [],
         [["k1", x], ["k1", x], ["k1", y]], [x, y]),
        ("lone-key-beside-own", "one key adds no server beside the client's own", [own_a],
         [["k1", x]], [own_a]),
        ("lone-key-beside-corroborated", "one key adds no server beside one named by two", [],
         [["k1", x], ["k2", y], ["k3", y]], [y]),
        ("corroborated-beside-own", "a server named by two keys comes after the client's own",
         [own_a], [["k1", x], ["k2", x], ["k3", y]], [own_a, x]),
        ("ranked-by-distinct-keys", "most keys first; ties in the order first named", [],
         [["k1", x], ["k1", y], ["k2", y], ["k3", y], ["k2", x], ["k4", z], ["k5", z], ["k6", z],
          ["k6", z]], [y, z, x]),
        ("at-most-four", "at most 4 in all", [own_a],
         [[f"k{j}-{i}", a] for i, a in enumerate(six) for j in (1, 2)], [own_a] + six[:3]),
        ("named-equal-to-own", "a named server that is the client's own is its own, once", [x],
         [["k1", x], ["k2", x], ["k3", y], ["k4", y]], [x, y]),
        ("ipv6", "a global unicast IPv6 server", [],
         [["k1", "[2606:4700::1111]:3478"], ["k2", "[2606:4700::1111]:3478"]], ["[2606:4700::1111]:3478"]),
        ("documentation-refused", "documentation addresses (RFC 5737, RFC 3849) route nowhere: never "
         "taken from Nostr, however many keys name them, and a lone key's routable server is "
         "taken instead", [],
         [[k, a] for a in documentation for k in ("k1", "k2")] + [["k3", x]], [x]),
        ("not-public-refused", "named addresses that are not global unicast, or not canonical, are "
         "never taken, however many keys name them", [],
         [[k, a] for a in refused for k in ("k1", "k2")], []),
        ("not-public-beside-a-lone-key", "a refused address does not count as something better", [],
         [["k1", "10.0.0.1:3478"], ["k2", "10.0.0.1:3478"], ["k3", x]], [x]),
    ]
    select_out = []
    for name, reason, own, named, want in cases:
        got = select(own, [tuple(p) for p in named])
        assert got == want, f"stun-select {name}: {got} != {want}"
        select_out.append({"name": name, "reason": reason, "own": own, "named": named,
                           "selected": want})

    yes = ["8.8.8.8:3478", "1.1.1.1:3478", "100.63.255.255:3478", "100.128.0.0:3478",
           "172.15.255.255:3478", "172.32.0.0:3478", "192.0.1.255:3478", "192.0.3.0:3478",
           "198.17.255.255:3478", "198.20.0.0:3478", "198.51.99.255:3478", "198.51.101.0:3478",
           "203.0.112.255:3478", "203.0.114.0:3478", "223.255.255.255:3478",
           "[2606:4700::1111]:3478", "[2001:db7:ffff::1]:3478", "[2001:db9::1]:3478",
           "[2a01:4f8::1]:3478", "[3fff:ffff::1]:3478"]
    no = refused + ["[4000::1]:3478", "240.0.0.1:3478", "[::]:3478"]
    for a in yes:
        assert usable(a), a
    for a in no:
        assert not usable(a), a

    return {
        "stun-announcement.json": {
            "description": "NFX-10 §1 STUN service announcements: kind 33478, addressable, signed by the "
                           "operator of a STUN server, checked at 'now'. Tags: exactly one 'd', the server's "
                           "ip:port in the canonical form of the beacon 'stun' endpoint, and global unicast (not a "
                           "documentation address either); "
                           "1 to 8 distinct 'n', each a namespace; exactly one 'expiration', a plain decimal "
                           "with created_at < expiration <= created_at + 86400, after 'now'; created_at at most "
                           "900 s ahead of 'now'; empty content; other tags ignored. A reader MUST accept every "
                           "'valid' event, reading it as 'reads_as', and MUST reject every 'invalid' one. A "
                           "scoped relay that admits kind 33478 (NFX-04 §1) admits the valid ones when it "
                           "serves one of their networks, and refuses the invalid ones.",
            "secret_keys_DO_NOT_USE": {"operator": secret},
            "now": NOW,
            "valid": valid_out,
            "invalid": invalid_out,
        },
        "stun-select.json": {
            "description": "NFX-10 §1 STUN server selection. 'own' are the client's own servers; 'named' "
                           "are [key, address] pairs, in the order heard, from live beacons' stun endpoints "
                           "(the beacon's signer) and live announcements (the operator). 'selected' is what "
                           "the client uses, in order: its own first, each once; then the named addresses "
                           "that are global unicast in canonical form and not its own, ranked by the number "
                           "of distinct keys naming each (most first, ties in the order first named); an "
                           "address named by one key only when the client has none of its own and no named "
                           "address has two or more keys; at most 'max' in all. 'global_unicast' lists "
                           "addresses a client may and may not take from Nostr. Global unicast here also "
                           "excludes the documentation blocks (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, "
                           "2001:db8::/32), which route nowhere; beacons that name them in a stun endpoint "
                           "stay valid beacons (beacon-stun.json), and only this selection refuses them. "
                           "No traffic is ever sent to an address of a vector.",
            "max": MAX_SERVERS,
            "cases": select_out,
            "global_unicast": {"yes": yes, "no": no},
        },
    }
