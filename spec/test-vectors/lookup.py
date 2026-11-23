"""NFX-17 (seeder lookup) test vectors, for generate.py.

Kind-20465 events: a viewer's `ask`, a seeder's `tell` carrying its signed kind-20464 beacon, and
events that MUST be rejected or ignored. Everything here is written from the spec text, with no
Nostr library: secp256k1 comes from coincurve, as in generate.py.
"""

import copy
import json

KIND = 20465
KIND_BEACON = 20464
ASK_TTL = 60
BEACON_TTL = 60
MAX_AGE = 60
MAX_FUTURE = 30
MAX_TELL_CONTENT = 16384

CREATED_AT = 1_790_000_000
NOW = CREATED_AT + 10
NAMESPACE = "nfx:mainnet:1"


def compact(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def lookup_vectors(keypair, schnorr_id_pubkey, nostr_event, secrets, a_tag, beacon_content) -> dict:
    seeder = keypair("nfx-test-vector/seeder")
    assert seeder.secret.hex() == secrets["seeder"], "the seeder key is generate.py's"
    asker = keypair("nfx-test-vector/lookup-asker")
    stranger = keypair("nfx-test-vector/lookup-stranger")
    asker_pk = schnorr_id_pubkey(asker)
    seeder_pk = schnorr_id_pubkey(seeder)
    other_a = a_tag.rsplit(":", 1)[0] + ":another-video"
    assert other_a != a_tag

    def beacon_event(created_at=CREATED_AT - 5, ttl=BEACON_TTL, sk=seeder, a=a_tag, content=None):
        c = content if content is not None else compact(beacon_content)
        tags = [["n", NAMESPACE], ["a", a], ["expiration", str(created_at + ttl)]]
        return nostr_event(sk, KIND_BEACON, tags, c, created_at)

    beacon = beacon_event()
    beacon_json = compact(beacon)
    beacon_exp = str(CREATED_AT - 5 + BEACON_TTL)

    def ask_tags(a=a_tag, expiration=CREATED_AT + ASK_TTL):
        return [["n", NAMESPACE], ["a", a], ["t", "ask"], ["expiration", str(expiration)]]

    def tell_tags(a=a_tag, p=asker_pk, expiration=beacon_exp):
        return [["n", NAMESPACE], ["a", a], ["t", "tell"], ["p", p], ["expiration", str(expiration)]]

    def ev(sk, tags, content="", created_at=CREATED_AT, kind=KIND):
        return nostr_event(sk, kind, tags, content, created_at)

    ask = ev(asker, ask_tags())
    tell = ev(seeder, tell_tags(), beacon_json)
    # Readers ignore tags they do not know (NFX-01 §4).
    ask_extra = ev(asker, ask_tags() + [["client", "any"]])
    tell_extra = ev(seeder, tell_tags() + [["client", "any"]], beacon_json)

    def wrap(b, created_at=CREATED_AT):
        return ev(seeder, tell_tags(expiration=b["tags"][2][1]), compact(b), created_at=created_at)

    boundaries = [
        {"name": "ask-59-s-old", "event": ev(asker, ask_tags(expiration=NOW + 1), created_at=NOW - 59)},
        {"name": "ask-30-s-ahead", "event": ev(asker, ask_tags(expiration=NOW + MAX_FUTURE + ASK_TTL),
                                               created_at=NOW + MAX_FUTURE)},
        {"name": "ask-lifetime-1", "event": ev(asker, ask_tags(expiration=NOW + 1), created_at=NOW)},
        {"name": "tell-60-s-old", "event": wrap(beacon_event(created_at=NOW - 70, ttl=120), NOW - MAX_AGE)},
        {"name": "tell-30-s-ahead", "event": wrap(beacon, NOW + MAX_FUTURE)},
        {"name": "tell-same-second-as-its-beacon", "event": wrap(beacon, beacon["created_at"])},
        {"name": "tell-beacon-expires-next-second", "event": wrap(beacon_event(created_at=NOW - 59), NOW - 1)},
    ]

    valid = {
        "description": "NFX-17: a viewer's ask and a seeder's tell, valid at 'now'. Each event is NIP-01 "
                       "signed with aux_rand = 32 zero bytes, so it reproduces byte for byte from the "
                       "throwaway keys. A tell's content is the compact JSON of the embedded kind-20464 "
                       "beacon, members in the order id, pubkey, created_at, kind, tags, content, sig. "
                       "'with_unknown_tag' events and every 'boundaries' event MUST be accepted: readers "
                       "ignore tags they do not know, and each boundary sits exactly on a limit.",
        "secret_keys_DO_NOT_USE": {"seeder": seeder.secret.hex(), "asker": asker.secret.hex()},
        "now": NOW,
        "manifest_a": a_tag,
        "asker": asker_pk,
        "seeder": seeder_pk,
        "beacon": beacon,
        "ask": ask,
        "tell": tell,
        "ask_with_unknown_tag": ask_extra,
        "tell_with_unknown_tag": tell_extra,
        "boundaries": boundaries,
    }

    rejected = []

    def reject(name, reason, event):
        rejected.append({"name": name, "reason": reason, "event": event})

    def without(tags, name):
        return [t for t in tags if t[0] != name]

    def tampered_sig(event):
        e = copy.deepcopy(event)
        e["sig"] = ("0" if e["sig"][0] != "0" else "1") + e["sig"][1:]
        return e

    def tampered_id(event):
        e = copy.deepcopy(event)
        e["id"] = ("0" if e["id"][0] != "0" else "1") + e["id"][1:]
        return e

    # ---- asks ----
    reject("ask-wrong-kind", "not kind 20465", ev(asker, ask_tags(), kind=20466))
    for name in ("n", "a", "t", "expiration"):
        reject(f"ask-no-{name}", f"no `{name}` tag", ev(asker, without(ask_tags(), name)))
    reject("ask-two-n", "`n` twice", ev(asker, ask_tags() + [["n", NAMESPACE]]))
    reject("ask-two-a", "`a` twice", ev(asker, ask_tags() + [["a", other_a]]))
    reject("ask-two-t", "`t` twice", ev(asker, ask_tags() + [["t", "tell"]]))
    reject("ask-two-expiration", "`expiration` twice",
           ev(asker, ask_tags() + [["expiration", str(CREATED_AT + 30)]]))
    reject("ask-other-network", "`a` names another network than `n`",
           ev(asker, [["n", "nfx:testnet:1"]] + ask_tags()[1:]))
    reject("ask-a-not-a-manifest", "`a` does not address a kind-38504 manifest",
           ev(asker, ask_tags(a="1" + a_tag)))
    reject("ask-with-p", "an ask carries no `p`", ev(asker, ask_tags() + [["p", seeder_pk]]))
    reject("ask-with-content", "an ask's content is empty", ev(asker, ask_tags(), "hello"))
    reject("ask-lifetime-61", "lifetime over 60 s", ev(asker, ask_tags(expiration=CREATED_AT + 61)))
    reject("ask-lifetime-0", "`expiration` equals `created_at`",
           ev(asker, ask_tags(expiration=NOW + 10), created_at=NOW + 10))
    reject("ask-expiration-not-a-number", "`expiration` is not a canonical integer",
           ev(asker, ask_tags(expiration="0" + str(CREATED_AT + 60))))
    reject("ask-expired", "`expiration` is not after now",
           ev(asker, ask_tags(expiration=NOW), created_at=NOW - 30))
    reject("ask-from-the-future", "`created_at` more than 30 s after now",
           ev(asker, ask_tags(expiration=NOW + MAX_FUTURE + 1 + ASK_TTL), created_at=NOW + MAX_FUTURE + 1))
    reject("ask-bad-signature", "the signature does not verify", tampered_sig(ask))
    reject("ask-bad-id", "the id is not the NIP-01 hash", tampered_id(ask))

    # ---- tells ----
    reject("tell-no-p", "a tell needs `p`", ev(seeder, without(tell_tags(), "p"), beacon_json))
    reject("tell-two-p", "`p` twice", ev(seeder, tell_tags() + [["p", seeder_pk]], beacon_json))
    reject("tell-p-uppercase", "`p` is not lowercase hex", ev(seeder, tell_tags(p=asker_pk.upper()), beacon_json))
    reject("tell-p-short", "`p` is not 64 hex", ev(seeder, tell_tags(p=asker_pk[:-2]), beacon_json))
    for name in ("n", "a", "t", "expiration"):
        reject(f"tell-no-{name}", f"no `{name}` tag", ev(seeder, without(tell_tags(), name), beacon_json))
    reject("tell-empty-content", "a tell carries a beacon", ev(seeder, tell_tags()))
    reject("tell-content-not-json", "the content is not JSON", ev(seeder, tell_tags(), "not json"))
    big = beacon_event(content=compact({**beacon_content, "padding": "x" * MAX_TELL_CONTENT}))
    assert len(compact(big)) > MAX_TELL_CONTENT
    reject("tell-content-too-large", "content over 16384 bytes, though it is a valid beacon",
           ev(seeder, tell_tags(), compact(big)))
    reject("tell-embedded-whitespace", "the embedded beacon is not compact",
           ev(seeder, tell_tags(), json.dumps(beacon, indent=1, ensure_ascii=False)))
    reject("tell-embedded-reordered", "the embedded beacon's members are out of order",
           ev(seeder, tell_tags(), compact(dict(reversed(list(beacon.items()))))))
    reject("tell-embedded-extra-member", "the embedded beacon has a member NIP-01 does not",
           ev(seeder, tell_tags(), compact({**beacon, "extra": 1})))
    reject("tell-embedded-duplicate-member", "the embedded beacon repeats a member",
           ev(seeder, tell_tags(), beacon_json[:-1] + ',"kind":20464}'))
    soon = beacon_event(created_at=CREATED_AT + 5)
    reject("tell-beacon-newer-than-the-tell", "the embedded beacon is dated after the tell",
           ev(seeder, tell_tags(expiration=soon["tags"][2][1]), compact(soon)))
    far = beacon_event(created_at=NOW + 899, ttl=120)
    reject("tell-beacon-from-the-future", "a beacon NFX-03 accepts, dated 15 min ahead, would hold a table slot",
           ev(seeder, tell_tags(expiration=far["tags"][2][1]), compact(far)))
    not_beacon = nostr_event(seeder, 1, beacon["tags"], beacon["content"], beacon["created_at"])
    reject("tell-embeds-another-kind", "the embedded event is not a beacon",
           ev(seeder, tell_tags(), compact(not_beacon)))
    reject("tell-embedded-bad-signature", "the embedded beacon's signature does not verify",
           ev(seeder, tell_tags(), compact(tampered_sig(beacon))))
    reject("tell-embedded-bad-id", "the embedded beacon's id is wrong",
           ev(seeder, tell_tags(), compact(tampered_id(beacon))))
    forged_content = copy.deepcopy(beacon)
    forged_content["content"] = compact({**beacon_content, "price_hint": 0})
    reject("tell-embedded-changed", "the embedded beacon was changed after signing",
           ev(seeder, tell_tags(), compact(forged_content)))
    broken = beacon_event(content=compact({k: v for k, v in beacon_content.items() if k != "chunks"}))
    reject("tell-embedded-fails-nfx-03", "the embedded beacon fails NFX-03 (no `chunks`)",
           ev(seeder, tell_tags(), compact(broken)))
    old = beacon_event(created_at=NOW - BEACON_TTL - 1)
    reject("tell-embedded-expired", "the embedded beacon has expired, though the tell claims it has not",
           ev(seeder, tell_tags(expiration=CREATED_AT + 60), compact(old)))
    gone = beacon_event(created_at=NOW - 70)
    reject("tell-expired", "the tell and its beacon have expired, though the tell is fresh",
           ev(seeder, tell_tags(expiration=gone["tags"][2][1]), compact(gone), created_at=NOW - 30))
    theirs = beacon_event(sk=stranger)
    reject("tell-embeds-another-seeders-beacon", "the tell's signer is not the beacon's",
           ev(seeder, tell_tags(), compact(theirs)))
    reject("tell-signed-by-another-key", "the tell's signer is not the beacon's",
           ev(stranger, tell_tags(), beacon_json))
    other_video = beacon_event(a=other_a, content=compact({**beacon_content, "video": other_a.split(":", 2)[2]}))
    reject("tell-other-video", "the embedded beacon serves another video",
           ev(seeder, tell_tags(), compact(other_video)))
    reject("tell-expiration-differs", "the tell's `expiration` is not the beacon's",
           ev(seeder, tell_tags(expiration=int(beacon_exp) + 1), beacon_json))
    long_lived = beacon_event(created_at=NOW - 70, ttl=120)
    reject("tell-too-old", "`created_at` more than 60 s before now",
           ev(seeder, tell_tags(expiration=long_lived["tags"][2][1]), compact(long_lived),
              created_at=NOW - MAX_AGE - 1))
    reject("tell-from-the-future", "`created_at` more than 30 s after now",
           ev(seeder, tell_tags(), beacon_json, created_at=NOW + MAX_FUTURE + 1))
    reject("tell-bad-signature", "the signature does not verify", tampered_sig(tell))
    reject("tell-bad-id", "the id is not the NIP-01 hash", tampered_id(tell))

    ignored = [
        {"name": "another-type", "reason": "a `t` this version does not use",
         "event": ev(asker, [["n", NAMESPACE], ["a", a_tag], ["t", "hello"], ["expiration", str(CREATED_AT + 60)]])},
    ]

    invalid = {
        "description": "NFX-17: kind-20465 events at 'now'. Every 'rejected' event MUST be refused by a "
                       "reader, whether it is an ask or a tell. 'ignored' MUST be dropped without error by "
                       "a reader (a type this version does not use); a scoped relay that admits lookups "
                       "refuses it. 'reason' is informative.",
        "secret_keys_DO_NOT_USE": {"seeder": seeder.secret.hex(), "asker": asker.secret.hex(),
                                   "stranger": stranger.secret.hex()},
        "now": NOW,
        "rejected": rejected,
        "ignored": ignored,
    }
    return {"lookup.json": valid, "lookup-invalid.json": invalid}
