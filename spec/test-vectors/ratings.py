"""Seeder ratings (NFX-16): the reference reader and scorer, and the vectors they classify.

A rating is a nostr-social-memory `rating` record (kind 7368, a nostr-identity fact op)
with scope `nfx.seeder`, plus an `n` and an `expiration` tag. `rating_tags` emits the
tags nostr-social-memory 0.1.1's builder emits for these facts, in its order, then those
two. `read_rating` is NFX-16 §1's validity check and `score` is §4's scoring. Every
vector's verdict below is checked against them when the vectors are generated.
"""

import hashlib
import re
import uuid

KIND = 7368
SCOPE = "nfx.seeder"
MIN_RATING = -100
MAX_RATING = 100
MAX_AGE = 30 * 24 * 60 * 60  # 2,592,000 s; also expiration - created_at
FUTURE_SKEW = 15 * 60
NAMESPACE = "nfx:mainnet:1"
CREATED_AT = 1_790_000_000
DAY = 24 * 60 * 60

HEX64 = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
UINT = re.compile(r"0|[1-9][0-9]*")
INT = re.compile(r"0|-?[1-9][0-9]*")

REQUIRED_FACTS = ("type", "schema", "scope", "rater", "subject", "rating",
                  "min_rating", "max_rating", "created_at")


class Invalid(Exception):
    pass


def record_id(seed: str) -> str:
    """A deterministic, canonical lowercase version-4 UUID for a vector's record."""
    b = bytearray(hashlib.sha256(seed.encode()).digest()[:16])
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(b)))


def rating_tags(rid: str, rater: str, subject: str, rating: int, reason: str,
                created_at: int, namespace: str = NAMESPACE) -> list:
    facts = sorted([
        ["created_at", str(created_at)],
        ["max_rating", str(MAX_RATING)],
        ["min_rating", str(MIN_RATING)],
        ["rater", rater],
        ["rating", str(rating)],
        ["reason", reason],
        ["schema", "1"],
        ["scope", SCOPE],
        ["subject", subject],
        ["type", "rating"],
    ])
    tags = [["i", rid, "subject"]]
    tags += [["i", v] for v in sorted({rater, subject, SCOPE})]  # external identifiers
    tags += [["p", v] for v in sorted({rater, subject})]          # pubkey-valued facts
    tags += facts
    tags += [["n", namespace], ["expiration", str(created_at + MAX_AGE)]]
    return tags


def _verify_event(event: dict) -> None:
    from coincurve import PublicKeyXOnly
    import json
    ser = json.dumps([0, event["pubkey"], event["created_at"], event["kind"], event["tags"],
                      event["content"]], separators=(",", ":"), ensure_ascii=False).encode()
    digest = hashlib.sha256(ser).digest()
    if digest.hex() != event["id"]:
        raise Invalid("id is not the NIP-01 hash")
    try:
        ok = PublicKeyXOnly(bytes.fromhex(event["pubkey"])).verify(bytes.fromhex(event["sig"]), digest)
    except Exception:
        ok = False
    if not ok:
        raise Invalid("bad signature")


def read_rating(event: dict, namespace: str) -> dict:
    """NFX-16 §1: a valid rating for `namespace`, or Invalid."""
    if event.get("kind") != KIND:
        raise Invalid("kind is not 7368")
    if event.get("content") != "":
        raise Invalid("content is not empty")
    if not HEX64.fullmatch(event.get("pubkey", "")):
        raise Invalid("pubkey is not 64 lowercase hex")
    _verify_event(event)
    tags = event["tags"]
    if any(not isinstance(t, list) or not t or not all(isinstance(x, str) for x in t) for t in tags):
        raise Invalid("a tag is not a non-empty list of strings")

    def only(name):
        found = [t for t in tags if t[0] == name]
        if len(found) != 1 or len(found[0]) != 2:
            raise Invalid(f"{name} must appear exactly once, with one value")
        return found[0][1]

    if only("n") != namespace:
        raise Invalid("n names another network")
    expiration = only("expiration")
    if not UINT.fullmatch(expiration):
        raise Invalid("expiration is not a decimal integer")
    if any(t[0] in ("d", "e") for t in tags):
        raise Invalid("d and e tags are not allowed")
    subjects = [t for t in tags if t[0] == "i" and len(t) >= 3 and t[2] == "subject"]
    if len(subjects) != 1 or not UUID.fullmatch(subjects[0][1]):
        raise Invalid("needs exactly one subject i tag holding a canonical lowercase UUID")

    facts = {name: only(name) for name in REQUIRED_FACTS}
    if facts["type"] != "rating" or facts["schema"] != "1":
        raise Invalid("not a schema-1 rating record")
    if facts["scope"] != SCOPE:
        raise Invalid("scope is not nfx.seeder")
    if facts["rater"] != event["pubkey"]:
        raise Invalid("rater is not the signer")
    if not HEX64.fullmatch(facts["subject"]):
        raise Invalid("subject is not 64 lowercase hex")
    if facts["subject"] == facts["rater"]:
        raise Invalid("a rater cannot rate itself")
    if facts["min_rating"] != str(MIN_RATING) or facts["max_rating"] != str(MAX_RATING):
        raise Invalid("range is not -100..100")
    if not INT.fullmatch(facts["rating"]) or not MIN_RATING <= int(facts["rating"]) <= MAX_RATING:
        raise Invalid("rating is not a canonical integer in -100..100")
    if not UINT.fullmatch(facts["created_at"]):
        raise Invalid("created_at is not a decimal integer")
    return {
        "rater": facts["rater"],
        "subject": facts["subject"],
        "rating": int(facts["rating"]),
        "created_at": int(facts["created_at"]),
        "expiration": int(expiration),
    }


