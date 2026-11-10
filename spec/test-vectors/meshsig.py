"""NFX-10 §6 (signaling over Nostr) test vectors, for generate.py.

Kind-25050 events with `i` = `nfx-mesh/1`: room derivation, room proofs (NIP-DC draft §2),
presence, offers and answers, NIP-44 v2 payloads with fixed nonces, and events that MUST be
rejected or ignored. Everything here is written from the spec text, with no Nostr library:
secp256k1 comes from coincurve (as in generate.py), ChaCha20 is written out below (RFC 8439
§2.3) and checked against libsodium's ChaCha20-Poly1305 keystream, and the NIP-44 v2 code is
checked against cases copied from the official NIP-44 vector file (paulmillr/nip44,
nip44.vectors.json, sha256 269ed0f6…5040, the hash NIP-44 publishes).
"""

import base64
import copy
import hashlib
import hmac
import json
import struct

import nacl.bindings as sodium
from coincurve import PrivateKey, PublicKey

KIND = 25050
PROTOCOL = "nfx-mesh/1"
APP = "nfx"
ROOM_LABEL = b"nfx/1/web/room"
PRESENCE_TTL = 90
MAX_AGE = 60
MAX_FUTURE = 30
MAX_CONTENT = 32768
SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

CREATED_AT = 1_790_000_000
NOW = CREATED_AT + 10
SWARM = "nfx/1/web/nfx:mainnet:1:salt-flats-dusk/720p"


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def nip01_json(value) -> str:
    """NIP-01's serialization: no whitespace, JSON string escaping, UTF-8 as itself."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


# ---- rooms (NFX-10 §6.1) ----

def valid_scalar(h: bytes) -> bool:
    return 0 < int.from_bytes(h, "big") < SECP256K1_N


def room_secret(swarm_id: str) -> tuple[bytes, bytes, int]:
    """(h0, the room secret, how many rehashes it took)."""
    h0 = sha256(ROOM_LABEL + b"\x00" + swarm_id.encode())
    h, steps = h0, 0
    while not valid_scalar(h):
        h, steps = sha256(h), steps + 1
    return h0, h, steps


def xonly(sk: PrivateKey) -> str:
    return sk.public_key.format(compressed=True)[1:].hex()


# ---- ChaCha20 (RFC 8439 §2.3), for NIP-44 v2 ----

def _rotl(v: int, c: int) -> int:
    return ((v << c) & 0xFFFFFFFF) | (v >> (32 - c))


def _quarter(s: list, a: int, b: int, c: int, d: int) -> None:
    s[a] = (s[a] + s[b]) & 0xFFFFFFFF
    s[d] = _rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) & 0xFFFFFFFF
    s[b] = _rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) & 0xFFFFFFFF
    s[d] = _rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) & 0xFFFFFFFF
    s[b] = _rotl(s[b] ^ s[c], 7)


def _block(key: bytes, counter: int, nonce: bytes) -> bytes:
    state = list(struct.unpack("<4I", b"expand 32-byte k")) + list(struct.unpack("<8I", key)) \
        + [counter] + list(struct.unpack("<3I", nonce))
    w = state[:]
    for _ in range(10):
        _quarter(w, 0, 4, 8, 12)
        _quarter(w, 1, 5, 9, 13)
        _quarter(w, 2, 6, 10, 14)
        _quarter(w, 3, 7, 11, 15)
        _quarter(w, 0, 5, 10, 15)
        _quarter(w, 1, 6, 11, 12)
        _quarter(w, 2, 7, 8, 13)
        _quarter(w, 3, 4, 9, 14)
    return struct.pack("<16I", *[(w[i] + state[i]) & 0xFFFFFFFF for i in range(16)])


def chacha20(key: bytes, nonce: bytes, data: bytes, counter: int = 0) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 64):
        ks = _block(key, counter + i // 64, nonce)
        out += bytes(x ^ y for x, y in zip(data[i:i + 64], ks))
    return bytes(out)


def _check_chacha20() -> None:
    """Our keystream from block 1 on equals libsodium's ChaCha20-Poly1305 ciphertext."""
    key, nonce = sha256(b"chacha-check-key"), sha256(b"chacha-check-nonce")[:12]
    msg = bytes(range(256)) * 3
    sealed = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(msg, None, nonce, key)
    assert chacha20(key, nonce, msg, counter=1) == sealed[:-16], "ChaCha20 differs from libsodium"


