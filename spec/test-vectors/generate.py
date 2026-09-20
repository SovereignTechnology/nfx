#!/usr/bin/env python3
"""NFX test-vector generator/verifier (NFX-11 §7).

Regenerates every vector deterministically:
  - keys derived from published seed phrases (NOT secure; never reuse)
  - fixed timestamps
  - BIP340 signatures with aux_rand = 32 zero bytes

Usage:
  python3 generate.py            # (re)write vectors
  python3 generate.py --verify   # recompute and compare against the files on disk

Requires: coincurve (pip install coincurve). No network access.
"""

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path

from coincurve import PrivateKey

HERE = Path(__file__).resolve().parent

CREATED_AT = 1_790_000_000  # fixed; exact date is irrelevant
NAMESPACE = "nutflix:mainnet:1"
VIDEO_ID = "salt-flats-dusk"
TTL = 120


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    creator = keypair("nfx-test-vector/creator")
    seeder = keypair("nfx-test-vector/seeder")
    cashu = keypair("nfx-test-vector/cashu")  # stands in for the creator's P2PK wallet key

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
        "video": f"{NAMESPACE}:{VIDEO_ID}",
        "files": files,
        "renditions": [{
            "id": "720p", "playlist": "r720.m3u8", "bandwidth": 2_500_000,
            "codecs": "avc1.64001f,mp4a.40.2", "resolution": "1280x720",
        }],
    }
    hashlist_bytes = json.dumps(hashlist, indent=2, ensure_ascii=False).encode() + b"\n"
    root = sha256(hashlist_bytes)

    # ---- 3. Manifest event (NFX-02), licensed mode, signed by the creator ----
    manifest_tags = [
        ["d", f"{NAMESPACE}:{VIDEO_ID}"],
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
    manifest = nostr_event(creator, 38504, manifest_tags,
                           "A walk through the salt flats at dusk.", CREATED_AT)

    # ---- 4. Beacon event (NFX-03), signed by the seeder ----
    beacon_content = {
        "v": 1,
        "video": f"{NAMESPACE}:{VIDEO_ID}",
        "endpoints": [
            {
                "t": "iroh",
                "node": sha256(b"nfx-test-vector/node-id"),
                "relay": "https://iroh-relay.example",
                "addrs": ["203.0.113.10:11204"],
                "tickets": {
                    "720p": "PLACEHOLDER-ticket-format-pinned-at-M1",
                    "meta": "PLACEHOLDER-meta-collection-ticket-pinned-at-M1",
                },
            },
            {"t": "https", "url": "https://seed.example/nfx"},
        ],
        "chunks": "all",
        "price_hint": 1,
        "accepts_mints": ["https://mint.example"],
        "free": False,
    }
    beacon_tags = [
        ["n", NAMESPACE],
        ["a", f"38504:{manifest['pubkey']}:{NAMESPACE}:{VIDEO_ID}"],
        ["expiration", str(CREATED_AT + TTL)],
    ]
    beacon = nostr_event(seeder, 20464, beacon_tags,
                         json.dumps(beacon_content, separators=(",", ":")), CREATED_AT)

    outputs = {
        "hashlist.json": {
            "description": "NFX-05 hash list for the 2026-09 test vector video. "
                           "Its exact byte content hashed with sha256 gives the manifest root.",
            "video": f"{NAMESPACE}:{VIDEO_ID}",
            "rendered_bytes_sha256": root,
            "note": "Vectors for fabricated bytes: 'fabricated' maps name -> base64 content.",
            "hashlist": hashlist,
            "fabricated": {k: base64.b64encode(v).decode() for k, v in fabricated.items()},
            "playlists": {"master.m3u8": master.decode(), "r720.m3u8": r720.decode()},
        },
        "manifest.json": {
            "description": "NFX-02 manifest (kind 38504), licensed mode. "
                           "Deterministic signature: aux_rand = 32 zero bytes.",
            "secret_keys_DO_NOT_USE": {
                "creator": hashlib.sha256(b"nfx-test-vector/creator").hexdigest(),
                "seeder": hashlib.sha256(b"nfx-test-vector/seeder").hexdigest(),
                "cashu": hashlib.sha256(b"nfx-test-vector/cashu").hexdigest(),
            },
            "event": manifest,
        },
        "beacon.json": {
            "description": "NFX-03 beacon (kind 20464, TTL 120). The iroh ticket is a "
                           "placeholder; ticket encodings pin at the M1 freeze (NFX-11 §4).",
            "secret_keys_DO_NOT_USE": {
                "seeder": hashlib.sha256(b"nfx-test-vector/seeder").hexdigest(),
            },
            "event": beacon,
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
