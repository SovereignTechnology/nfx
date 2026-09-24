#!/usr/bin/env python3
"""The JSON schemas (normative per NFX-03 §4 and NFX-05 §2) against the test vectors.

Every valid vector must conform. Of the invalid vectors, the schema must reject exactly
the structural cases listed below; the rest are cross-reference rules only a parser can
check (root, video, segs, playlists, uniqueness) and must pass the schema. A change on
either side therefore shows up here instead of drifting silently.

Requires: jsonschema. Usage: python3 spec/schemas/check.py
"""

import base64
import json
import sys
from pathlib import Path

import jsonschema

HERE = Path(__file__).resolve().parent
VECTORS = HERE.parent / "test-vectors"

SCHEMA_REJECTS_HASHLISTS = {"version-2", "meta-rendition-id", "bad-sha256", "unknown-role", "no-files"}
SCHEMA_REJECTS_BEACONS = {
    "content-not-json", "paying-without-mints", "paying-empty-mints", "no-endpoints", "chunks-missing",
}


def load(name: str):
    return json.loads((HERE / name).read_text())


def conforms(instance, schema) -> bool:
    try:
        jsonschema.validate(instance, schema)
        return True
    except jsonschema.ValidationError:
        return False


def main() -> int:
    hashlist_schema = load("hashlist.schema.json")
    beacon_schema = load("beacon-content.schema.json")
    for s in (hashlist_schema, beacon_schema):
        jsonschema.validators.validator_for(s).check_schema(s)
    failures = []

    def expect(label: str, got: bool, want: bool) -> None:
        mark = "ok" if got == want else "FAIL"
        print(f"{mark:4} {label}: schema {'accepts' if got else 'rejects'}")
        if got != want:
            failures.append(label)

    hl = json.loads((VECTORS / "hashlist.json").read_text())
    expect("hashlist.json", conforms(hl["hashlist"], hashlist_schema), True)
    for case in json.loads((VECTORS / "hashlist-invalid.json").read_text())["hashlists"]:
        instance = json.loads(base64.b64decode(case["bytes_b64"]))
        expect(f"hashlist-invalid/{case['name']}", conforms(instance, hashlist_schema),
               case["name"] not in SCHEMA_REJECTS_HASHLISTS)

    beacon = json.loads((VECTORS / "beacon.json").read_text())
    expect("beacon.json content", conforms(json.loads(beacon["event"]["content"]), beacon_schema), True)
    for case in json.loads((VECTORS / "beacon-invalid.json").read_text())["cases"]:
        try:
            content = json.loads(case["event"]["content"])
        except json.JSONDecodeError:
            content = None  # not JSON at all: no schema can accept it
        got = content is not None and conforms(content, beacon_schema)
        expect(f"beacon-invalid/{case['name']}", got, case["name"] not in SCHEMA_REJECTS_BEACONS)

    if failures:
        print(f"\n{len(failures)} schema/vector disagreement(s)", file=sys.stderr)
        return 1
    print("\nschemas agree with the vectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
