"""pay/1 (NFX-07 §2): the reference reader, and the vectors it classifies.

Imported by generate.py, which writes `pay1.json`. This file is pinned with the money
code (crates/ci/check-locked.sh), so the reader the Rust parser is checked against can
only change with review. It is self-contained on purpose: it carries its own copy of the
NFX-11 §9 value rules rather than importing generate.py's.
"""

import json

MAX_SAFE_INT = 2**53 - 1
MAX_U64 = 2**64 - 1
PAY1_MAX_LINE_BYTES = 32 * 1024
PAY1_MAX_DEPTH = 16
PAY1_MAX_MINTS = 16
PAY1_MAX_DETAIL_BYTES = 1024
PAY1_TOKEN_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_=+/-")
PAY1_HOST_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-")
PAY1_V6_CHARS = set("0123456789abcdefABCDEF:.")
LOWER_ALNUM_DASH = set("abcdefghijklmnopqrstuvwxyz0123456789-")


class Pay1Error(ValueError):
    pass


# ---- NFX-11 §9 value rules: reject, never normalise ----

def _reject_float(text):
    raise Pay1Error(f"non-integer number {text!r}")


def _checked_int(text):
    if text == "-0":
        raise Pay1Error("-0")
    value = int(text)
    if not -MAX_SAFE_INT <= value <= MAX_SAFE_INT:
        raise Pay1Error(f"integer out of range {text}")
    return value


def _reject_constant(text):
    raise Pay1Error(f"non-JSON constant {text}")


def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise Pay1Error(f"duplicate key {key!r}")
        out[key] = value
    return out


def _loads(text: str):
    obj = json.loads(text, object_pairs_hook=_no_duplicates, parse_float=_reject_float,
                     parse_int=_checked_int, parse_constant=_reject_constant)
    json.dumps(obj, ensure_ascii=False).encode("utf-8")  # a lone surrogate cannot encode
    return obj


# ---- the reader ----

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
        if not after.startswith(":") or not 1 <= len(port) <= 5 or not port.isascii() \
                or not port.isdigit() or not 1 <= int(port) <= 65535:
            return False
    if loopback_only:
        return host in ("127.0.0.1", "localhost", "[::1]")
    return True


def pay1_depth(v, level=1) -> int:
    """Container nesting: the message object is level 1, scalars add nothing."""
    if isinstance(v, dict):
        return max([pay1_depth(x, level + 1) for x in v.values()], default=level)
    if isinstance(v, list):
        return max([pay1_depth(x, level + 1) for x in v], default=level)
    return level - 1


def video_addr_ok(video: str) -> bool:
    """NFX-01 `<namespace>:<video-id>`. `specver` is bounded to u64, as every
    implementation reads it (NFX-01's ABNF leaves it unbounded; noted for its next
    revision)."""
    ns, _, vid = video.rpartition(":")
    parts = ns.split(":")
    if len(parts) != 3 or parts[0] != "nfx":
        return False
    network, specver = parts[1], parts[2]
    return (2 <= len(network) <= 32 and set(network) <= LOWER_ALNUM_DASH
            and specver.isascii() and specver.isdigit() and (specver == "0" or specver[0] != "0")
            and len(specver) <= 20 and int(specver) <= MAX_U64
            and 7 <= len(vid) <= 63 and vid[0] in "abcdefghijklmnopqrstuvwxyz0123456789"
            and set(vid) <= LOWER_ALNUM_DASH)


