#!/usr/bin/env python3
"""NFX test-vector generator/verifier (NFX-11 §7).

Regenerates every vector deterministically:
  - keys derived from published seed phrases (NOT secure; never reuse)
  - fixed timestamps
  - BIP340 signatures with aux_rand = 32 zero bytes

Usage:
  python3 generate.py            # (re)write vectors
  python3 generate.py --verify   # recompute and compare against the files on disk

Requires: coincurve, pynacl and blake3 (pip install coincurve pynacl blake3). No network
access.
"""

import argparse
import base64
import copy
import hashlib
import ipaddress
import json
import sys
from pathlib import Path

import blake3

import nacl.bindings as sodium
import nacl.exceptions
from coincurve import PrivateKey, PublicKey

HERE = Path(__file__).resolve().parent

CREATED_AT = 1_790_000_000  # fixed; exact date is irrelevant
NAMESPACE = "nfx:mainnet:1"
VIDEO_ID = "salt-flats-dusk"
TTL = 120
MAX_SAFE_INT = 2**53 - 1


def uvarint(n: int) -> bytes:
    """Unsigned LEB128, postcard's integer encoding."""
    out = bytearray()
    while True:
        byte, n = n & 0x7F, n >> 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def blob_ticket(endpoint_id: bytes, relay_url: str | None, direct: list[str], fmt: int,
                hash32: bytes) -> tuple[str, bytes]:
    """NFX-06 §2 ticket string: an iroh-blobs 0.103 BlobTicket, encoded independently of
    iroh from the documented layout (the Rust vector test decodes and re-encodes it with
    iroh itself).

    bytes = 0x00 (variant 0) || endpoint_id[32] || relay (0x00 | 0x01 uvarint(len) utf8)
            || uvarint(n) || n x (0x00 ipv4[4] | 0x01 ipv6[16]) uvarint(port)
            || uvarint(format: 0 raw, 1 hash_seq) || hash[32]
    string = "blob" || lowercase(base32(bytes), RFC 4648, no padding)
    Direct addresses are sorted (IPv4 before IPv6, then address, then port) and unique.
    """
    assert len(endpoint_id) == 32 and len(hash32) == 32
    b = bytearray(uvarint(0))
    b += endpoint_id
    if relay_url is None:
        b += b"\x00"
    else:
        u = relay_url.encode()
        b += b"\x01" + uvarint(len(u)) + u
    addrs = []
    for a in direct:
        host, port = a.rsplit(":", 1)
        ip = ipaddress.ip_address(host.strip("[]"))
        addrs.append((ip.version, ip.packed, int(port)))
    addrs = sorted(set(addrs))
    b += uvarint(len(addrs))
    for version, packed, port in addrs:
        b += uvarint(0 if version == 4 else 1) + packed + uvarint(port)
    b += uvarint(fmt)
    b += hash32
    raw = bytes(b)
    return "blob" + base64.b32encode(raw).decode().rstrip("=").lower(), raw


def keypair(seed: str) -> PrivateKey:
    secret = hashlib.sha256(seed.encode()).digest()
    return PrivateKey(secret)


def schnorr_id_pubkey(pk: PrivateKey):
    """Nostr pubkey (x-only hex)."""
    return pk.public_key.format(compressed=True)[1:].hex()


def nostr_event(sk: PrivateKey, kind: int, tags: list, content: str, created_at: int):
    pubkey = schnorr_id_pubkey(sk)
    ser = json.dumps([0, pubkey, created_at, kind, tags, content],
                     separators=(",", ":"), ensure_ascii=False).encode()
    event_id = hashlib.sha256(ser).digest()
    sig = sk.sign_schnorr(event_id, aux_randomness=bytes(32))
    return {
        "id": event_id.hex(),
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig.hex(),
    }


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---- canon (NFX-11 §9): the reference implementation ----

class NonCanonical(ValueError):
    pass


def _reject_float(text):
    raise NonCanonical(f"non-integer number {text!r}")


def _checked_int(text):
    if text == "-0":
        raise NonCanonical("-0")
    value = int(text)
    if not -MAX_SAFE_INT <= value <= MAX_SAFE_INT:
        raise NonCanonical(f"integer out of range {text}")
    return value


def _reject_constant(text):
    raise NonCanonical(f"non-JSON constant {text}")


def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise NonCanonical(f"duplicate key {key!r}")
        out[key] = value
    return out


def canon_loads(text: str):
    """Parse received JSON text under the canon rules (reject, never normalize)."""
    return json.loads(text, object_pairs_hook=_no_duplicates, parse_float=_reject_float,
                      parse_int=_checked_int, parse_constant=_reject_constant)


def canon(value) -> bytes:
    def check(v):
        if isinstance(v, bool) or v is None or isinstance(v, str):
            return
        if isinstance(v, int):
            if not -MAX_SAFE_INT <= v <= MAX_SAFE_INT:
                raise NonCanonical("integer out of range")
            return
        if isinstance(v, float):
            raise NonCanonical("float")
        if isinstance(v, list):
            for item in v:
                check(item)
            return
        if isinstance(v, dict):
            for item in v.values():
                check(item)
            return
        raise NonCanonical(f"unsupported type {type(v)}")

    check(value)
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=False, allow_nan=False).encode("utf-8")
    except UnicodeEncodeError as e:  # lone surrogate
        raise NonCanonical("lone surrogate") from e


def sign_canon(sk: PrivateKey, body: dict) -> tuple[bytes, bytes, str]:
    text = canon(body)
    digest = hashlib.sha256(text).digest()
    return text, digest, sk.sign_schnorr(digest, aux_randomness=bytes(32)).hex()


def render_hashlist(hashlist: dict) -> bytes:
    return json.dumps(hashlist, indent=2, ensure_ascii=False).encode() + b"\n"


# ---- pay/1 (NFX-07 §2): the reference reader, and the vectors it classifies ----

PAY1_MAX_LINE_BYTES = 32 * 1024
PAY1_MAX_DEPTH = 16
PAY1_MAX_MINTS = 16
PAY1_MAX_DETAIL_BYTES = 1024
# NFX-07 §2: what `rej.detail` may not contain (controls, and characters that are
# invisible or reorder text).
PAY1_DETAIL_FORBIDDEN = (
    (0x0000, 0x001F), (0x007F, 0x009F), (0x00AD, 0x00AD), (0x061C, 0x061C),
    (0x180E, 0x180E), (0x200B, 0x200F), (0x2028, 0x202E), (0x2060, 0x2064),
    (0x2066, 0x206F), (0xFEFF, 0xFEFF), (0xFFF9, 0xFFFB), (0xE0000, 0xE007F),
)
PAY1_TOKEN_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_=+/-")
PAY1_HOST_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-")
PAY1_V6_CHARS = set("0123456789abcdefABCDEF:.")


class Pay1Error(ValueError):
    pass