def _trunc_div(a: int, b: int) -> int:
    q = abs(a) // b
    return q if a >= 0 else -q


def score(events, namespace, now, root, follows, trusted, muted):
    """NFX-16 §4. Returns ({subject: {"score", "authors"}}, [verdict per event])."""
    admitted = ({root} | set(follows) | set(trusted)) - set(muted)
    verdicts, latest = [], {}
    for event in events:
        try:
            r = read_rating(event, namespace)
        except Invalid as e:
            verdicts.append(f"ignored: invalid ({e})")
            continue
        if r["rater"] not in admitted:
            verdicts.append("ignored: author not admitted")
            continue
        if r["created_at"] > now + FUTURE_SKEW or event["created_at"] > now + FUTURE_SKEW:
            verdicts.append("ignored: from the future")
            continue
        if now - r["created_at"] > MAX_AGE or r["expiration"] <= now:
            verdicts.append("ignored: expired")
            continue
        verdicts.append(None)  # decided below, once the newest per (rater, subject) is known
        key = (r["rater"], r["subject"])
        rank = (r["created_at"], event["id"])
        if key not in latest or rank > latest[key][0]:
            latest[key] = (rank, r["rating"])
    newest = {rank[1]: rating for rank, rating in latest.values()}
    for i, event in enumerate(events):
        if verdicts[i] is None:
            if event["id"] not in newest:
                verdicts[i] = "superseded by a newer rating from the same author"
            elif newest[event["id"]] == 0:
                verdicts[i] = "newest, a withdrawal: adds nothing"
            else:
                verdicts[i] = "counted"
    totals = {}
    for (_, subject), (_, rating) in sorted(latest.items()):
        if rating == 0:
            continue
        s, n = totals.get(subject, (0, 0))
        totals[subject] = (s + rating, n + 1)
    scores = {subject: {"score": _trunc_div(s, n), "authors": n}
              for subject, (s, n) in sorted(totals.items())}
    return scores, verdicts


