#!/usr/bin/env python3
"""The parts of the locked-path check that need a parser (crates/ci/check-locked.sh).

    locked.py manifest            the derived pin lines for crates/ci/locked.sha256
    locked.py sources             every cached .crate matches its Cargo.lock checksum
    locked.py facts               what the money crates are built from, from cargo
                                  metadata alone (nothing is compiled), against
                                  crates/ci/locked-compiled.txt
    locked.py compiled [--pin]    the facts, then a build of nfx-pay and nfx-pay-wire alone:
                                  check what the compiler read for every one of their
                                  targets, and that the money tests really ran; --pin
                                  rewrites the facts file.

The facts, one per line:
- `build-script <crate>` and `proc-macro <crate>`: workspace crates that run code at build
  time. Any new one fails.
- `depends-on-nfx-pay <crate>`: workspace crates that may use the money crate.
- `money-dep <name> <version> <source> <checksum> <features>`: the resolved dependency
  closure of nfx-pay and nfx-pay-wire (every kind for those two, their test dependencies
  included, and normal and build below them), with the features the workspace unifies
  onto each. A version bump, a swapped source, a [patch] or a feature switched on
  elsewhere fails.
- `toolchain rustc <release> <commit>`.
- `money-build <name> <version> <features>`: the features the lock job's own build of the
  money crates compiles each package with (a narrower set than the workspace unifies).
  Checked after that build.

Every path package must be a workspace member: a crate outside the workspace, wired in
by path, would escape every check here. The money crates are locked whole
(check-locked.sh), and the only workspace crates in their closure are each other: within
one crate, an unpinned module could change how a pinned one compiles.

`compiled` also checks, without pins, on the money crates' own build: every target of
nfx-pay and nfx-pay-wire yields rustc's dep-info (a target without it fails), and every
file it lists is tracked; every target reads only its own crate's files, except
nfx-pay-wire's integration tests, which may read the pay/1 vectors.

Out of scope, and why: code in other crates. It may compile a pinned file (by
`#[path]`, say), but it cannot change one, and a copy of money logic written anywhere is
a code change this lock was never able to see (check-locked.sh).
- no file outside nfx-pay and nfx-node's locked paths names `nfx_pay`;
- the suite, the mutants and the pay/1 vector tests each ran, and reported exactly the
  number of tests their pinned sources declare. A test runner that runs nothing fails.
"""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tomllib

REPO = pathlib.Path(
    subprocess.run(["git", "-C", str(pathlib.Path(__file__).parent), "rev-parse", "--show-toplevel"],
                   check=True, capture_output=True, text=True).stdout.strip()).resolve()
CRATES = REPO / "crates"
PAY1_VECTORS = (REPO / "spec" / "test-vectors" / "pay1.json").resolve()
PINS = CRATES / "ci" / "locked-compiled.txt"
MONEY_USERS = [":!crates/nfx-pay", ":!crates/nfx-node/src/pay", ":!crates/nfx-node/src/origin_pay.rs"]
BUILD = "money-build "


def fail(msg: str) -> None:
    print(f"locked paths: {msg}", file=sys.stderr)
    sys.exit(1)


def run(*args: str, cwd: pathlib.Path = CRATES) -> str:
    r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"{' '.join(args)} failed:\n{r.stderr[-3000:]}")
    return r.stdout