# ---- NIP-44 v2 ----

def conversation_key(sk: PrivateKey, pub_xonly_hex: str) -> bytes:
    shared = PublicKey(b"\x02" + bytes.fromhex(pub_xonly_hex)).multiply(sk.secret)
    shared_x = shared.format(compressed=True)[1:]
    return hmac.new(b"nip44-v2", shared_x, hashlib.sha256).digest()


def message_keys(ck: bytes, nonce: bytes) -> tuple[bytes, bytes, bytes]:
    okm, t = b"", b""
    for i in range(1, 4):
        t = hmac.new(ck, t + nonce + bytes([i]), hashlib.sha256).digest()
        okm += t
    return okm[:32], okm[32:44], okm[44:76]


def calc_padded_len(n: int) -> int:
    if n <= 32:
        return 32
    next_power = 1 << (n - 1).bit_length()
    chunk = 32 if next_power <= 256 else next_power // 8
    return chunk * ((n - 1) // chunk + 1)


def nip44_encrypt(ck: bytes, plaintext: str, nonce: bytes) -> str:
    pt = plaintext.encode()
    assert 1 <= len(pt) <= 65535
    padded = struct.pack(">H", len(pt)) + pt + bytes(calc_padded_len(len(pt)) - len(pt))
    key, cnonce, hkey = message_keys(ck, nonce)
    ct = chacha20(key, cnonce, padded)
    mac = hmac.new(hkey, nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(b"\x02" + nonce + ct + mac).decode()


def nip44_decrypt(ck: bytes, payload: str) -> str:
    if not payload or payload[0] == "#":
        raise ValueError("unknown version")
    if not 132 <= len(payload) <= 87472:
        raise ValueError("payload size")
    data = base64.b64decode(payload, validate=True)
    if not 99 <= len(data) <= 65603 or data[0] != 2:
        raise ValueError("data size or version")
    nonce, ct, mac = data[1:33], data[33:-32], data[-32:]
    key, cnonce, hkey = message_keys(ck, nonce)
    if not hmac.compare_digest(hmac.new(hkey, nonce + ct, hashlib.sha256).digest(), mac):
        raise ValueError("mac")
    padded = chacha20(key, cnonce, ct)
    n = struct.unpack(">H", padded[:2])[0]
    if n == 0 or len(padded) != 2 + calc_padded_len(n):
        raise ValueError("padding")
    return padded[2:2 + n].decode()


# Copied from nip44.vectors.json (v2): a few cases of each kind, as published.
NIP44_REFERENCE = {
    "source": "https://github.com/paulmillr/nip44 nip44.vectors.json, sha256 "
              "269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040 (v2)",
    "get_conversation_key": [
        {"sec1": "315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268",
         "pub2": "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133",
         "conversation_key": "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1"},
        {"sec1": "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364139",
         "pub2": "0000000000000000000000000000000000000000000000000000000000000002",
         "conversation_key": "8b6392dbf2ec6a2b2d5b1477fc2be84d63ef254b667cadd31bd3f444c44ae6ba"},
    ],
    "get_message_keys": {
        "conversation_key": "a1a3d60f3470a8612633924e91febf96dc5366ce130f658b1f0fc652c20b3b54",
        "keys": [
            {"nonce": "e1e6f880560d6d149ed83dcc7e5861ee62a5ee051f7fde9975fe5d25d2a02d72",
             "chacha_key": "f145f3bed47cb70dbeaac07f3a3fe683e822b3715edb7c4fe310829014ce7d76",
             "chacha_nonce": "c4ad129bb01180c0933a160c",
             "hmac_key": "027c1db445f05e2eee864a0975b0ddef5b7110583c8c192de3732571ca5838c4"},
        ],
    },
    "calc_padded_len": [[16, 32], [32, 32], [33, 64], [37, 64], [45, 64], [49, 64], [64, 64],
                        [65, 96], [100, 128], [111, 128], [200, 224], [250, 256], [320, 320],
                        [383, 384], [384, 384], [400, 448], [500, 512], [512, 512], [515, 640],
                        [700, 768], [800, 896], [900, 1024], [1020, 1024], [65536, 65536]],
    "encrypt_decrypt": [
        {"sec1": "0000000000000000000000000000000000000000000000000000000000000001",
         "sec2": "0000000000000000000000000000000000000000000000000000000000000002",
         "conversation_key": "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d",
         "nonce": "0000000000000000000000000000000000000000000000000000000000000001",
         "plaintext": "a",
         "payload": "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb"},
    ],
    "invalid_decrypt": [
        {"conversation_key": "ca2527a037347b91bea0c8a30fc8d9600ffd81ec00038671e3a0f0cb0fc9f642",
         "nonce": "daaea5ca345b268e5b62060ca72c870c48f713bc1e00ff3fc0ddb78e826f10db",
         "plaintext": "n o b l e",
         "payload": "#Atqupco0WyaOW2IGDKcshwxI9xO8HgD/P8Ddt46CbxDbrhdG8VmJdU0MIDf06CUvEvdnr1cp1fiMtlM/GrE92xAc1K5odTpCzUB+mjXgbaqtntBUbTToSUoT0ovrlPwzGjyp",
         "note": "unknown encryption version"},
        {"conversation_key": "36f04e558af246352dcf73b692fbd3646a2207bd8abd4b1cd26b234db84d9481",
         "nonce": "ad408d4be8616dc84bb0bf046454a2a102edac937c35209c43cd7964c5feb781",
         "plaintext": "⚠️",
         "payload": "AK1AjUvoYW3IS7C/BGRUoqEC7ayTfDUgnEPNeWTF/reBZFaha6EAIRueE9D1B1RuoiuFScC0Q94yjIuxZD3JStQtE8JMNacWFs9rlYP+ZydtHhRucp+lxfdvFlaGV/sQlqZz",
         "note": "unknown encryption version 0"},
    ],
}


def _check_nip44(ref: dict) -> None:
    for c in ref["get_conversation_key"]:
        assert conversation_key(PrivateKey(bytes.fromhex(c["sec1"])), c["pub2"]).hex() == c["conversation_key"]
    mk = ref["get_message_keys"]
    for k in mk["keys"]:
        key, cn, hk = message_keys(bytes.fromhex(mk["conversation_key"]), bytes.fromhex(k["nonce"]))
        assert (key.hex(), cn.hex(), hk.hex()) == (k["chacha_key"], k["chacha_nonce"], k["hmac_key"])
    for n, want in ref["calc_padded_len"]:
        assert calc_padded_len(n) == want, (n, want)
    for c in ref["encrypt_decrypt"]:
        s1, s2 = PrivateKey(bytes.fromhex(c["sec1"])), PrivateKey(bytes.fromhex(c["sec2"]))
        ck = conversation_key(s1, xonly(s2))
        assert ck.hex() == c["conversation_key"] == conversation_key(s2, xonly(s1)).hex()
        assert nip44_encrypt(ck, c["plaintext"], bytes.fromhex(c["nonce"])) == c["payload"]
        assert nip44_decrypt(ck, c["payload"]) == c["plaintext"]
    for c in ref["invalid_decrypt"]:
        try:
            nip44_decrypt(bytes.fromhex(c["conversation_key"]), c["payload"])
        except (ValueError, UnicodeDecodeError, base64.binascii.Error):
            continue
        raise AssertionError(f"invalid NIP-44 payload decrypted: {c['note']}")




# ---- events (NFX-10 §§6.2-6.3) ----

def challenge(t: str, tags: list, content: str) -> str:
    def one(name):
        vals = [x[1] for x in tags if x[0] == name]
        return vals[0] if vals else ""
    if t in ("connect", "disconnect"):
        return nip01_json(["nip-dc-presence-v1", t, one("P"), one("d"), one("i"), one("y"),
                           one("version"), one("expiration"), content])
    return nip01_json([one("p"), content])


def roomproof(room: PrivateKey, created_at: int, sender_pubkey: str, chal: str) -> tuple[str, str, str]:
    """(preimage, id, sig): id = sha256(NIP-01 JSON of [0, P, created_at, kind, pubkey, challenge, ""])."""
    preimage = nip01_json([0, xonly(room), created_at, KIND, sender_pubkey, chal, ""])
    rid = sha256(preimage.encode())
    return preimage, rid.hex(), room.sign_schnorr(rid, aux_randomness=bytes(32)).hex()


def meshsig_vectors(keypair, schnorr_id_pubkey, nostr_event) -> dict:
    _check_chacha20()
    ref = NIP44_REFERENCE
    _check_nip44(ref)

    def event(sk, t, room, session_id, content="", p=None, e=None, expiration=None, created_at=CREATED_AT,
              extra=None, proof=True, proof_challenge=None, proof_key=None):
        tags = [["t", t], ["P", xonly(room)], ["d", session_id], ["i", PROTOCOL], ["y", APP]]
        if p is not None:
            tags.append(["p", p])
        if e is not None:
            tags.append(["e", e])
        if expiration is not None:
            tags.append(["expiration", str(expiration)])
        tags += extra or []
        info = None
        if proof:
            chal = proof_challenge if proof_challenge is not None else challenge(t, tags, content)
            pre, rid, sig = roomproof(proof_key or room, created_at, schnorr_id_pubkey(sk), chal)
            tags.append(["roomproof", rid, sig])
            info = {"challenge": chal, "preimage": pre, "id": rid}
        return nostr_event(sk, KIND, tags, content, created_at), info

    # Rooms.
    h0, secret, steps = room_secret(SWARM)
    assert steps == 0
    room = PrivateKey(secret)
    other_h0, other_secret, _ = room_secret("nfx/1/web/nfx:mainnet:1:salt-flats-dusk/360p")
    other_room = PrivateKey(other_secret)
    rooms = []
    for swarm in (SWARM, "nfx/1/web/nfx:mainnet:1:salt-flats-dusk/360p", "nfx/1/web/nfx:testnet:1:mesh-e2e/1080p"):
        r0, rs, n = room_secret(swarm)
        rooms.append({"stream_swarm_id": swarm, "h0": r0.hex(), "rehashes": n, "secret": rs.hex(),
                      "pubkey": xonly(PrivateKey(rs))})
    # No swarm ID that needs a rehash is known (an h0 out of range has probability ~2^-128),
    # so the step is pinned from forced out-of-range values.
    forced = []
    for h in (bytes(32), SECP256K1_N.to_bytes(32, "big"), b"\xff" * 32, (SECP256K1_N - 1).to_bytes(32, "big")):
        nxt = sha256(h)
        forced.append({"h": h.hex(), "valid": valid_scalar(h), "next": nxt.hex(), "next_valid": valid_scalar(nxt)})

    # Sessions: the lower pubkey offers (NFX-10 §6.6).
    a, b = keypair("nfx-test-vector/mesh-alice"), keypair("nfx-test-vector/mesh-bob")
    carol = keypair("nfx-test-vector/mesh-carol")
    offerer, answerer = sorted([a, b], key=schnorr_id_pubkey)
    names = {schnorr_id_pubkey(a): "alice", schnorr_id_pubkey(b): "bob"}
    off_name, ans_name = names[schnorr_id_pubkey(offerer)], names[schnorr_id_pubkey(answerer)]
    off_pk, ans_pk = schnorr_id_pubkey(offerer), schnorr_id_pubkey(answerer)
    off_d = sha256(b"nfx-test-vector/mesh-session/" + off_name.encode())[:16].hex()
    ans_d = sha256(b"nfx-test-vector/mesh-session/" + ans_name.encode())[:16].hex()

    offer_sdp = (
        "v=0\r\n"
        "o=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n"
        "s=-\r\n"
        "t=0 0\r\n"
        "a=group:BUNDLE 0\r\n"
        "a=extmap-allow-mixed\r\n"
        "a=msid-semantic: WMS\r\n"
        "m=application 50000 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        "c=IN IP4 203.0.113.7\r\n"
        "a=candidate:1467250027 1 udp 2122260223 192.0.2.10 50000 typ host generation 0 network-id 1\r\n"
        "a=candidate:842163049 1 udp 1686052607 203.0.113.7 50000 typ srflx raddr 192.0.2.10 rport 50000 generation 0 network-id 1\r\n"
        "a=end-of-candidates\r\n"
        "a=ice-ufrag:Zx4q\r\n"
        "a=ice-pwd:t1bn2hNzEJhVqk8eY0dWfB3x\r\n"
        "a=ice-options:trickle\r\n"
        "a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CC:87:32:BE:DD:8C:66:A5:8E:50:55:EA:8C:D3:B6:5C:09:5E:79:F2\r\n"
        "a=setup:actpass\r\n"
        "a=mid:0\r\n"
        "a=sctp-port:5000\r\n"
        "a=max-message-size:262144\r\n"
    )
    answer_sdp = (
        "v=0\r\n"
        "o=- 2924151394583718465 2 IN IP4 127.0.0.1\r\n"
        "s=-\r\n"
        "t=0 0\r\n"
        "a=group:BUNDLE 0\r\n"
        "a=extmap-allow-mixed\r\n"
        "a=msid-semantic: WMS\r\n"
        "m=application 50001 UDP/DTLS/SCTP webrtc-datachannel\r\n"
        "c=IN IP4 198.51.100.20\r\n"
        "a=candidate:3029810186 1 udp 2122260223 192.0.2.77 50001 typ host generation 0 network-id 1\r\n"
        "a=candidate:2391857424 1 udp 1686052607 198.51.100.20 50001 typ srflx raddr 192.0.2.77 rport 50001 generation 0 network-id 1\r\n"
        "a=end-of-candidates\r\n"
        "a=ice-ufrag:9ePq\r\n"
        "a=ice-pwd:Wl0r5nQ2mKcY8sVb3xHj7aTu\r\n"
        "a=ice-options:trickle\r\n"
        "a=fingerprint:sha-256 0C:41:39:7B:3E:0A:1F:5E:27:84:9D:10:6C:A2:F4:33:58:B0:7E:91:C6:2D:4A:E8:15:73:BF:09:62:D4:8E:21\r\n"
        "a=setup:active\r\n"
        "a=mid:0\r\n"
        "a=sctp-port:5000\r\n"
        "a=max-message-size:262144\r\n"
    )
    ck = conversation_key(offerer, ans_pk)
    assert ck == conversation_key(answerer, off_pk)
    offer_nonce = sha256(b"nfx-test-vector/mesh-offer-nonce")
    answer_nonce = sha256(b"nfx-test-vector/mesh-answer-nonce")
    offer_ct = nip44_encrypt(ck, offer_sdp, offer_nonce)
    answer_ct = nip44_encrypt(ck, answer_sdp, answer_nonce)
    assert nip44_decrypt(ck, offer_ct) == offer_sdp and nip44_decrypt(ck, answer_ct) == answer_sdp

    connect, connect_proof = event(offerer, "connect", room, off_d, expiration=CREATED_AT + PRESENCE_TTL)
    disconnect, disconnect_proof = event(offerer, "disconnect", room, off_d)
    offer, offer_proof = event(offerer, "offer", room, off_d, content=offer_ct, p=ans_pk)
    answer, answer_proof = event(answerer, "answer", room, ans_d, content=answer_ct, p=off_pk, e=offer["id"])
    answerer_connect, _ = event(answerer, "connect", room, ans_d, expiration=CREATED_AT + PRESENCE_TTL)
    with_unknown, _ = event(offerer, "connect", room, off_d, expiration=CREATED_AT + PRESENCE_TTL,
                            extra=[["x-future-tag", "ignored"]])

    valid = {
        "description": "NFX-10 §6 signaling over Nostr (kind 25050, i = nfx-mesh/1), signaling-compatible "
                       "with the NIP-DC draft §§2, 4-6. 'rooms': room secret = the first h_i in range "
                       "(0 < h_i < n), h_0 = sha256(utf8('nfx/1/web/room') || 0x00 || utf8(stream swarm ID)), "
                       "h_(i+1) = sha256(h_i); P = its BIP-340 x-only key. 'rehash' pins that step from "
                       "forced out-of-range values (no swarm ID needing one is known). 'events' are checked "
                       "at 'now' in room P by the session that each directed event's p names; the "
                       "lower session pubkey is the offerer. Offer and answer content is NIP-44 v2 "
                       "(offerer <-> answerer conversation key) of the complete SDP, with the fixed "
                       "nonces given; 'roomproof' gives each event's challenge, preimage and id "
                       "(NIP-DC §2: sig = BIP-340 by the room secret over id, here aux_rand = 32 zero "
                       "bytes like every signature in these vectors). 'connect_with_unknown_tag' MUST "
                       "be accepted. 'nip44_reference' are cases copied from the official NIP-44 "
                       "vectors, which an implementation of these events should also pass.",
        "secret_keys_DO_NOT_USE": {
            "offerer": offerer.secret.hex(), "answerer": answerer.secret.hex(),
            "room": secret.hex(),
        },
        "now": NOW,
        "max_age": MAX_AGE,
        "max_future": MAX_FUTURE,
        "presence_ttl": PRESENCE_TTL,
        "max_content": MAX_CONTENT,
        "rooms": rooms,
        "rehash": forced,
        "room": {"stream_swarm_id": SWARM, "pubkey": xonly(room)},
        "sessions": {
            "offerer": {"name": off_name, "pubkey": off_pk, "session_id": off_d},
            "answerer": {"name": ans_name, "pubkey": ans_pk, "session_id": ans_d},
        },
        "nip44": {
            "conversation_key": ck.hex(),
            "offer_nonce": offer_nonce.hex(),
            "answer_nonce": answer_nonce.hex(),
            "offer_padded_len": calc_padded_len(len(offer_sdp.encode())),
        },
        "sdp": {"offer": offer_sdp, "answer": answer_sdp},
        "events": {
            "connect": connect,
            "disconnect": disconnect,
            "offer": offer,
            "answer": answer,
            "answerer_connect": answerer_connect,
        },
        "roomproof": {
            "connect": connect_proof,
            "disconnect": disconnect_proof,
            "offer": offer_proof,
            "answer": answer_proof,
        },
        "connect_with_unknown_tag": with_unknown,
        "nip44_reference": ref,
    }

    # ---- events that MUST be rejected, or ignored, by the answerer at NOW ----
    def case(name, reason, ev):
        return {"name": name, "reason": reason, "event": ev}

    def tamper(ev, **changes):
        bad = copy.deepcopy(ev)
        bad.update(changes)
        return bad

    def off(**kw):
        kw.setdefault("content", offer_ct)
        kw.setdefault("p", ans_pk)
        return event(offerer, "offer", room, off_d, **kw)[0]

    def conn(**kw):
        kw.setdefault("expiration", CREATED_AT + PRESENCE_TTL)
        return event(offerer, "connect", room, off_d, **kw)[0]

    other_nonce = sha256(b"nfx-test-vector/mesh-other-nonce")
    flipped = bytearray(base64.b64decode(offer_ct))
    flipped[40] ^= 0x01
    bad_mac = base64.b64encode(bytes(flipped)).decode()
    v1 = bytearray(base64.b64decode(offer_ct))
    v1[0] = 1
    long_ct = nip44_encrypt(ck, "v=0\r\n" + "a=x-pad:" + "p" * 24600 + "\r\n", other_nonce)
    assert len(long_ct) > MAX_CONTENT
    wrong_sig = tamper(connect, sig=connect["sig"][:-2] + ("00" if connect["sig"][-2:] != "00" else "01"))
    wrong_id = tamper(connect, id=offer["id"])
    other_room_tags = [["t", "connect"], ["P", xonly(other_room)], ["d", off_d], ["i", PROTOCOL], ["y", APP],
                       ["expiration", str(CREATED_AT + PRESENCE_TTL)]]
    _, orid, osig = roomproof(other_room, CREATED_AT, off_pk, challenge("connect", other_room_tags, ""))
    other_room_ev = nostr_event(offerer, KIND, other_room_tags + [["roomproof", orid, osig]], "", CREATED_AT)

    rejected = [
        case("bad-signature", "NIP-01 signature", wrong_sig),
        case("id-mismatch", "NIP-01 id", wrong_id),
        case("other-room", "P is not the room subscribed to (its proof is valid for that room)", other_room_ev),
        case("wrong-y", "y must be nfx",
             _retag(offerer, nostr_event, room, "connect", off_d, {"y": "other"}, expiration=CREATED_AT + 90)),
        case("session-id-short", "d is 32 lowercase hex",
             event(offerer, "connect", room, off_d[:30], expiration=CREATED_AT + 90)[0]),
        case("session-id-upper", "d is 32 lowercase hex",
             event(offerer, "connect", room, off_d.upper(), expiration=CREATED_AT + 90)[0]),
        case("two-d-tags", "exactly one d",
             conn(extra=[["d", ans_d]])),
        case("too-old", "created_at >= now - 60",
             conn(created_at=NOW - MAX_AGE - 1, expiration=NOW - MAX_AGE - 1 + PRESENCE_TTL)),
        case("too-new", "created_at <= now + 30",
             conn(created_at=NOW + MAX_FUTURE + 1, expiration=NOW + MAX_FUTURE + 1 + PRESENCE_TTL)),
        case("connect-expired", "presence expiration > now",
             conn(expiration=NOW)),
        case("connect-ttl-too-long", "expiration - created_at <= 90",
             conn(expiration=CREATED_AT + PRESENCE_TTL + 1)),
        case("connect-expiration-before-created", "expiration > created_at",
             conn(created_at=NOW + 5, expiration=NOW + 5)),
        case("connect-no-expiration", "connect carries expiration",
             event(offerer, "connect", room, off_d)[0]),
        case("connect-expiration-not-decimal", "expiration is a plain decimal",
             conn(expiration="+" + str(CREATED_AT + 60))),
        case("connect-two-expirations", "exactly one expiration",
             conn(extra=[["expiration", str(CREATED_AT + 60)]])),
        case("connect-content", "presence content is empty",
             conn(content="hello")),
        case("connect-directed", "presence carries no p",
             conn(p=ans_pk)),
        case("disconnect-with-expiration", "disconnect carries no expiration",
             event(offerer, "disconnect", room, off_d, expiration=CREATED_AT + 90)[0]),
        case("no-roomproof", "every event carries a room proof", conn(proof=False)),
        case("roomproof-by-sender", "the room proof is signed by the room key, not the sender",
             conn(proof_key=offerer)),
        case("roomproof-other-room", "the room proof is the room's",
             conn(proof_key=other_room)),
        case("roomproof-wrong-challenge", "the presence challenge (here: an offer's)",
             conn(proof_challenge=nip01_json([ans_pk, ""]))),
        case("roomproof-stale-content", "the proof covers the content",
             _swap_content(offer, nip44_encrypt(ck, offer_sdp, other_nonce), offerer, nostr_event)),
        case("offer-no-p", "directed events carry exactly one p", off(p=None)),
        case("offer-two-p", "exactly one p", off(extra=[["p", schnorr_id_pubkey(carol)]])),
        case("offer-p-not-hex", "p is 64 lowercase hex", off(p=ans_pk.upper())),
        case("offer-plaintext-sdp", "content is NIP-44 v2, never a plaintext SDP", off(content=offer_sdp)),
        case("offer-empty", "content is NIP-44 v2", off(content="")),
        case("offer-too-long", "content is at most 32768 bytes", off(content=long_ct)),
        case("offer-bad-mac", "NIP-44 MAC", off(content=bad_mac)),
        case("offer-version-1", "NIP-44 version 2 only",
             off(content=base64.b64encode(bytes(v1)).decode())),
        case("offer-version-hash", "NIP-44: '#' is an unknown version", off(content="#" + offer_ct[1:])),
        case("offer-not-sdp", "the plaintext is an SDP (first line v=0)",
             off(content=nip44_encrypt(ck, "hello, not an SDP", other_nonce))),
        case("offer-for-other-key", "encrypted to another key: decryption fails",
             off(content=nip44_encrypt(conversation_key(offerer, schnorr_id_pubkey(carol)), offer_sdp, other_nonce))),
        case("answer-no-e", "an answer names the offer it answers",
             event(answerer, "answer", room, ans_d, content=nip44_encrypt(ck, answer_sdp, other_nonce),
                   p=off_pk)[0]),
        case("answer-e-not-hex", "e is 64 lowercase hex",
             event(answerer, "answer", room, ans_d, content=nip44_encrypt(ck, answer_sdp, other_nonce),
                   p=off_pk, e=offer["id"][:63])[0]),
    ]
    # Read by the answerer, except 'answer-*', which the offerer reads.
    ignored = [
        case("other-protocol", "i is not nfx-mesh/1",
             _retag(offerer, nostr_event, room, "connect", off_d, {"i": "other-app/1"}, expiration=CREATED_AT + 90)),
        case("nip-dc-dc4", "a NIP-DC presence of another application",
             _retag(offerer, nostr_event, room, "connect", off_d, {"i": "nostr4j-demo", "y": "demo"},
                    expiration=CREATED_AT + 90, extra=[["version", "dc4"]])),
        case("no-i", "a kind-25050 event with no i (another shape, e.g. hashtree's)",
             nostr_event(offerer, KIND, [["P", xonly(room)], ["t", "connect"]], "", CREATED_AT)),
        case("two-i", "exactly one i", conn(extra=[["i", "other-app/1"]])),
        case("route", "route (trickle candidates) is not used by nfx-mesh/1",
             event(offerer, "route", room, off_d, content=nip44_encrypt(ck, '{"candidates":[]}', other_nonce),
                   p=ans_pk)[0]),
        case("unknown-type", "t is one of connect, disconnect, offer, answer",
             event(offerer, "hello", room, off_d, p=ans_pk)[0]),
        case("not-for-us", "an offer to another session",
             event(offerer, "offer", room, off_d,
                   content=nip44_encrypt(conversation_key(offerer, schnorr_id_pubkey(carol)), offer_sdp, other_nonce),
                   p=schnorr_id_pubkey(carol))[0]),
    ]
    invalid = {
        "description": "Kind-25050 events checked at 'now' in the room of mesh-signal.json, by the "
                       "answerer session (by the offerer for 'answer-*' cases). Every event is correctly "
                       "signed (NIP-01) unless its name says otherwise. 'rejected' MUST be dropped as "
                       "invalid (NFX-10 §6.5): an implementation fails it at parsing, at the room proof "
                       "or at decryption. 'ignored' MUST be dropped as not this reader's (another "
                       "protocol identifier, a type nfx-mesh/1 does not use, or another receiver) "
                       "without error and before any decryption. 'reason' is informative.",
        "secret_keys_DO_NOT_USE": {"offerer": offerer.secret.hex(), "answerer": answerer.secret.hex(),
                                   "carol": carol.secret.hex()},
        "now": NOW,
        "room": xonly(room),
        "offerer": off_pk,
        "answerer": ans_pk,
        "rejected": rejected,
        "ignored": ignored,
    }
    return {"mesh-signal.json": valid, "mesh-signal-invalid.json": invalid}


def _retag(sk, nostr_event, room, t, session_id, replace, expiration=None, extra=None):
    """A correctly proved event whose t, P, d, i, y tags take `replace`'s values."""
    base = {"t": t, "P": xonly(room), "d": session_id, "i": PROTOCOL, "y": APP}
    base.update(replace)
    tags = [[k, base[k]] for k in ("t", "P", "d", "i", "y")]
    if expiration is not None:
        tags.append(["expiration", str(expiration)])
    tags += extra or []
    pub = sk.public_key.format(compressed=True)[1:].hex()
    _, rid, sig = roomproof(room, CREATED_AT, pub, challenge(t, tags, ""))
    return nostr_event(sk, KIND, tags + [["roomproof", rid, sig]], "", CREATED_AT)


def _swap_content(ev, content, sk, nostr_event):
    """`ev` re-signed (NIP-01) with other content, its room proof left as it was."""
    return nostr_event(sk, KIND, ev["tags"], content, ev["created_at"])