def pay1_mint_ok(url: str, allow_loopback_http: bool) -> bool:
    if not url or not all(0x21 <= ord(c) <= 0x7E and c not in "\\@" for c in url):
        return False
    if url.startswith("https://"):
        rest, loopback_only = url[len("https://"):], False
    elif allow_loopback_http and url.startswith("http://"):
        rest, loopback_only = url[len("http://"):], True
    else:
        return False
    end = min([i for i in (rest.find("/"), rest.find("?"), rest.find("#")) if i >= 0], default=len(rest))
    authority = rest[:end]
    if authority.startswith("["):
        close = authority.find("]")
        if close < 0:
            return False
        host, after = authority[:close + 1], authority[close + 1:]
        inner = host[1:-1]
        if not 2 <= len(inner) <= 45 or not set(inner) <= PAY1_V6_CHARS:
            return False
    else:
        host, _, port = authority.partition(":")
        after = ":" + port if ":" in authority else ""
        if not 1 <= len(host) <= 253 or not set(host) <= PAY1_HOST_CHARS:
            return False
    if after:
        port = after[1:]
        if not after.startswith(":") or not 1 <= len(port) <= 5 or not port.isdigit() \
                or not port.isascii() or not 1 <= int(port) <= 65535:
            return False
    if loopback_only:
        return host in ("127.0.0.1", "localhost", "[::1]")
    return True


def pay1_depth(v, level=1) -> int:
    if isinstance(v, dict):
        return max([pay1_depth(x, level + 1) for x in v.values()], default=level)
    if isinstance(v, list):
        return max([pay1_depth(x, level + 1) for x in v], default=level)
    return level - 1


def pay1_parse(wire: str, allow_loopback_http: bool = False) -> dict:
    """Parse one pay/1 line (without its newline) as NFX-07 §2 says, or raise Pay1Error.
    Returns the message's known fields."""
    if len(wire.encode("utf-8", "surrogatepass")) + 1 > PAY1_MAX_LINE_BYTES:
        raise Pay1Error("a line is at most 32 KiB")
    try:
        obj = canon_loads(wire)
        canon(obj)  # lone surrogates
    except (ValueError, NonCanonical) as e:
        raise Pay1Error(f"not JSON under NFX-11 §9: {e}") from e
    if not isinstance(obj, dict):
        raise Pay1Error("not an object")
    if pay1_depth(obj) > PAY1_MAX_DEPTH:
        raise Pay1Error("nested too deep")

    def integer(name):
        v = obj.get(name)
        if v is None:
            raise Pay1Error(f"missing {name}")
        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_SAFE_INT:
            raise Pay1Error(f"{name} is a non-negative integer")
        return v

    def string(name):
        v = obj.get(name)
        if v is None:
            raise Pay1Error(f"missing {name}")
        if not isinstance(v, str):
            raise Pay1Error(f"{name} is a string")
        return v

    t = string("t")
    if t == "hello":
        video, session = string("video"), string("session")
        ns, _, vid = video.rpartition(":")
        parts = ns.split(":")
        if not (len(parts) == 3 and parts[0] == "nfx"
                and 2 <= len(parts[1]) <= 32 and set(parts[1]) <= set("abcdefghijklmnopqrstuvwxyz0123456789-")
                and parts[2].isdigit() and parts[2].isascii() and (parts[2] == "0" or parts[2][0] != "0")
                and 7 <= len(vid) <= 63 and vid[0] in "abcdefghijklmnopqrstuvwxyz0123456789"
                and set(vid) <= set("abcdefghijklmnopqrstuvwxyz0123456789-")):
            raise Pay1Error("video is an NFX address")
        if len(session) != 32 or not set(session) <= set("0123456789abcdef"):
            raise Pay1Error("session is 32 lowercase hex")
        return {"t": t, "video": video, "session": session}
    if t == "quote":
        out = {"t": t}
        for name in ("price_per_chunk", "window", "served", "accepted_upto", "spent_total"):
            out[name] = integer(name)
        if out["price_per_chunk"] < 1 or out["window"] < 1:
            raise Pay1Error("price_per_chunk and window are at least 1")
        mints = obj.get("mints")
        if not isinstance(mints, list) or not 1 <= len(mints) <= PAY1_MAX_MINTS:
            raise Pay1Error("mints is 1 to 16 URLs")
        if not all(isinstance(m, str) and pay1_mint_ok(m, allow_loopback_http) for m in mints):
            raise Pay1Error("mint URL")
        out["mints"] = mints
        return out
    if t == "pay":
        upto, token = integer("upto_chunk"), string("token")
        if upto < 1:
            raise Pay1Error("upto_chunk >= 1")
        if not (token.startswith(("cashuA", "cashuB")) and len(token) > 6
                and set(token[6:]) <= PAY1_TOKEN_CHARS):
            raise Pay1Error("token is a NUT-00 token")
        return {"t": t, "upto_chunk": upto, "token": token}
    if t == "ack":
        return {"t": t, "accepted_upto": integer("accepted_upto"), "spent_total": integer("spent_total")}
    if t == "rej":
        code = string("code")
        if not 1 <= len(code) <= 64 or not set(code) <= set("abcdefghijklmnopqrstuvwxyz0123456789-"):
            raise Pay1Error("code is 1 to 64 of [a-z0-9-]")
        out = {"t": t, "code": code}
        if "detail" in obj:
            detail = obj["detail"]
            if not isinstance(detail, str) or len(detail.encode()) > PAY1_MAX_DETAIL_BYTES \
                    or any(lo <= ord(c) <= hi for c in detail for lo, hi in PAY1_DETAIL_FORBIDDEN):
                raise Pay1Error("detail")
            out["detail"] = detail
        return out
    raise Pay1Error("unknown t")