def ratings_vectors(keypair, pubkey_of, nostr_event) -> dict:
    """NFX-16 §7. `keypair(seed)`, `pubkey_of(sk)` and `nostr_event(sk, kind, tags, content,
    created_at)` are generate.py's helpers."""
    seeds = ["watcher", "friend-a", "friend-b", "friend-c", "trusted", "muted", "stranger",
             "seeder", "seeder-2", "seeder-3"]
    sk = {s: keypair(f"nfx-test-vector/{s}") for s in seeds}
    pk = {s: pubkey_of(sk[s]) for s in seeds}
    secrets = {s: hashlib.sha256(f"nfx-test-vector/{s}".encode()).hexdigest() for s in seeds}

    def rate(rater, subject, rating, reason, created_at, seed, namespace=NAMESPACE, edit=None):
        tags = rating_tags(record_id(f"nfx-test-vector/rating/{seed}"), pk[rater], pk[subject],
                           rating, reason, created_at, namespace)
        if edit:
            tags = edit(tags)
        return nostr_event(sk[rater], KIND, tags, "", created_at)

    # ---- valid ratings (§1) ----
    valid = [
        ("measured", "the watcher's software rates the beacon vector's seeder +80",
         rate("watcher", "seeder", 80, "measured", CREATED_AT, "measured")),
        ("user", "a person's vote: -60 for a second seeder",
         rate("watcher", "seeder-2", -60, "user", CREATED_AT, "user")),
        ("withdrawal", "a day later, 0 withdraws the first rating (§4)",
         rate("watcher", "seeder", 0, "measured", CREATED_AT + DAY, "withdrawal")),
    ]
    valid_out = []
    for name, reason, event in valid:
        valid_out.append({"name": name, "reason": reason, "event": event,
                          "reads_as": read_rating(event, NAMESPACE)})

    # ---- invalid ratings (§1): every reader MUST reject each ----
    def set_fact(name, value):
        return lambda tags: [[t[0], value] if t[0] == name else t for t in tags]

    def drop(name):
        return lambda tags: [t for t in tags if t[0] != name]

    def add(tag):
        return lambda tags: tags + [tag]

    base = ("watcher", "seeder", 80, "measured", CREATED_AT)
    cases = [
        ("no-n", "exactly one n tag is required (NFX-01 §3)", drop("n")),
        ("two-n", "exactly one n tag is required (NFX-01 §3)", add(["n", "nfx:testnet:1"])),
        ("no-expiration", "exactly one expiration tag is required", drop("expiration")),
        ("scope-vpn-exit", "a nostr-vpn exit rating, not a seeder rating", set_fact("scope", "vpn.exit")),
        ("rater-not-signer", "the rater fact must be the event's pubkey",
         set_fact("rater", pk["friend-a"])),
        ("self-rating", "the subject must differ from the rater", set_fact("subject", pk["watcher"])),
        ("subject-npub", "the subject is 64 lowercase hex, not bech32",
         set_fact("subject", "npub1" + pk["seeder"][:58])),
        ("rating-101", "the rating is within -100..100", set_fact("rating", "101")),
        ("rating-plus-sign", "the rating is a canonical decimal integer", set_fact("rating", "+80")),
        ("rating-leading-zero", "the rating is a canonical decimal integer", set_fact("rating", "080")),
        ("range-0-100", "the range is exactly -100..100", set_fact("min_rating", "0")),
        ("schema-2", "only schema 1 is defined", set_fact("schema", "2")),
        ("type-attestation", "the record type is rating",
         set_fact("type", "social_memory_attestation")),
        ("two-ratings", "each required fact appears exactly once", add(["rating", "-80"])),
        ("rating-two-values", "each required fact holds one value",
         lambda tags: [t + ["90"] if t[0] == "rating" else t for t in tags]),
        ("no-created-at-fact", "created_at is a required fact", drop("created_at")),
        ("d-tag", "a fact op carries no d tag", add(["d", "nfx-seeder"])),
        ("e-tag", "an NFX rating links to no other event", add(["e", "00" * 32, "", "prev"])),
        ("uuid-uppercase", "the record UUID is canonical lowercase",
         lambda tags: [[t[0], t[1].upper(), t[2]] if t[0] == "i" and len(t) == 3 else t for t in tags]),
        ("two-subject-i", "exactly one subject i tag",
         add(["i", record_id("nfx-test-vector/rating/extra"), "subject"])),
    ]
    invalid = []
    for name, reason, edit in cases:
        event = rate(*base, f"invalid/{name}", edit=edit)
        invalid.append({"name": name, "reason": reason, "event": event})
    content = rate(*base, "invalid/content")
    content = nostr_event(sk["watcher"], KIND, content["tags"], "seeder was great", CREATED_AT)
    invalid.append({"name": "content", "reason": "the content is empty", "event": content})
    edited = rate(*base, "invalid/id-mismatch")
    edited = dict(edited, tags=[[t[0], "100"] if t[0] == "rating" else t for t in edited["tags"]])
    invalid.append({"name": "id-mismatch", "reason": "edited after signing: the id no longer "
                    "matches", "event": edited})
    other = rate(*base, "invalid/bad-sig")
    flipped = ("0" if other["sig"][0] != "0" else "1") + other["sig"][1:]
    invalid.append({"name": "bad-sig", "reason": "the signature does not verify",
                    "event": dict(other, sig=flipped)})
    for case in invalid:
        try:
            read_rating(case["event"], NAMESPACE)
        except Invalid:
            continue
        raise AssertionError(f"ratings-invalid case {case['name']} was accepted")

    # ---- scoring (§4) ----
    now = CREATED_AT + 7 * DAY
    S1, S2, S3 = "seeder", "seeder-2", "seeder-3"
    scoring_events = [
        ("a-old", "superseded by friend-a's newer rating of the same seeder",
         rate("friend-a", S1, 80, "measured", now - 2 * DAY, "score/a-old")),
        ("a-new", "friend-a's newest rating of seeder: counts",
         rate("friend-a", S1, 40, "measured", now - DAY, "score/a-new")),
        ("b", "friend-b: counts", rate("friend-b", S1, -30, "measured", now - DAY, "score/b")),
        ("root", "the watcher's own vote: counts", rate("watcher", S1, 100, "user", now - 3 * DAY, "score/root")),
        ("c-s2", "friend-c: counts", rate("friend-c", S2, -50, "measured", now - DAY, "score/c-s2")),
        ("trusted", "a configured trusted author: counts",
         rate("trusted", S2, 25, "measured", now - DAY, "score/trusted")),
        ("muted", "followed but muted: ignored", rate("muted", S2, -100, "user", now - DAY, "score/muted")),
        ("stranger", "not followed: ignored", rate("stranger", S2, 100, "user", now - DAY, "score/stranger")),
        ("stale", "older than 30 days: ignored",
         rate("friend-b", S2, 60, "measured", now - 31 * DAY, "score/stale")),
        ("future", "more than 15 minutes ahead: ignored",
         rate("friend-a", S2, 100, "measured", now + 3600, "score/future")),
        ("testnet", "another network: ignored",
         rate("friend-a", S2, -100, "measured", now - DAY, "score/testnet", namespace="nfx:testnet:1")),
        ("c-s3", "superseded by friend-c's withdrawal",
         rate("friend-c", S3, 70, "measured", now - 2 * DAY, "score/c-s3")),
        ("c-s3-withdraw", "0: friend-c withdraws, and adds nothing to the mean",
         rate("friend-c", S3, 0, "measured", now - DAY, "score/c-s3-withdraw")),
        ("b-s3-tie-1", "same created_at as b-s3-tie-2: the larger event id wins",
         rate("friend-b", S3, 10, "measured", now - DAY, "score/b-s3-tie-1")),
        ("b-s3-tie-2", "same created_at as b-s3-tie-1: the larger event id wins",
         rate("friend-b", S3, 90, "measured", now - DAY, "score/b-s3-tie-2")),
    ]
    follows = [pk[s] for s in ("friend-a", "friend-b", "friend-c", "muted")]
    scores, verdicts = score([e for _, _, e in scoring_events], NAMESPACE, now, pk["watcher"],
                             follows, [pk["trusted"]], [pk["muted"]])
    by_name = {pk[s]: s for s in seeds}
    assert scores == {
        pk[S1]: {"score": 36, "authors": 3},   # (40 - 30 + 100) / 3 = 36.67, truncated
        pk[S2]: {"score": -12, "authors": 2},  # (-50 + 25) / 2 = -12.5, truncated toward zero
        pk[S3]: scores[pk[S3]],                # one author; which score depends on the tie
    }, {by_name[k]: v for k, v in scores.items()}
    tie = max((e for n, _, e in scoring_events if n.startswith("b-s3-tie")), key=lambda e: e["id"])
    assert scores[pk[S3]] == {"score": int(read_rating(tie, NAMESPACE)["rating"]), "authors": 1}

    return {
        "ratings.json": {
            "description": "NFX-16 §1 valid seeder ratings (kind 7368, a nostr-social-memory "
                           "rating record, scope nfx.seeder). Tags are nostr-social-memory 0.1.1's "
                           "builder output for these facts, in its order, then n and expiration. "
                           "'reads_as' is what a reader takes from each. The subject of 'measured' "
                           "is the beacon vector's seeder.",
            "secret_keys_DO_NOT_USE": {s: secrets[s] for s in ("watcher",)},
            "namespace": NAMESPACE,
            "cases": valid_out,
        },
        "ratings-invalid.json": {
            "description": "NFX-16 §1: events every reader of namespace nfx:mainnet:1 MUST reject. "
                           "Correctly signed except 'id-mismatch' and 'bad-sig'. 'reason' is "
                           "informative.",
            "secret_keys_DO_NOT_USE": {s: secrets[s] for s in ("watcher",)},
            "namespace": NAMESPACE,
            "cases": invalid,
        },
        "ratings-scoring.json": {
            "description": "NFX-16 §4: a reader of namespace nfx:mainnet:1 at 'now', with this root, "
                           "follow list, trusted authors and mute list, scores the events as "
                           "'scores' says. 'verdict' per event is informative.",
            "secret_keys_DO_NOT_USE": {s: secrets[s] for s in seeds},
            "namespace": NAMESPACE,
            "now": now,
            "root": pk["watcher"],
            "follows": follows,
            "trusted": [pk["trusted"]],
            "muted": [pk["muted"]],
            "pubkeys": {s: pk[s] for s in seeds},
            "events": [{"name": n, "note": note, "verdict": v, "event": e}
                       for (n, note, e), v in zip(scoring_events, verdicts)],
            "scores": scores,
        },
    }