def manifest() -> None:
    """Sections of the workspace manifest that change how every crate compiles."""
    with open(CRATES / "Cargo.toml", "rb") as f:
        ws = tomllib.load(f)
    w = ws.get("workspace", {})
    sections = {k: ws.get(k) for k in ("profile", "patch", "replace")}
    sections.update({f"workspace.{k}": w.get(k) for k in ("lints", "resolver", "members", "package")})
    text = json.dumps(sections, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(text.encode()).hexdigest()
    print(f"derived {digest} crates/Cargo.toml#profile,patch,replace,workspace.lints,resolver,members,package")


def member_names() -> set[str]:
    with open(CRATES / "Cargo.toml", "rb") as f:
        members = tomllib.load(f)["workspace"]["members"]
    names = set()
    for m in members:
        with open(CRATES / m / "Cargo.toml", "rb") as f:
            names.add(tomllib.load(f)["package"]["name"])
    return names


def sources() -> None:
    """Every .crate in CARGO_HOME's cache that Cargo.lock names matches its checksum, so
    sources extracted from the cache are the published ones. Every package without a
    source is a workspace member."""
    with open(CRATES / "Cargo.lock", "rb") as f:
        lock = tomllib.load(f)
    unsourced = {p["name"] for p in lock.get("package", []) if p.get("source") is None}
    strangers = unsourced - member_names()
    if strangers:
        fail(f"path packages outside the workspace: {sorted(strangers)}")
    home = pathlib.Path(os.environ.get("CARGO_HOME", pathlib.Path.home() / ".cargo"))
    caches = list((home / "registry" / "cache").glob("*"))
    checked = 0
    for p in lock.get("package", []):
        source = p.get("source")
        if source is None:
            continue  # a workspace crate
        if source != "registry+https://github.com/rust-lang/crates.io-index" or "checksum" not in p:
            fail(f"{p['name']} {p['version']} comes from {source}: only crates.io, checksummed")
        for cache in caches:
            f = cache / f"{p['name']}-{p['version']}.crate"
            if not f.exists():
                continue
            digest = hashlib.sha256(f.read_bytes()).hexdigest()
            if digest != p["checksum"]:
                fail(f"{f} does not match Cargo.lock's checksum for {p['name']} {p['version']}")
            checked += 1
    print(f"locked paths: {checked} cached crates match Cargo.lock")


MONEY_CRATES = ("nfx-pay", "nfx-pay-wire")


def closure(meta: dict, lock: dict) -> list[str]:
    pkgs = {p["id"]: p for p in meta["packages"]}
    roots = {p["id"] for p in meta["packages"] if p["name"] in MONEY_CRATES and p["source"] is None}
    if len(roots) != len(MONEY_CRATES):
        fail("cannot find the money crates in cargo metadata")
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    checksums = {(p["name"], p["version"], p.get("source")): p.get("checksum", "-")
                 for p in lock.get("package", [])}
    seen, todo = set(roots), list(roots)
    while todo:
        cur = todo.pop()
        for dep in nodes[cur]["deps"]:
            kinds = {k["kind"] for k in dep["dep_kinds"]}
            if cur not in roots and kinds <= {"dev"}:
                continue
            if dep["pkg"] not in seen:
                seen.add(dep["pkg"])
                todo.append(dep["pkg"])
    out = []
    for pid in seen - roots:
        p = pkgs[pid]
        if p["source"] is None:
            fail(f"a money crate depends on {p['name']}, a workspace crate not locked whole")
        source = p["source"]
        checksum = checksums.get((p["name"], p["version"], p["source"]), "-")
        features = ",".join(sorted(nodes[pid].get("features", []))) or "-"
        out.append(f"money-dep {p['name']} {p['version']} {source} {checksum} {features}")
    return out


def sources_read(dep_file: pathlib.Path) -> set[pathlib.Path]:
    """The files rustc's dep-info file says it read for one target (each is listed as
    `path:`; a name's spaces are escaped as `\\ `)."""
    out = set()
    for line in dep_file.read_text().splitlines():
        if line.startswith("#") or not line.endswith(":") or line == ":":
            continue
        path = line[:-1].replace("\\ ", " ")
        p = pathlib.Path(path)
        out.add((p if p.is_absolute() else CRATES / p).resolve())
    return out


def dep_info(filenames: list[str]) -> pathlib.Path | None:
    """rustc's own dep-info for one target, from its artefacts. A library or a test sits
    in deps/ under a hashed name (`<stem>-<16 hex>`), with its dep-info beside it; a
    cdylib or dylib sits there unhashed, with its own `<stem>.d`. A binary or an example
    is listed at its uplifted name (target/debug/x, examples/x), a hard link to a hashed
    twin in deps/ or examples/ whose name has `-` turned to `_`: that twin's dep-info is
    read, never the uplifted copy, which lists the dependencies' files too."""
    for f in filenames:
        p = pathlib.Path(f)
        stem = p.name.split(".")[0]
        if not re.search(r"-[0-9a-f]{16}$", stem) and p.parent.name != "deps":
            dirs = [p.parent] if p.parent.name == "examples" else [p.parent / "deps", p.parent]
            names = {p.name, p.name.replace("-", "_")}
            twins = [c for d in dirs if d.is_dir() for n in names for c in d.glob(f"{n}-*")
                     if c.suffix != ".d" and p.exists() and c.exists() and c.samefile(p)]
            if not twins:
                continue
            p = twins[0]
            stem = p.name.split(".")[0]
        stem = stem[3:] if stem.startswith("lib") and p.suffix in (".rlib", ".rmeta", ".so", ".a") else stem
        d = p.parent / f"{stem}.d"
        if d.exists():
            return d
    return None


def test_counts() -> dict[str, int]:
    """The number of tests each pinned test binary declares."""
    adversary = (CRATES / "nfx-pay" / "src" / "adversary.rs").read_text()
    listed = re.search(r"adversary_suite!\(@each \$h;\n(.*?)\n\s*\);", adversary, re.S)
    if not listed:
        fail("cannot find the adversary_suite! list")
    mutants = (CRATES / "nfx-pay" / "tests" / "mutants.rs").read_text()
    pay1 = (CRATES / "nfx-pay-wire" / "tests" / "pay1.rs").read_text()
    scenarios = len(re.findall(r"^\s+[a-z_0-9]+,$", listed.group(1), re.M))
    return {
        "adversary": scenarios,
        "round_trip": scenarios,  # the same suite, the mint answering reads on a later poll
        "mutants": len(re.findall(r"^\s+[a-z_0-9]+: [sv]\(", mutants, re.M)),
        "pay1": len(re.findall(r"^#\[test\]$", pay1, re.M)),
    }


def facts_now() -> tuple[list[str], dict, list[dict]]:
    """The facts, from cargo metadata and rustc alone: nothing is compiled."""
    meta = json.loads(run("cargo", "metadata", "--format-version", "1", "--locked", "--offline"))
    with open(CRATES / "Cargo.lock", "rb") as f:
        lock = tomllib.load(f)
    members = [p for p in meta["packages"] if p["id"] in meta["workspace_members"]]
    strangers = [p["name"] for p in meta["packages"]
                 if p["source"] is None and p["id"] not in meta["workspace_members"]]
    if strangers:
        fail(f"path packages outside the workspace: {sorted(strangers)}")
    facts = []
    for p in meta["packages"]:
        if p["name"] != "nfx-pay" and any(d["name"] == "nfx-pay" for d in p["dependencies"]):
            facts.append(f"depends-on-nfx-pay {p['name']}")
    for p in members:
        kinds = {k for t in p["targets"] for k in t["kind"]}
        if "custom-build" in kinds:
            facts.append(f"build-script {p['name']}")
        if "proc-macro" in kinds:
            facts.append(f"proc-macro {p['name']}")
    facts += closure(meta, lock)
    version = run("rustc", "-vV")
    release = re.search(r"^release: (\S+)$", version, re.M)
    commit = re.search(r"^commit-hash: (\S+)$", version, re.M)
    if not (release and commit):
        fail("cannot read the toolchain's release and commit")
    facts.append(f"toolchain rustc {release.group(1)} {commit.group(1)}")
    return sorted(facts), meta, members


def check_facts(facts: list[str], build: bool = False) -> None:
    """The metadata facts (or, with `build`, the money build's) against their pins."""
    pinned = PINS.read_text().splitlines() if PINS.exists() else []
    old = {x for x in pinned if x.startswith(BUILD) == build}
    new = set(facts)
    if old != new:
        diff = [f"- {x}" for x in sorted(old - new)] + [f"+ {x}" for x in sorted(new - old)]
        fail("what the money crates are built from differs from its pins:\n" + "\n".join(diff))


def facts() -> None:
    found, _, _ = facts_now()
    check_facts(found)
    print(f"locked paths: {len(found)} facts match their pins, read before any build")


def package_of(package_id: str) -> tuple[str, str]:
    """(name, version) from a cargo package id: `source#name@version`, or `source#version`
    when the name is the path's last component."""
    base, _, frag = package_id.partition("#")
    if "@" in frag:
        name, _, version = frag.partition("@")
    else:
        name, version = base.rstrip("/").rsplit("/", 1)[-1], frag
    return name, version


def compiled(pin: bool) -> None:
    found, meta, members = facts_now()
    if not pin:
        check_facts(found)

    # What the money crates' own build compiled, target by target, failing closed.
    tracked = {(REPO / f).resolve() for f in run("git", "ls-files", "-z", cwd=REPO).split("\0") if f}
    money = {p["manifest_path"]: pathlib.Path(p["manifest_path"]).parent.resolve()
             for p in members if p["name"] in MONEY_CRATES}
    wire_dir = (CRATES / "nfx-pay-wire").resolve()
    out = run("cargo", "test", "-p", "nfx-pay", "-p", "nfx-pay-wire", "--all-targets", "--no-run",
              "--locked", "--offline", "--message-format=json")
    seen_targets = 0
    built = set()
    for line in out.splitlines():
        msg = json.loads(line)
        if msg.get("reason") != "compiler-artifact":
            continue
        name, version = package_of(msg["package_id"])
        built.add(f"{BUILD}{name} {version} {','.join(sorted(msg.get('features', []))) or '-'}")
        if msg["manifest_path"] not in money:
            continue
        crate = money[msg["manifest_path"]]
        target = f"{crate.name} {'/'.join(msg['target']['kind'])} {msg['target']['name']}"
        d = dep_info(msg["filenames"] + ([msg["executable"]] if msg.get("executable") else []))
        if d is None:
            fail(f"no dep-info for {target}: every money target must show what it compiled")
        seen_targets += 1
        # Only nfx-pay-wire's integration tests may read outside their crate, and only the
        # pinned pay/1 vectors, symlinks resolved. An example or a bench is built in test
        # mode by --all-targets too: that is no exemption.
        vectors_ok = crate == wire_dir and msg["target"]["kind"] == ["test"]
        for src in sources_read(d):
            if src not in tracked:
                fail(f"{target} compiled {src}, which is not a tracked file ({d.name})")
            vector = vectors_ok and src == PAY1_VECTORS
            if crate not in src.parents and not vector:
                fail(f"{target} compiled {src}, from outside its crate ({d.name})")
    if seen_targets == 0:
        fail("found no dep-info for the money crates' build")

    named = subprocess.run(["git", "grep", "-nw", "nfx_pay", "--", "*.rs", *MONEY_USERS],
                           cwd=REPO, capture_output=True, text=True)
    if named.returncode == 0:
        fail("only nfx-pay and nfx-node's locked paths may name nfx_pay:\n" + named.stdout)

    # The money tests ran, all of them. `cargo test` exits 0 when a runner skips them.
    want = test_counts()
    out = subprocess.run(["cargo", "test", "--color", "never", "--locked", "--offline",
                          "-p", "nfx-pay", "-p", "nfx-pay-wire",
                          "--test", "adversary", "--test", "round_trip", "--test", "mutants",
                          "--test", "pay1"],
                         cwd=CRATES, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if out.returncode != 0:
        fail(f"the money tests failed:\n{out.stdout[-4000:]}")
    ran = {}
    current = None
    for line in out.stdout.splitlines():  # one stream, so each result follows its binary
        m = re.search(r"Running tests/(\w+)\.rs \((.+?)\)$", line)
        if m:
            # Keyed by the binary cargo actually ran, not by the file name alone.
            exe = pathlib.Path(m.group(2)).name
            current = m.group(1) if exe.startswith(f"{m.group(1)}-") else None
        m = re.match(r"test result: ok\. (\d+) passed; 0 failed", line)
        if m and current:
            ran[current] = int(m.group(1))
            current = None
    for name, n in want.items():
        if ran.get(name) != n:
            fail(f"tests/{name}.rs: {n} tests declared, {ran.get(name)} ran and passed")

    if pin:
        found = sorted(found + list(built))
    else:
        check_facts(sorted(built), build=True)
    if pin:
        PINS.write_text("".join(f + "\n" for f in found))
        print(f"pinned {len(found)} facts in {PINS.relative_to(REPO)}")
        return
    counts = ", ".join(f"{k} {v}" for k, v in want.items())
    print(f"locked paths: {len(found)} facts match their pins; every money target's compiled "
          f"files are tracked and its own; the money tests ran ({counts})")


def main() -> None:
    args = sys.argv[1:]
    if args == ["manifest"]:
        manifest()
    elif args == ["sources"]:
        sources()
    elif args == ["facts"]:
        facts()
    elif args[:1] == ["compiled"] and args[1:] in ([], ["--pin"]):
        compiled("--pin" in args)
    else:
        fail(__doc__.strip().splitlines()[2].strip())


if __name__ == "__main__":
    main()