def pay1_vectors() -> dict:
    """NFX-07 §2: pay/1 wire messages. Each `wire` is one NDJSON line without its newline.
    Every verdict is checked against the reference reader above."""
    line = lambda obj: json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    video = "nfx:mainnet:1:salt-flats-dusk"
    session = "0123456789abcdef0123456789abcdef"
    def quote(mints, **kw):
        q = {"t": "quote", "price_per_chunk": 1, "mints": mints, "window": 8,
             "served": 0, "accepted_upto": 0, "spent_total": 0}
        q.update(kw)
        return q
    q1 = lambda mint: line(quote([mint]))
    # A pay line of exactly `n` bytes (the line limit counts the newline too).
    def pay_of(n):
        base = line({"t": "pay", "upto_chunk": 1, "token": "cashuB"})
        return line({"t": "pay", "upto_chunk": 1, "token": "cashuB" + "a" * (n - len(base))})
    at_limit, over_limit = pay_of(32767), pay_of(32768)
    assert len(at_limit.encode()) == 32767 and len(over_limit.encode()) == 32768
    def nested(levels):  # an unknown field nesting the message to `levels` levels in total
        v = 0
        for _ in range(levels - 1):
            v = [v]
        return line({"t": "ack", "accepted_upto": 1, "spent_total": 1, "x-future": v})
    no_quote = lambda *drop: line({k: v for k, v in quote(["https://mint.example"]).items() if k not in drop})
    valid = [
        ("hello", line({"t": "hello", "video": video, "session": session})),
        ("quote", q1("https://mint.example")),
        ("quote-resumed-account", line(quote(["https://mint.example"], served=40, accepted_upto=36, spent_total=36))),
        ("quote-ipv6-host", q1("https://[2001:db8::1]:3338")),
        ("quote-port-and-path", q1("https://mint.example:3338/cashu/api?x=1#y")),
        ("quote-sixteen-mints", line(quote([f"https://m{i}.example" for i in range(16)]))),
        ("pay", line({"t": "pay", "upto_chunk": 17, "token": "cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb20="})),
        ("pay-cashuA-base64", line({"t": "pay", "upto_chunk": 1, "token": "cashuAeyJ0b2tlbiI6W119+/_-"})),
        ("ack", line({"t": "ack", "accepted_upto": 17, "spent_total": 17})),
        ("rej", line({"t": "rej", "code": "underpaid", "detail": "short by 2 sat"})),
        ("rej-mint-unavailable", line({"t": "rej", "code": "mint-unavailable"})),
        ("rej-unknown-code-no-detail", line({"t": "rej", "code": "some-future-code"})),
        ("rej-detail-1024-bytes-of-emoji", line({"t": "rej", "code": "stale", "detail": "\U0001F600" * 256})),
        ("rej-detail-accents-and-cjk", line({"t": "rej", "code": "stale", "detail": "café 支払い"})),
        ("hello-unknown-field", line({"t": "hello", "video": video, "session": session, "x-future": 1})),
        ("nested-16-levels", nested(16)),
        ("max-safe-integer", line({"t": "ack", "accepted_upto": 9007199254740991, "spent_total": 0})),
        ("line-of-32767-bytes", at_limit),
    ]
    loopback = [
        ("quote-loopback-ipv4", line(quote(["http://127.0.0.1:3338"], price_per_chunk=2, window=1))),
        ("quote-loopback-name", q1("http://localhost:3338/")),
        ("quote-loopback-ipv6", q1("http://[::1]:3338")),
    ]
    invalid = [
        ("not-json", "hello", "not JSON"),
        ("not-an-object", line([1, 2]), "not an object"),
        ("no-t", line({"video": video, "session": session}), "missing t"),
        ("unknown-t", line({"t": "tip", "amount": 1}), "unknown t"),
        ("duplicate-t", '{"t":"pay","t":"ack","accepted_upto":1,"spent_total":1,"upto_chunk":1,"token":"cashuBx"}', "no duplicate keys"),
        ("duplicate-upto", '{"t":"pay","upto_chunk":1,"upto_chunk":99,"token":"cashuBx"}', "no duplicate keys"),
        ("nested-17-levels", nested(17), "at most 16 levels"),
        ("session-short", line({"t": "hello", "video": video, "session": session[:-1]}), "session is 32 lowercase hex"),
        ("session-uppercase", line({"t": "hello", "video": video, "session": session.upper()}), "session is 32 lowercase hex"),
        ("bad-video", line({"t": "hello", "video": "mainnet:salt", "session": session}), "video is an NFX address"),
        ("quote-no-mints", line(quote([])), "mints is 1 to 16 URLs"),
        ("quote-17-mints", line(quote([f"https://m{i}.example" for i in range(17)])), "mints is 1 to 16 URLs"),
        ("quote-missing-served", no_quote("served"), "the account position is required"),
        ("quote-missing-accepted-upto", no_quote("accepted_upto"), "the account position is required"),
        ("quote-missing-spent-total", no_quote("spent_total"), "the account position is required"),
        ("mint-http", q1("http://mint.example"), "mint must be https"),
        ("mint-empty-host", q1("https://:443"), "mint needs a host"),
        ("mint-backslash", q1("https://evil.example\\.mint.example"), "no backslash"),
        ("mint-at", q1("https://mint.example@evil.example"), "no @"),
        ("mint-space", q1("https://mint.example/a b"), "printable ASCII without space"),
        ("mint-rlo", q1("https://mint‮elpmaxe.example"), "printable ASCII only"),
        ("mint-zero-width", q1("https://mi​nt.example"), "printable ASCII only"),
        ("mint-underscore-host", q1("https://mi_nt.example"), "host is [A-Za-z0-9.-]"),
        ("mint-unclosed-ipv6", q1("https://[2001:db8::1"), "an IPv6 literal closes with ]"),
        ("mint-bad-ipv6", q1("https://[x]"), "an IPv6 literal is hex, colons and dots"),
        ("mint-two-colons", q1("https://a:b:c"), "a port is digits"),
        ("mint-port-empty", q1("https://mint.example:/x"), "a port is 1 to 5 digits"),
        ("mint-port-zero", q1("https://mint.example:0"), "a port is 1 to 65535"),
        ("mint-port-too-big", q1("https://mint.example:99999"), "a port is 1 to 65535"),
        ("mint-junk-after-ipv6", q1("https://[::1]x"), "after the host: a port, a path or nothing"),
        ("mint-loopback-lookalike", q1("http://127.0.0.1.evil.example"), "not loopback"),
        ("mint-loopback-ipv6-junk", q1("http://[::1]x"), "after the host: a port, a path or nothing"),
        ("quote-price-zero", line(quote(["https://mint.example"], price_per_chunk=0)), "price_per_chunk >= 1"),
        ("quote-window-zero", line(quote(["https://mint.example"], window=0)), "window >= 1"),
        ("quote-fraction", line(quote(["https://mint.example"])).replace('"price_per_chunk":1', '"price_per_chunk":17.0'), "integers only"),
        ("quote-exponent", line(quote(["https://mint.example"])).replace('"price_per_chunk":1', '"price_per_chunk":1e3'), "integers only"),
        ("quote-minus-zero", line(quote(["https://mint.example"])).replace('"price_per_chunk":1', '"price_per_chunk":-0'), "integers only"),
        ("quote-negative", line(quote(["https://mint.example"], price_per_chunk=-1)), "non-negative"),
        ("pay-upto-zero", line({"t": "pay", "upto_chunk": 0, "token": "cashuBx"}), "upto_chunk >= 1"),
        ("pay-no-token", line({"t": "pay", "upto_chunk": 3}), "missing token"),
        ("pay-not-cashu", line({"t": "pay", "upto_chunk": 3, "token": "lnbc1..."}), "token is a NUT-00 token"),
        ("pay-token-empty-payload", line({"t": "pay", "upto_chunk": 3, "token": "cashuB"}), "token has a payload"),
        ("pay-token-escape", line({"t": "pay", "upto_chunk": 3, "token": "cashuBab\u001b[2Jcd"}), "token is base64"),
        ("pay-token-newline", line({"t": "pay", "upto_chunk": 3, "token": "cashuBab\ncd"}), "token is base64"),
        ("pay-token-space", line({"t": "pay", "upto_chunk": 3, "token": "cashuBab cd"}), "token is base64"),
        ("ack-missing", line({"t": "ack", "accepted_upto": 3}), "missing spent_total"),
        ("ack-bool", line({"t": "ack", "accepted_upto": True, "spent_total": 1}), "integers only"),
        ("rej-no-code", line({"t": "rej", "detail": "x"}), "missing code"),
        ("rej-empty-code", line({"t": "rej", "code": ""}), "code is 1 to 64 of [a-z0-9-]"),
        ("rej-code-uppercase", line({"t": "rej", "code": "Underpaid"}), "code is 1 to 64 of [a-z0-9-]"),
        ("rej-code-65", line({"t": "rej", "code": "a" * 65}), "code is 1 to 64 of [a-z0-9-]"),
        ("rej-detail-1026-bytes", line({"t": "rej", "code": "stale", "detail": "€" * 342}), "detail at most 1 KiB (bytes)"),
        ("rej-detail-escape-sequence", line({"t": "rej", "code": "stale", "detail": "\u001b[31mred"}), "no control characters"),
        ("rej-detail-c1", line({"t": "rej", "code": "stale", "detail": "a\u0085b"}), "no control characters"),
        ("rej-detail-bidi-override", line({"t": "rej", "code": "stale", "detail": "ok‮ko"}), "no bidirectional overrides"),
        ("rej-detail-bidi-mark", line({"t": "rej", "code": "stale", "detail": "ok‏ko"}), "no bidirectional marks"),
        ("rej-detail-arabic-mark", line({"t": "rej", "code": "stale", "detail": "ok؜ko"}), "no bidirectional marks"),
        ("rej-detail-line-separator", line({"t": "rej", "code": "stale", "detail": "ok ko"}), "no line or paragraph separators"),
        ("rej-detail-zero-width-space", line({"t": "rej", "code": "stale", "detail": "o​k"}), "no invisible characters"),
        ("rej-detail-soft-hyphen", line({"t": "rej", "code": "stale", "detail": "o­k"}), "no invisible characters"),
        ("rej-detail-bom", line({"t": "rej", "code": "stale", "detail": "﻿ok"}), "no invisible characters"),
        ("rej-detail-tag", line({"t": "rej", "code": "stale", "detail": "ok\U000e0041"}), "no tag characters"),
        ("rej-detail-null", line({"t": "rej", "code": "stale", "detail": None}), "detail is a string"),
        ("beyond-2^53", '{"t":"ack","accepted_upto":9007199254740992,"spent_total":0}', "integers at most 2^53-1"),
        ("line-of-32768-bytes", over_limit, "a line is at most 32 KiB, newline included"),
    ]
    # Every verdict agrees with the reference reader, in both modes.
    for name, wire in valid:
        for lb in (False, True):
            pay1_parse(wire, lb)
    for name, wire in loopback:
        pay1_parse(wire, True)
        try:
            pay1_parse(wire, False)
        except Pay1Error:
            pass
        else:
            raise SystemExit(f"vector bug: {name} parses without loopback")
    for name, wire, _ in invalid:
        for lb in (False, True):
            try:
                pay1_parse(wire, lb)
            except Pay1Error:
                continue
            raise SystemExit(f"vector bug: invalid {name} parses (loopback={lb})")
    return {
        "description": "NFX-07 §2 pay/1 messages: one JSON object per line (NDJSON), at most "
                       "32 KiB with its newline, under the NFX-11 §9 value rules. Every 'valid' "
                       "wire parses to its 'message' (the known fields; unknown ones are dropped); "
                       "every 'valid_with_loopback' wire parses only where a deployment allows "
                       "loopback http mints, and is refused by default; every 'invalid' wire "
                       "MUST be refused, whether or not loopback is allowed.",
        "max_line_bytes": PAY1_MAX_LINE_BYTES,
        "max_depth": PAY1_MAX_DEPTH,
        "valid": [{"name": n, "wire": w, "message": pay1_parse(w)} for n, w in valid],
        "valid_with_loopback": [{"name": n, "wire": w, "message": pay1_parse(w, True)} for n, w in loopback],
        "invalid": [{"name": n, "wire": w, "why": why} for n, w, why in invalid],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    creator = keypair("nfx-test-vector/creator")
    seeder = keypair("nfx-test-vector/seeder")
    cashu = keypair("nfx-test-vector/cashu")  # stands in for the creator's P2PK wallet key
    secrets = {
        "creator": hashlib.sha256(b"nfx-test-vector/creator").hexdigest(),
        "seeder": hashlib.sha256(b"nfx-test-vector/seeder").hexdigest(),
        "cashu": hashlib.sha256(b"nfx-test-vector/cashu").hexdigest(),
    }
    video = f"{NAMESPACE}:{VIDEO_ID}"

    # ---- 1. Fabricate tiny "media" files and hash them (roles per NFX-05 §2) ----
    fabricated = {
        "init-720.mp4": b"NFX-VECTOR init segment bytes (not a real fMP4 init)\n",
        "seg-0": b"NFX-VECTOR segment 0 bytes\n",
        "seg-1": b"NFX-VECTOR segment 1 bytes\n",
        "seg-2": b"NFX-VECTOR segment 2 bytes\n",
        "thumb.jpg": b"NFX-VECTOR thumbnail bytes\n",
    }
    fhash = {name: sha256(data) for name, data in fabricated.items()}

    # ---- 2. Playlists with hash-named URIs (NFX-05 §3) ----
    r720 = (
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n"
        '#EXT-X-MAP:URI="' + fhash["init-720.mp4"] + '.mp4"\n'
        "#EXT-X-INDEPENDENT-SEGMENTS\n"
        "#EXTINF:2.000,\n" + fhash["seg-0"] + ".m4s\n"
        "#EXTINF:2.000,\n" + fhash["seg-1"] + ".m4s\n"
        "#EXTINF:2.000,\n" + fhash["seg-2"] + ".m4s\n"
        "#EXT-X-ENDLIST\n"
    ).encode()
    master = (
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n"
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,'
        'CODECS="avc1.64001f,mp4a.40.2"\n' + sha256(r720) + ".m3u8\n"
    ).encode()

    files = [
        {"name": "master.m3u8", "role": "playlist-master", "sha256": sha256(master), "size": len(master)},
        {"name": "r720.m3u8", "role": "playlist", "sha256": sha256(r720), "size": len(r720)},
        {"name": "init-720.mp4", "role": "init", "sha256": fhash["init-720.mp4"], "size": len(fabricated["init-720.mp4"])},
        {"name": "seg0.m4s", "role": "segment", "sha256": fhash["seg-0"], "size": len(fabricated["seg-0"]), "dur_ms": 2000},
        {"name": "seg1.m4s", "role": "segment", "sha256": fhash["seg-1"], "size": len(fabricated["seg-1"]), "dur_ms": 2000},
        {"name": "seg2.m4s", "role": "segment", "sha256": fhash["seg-2"], "size": len(fabricated["seg-2"]), "dur_ms": 2000},
        {"name": "thumb.jpg", "role": "thumb", "sha256": fhash["thumb.jpg"], "size": len(fabricated["thumb.jpg"])},
    ]
    hashlist = {
        "v": 1,
        "video": video,
        "files": files,
        "renditions": [{
            "id": "720p", "playlist": "r720.m3u8", "bandwidth": 2_500_000,
            "codecs": "avc1.64001f,mp4a.40.2", "resolution": "1280x720",
        }],
    }
    hashlist_bytes = render_hashlist(hashlist)
    root = sha256(hashlist_bytes)

    # ---- 3. Manifest event (NFX-02), licensed mode, signed by the creator ----
    manifest_tags = [
        ["d", video],
        ["n", NAMESPACE],
        ["title", "Salt Flats at Dusk"],
        ["published_at", str(CREATED_AT)],
        ["license", "licensed"],
        ["root", root],
        ["segs", str(len(files))],
        ["duration", "6"],
        ["thumb", fhash["thumb.jpg"], "image/jpeg"],
        ["key_price", "200"],
        ["split", "5000"],
        ["mint", "https://mint.example"],
        ["cashu_key", cashu.public_key.format(compressed=True).hex()],
        ["free_seeder", schnorr_id_pubkey(seeder)],
        ["t", "travel"],
        ["alt", "Drone footage over salt flats at sunset, 6 seconds."],
    ]
    manifest_content = "A walk through the salt flats at dusk."
    manifest = nostr_event(creator, 38504, manifest_tags, manifest_content, CREATED_AT)
    a_tag = f"38504:{manifest['pubkey']}:{video}"

    # ---- 3b. Open-mode manifest: the NFX-02 §6 delisting update of the same video ----
    open_tags = [
        ["d", video],
        ["n", NAMESPACE],
        ["title", "Salt Flats at Dusk"],
        ["published_at", str(CREATED_AT)],
        ["license", "open"],
        ["root", root],
        ["segs", str(len(files))],
        ["duration", "6"],
        ["price_hint", "0"],
        ["t", "travel"],
        ["x-future-tag", "readers ignore tags they do not know (NFX-01 §4)"],
    ]
    manifest_open = nostr_event(creator, 38504, open_tags, manifest_content, CREATED_AT + 3600)

    # ---- 3c. Signed manifests that every L1 reader MUST reject (NFX-02 §4) ----
    def with_tags(mutate):
        tags = copy.deepcopy(manifest_tags)
        mutate(tags)
        return tags

    def set_tag(name, *values):
        def m(tags):
            for t in tags:
                if t[0] == name:
                    t[1:] = list(values)
        return m

    def drop_tag(name):
        def m(tags):
            tags[:] = [t for t in tags if t[0] != name]
        return m

    def add_tag(*tag):
        def m(tags):
            tags.append(list(tag))
        return m

    def chain(*ms):
        def m(tags):
            for f in ms:
                f(tags)
        return m

    not_on_curve = "02" + "00" * 32
    try:
        PublicKey(bytes.fromhex(not_on_curve))
        raise SystemExit("vector bug: x=0 unexpectedly on the curve")
    except ValueError:
        pass

    tag_cases = [
        ("n-d-mismatch", "n names testnet, d names mainnet", set_tag("n", "nfx:testnet:1")),
        ("two-n-tags", "exactly one n tag (NFX-01 §3)", add_tag("n", "nfx:testnet:1")),
        ("no-n-tag", "n tag required", drop_tag("n")),
        ("void-token-nutflix", "nutflix:* namespaces are void (NFX-01 §2)",
         chain(set_tag("d", f"nutflix:mainnet:1:{VIDEO_ID}"), set_tag("n", "nutflix:mainnet:1"))),
        ("specver-leading-zero", "specver has no leading zeros",
         chain(set_tag("d", f"nfx:mainnet:01:{VIDEO_ID}"), set_tag("n", "nfx:mainnet:01"))),
        ("video-id-too-short", "video-id is 7..63 chars", set_tag("d", f"{NAMESPACE}:abcdef")),
        ("video-id-uppercase", "video-id is lowercase", set_tag("d", f"{NAMESPACE}:Salt-flats-dusk")),
        ("duplicate-root", "single-valued tags at most once (NFX-02 §3)", add_tag("root", "00" * 32)),
        ("duplicate-title", "single-valued tags at most once (NFX-02 §3)", add_tag("title", "Another title")),
        ("missing-root", "root required", drop_tag("root")),
        ("missing-title", "title required", drop_tag("title")),
        ("root-uppercase-hex", "root is 64 lowercase hex", set_tag("root", root.upper())),
        ("segs-zero", "segs >= 1", set_tag("segs", "0")),
        ("integer-leading-zero", "integer grammar (NFX-02 §3)", set_tag("split", "05000")),
        ("integer-plus-sign", "integer grammar (NFX-02 §3)", set_tag("key_price", "+200")),
        ("integer-overflow", "integer <= 2^64-1", set_tag("published_at", "18446744073709551616")),
        ("split-out-of-range", "split in [0,10000]", set_tag("split", "10001")),
        ("license-unknown-value", "license is open|licensed", set_tag("license", "free")),
        ("licensed-missing-mint", "licensed requires exactly one mint", drop_tag("mint")),
        ("licensed-two-mints", "licensed requires exactly one mint", add_tag("mint", "https://mint2.example")),
        ("mint-not-https", "mint is an https URL", set_tag("mint", "http://mint.example")),
        ("mint-userinfo", "mint URL has no userinfo", set_tag("mint", "https://mint.example@evil.example")),
        ("licensed-missing-cashu-key", "cashu_key required when licensed", drop_tag("cashu_key")),
        ("cashu-key-not-on-curve", "cashu_key is a valid compressed point", set_tag("cashu_key", not_on_curve)),
        ("cashu-key-bad-prefix", "cashu_key is a valid compressed point",
         set_tag("cashu_key", "04" + cashu.public_key.format(compressed=True).hex()[2:])),
        ("licensed-with-price-hint", "price_hint prohibited when licensed", add_tag("price_hint", "1")),
        ("open-with-key-price", "licensed-only tags prohibited when open", set_tag("license", "open")),
        ("thumb-bad-hash", "thumb is 64 lowercase hex + mime", set_tag("thumb", "abc", "image/jpeg")),
        ("thumb-missing-mime", "thumb is 64 lowercase hex + mime", set_tag("thumb", fhash["thumb.jpg"])),
        ("free-seeder-bad-hex", "free_seeder is 64 lowercase hex", set_tag("free_seeder", "npub1notallowed")),
    ]
    invalid = []
    for name, reason, mutate in tag_cases:
        invalid.append({"name": name, "reason": reason,
                        "event": nostr_event(creator, 38504, with_tags(mutate), manifest_content, CREATED_AT)})
    invalid.append({"name": "wrong-kind", "reason": "kind must be 38504",
                    "event": nostr_event(creator, 38505, manifest_tags, manifest_content, CREATED_AT)})
    bad_sig = copy.deepcopy(manifest)
    bad_sig["sig"] = bad_sig["sig"][:-1] + ("0" if bad_sig["sig"][-1] != "0" else "1")
    invalid.append({"name": "bad-signature", "reason": "sig must verify (BIP-340)", "event": bad_sig})
    id_mismatch = copy.deepcopy(manifest)
    id_mismatch["content"] = manifest_content + " (edited after signing)"
    invalid.append({"name": "id-mismatch", "reason": "id must equal the NIP-01 serialization hash",
                    "event": id_mismatch})

    # ---- 3b. iroh collections and tickets (NFX-06 §2) ----
    # The seeder's iroh identity is an ed25519 key; its public key is the endpoint id.
    iroh_seed = hashlib.sha256(b"nfx-test-vector/iroh-node").digest()
    iroh_pk, _ = sodium.crypto_sign_seed_keypair(iroh_seed)
    relay_url = "https://iroh-relay.example/"
    direct = ["203.0.113.10:11204"]
    by_name = {"master.m3u8": master, "r720.m3u8": r720, "init-720.mp4": fabricated["init-720.mp4"],
               "seg0.m4s": fabricated["seg-0"], "seg1.m4s": fabricated["seg-1"],
               "seg2.m4s": fabricated["seg-2"], "thumb.jpg": fabricated["thumb.jpg"]}
    meta_names = ["(hash list)"] + [f["name"] for f in files if f["role"] not in ("init", "segment")]
    r720_names = ["init-720.mp4", "seg0.m4s", "seg1.m4s", "seg2.m4s"]  # init, then playlist order

    def collection(names: list[str]) -> dict:
        members = []
        for n in names:
            data = hashlist_bytes if n == "(hash list)" else by_name[n]
            members.append({"file": n, "sha256": sha256(data), "blake3": blake3.blake3(data).hexdigest()})
        seq = b"".join(bytes.fromhex(m["blake3"]) for m in members)
        return {"members": members, "hash_seq": seq.hex(), "blake3": blake3.blake3(seq).hexdigest()}

    collections = {"meta": collection(meta_names), "720p": collection(r720_names)}
    tickets = {}
    for cid, col in collections.items():
        text, raw = blob_ticket(iroh_pk, relay_url, direct, 1, bytes.fromhex(col["blake3"]))
        tickets[cid] = {"string": text, "bytes": raw.hex(), "format": "hash_seq", "hash": col["blake3"]}

    # ---- 4. Beacon event (NFX-03), signed by the seeder ----
    beacon_content = {
        "v": 1,
        "video": video,
        "endpoints": [
            {
                "t": "iroh",
                "node": iroh_pk.hex(),
                "relay": relay_url,
                "addrs": direct,
                "tickets": {"720p": tickets["720p"]["string"], "meta": tickets["meta"]["string"]},
            },
            {"t": "https", "url": "https://seed.example/nfx"},
            {"t": "webrtc", "tracker_urls": ["wss://tracker.example/announce"], "renditions": ["720p"]},
            {"t": "hyper", "drive": sha256(b"nfx-test-vector/hyperdrive-key")},
        ],
        "chunks": "all",
        "price_hint": 1,
        "accepts_mints": ["https://mint.example"],
        "free": False,
    }
    beacon_tags = [
        ["n", NAMESPACE],
        ["a", a_tag],
        ["expiration", str(CREATED_AT + TTL)],
    ]
    beacon = nostr_event(seeder, 20464, beacon_tags,
                         json.dumps(beacon_content, separators=(",", ":")), CREATED_AT)

    # ---- 4b. Signed beacons that MUST be rejected (NFX-03 §§1,4) ----
    now = CREATED_AT + 30

    def beacon_case(name, reason, tags=None, content=None, created_at=CREATED_AT):
        return {"name": name, "reason": reason,
                "event": nostr_event(seeder, 20464, tags if tags is not None else beacon_tags,
                                     content if content is not None else json.dumps(beacon_content, separators=(",", ":")),
                                     created_at)}

    def content_with(**changes):
        c = copy.deepcopy(beacon_content)
        c.update(changes)
        return json.dumps(c, separators=(",", ":"))

    beacon_invalid = [
        beacon_case("ttl-too-long", "expiration - created_at in [60,120]",
                    tags=[["n", NAMESPACE], ["a", a_tag], ["expiration", str(CREATED_AT + 121)]]),
        beacon_case("ttl-too-short", "expiration - created_at in [60,120]",
                    tags=[["n", NAMESPACE], ["a", a_tag], ["expiration", str(CREATED_AT + 59)]]),
        beacon_case("missing-expiration", "expiration required",
                    tags=[["n", NAMESPACE], ["a", a_tag]]),
        beacon_case("two-n-tags", "exactly one n tag",
                    tags=[["n", NAMESPACE], ["n", "nfx:testnet:1"], ["a", a_tag], ["expiration", str(CREATED_AT + TTL)]]),
        beacon_case("a-namespace-mismatch", "a names a different network than n",
                    tags=[["n", NAMESPACE], ["a", a_tag.replace(NAMESPACE, "nfx:testnet:1")],
                          ["expiration", str(CREATED_AT + TTL)]]),
        beacon_case("a-wrong-kind", "a must address a kind-38504 manifest",
                    tags=[["n", NAMESPACE], ["a", "30023" + a_tag[5:]], ["expiration", str(CREATED_AT + TTL)]]),
        beacon_case("video-mismatch", "content.video must equal the a tag's d",
                    content=content_with(video=f"{NAMESPACE}:another-video")),
        beacon_case("paying-without-mints", "accepts_mints is required unless free (NFX-03 §4)",
                    content=json.dumps({k: v for k, v in beacon_content.items() if k != "accepts_mints"},
                                       separators=(",", ":"))),
        beacon_case("paying-empty-mints", "accepts_mints is non-empty unless free (NFX-03 §4)",
                    content=content_with(accepts_mints=[])),
        beacon_case("no-endpoints", "at least one endpoint", content=content_with(endpoints=[])),
        beacon_case("chunks-missing", "chunks is required", content=json.dumps(
            {k: v for k, v in beacon_content.items() if k != "chunks"}, separators=(",", ":"))),
        beacon_case("content-not-json", "content is JSON", content="not json"),
        beacon_case("created-at-skew", "created_at within ±15 min of now", created_at=now - 16 * 60,
                    tags=[["n", NAMESPACE], ["a", a_tag], ["expiration", str(now - 16 * 60 + TTL)]]),
    ]
    only_unknown = copy.deepcopy(beacon_content)
    only_unknown["endpoints"] = [{"t": "carrier-pigeon", "loft": "north"}]
    beacon_unknown_only = nostr_event(seeder, 20464, beacon_tags,
                                      json.dumps(only_unknown, separators=(",", ":")), CREATED_AT)

    # ---- 5. Hash lists and playlists that MUST be rejected (NFX-03 §4, NFX-05 §§2-3) ----
    def hashlist_case(name, reason, mutate, root_override=None, segs=len(files)):
        h = copy.deepcopy(hashlist)
        mutate(h)
        b = render_hashlist(h)
        return {"name": name, "reason": reason, "bytes_b64": base64.b64encode(b).decode(),
                "root": root_override or sha256(b), "video": video, "segs": segs}

    def set_field(path, value):
        def m(h):
            target = h
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
        return m

    hashlist_invalid = [
        hashlist_case("root-mismatch", "sha256(bytes) must equal the manifest root", lambda h: None,
                      root_override="00" * 32),
        hashlist_case("video-mismatch", "video must equal the manifest's namespace:video-id",
                      set_field(["video"], f"{NAMESPACE}:another-video")),
        hashlist_case("segs-mismatch", "manifest segs must equal len(files)", lambda h: None,
                      segs=len(files) + 1),
        hashlist_case("version-2", "v must be 1", set_field(["v"], 2)),
        hashlist_case("meta-rendition-id", "rendition id 'meta' is reserved (NFX-03 §4)",
                      set_field(["renditions", 0, "id"], "meta")),
        hashlist_case("bad-sha256", "sha256 is 64 lowercase hex", set_field(["files", 3, "sha256"], "abc")),
        hashlist_case("unknown-role", "role is one of the six", set_field(["files", 3, "role"], "trailer")),
        hashlist_case("rendition-playlist-missing", "rendition playlist names a playlist file",
                      set_field(["renditions", 0, "playlist"], "r1080.m3u8")),
        hashlist_case("no-files", "files is non-empty", set_field(["files"], [])),
        hashlist_case("duplicate-file-name", "file names are unique (NFX-05 §2)",
                      set_field(["files", 3, "name"], "init-720.mp4")),
        hashlist_case("duplicate-rendition-playlist", "renditions name distinct playlists (NFX-05 §2)",
                      lambda h: h["renditions"].append(dict(h["renditions"][0], id="480p", bandwidth=1_000_000))),
    ]
    path_like = r720.replace((fhash["seg-1"] + ".m4s").encode(), b"seg/0001.m4s")
    unlisted = r720.replace(fhash["seg-1"].encode(), ("ab" * 32).encode())
    init_uri = ('URI="' + fhash["init-720.mp4"] + '.mp4"').encode()
    duplicate_uri = r720.replace(init_uri, init_uri + b',URI="https://tracker.example/x.mp4"')
    assert duplicate_uri != r720
    playlist_invalid = [
        {"name": "path-like-uri", "reason": "playlist URIs are content names (NFX-05 §3)",
         "playlist": path_like.decode()},
        {"name": "unlisted-content-name", "reason": "every content name must be in files",
         "playlist": unlisted.decode()},
        {"name": "duplicate-uri-attribute",
         "reason": "every URI attribute counts; a tag with two is invalid (NFX-05 §3)",
         "playlist": duplicate_uri.decode()},
    ]

    # ---- 5b. Deletion (NFX-02 §6): kind 5, `a` tags only, the author's own addresses ----
    deleted_at = CREATED_AT + 100
    deletion = nostr_event(creator, 5, [["a", a_tag], ["k", "38504"]],
                           "withdrawn by the creator", deleted_at)
    foreign_a = f"38504:{schnorr_id_pubkey(seeder)}:{video}"
    deletion_invalid = [
        {"name": "foreign-address", "reason": "every `a` must be the deletion author's own address",
         "event": nostr_event(creator, 5, [["a", foreign_a]], "", deleted_at)},
        {"name": "one-of-two-foreign", "reason": "every `a`, not just one, must be the author's",
         "event": nostr_event(creator, 5, [["a", a_tag], ["a", foreign_a]], "", deleted_at)},
        {"name": "e-tag", "reason": "manifests are addressed; an `e` tag is not allowed",
         "event": nostr_event(creator, 5, [["a", a_tag], ["e", manifest["id"]]], "", deleted_at)},
        {"name": "no-a-tag", "reason": "at least one `a` tag is required",
         "event": nostr_event(creator, 5, [["k", "38504"]], "", deleted_at)},
        {"name": "not-a-manifest-address", "reason": "`a` must name a kind-38504 address",
         "event": nostr_event(creator, 5, [["a", f"30023:{manifest['pubkey']}:{video}"]], "", deleted_at)},
        {"name": "wrong-kind", "reason": "a deletion is kind 5",
         "event": nostr_event(creator, 1, [["a", a_tag]], "", deleted_at)},
    ]

    # ---- 6. canon (NFX-11 §9) ----
    canon_inputs = [
        ("key-order", '{"b":1,"a":2,"aa":3,"A":4,"é":5,"z":6}'),
        ("code-point-not-utf16", '{"\U0001F600":1,"｡":2}'),
        ("nested-and-whitespace", '{ "z" : [ 3 , { "y" : true , "x" : null } ] , "a" : false }'),
        ("string-escapes", '{"s":"q\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001F\\u007f\\u00e9\\u2028 \U0001F600"}'),
        ("escaped-non-ascii-input", '{"s":"\\u00f1\\ud83d\\ude00"}'),
        ("integers", '{"a":0,"b":-1,"c":9007199254740991,"d":-9007199254740991}'),
        ("empty", '{"a":{},"b":[],"c":""}'),
        ("reject-duplicate-key", '{"a":1,"a":2}'),
        ("reject-fraction", '{"a":1.0}'),
        ("reject-exponent", '{"a":1e2}'),
        ("reject-negative-zero", '{"a":-0}'),
        ("reject-out-of-range", '{"a":9007199254740992}'),
        ("reject-lone-surrogate", '{"a":"\\ud800"}'),
        ("reject-nan", '{"a":NaN}'),
    ]
    canon_cases = []
    for name, text in canon_inputs:
        try:
            out = canon(canon_loads(text)).decode("utf-8")
            canon_cases.append({"name": name, "input": text, "canon": out})
        except NonCanonical:
            if not name.startswith("reject-"):
                raise
            canon_cases.append({"name": name, "input": text, "canon": None})
        else:
            if name.startswith("reject-"):
                raise SystemExit(f"vector bug: {name} was accepted")

    # ---- 7. Voucher (NFX-08 §5) ----
    voucher = {"v": 1, "type": "nfx-voucher", "network": NAMESPACE, "video": video,
               "seeder": schnorr_id_pubkey(seeder), "not_after": CREATED_AT + 30 * 86400}
    voucher_canon, voucher_digest, voucher_sig = sign_canon(creator, voucher)
    voucher_wire = json.dumps(voucher, indent=1)  # sender layout; verifiers re-canonicalize
    tampered = dict(voucher, not_after=voucher["not_after"] + 1)

    # ---- 8. Gossip envelope (NFX-06 §4) ----
    gossip_body = {"v": 1, "op": "here", "pubkey": schnorr_id_pubkey(seeder),
                   "beacon": beacon_content, "created_at": CREATED_AT}
    gossip_canon, gossip_digest, gossip_sig = sign_canon(seeder, gossip_body)
    gossip_wire = json.dumps(dict(gossip_body, sig=gossip_sig), ensure_ascii=False)

    # ---- 8b. Licensed-mode encryption (NFX-08 §2), generated by libsodium ----
    video_key = hashlib.sha256(b"nfx-test-vector/video-key").digest()
    enc_name = "init-720.mp4"
    enc_nonce = hashlib.sha256(f"nfx-test-vector/nonce/{enc_name}".encode()).digest()[:24]
    enc_aad = f"{video}/{enc_name}".encode()
    enc_plain = fabricated["init-720.mp4"]
    enc_ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(enc_plain, enc_aad, enc_nonce, video_key)
    enc_stored = enc_nonce + enc_ct
    wrong_aad = f"{video}/seg0.m4s"
    try:
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(enc_ct, wrong_aad.encode(), enc_nonce, video_key)
        raise SystemExit("vector bug: wrong aad decrypted")
    except nacl.exceptions.CryptoError:
        pass

    # ---- 9. Derived identifiers (NFX-01 §2, NFX-06 §4, NFX-10 §2, NFX-12 §3) ----
    def web_swarm(ns, vid, rendition):
        swarm_id = f"nfx/1/web/{ns}:{vid}/{rendition}"
        # NFX-10 §2: p2p-media-loader v4 computeInfoHash = base64(sha1(id)[0..15]).
        infohash = base64.b64encode(hashlib.sha1(swarm_id.encode()).digest()[:15]).decode()
        return {"rendition": rendition, "stream_swarm_id": swarm_id, "tracker_infohash": infohash}

    def derived_for(ns, vid):
        return {
            "namespace": ns, "video_id": vid, "d": f"{ns}:{vid}",
            "swarm_topic": sha256(f"nfx/1/swarm/{ns}/{vid}".encode()),
            "web_swarms": [web_swarm(ns, vid, r) for r in ("1080p", "720p", "360p")],
            "hyper_topic": sha256(f"nfx/1/hyper/{ns}/{vid}".encode()),
        }

    derived = {
        "description": "Derived identifiers and namespace/video-id grammar cases.",
        "videos": [derived_for(NAMESPACE, VIDEO_ID), derived_for("nfx:testnet:1", VIDEO_ID),
                   derived_for("nfx:acme-cdn:7", "a1b2c3d")],
        "a_tag": {"creator": manifest["pubkey"], "d": video, "a": a_tag},
        "namespaces_valid": ["nfx:mainnet:1", "nfx:testnet:1", "nfx:regtest:1", "nfx:mainnet:0",
                             "nfx:mainnet:12", "nfx:acme-cdn:1", "nfx:ab:7", "nfx:" + "a" * 32 + ":1"],
        "namespaces_invalid": ["nutflix:mainnet:1", "NFX:mainnet:1", "nfx:Mainnet:1", "nfx:mainnet:01",
                               "nfx:mainnet:-1", "nfx:mainnet", "nfx::1", "nfx:a:1",
                               "nfx:" + "a" * 33 + ":1", "nfx:mainnet:1 ", "nfx:acme_cdn:1", "",
                               "nfx:mainnet:1:salt-flats-dusk"],
        "video_ids_valid": ["salt-flats-dusk", "abcdefg", "0123456", "a" * 63, "a-------"],
        "video_ids_invalid": ["abcdef", "-abcdefg", "a" * 64, "Salt-flats", "salt_flats", "salt flats", ""],
    }

    outputs = {
        "hashlist.json": {
            "description": "NFX-05 hash list for the 2026-09 test vector video. "
                           "Its exact byte content hashed with sha256 gives the manifest root.",
            "video": video,
            "rendered_bytes_sha256": root,
            "note": "Vectors for fabricated bytes: 'fabricated' maps name -> base64 content.",
            "hashlist": hashlist,
            "fabricated": {k: base64.b64encode(v).decode() for k, v in fabricated.items()},
            "playlists": {"master.m3u8": master.decode(), "r720.m3u8": r720.decode()},
        },
        "hashlist-invalid.json": {
            "description": "NFX-05 hash lists and playlists every implementation MUST reject. "
                           "Each hash-list case gives the exact bytes (base64) and the manifest "
                           "context it is checked against (root, video, segs). Playlist cases are "
                           "checked against the valid hash list in hashlist.json.",
            "hashlists": hashlist_invalid,
            "playlists": playlist_invalid,
        },
        "manifest.json": {
            "description": "NFX-02 manifest (kind 38504), licensed mode. "
                           "Deterministic signature: aux_rand = 32 zero bytes.",
            "secret_keys_DO_NOT_USE": secrets,
            "event": manifest,
        },
        "manifest-open.json": {
            "description": "NFX-02 manifest, open mode: the §6 delisting update of the licensed "
                           "vector (same d, newer created_at, licensed-only tags removed). Carries "
                           "one unknown tag, which readers MUST ignore. MUST parse.",
            "secret_keys_DO_NOT_USE": {"creator": secrets["creator"]},
            "event": manifest_open,
        },
        "manifest-invalid.json": {
            "description": "Correctly signed kind-38504 events (except where the case says "
                           "otherwise) that every L1 reader MUST reject (NFX-02 §4). 'reason' "
                           "is informative, not a required error code.",
            "secret_keys_DO_NOT_USE": {"creator": secrets["creator"]},
            "cases": invalid,
        },
        "beacon.json": {
            "description": "NFX-03 beacon (kind 20464, TTL 120) with one endpoint of every "
                           "registered type (NFX-11 §3). The iroh tickets are real (see "
                           "tickets.json).",
            "secret_keys_DO_NOT_USE": {"seeder": secrets["seeder"]},
            "now": now,
            "event": beacon,
        },
        "beacon-invalid.json": {
            "description": "Correctly signed kind-20464 events that MUST be rejected, checked "
                           "at 'now'. 'unknown_endpoint_only' MUST parse (unknown endpoint "
                           "types are skipped, NFX-03 §4) but leaves no usable endpoint.",
            "secret_keys_DO_NOT_USE": {"seeder": secrets["seeder"]},
            "now": now,
            "cases": beacon_invalid,
            "unknown_endpoint_only": beacon_unknown_only,
        },
        "canon.json": {
            "description": "NFX-11 §9 canonical JSON. 'input' is received JSON text; 'canon' "
                           "is the exact canonical text, or null when the input is "
                           "non-canonicalizable and MUST be rejected.",
            "cases": canon_cases,
        },
        "voucher.json": {
            "description": "NFX-08 §5 free-seeder voucher for the manifest vector's "
                           "free_seeder. sig = BIP-340(creator, sha256(canon(voucher))), "
                           "aux_rand = 32 zero bytes. 'wire' is a sender layout; verifiers "
                           "MUST re-canonicalize. 'tampered' MUST fail against the same sig. "
                           "A mint accepts it only from a request NIP-98-signed by 'seeder' "
                           "(NFX-08 §5).",
            "secret_keys_DO_NOT_USE": {"creator": secrets["creator"]},
            "creator_pubkey": manifest["pubkey"],
            "manifest_a": a_tag,
            "voucher": voucher,
            "wire": voucher_wire,
            "canon": voucher_canon.decode("utf-8"),
            "digest": voucher_digest.hex(),
            "sig": voucher_sig,
            "tampered": tampered,
        },
        "gossip.json": {
            "description": "NFX-06 §4 gossip envelope ('here') signed by the seeder over "
                           "sha256(canon(body)), body = message without sig. 'wire' is a "
                           "sender layout; verifiers MUST re-canonicalize.",
            "secret_keys_DO_NOT_USE": {"seeder": secrets["seeder"]},
            "topic": sha256(f"nfx/1/swarm/{NAMESPACE}/{VIDEO_ID}".encode()),
            "wire": gossip_wire,
            "canon": gossip_canon.decode("utf-8"),
            "digest": gossip_digest.hex(),
            "sig": gossip_sig,
        },
        "deletion.json": {
            "description": "NFX-02 §6 deletion of the manifest vector's address by its creator "
                           "(kind 5, `a` tags only, created after the manifest). Readers treat "
                           "that manifest as deleted; 'cases' MUST all be rejected as NFX "
                           "deletions.",
            "secret_keys_DO_NOT_USE": {"creator": secrets["creator"]},
            "manifest_a": a_tag,
            "event": deletion,
            "cases": deletion_invalid,
        },
        "tickets.json": {
            "description": "NFX-06 §2 iroh collections and tickets for the hash-list vector. "
                           "Each collection's members are hashed with BLAKE3; 'hash_seq' is "
                           "their concatenation and 'blake3' its BLAKE3, the collection's "
                           "address. 'meta' = hash list, then every playlist, thumb and "
                           "subtitle in files order; '720p' = init, then segments in playlist "
                           "order. A ticket is an iroh-blobs 0.103 BlobTicket: 'bytes' per the "
                           "layout in NFX-06 §2, 'string' = \"blob\" + lowercase unpadded "
                           "RFC 4648 base32 of them. The endpoint id is the ed25519 public key "
                           "of the 'iroh_node' seed and equals the beacon endpoint's 'node'.",
            "secret_keys_DO_NOT_USE": {"iroh_node": iroh_seed.hex()},
            "endpoint": {"endpoint_id": iroh_pk.hex(), "relay_url": relay_url, "direct_addresses": direct},
            "collections": collections,
            "tickets": tickets,
        },
        "derived.json": derived,
        "pay1.json": pay1_vectors(),
        "licensed.json": {
            "description": "NFX-08 §2 licensed-mode encryption of one file: stored = nonce || "
                           "XChaCha20-Poly1305-Encrypt(K, nonce, plaintext, aad) (IETF construction, "
                           "ciphertext || 16-byte tag), aad = utf8(video + '/' + name). Generated with "
                           "libsodium. Decrypting with 'wrong_aad' MUST fail. Standalone: the manifest "
                           "vector's hash list is not re-encrypted.",
            "secret_keys_DO_NOT_USE": {"video_key": video_key.hex()},
            "video": video,
            "name": enc_name,
            "aad": enc_aad.decode(),
            "nonce": enc_nonce.hex(),
            "plaintext_b64": base64.b64encode(enc_plain).decode(),
            "stored_b64": base64.b64encode(enc_stored).decode(),
            "stored_sha256": sha256(enc_stored),
            "wrong_aad": wrong_aad,
        },
    }

    rc = 0
    for fname, payload in outputs.items():
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        path = HERE / fname
        if args.verify:
            try:
                current = path.read_text()
            except FileNotFoundError:
                print(f"MISSING {fname}")
                rc = 1
                continue
            if current == text:
                print(f"OK      {fname}")
            else:
                print(f"DIFFERS {fname}")
                rc = 1
        else:
            path.write_text(text)
            print(f"wrote   {fname}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
