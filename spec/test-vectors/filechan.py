"""NFX-10 §6.10 file channel vectors (`nfx-files/1`): file-channel.json and
file-channel-invalid.json.

Every message is one data-channel message: a type byte, then the body; integers are 4-byte
little endian. Types 0-3 carry NFX-12 §4's messages byte for byte after the type byte.
Imported by generate.py, which passes the hash-list vector's files and its beacon content.
"""

import copy
import hashlib
import json
import struct

LABEL = "nfx-files/1"
VERSION = 1
FLAG_FILES = 1
FLAG_BEACONS = 2
MAX_MESSAGE = 16_384
MAX_DATA = MAX_MESSAGE - 5
MAX_OPEN_REQUESTS = 8
MAX_HAVE_JSON = 2_048
MAX_HAVE_IDS = 32
MAX_BEACONS = 4
MAX_BEACON_BYTES = 16_384
MAX_BEACONS_ANSWER = 65_536
MAX_FUTURE_S = 30
TYPES = ["get", "data", "end", "missing", "hello", "cancel", "busy", "list", "have", "beacons"]

CREATED_AT = 1_790_000_000
TTL = 120


def u32(n: int) -> bytes:
    return struct.pack("<I", n)


def msg(name: str, req: int | None = None, body: bytes = b"") -> bytes:
    t = bytes([TYPES.index(name)])
    return t + (u32(req) if req is not None else b"") + body


def have_json(whole: list, part: list) -> bytes:
    return json.dumps({"whole": whole, "part": part}, separators=(",", ":")).encode()


def compact(ev: dict) -> str:
    """NFX-17 §1.2: the event as compact JSON, members in NIP-01 order."""
    order = ["id", "pubkey", "created_at", "kind", "tags", "content", "sig"]
    return json.dumps({k: ev[k] for k in order}, separators=(",", ":"), ensure_ascii=False)


def beacons_answer(events: list) -> bytes:
    return ("[" + ",".join(compact(e) for e in events) + "]").encode()


def big_file(n: int) -> bytes:
    """The transfer vector's file: byte i is i mod 251."""
    return bytes(i % 251 for i in range(n))


def data_messages(req: int, file: bytes) -> list:
    out = [msg("data", req, file[i:i + MAX_DATA]) for i in range(0, len(file), MAX_DATA)]
    return out + [msg("end", req)]