def pay1_parse(wire: str, allow_loopback_http: bool = False) -> dict:
    """Parse one pay/1 line (without its newline) as NFX-07 §2 says, or raise Pay1Error.
    Returns the message's known fields."""
    if len(wire.encode("utf-8", "surrogatepass")) + 1 > PAY1_MAX_LINE_BYTES:
        raise Pay1Error("a line is at most 32 KiB")
    try:
        obj = _loads(wire)
    except (ValueError, RecursionError, UnicodeEncodeError) as e:
        raise Pay1Error(f"not JSON under NFX-11 §9: {type(e).__name__}") from e
    if not isinstance(obj, dict):
        raise Pay1Error("not an object")
    try:
        if pay1_depth(obj) > PAY1_MAX_DEPTH:
            raise Pay1Error("nested too deep")
    except RecursionError as e:
        raise Pay1Error("nested too deep") from e

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
        if not video_addr_ok(video):
            raise Pay1Error("video is an NFX address")
        if len(session) != 32 or not set(session) <= set("0123456789abcdef"):
            raise Pay1Error("session is 32 lowercase hex")
        return {"t": t, "video": video, "session": session}
    if t == "quote":
        out = {"t": t}
        for name in ("price_per_chunk", "window", "served", "accepted_upto", "spent_total"):
            out[name] = integer(name)
        if out["price_per_chunk"] < 1:
            raise Pay1Error("price_per_chunk is at least 1")
        if out["window"] < 2:
            raise Pay1Error("window is at least 2")
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
        if not 1 <= len(code) <= 64 or not set(code) <= LOWER_ALNUM_DASH:
            raise Pay1Error("code is 1 to 64 of [a-z0-9-]")
        out = {"t": t, "code": code}
        if "detail" in obj:
            detail = obj["detail"]
            if not isinstance(detail, str) or len(detail) > PAY1_MAX_DETAIL_BYTES \
                    or not all(0x20 <= ord(c) <= 0x7E for c in detail):
                raise Pay1Error("detail is at most 1 KiB of printable ASCII")
            out["detail"] = detail
        return out
    raise Pay1Error("unknown t")


# ---- the vectors ----

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
    rej = lambda detail: line({"t": "rej", "code": "stale", "detail": detail})
    hello_at = lambda specver: line({"t": "hello", "video": f"nfx:mainnet:{specver}:salt-flats-dusk", "session": session})
    valid = [
        ("hello", line({"t": "hello", "video": video, "session": session})),
        ("hello-specver-max-u64", hello_at(MAX_U64)),
        ("quote", q1("https://mint.example")),
        ("quote-window-two", line(quote(["https://mint.example"], window=2))),
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
        ("rej-detail-1024-ascii", rej("x" * 1024)),
        ("rej-detail-printable-ascii", rej(" !\"#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~")),
        ("hello-unknown-field", line({"t": "hello", "video": video, "session": session, "x-future": 1})),
        ("nested-16-levels", nested(16)),
        ("max-safe-integer", line({"t": "ack", "accepted_upto": 9007199254740991, "spent_total": 0})),
        ("line-of-32767-bytes", at_limit),
    ]
    loopback = [
        ("quote-loopback-ipv4", line(quote(["http://127.0.0.1:3338"], price_per_chunk=2, window=2))),
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
        ("nested-2000-levels", nested(2000), "at most 16 levels (a reader must not crash)"),
        ("session-short", line({"t": "hello", "video": video, "session": session[:-1]}), "session is 32 lowercase hex"),
        ("session-uppercase", line({"t": "hello", "video": video, "session": session.upper()}), "session is 32 lowercase hex"),
        ("bad-video", line({"t": "hello", "video": "mainnet:salt", "session": session}), "video is an NFX address"),
        ("hello-specver-beyond-u64", hello_at(MAX_U64 + 1), "specver fits in u64"),
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
        ("quote-window-zero", line(quote(["https://mint.example"], window=0)), "window >= 2"),
        ("quote-window-one", line(quote(["https://mint.example"], window=1)), "window >= 2"),
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
        ("rej-detail-1025-ascii", rej("x" * 1025), "detail at most 1 KiB"),
        ("rej-detail-accent", rej("café"), "detail is printable ASCII"),
        ("rej-detail-emoji", rej("\U0001F600"), "detail is printable ASCII"),
        ("rej-detail-tab", rej("a\tb"), "detail is printable ASCII"),
        ("rej-detail-escape-sequence", rej("\u001b[31mred"), "no control characters"),
        ("rej-detail-del", rej("a\u007fb"), "no control characters"),
        ("rej-detail-c1", rej("a\u0085b"), "no control characters"),
        ("rej-detail-bidi-override", rej("ok‮ko"), "no bidirectional overrides"),
        ("rej-detail-zero-width-space", rej("o​k"), "no invisible characters"),
        ("rej-detail-variation-selector", rej("o️k"), "no invisible characters"),
        ("rej-detail-hangul-filler", rej("oㅤk"), "no invisible characters"),
        ("rej-detail-tag", rej("ok\U000e0041"), "no tag characters"),
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