def filechan_vectors(keypair, schnorr_id_pubkey, nostr_event, *, namespace, a_tag, root,
                     hashlist_bytes, fabricated, files, beacon_content) -> dict:
    sha = lambda b: hashlib.sha256(b).digest()  # noqa: E731
    root_b = bytes.fromhex(root)
    init = fabricated["init-720.mp4"]
    init_sha = sha(init)

    # ---- every message, once ----
    have = have_json(["720p"], [])
    messages = [
        {"name": "get", "req": 7, "sha256": init_sha.hex(), "hex": msg("get", 7, init_sha).hex()},
        {"name": "get-hash-list", "req": 1, "sha256": root, "hex": msg("get", 1, root_b).hex()},
        {"name": "data", "req": 7, "bytes_hex": init.hex(), "hex": msg("data", 7, init).hex()},
        {"name": "end", "req": 7, "hex": msg("end", 7).hex()},
        {"name": "missing", "req": 7, "hex": msg("missing", 7).hex()},
        {"name": "hello", "version": VERSION, "flags": FLAG_FILES | FLAG_BEACONS,
         "hex": bytes([4, VERSION, FLAG_FILES | FLAG_BEACONS]).hex()},
        {"name": "hello-asks-only", "version": VERSION, "flags": 0, "hex": bytes([4, VERSION, 0]).hex()},
        {"name": "hello-unknown-flag-bits", "version": VERSION, "flags": 0xFD,
         "reads_as_flags": FLAG_FILES, "read_only": True, "hex": bytes([4, VERSION, 0xFD]).hex()},
        {"name": "cancel", "req": 7, "hex": msg("cancel", 7).hex()},
        {"name": "busy", "req": 7, "hex": msg("busy", 7).hex()},
        {"name": "list", "req": 2, "root": root, "hex": msg("list", 2, root_b).hex()},
        {"name": "have", "req": 2, "whole": ["720p"], "part": [], "hex": msg("have", 2, have).hex()},
        {"name": "have-with-another-member", "req": 2, "whole": [], "part": ["720p"],
         "read_only": True, "hex": msg("have", 2, b'{"part":["720p"],"whole":[],"v":2}').hex()},
        {"name": "beacons", "req": 3, "hex": msg("beacons", 3).hex()},
        {"name": "end-req-max", "req": 0xFFFFFFFF, "hex": msg("end", 0xFFFFFFFF).hex()},
    ]

    # ---- transfers ----
    hl_transfer = [msg("get", 1, root_b)] + data_messages(1, hashlist_bytes)
    init_transfer = [msg("get", 7, init_sha)] + data_messages(7, init)
    big = big_file(2 * MAX_DATA + 100)
    big_msgs = data_messages(9, big)
    assert len(big_msgs) == 4  # three data, then end
    transfers = {
        "hash_list": {"sha256": root, "size": len(hashlist_bytes),
                      "messages": [m.hex() for m in hl_transfer]},
        "init": {"file": "init-720.mp4", "sha256": init_sha.hex(), "size": len(init),
                 "messages": [m.hex() for m in init_transfer]},
        "three_data_messages": {
            "rule": "byte i of the file is i mod 251",
            "size": len(big), "sha256": sha(big).hex(), "req": 9,
            "get_hex": msg("get", 9, sha(big)).hex(),
            "messages": [{"length": len(m), "head_hex": m[:16].hex(), "sha256": sha(m).hex()}
                         for m in big_msgs],
        },
    }

    # ---- beacons: an answer, and what a reader takes from one ----
    creator = keypair("nfx-test-vector/creator")
    seeder = keypair("nfx-test-vector/seeder")
    stranger = keypair("nfx-test-vector/file-channel-stranger")
    content = json.dumps(beacon_content, separators=(",", ":"))

    def beacon(sk, created_at, a=a_tag, ttl=TTL):
        tags = [["n", namespace], ["a", a], ["expiration", str(created_at + ttl)]]
        return nostr_event(sk, 20464, tags, content, created_at)

    now = CREATED_AT + 30
    seeder_b = beacon(seeder, CREATED_AT + 20)
    creator_b = beacon(creator, CREATED_AT + 10)
    stranger_b = beacon(stranger, CREATED_AT + 25)
    answer = beacons_answer([seeder_b, creator_b])
    assert len(answer) <= MAX_DATA
    other_video = a_tag.rsplit(":", 1)[0] + ":another-video"
    reader = {
        "now": now,
        "video": a_tag,
        "creator": schnorr_id_pubkey(creator),
        "trusted": [schnorr_id_pubkey(seeder)],
        "take": [
            {"name": "the creator's own", "event": creator_b, "tier": 1},
            {"name": "a key with a positive trusted score", "event": seeder_b, "tier": 2},
            {"name": "any other key: a pool entry", "event": stranger_b, "tier": "pool"},
            {"name": "30 s ahead of the reader's clock", "event": beacon(stranger, now + MAX_FUTURE_S),
             "tier": "pool"},
        ],
        "sequence": {
            "description": "read in order from one peer: per signer the newest is kept, an older one is refused",
            "events": [beacon(seeder, CREATED_AT + 20), beacon(seeder, CREATED_AT + 5),
                       beacon(seeder, CREATED_AT + 25)],
            "taken": [True, False, True],
        },
    }

    valid = {
        "description": "NFX-10 §6.10, the file channel ('nfx-files/1'). Each message is one "
                       "data-channel message: a type byte (get 0, data 1, end 2, missing 3, hello 4, "
                       "cancel 5, busy 6, list 7, have 8, beacons 9), then its body; integers are u32 "
                       "little endian. 'messages' MUST be read as named, and a writer writes each byte "
                       "for byte, except those marked 'read_only' ('have' members other than whole "
                       "and part are ignored; hello flag bits other than 0 and 1 are ignored, and sent "
                       "as 0). 'transfers' are a requester's get, then the "
                       "server's data messages (at most 16,384 bytes each, file bytes in order) and "
                       "end; 'three_data_messages' pins a 32,858-byte file by its rule, and each "
                       "message by length, first 16 bytes and sha256. 'beacons_answer' is the bytes of "
                       "a beacons answer (a JSON array of compact kind-20464 events, NFX-17 §1.2). "
                       "'reader' gives, at 'now' and for the video 'video', the tier a reader gives "
                       "each beacon in 'take' (1: signed by the creator; 2: a key in 'trusted'; "
                       "pool: any other), and in 'sequence' which of one peer's beacons it takes in "
                       "order. The beacons it MUST refuse are in file-channel-invalid.json.",
        "label": LABEL,
        "version": VERSION,
        "flags": {"files": FLAG_FILES, "beacons": FLAG_BEACONS},
        "limits": {"max_message": MAX_MESSAGE, "max_data": MAX_DATA,
                   "max_open_requests": MAX_OPEN_REQUESTS, "max_have_json": MAX_HAVE_JSON,
                   "max_have_ids": MAX_HAVE_IDS, "max_beacons": MAX_BEACONS,
                   "max_beacon_bytes": MAX_BEACON_BYTES, "max_beacons_answer": MAX_BEACONS_ANSWER,
                   "max_future_s": MAX_FUTURE_S},
        "root": root,
        "messages": messages,
        "transfers": transfers,
        "beacons_answer": {"events": [seeder_b, creator_b], "text": answer.decode(),
                           "messages": [m.hex() for m in [msg("beacons", 3)] + data_messages(3, answer)]},
        "reader": reader,
    }

    # ---- what MUST close the channel ----
    over = msg("data", 1, b"\x00" * (MAX_DATA + 1))
    assert len(over) == MAX_MESSAGE + 1
    many = have_json([f"r{i}" for i in range(MAX_HAVE_IDS + 1)], [])
    long_have = have_json(["x" * (MAX_HAVE_JSON - 22)], [])
    assert len(long_have) > MAX_HAVE_JSON
    refused = [
        ("empty", b""),
        ("type-10", bytes([10]) + u32(1)),
        ("type-255", bytes([255])),
        ("get-35-bytes", msg("get", 7, init_sha[:31])),
        ("get-37-bytes", msg("get", 7, init_sha + b"\x00")),
        ("data-no-bytes", msg("data", 7)),
        ("data-16385-bytes", over),
        ("end-3-bytes", bytes([2]) + u32(7)[:3]),
        ("end-5-bytes", msg("end", 7, b"\x00")),
        ("missing-5-bytes", msg("missing", 7, b"\x00")),
        ("hello-version-2", bytes([4, 2, 0])),
        ("hello-version-0", bytes([4, 0, 0])),
        ("hello-1-byte", bytes([4, VERSION])),
        ("hello-3-bytes", bytes([4, VERSION, 0, 0])),
        ("cancel-3-bytes", bytes([5]) + u32(7)[:3]),
        ("busy-5-bytes", msg("busy", 7, b"\x00")),
        ("list-35-bytes", msg("list", 2, root_b[:31])),
        ("beacons-5-bytes", msg("beacons", 3, b"\x00")),
        ("have-1-byte", msg("have", 2, b"{")),
        ("have-not-json", msg("have", 2, b"{whole}")),
        ("have-an-array", msg("have", 2, b"[[],[]]")),
        ("have-no-part", msg("have", 2, b'{"whole":[]}')),
        ("have-id-in-both", msg("have", 2, have_json(["720p"], ["720p"]))),
        ("have-id-twice", msg("have", 2, have_json(["720p", "720p"], []))),
        ("have-empty-id", msg("have", 2, have_json([""], []))),
        ("have-meta", msg("have", 2, have_json(["meta"], []))),
        ("have-a-number", msg("have", 2, b'{"whole":[720],"part":[]}')),
        ("have-33-ids", msg("have", 2, many)),
        ("have-over-2048-bytes", msg("have", 2, long_have)),
    ]

    def seq(name, reason, sent):
        return {"name": name, "reason": reason, "sent": [m.hex() for m in sent]}

    sequences = [
        seq("second-hello", "a second hello", [bytes([4, VERSION, 1]), bytes([4, VERSION, 1])]),
        seq("ninth-open-request", "more than 8 open requests",
            [bytes([4, VERSION, 0])] + [msg("get", i, sha(bytes([i]))) for i in range(9)]),
        seq("req-already-open", "a req that is open", [bytes([4, VERSION, 0]), msg("get", 1, init_sha),
                                                       msg("list", 1, root_b)]),
        seq("one-file-twice-open", "two open requests for one sha",
            [bytes([4, VERSION, 0]), msg("get", 1, init_sha), msg("get", 2, init_sha)]),
    ]
    not_compact = answer.decode().replace(",", ", ", 1).encode()
    beacons_refused = [
        {"name": "five-events", "text": beacons_answer([seeder_b] * 5).decode()},
        {"name": "no-events", "text": "[]"},
        {"name": "not-compact", "text": not_compact.decode()},
        {"name": "members-reordered", "text": "[" + json.dumps(seeder_b, separators=(",", ":"), sort_keys=True) + "]"},
        {"name": "not-a-beacon", "text": beacons_answer([nostr_event(seeder, 1, [], "hi", CREATED_AT)]).decode()},
        {"name": "not-an-array", "text": compact(seeder_b)},
        {"name": "no-sig", "text": "[" + json.dumps({k: seeder_b[k] for k in ["id", "pubkey", "created_at", "kind", "tags", "content"]},
                                                     separators=(",", ":"), ensure_ascii=False) + "]"},
        {"name": "kind-a-string", "text": "[" + compact(seeder_b).replace('"kind":20464', '"kind":"20464"', 1) + "]"},
    ]
    reader_refused = {
        "now": now,
        "video": a_tag,
        "events": [
            {"name": "31 s ahead of the reader's clock", "event": beacon(stranger, now + MAX_FUTURE_S + 1)},
            {"name": "expired at the reader's clock", "event": beacon(stranger, now - 61, ttl=60)},
            {"name": "another video's beacon", "event": beacon(seeder, CREATED_AT + 20, a=other_video)},
            {"name": "not a beacon", "event": nostr_event(seeder, 1, [["a", a_tag]], "hi", CREATED_AT + 20)},
        ],
    }
    invalid = {
        "description": "NFX-10 §6.10. 'messages' MUST each close the channel when received (a "
                       "protocol error). 'sequences' are messages one side sends in order, a hello first: "
                       "the receiving server MUST close the channel at the last one. 'beacons_refused' "
                       "are beacons answers a reader MUST refuse whole; 'reader_refused' are beacons a "
                       "reader MUST refuse at 'now' when it plays 'video'. 'reason' is informative.",
        "messages": [{"name": n, "hex": b.hex()} for n, b in refused],
        "sequences": sequences,
        "beacons_refused": beacons_refused,
        "reader_refused": reader_refused,
    }
    return {"file-channel.json": valid, "file-channel-invalid.json": invalid}
