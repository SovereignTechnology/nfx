#!/usr/bin/env python3
"""The parts of the locked-path check that need a parser (crates/ci/check-locked.sh).

    locked.py manifest            the derived pin lines for crates/ci/locked.sha256, once
                                  the workspace's manifests and lock file are tracked files
    locked.py sources             every cached .crate matches its Cargo.lock checksum
    locked.py facts               what the money crates are built from and which test
                                  targets they have, from cargo metadata alone (nothing is
                                  compiled), against crates/ci/locked-compiled.txt
    locked.py compiled [--pin]    the facts, then a build of nfx-pay and nfx-pay-wire alone,
                                  into a target directory made for this run (a fresh
                                  temporary one, removed after): check what the compiler
                                  read for every one of their targets, and that every money
                                  test really ran; --pin rewrites the facts file. Because
                                  the build and the run use that directory, no build
                                  directory git does not track can stand in for a compile or
                                  a test binary; in CI a compiler artifact reported reused
                                  (`fresh`) fails, so nothing carried in can be reused.

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
- `money-test <crate> <kind> <target> <tests>`: every test binary of the money crates, and
  the number of tests it runs. There is one for each target cargo metadata lists for the
  two crates, since `cargo test --all-targets` builds each as a test binary (a library's
  unit tests, each file under tests/, any bin, example or bench), and one of kind `doc` for
  each library's doctests. The set of targets, and the numbers the suite's own files
  declare, are checked before any build; every number after the run. A test file added,
  removed, renamed or emptied, or a number of tests that changed, fails until it is
  re-pinned, and then shows in the pins' diff.

Every path package must be a workspace member: a crate outside the workspace, wired in
by path, would escape every check here. And every workspace member must be one the
workspace manifest's `members` key names (the derived pin holds that key), read at the
path it names: cargo also takes for a member a path dependency under crates/ and a
package in the workspace's own manifest, which the key does not name. `sources` refuses
those by name, from Cargo.lock; `facts` by name and manifest, from cargo metadata. The
money crates are locked whole
(check-locked.sh), and the only workspace crates in their closure are each other: within
one crate, an unpinned module could change how a pinned one compiles.

`compiled` also checks, without pins, on the money crates' own build (in a target
directory made for the run, so the checkout's own is never read or trusted):
- every target of nfx-pay and nfx-pay-wire yields rustc's dep-info (a target without it
  fails), and every file it lists is tracked; every target reads only its own crate's
  files, except nfx-pay-wire's integration tests, which may read the pay/1 vectors;
- no file outside nfx-pay and nfx-node's locked paths names `nfx_pay`;
- no tracked file of the money crates but the suite's own (nfx-pay/src/adversary.rs)
  names `track_caller`: a panic in a function so marked is reported where it was called,
  so one in the mock, called from the suite, would be taken for a failed assertion of the
  suite;
- every test binary of the money crates ran, and no other: the binaries run are the ones
  the build made and checked, one for each target cargo metadata lists, and each reported
  exactly the number of tests pinned for it, all passed, none ignored or filtered out;
- the suite, the mutants, the runner they share and the pay/1 vector tests each reported
  exactly the number of tests their pinned sources declare. A test runner that runs
  nothing fails.

Out of scope, and why: code in other crates. It may compile a pinned file (by
`#[path]`, say), but it cannot change one, and a copy of money logic written anywhere is
a code change this lock was never able to see (check-locked.sh).
"""

import hashlib
import json
import os
import pathlib
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

REPO = pathlib.Path(
    subprocess.run(["git", "-C", str(pathlib.Path(__file__).parent), "rev-parse", "--show-toplevel"],
                   check=True, capture_output=True, text=True).stdout.strip()).resolve()
CRATES = REPO / "crates"
PAY1_VECTORS = (REPO / "spec" / "test-vectors" / "pay1.json").resolve()
PINS = CRATES / "ci" / "locked-compiled.txt"
MONEY_USERS = [":!crates/nfx-pay", ":!crates/nfx-node/src/pay", ":!crates/nfx-node/src/origin_pay.rs"]
# Where `track_caller` may not appear: every money crate file but the suite's own.
NOT_TRACK_CALLER = ["crates/nfx-pay", "crates/nfx-pay-wire", ":!crates/nfx-pay/src/adversary.rs"]
BUILD = "money-build "
TESTS = "money-test "
# CI, as check-locked.sh recognises it: there the money build must be from scratch.
IN_CI = bool(os.environ.get("CI") or os.environ.get("GITLAB_CI") or os.environ.get("CI_JOB_ID"))


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
    # No pin covers the workspace's manifests and lock file whole (check-locked.sh), so
    # each is a file git tracks at the path cargo reads it from, never one reached through
    # a link in a directory above it. check-locked.sh checks that each is a regular file.
    read = ["crates/Cargo.toml", "crates/Cargo.lock",
            *(posixpath.normpath(f"crates/{m}/Cargo.toml") for m in w.get("members", []))]
    tracked = set(run("git", "ls-files", "-z", "--", *read, cwd=REPO).split("\0"))
    if not set(read) <= tracked:
        fail("manifests or lock files cargo reads that git does not track at that path: "
             f"{sorted(set(read) - tracked)}")
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


def spelled_members() -> list[tuple[str, str]]:
    """The workspace's members as its manifest's `members` key spells them: each one's
    package name, and its manifest as cargo names the one it reads."""
    with open(CRATES / "Cargo.toml", "rb") as f:
        members = tomllib.load(f)["workspace"]["members"]
    out = []
    for m in members:
        path = os.path.normpath(CRATES / m / "Cargo.toml")
        with open(path, "rb") as f:
            out.append((tomllib.load(f)["package"]["name"], path))
    return sorted(out)


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
    timings = (CRATES / "nfx-pay" / "tests" / "honest_timings.rs").read_text()
    runner = (CRATES / "nfx-pay" / "tests" / "runner.rs").read_text()
    pay1 = (CRATES / "nfx-pay-wire" / "tests" / "pay1.rs").read_text()
    scenarios = len(re.findall(r"^\s+[a-z_0-9]+,$", listed.group(1), re.M))
    return {
        "adversary": scenarios,
        "round_trip": scenarios,  # the same suite, the mint answering reads on a later poll
        "woken_answers": scenarios,  # the same suite, every mint call answered from another thread
        "listings_at_start": scenarios,  # the same suite, keyset listings asked at the start too
        # the same suite against each honest engine and mint that take their time
        # differently, and the scenarios the file names one by one under a timing of their
        # own (`@each <harness>;`, a name to a line)
        "honest_timings": (
            scenarios * len(re.findall(r"^\s+nfx_pay::adversary_suite!\((?!@)", timings, re.M))
            + sum(len(re.findall(r"^\s+[a-z_0-9]+,$", names, re.M)) for names in
                  re.findall(r"^\s+nfx_pay::adversary_suite!\(@each [^;]*;\n(.*?)\n\s*\);", timings, re.M | re.S))),
        "mutants": len(re.findall(r"^\s+[a-z_0-9]+: [svrwlt]\(", mutants, re.M)),
        "runner": len(re.findall(r"^#\[test\]$", runner, re.M)),
        "pay1": len(re.findall(r"^#\[test\]$", pay1, re.M)),
    }


def test_targets(members: list[dict]) -> list[str]:
    """Every test binary the money crates have, as `<crate> <kind> <target>`, from cargo
    metadata alone: one for each target, since `cargo test --all-targets` builds each as a
    test binary (a library's or a bin's unit tests, a file under tests/, an example, a
    bench), and one of kind `doc` for the doctests of each library rustdoc tests. A build
    script is no test target: it is a fact of its own (`build-script`)."""
    out = []
    for p in members:
        if p["name"] not in MONEY_CRATES:
            continue
        for t in p["targets"]:
            kinds = t["kind"]
            if "custom-build" in kinds:
                continue
            out.append(f"{p['name']} {'/'.join(kinds)} {t['name']}")
            if {"lib", "rlib", "proc-macro"} & set(kinds):
                out.append(f"{p['name']} doc {t['name']}")
    if len(set(out)) != len(out) or any(len(x.split()) != 3 for x in out):
        fail(f"the money crates' test targets cannot be told apart by crate, kind and name: {out}")
    return sorted(out)


def pinned_tests() -> dict[str, int]:
    """The test binaries the pins count, each with its number of tests."""
    out = {}
    for line in PINS.read_text().splitlines() if PINS.exists() else []:
        if not line.startswith(TESTS):
            continue
        label, _, n = line[len(TESTS):].rpartition(" ")
        if not n.isdigit() or len(label.split()) != 3 or label in out:
            fail(f"a pin that is malformed or repeated: {line}")
        out[label] = int(n)
    return out


def check_test_targets(targets: list[str]) -> None:
    """The money crates' test targets are exactly the ones the pins count, and each of the
    suite's files declares the number of tests pinned for it: both known before any build."""
    pinned = pinned_tests()
    old, new = set(pinned), set(targets)
    if old != new:
        diff = [f"- {x}" for x in sorted(old - new)] + [f"+ {x}" for x in sorted(new - old)]
        fail("the money crates' test targets differ from the ones their pins count:\n"
             + "\n".join(diff))
    for name, n in test_counts().items():
        got = [pinned[x] for x in pinned if x.split()[1:] == ["test", name]]
        if got != [n]:
            got = got[0] if len(got) == 1 else got
            fail(f"tests/{name}.rs declares {n} tests, and its pin counts {got}")


def facts_now() -> tuple[list[str], dict, list[dict]]:
    """The facts, from cargo metadata and rustc alone: nothing is compiled."""
    meta = json.loads(run("cargo", "metadata", "--format-version", "1", "--locked", "--offline"))
    with open(CRATES / "Cargo.lock", "rb") as f:
        lock = tomllib.load(f)
    members = [p for p in meta["packages"] if p["id"] in meta["workspace_members"]]
    # The members cargo builds are the ones the pinned `members` key spells, each read at
    # the path it spells: no more, no fewer and no other. Cargo also takes for a member a
    # path dependency that lies under crates/ (through a link too) or names this workspace
    # as its own, and a package in the workspace's own manifest. `sources` refuses those by
    # name from Cargo.lock; this refuses them here as well, by name and by manifest, so the
    # facts do not lean on `sources` having run first.
    cargos = sorted((p["name"], os.path.normpath(p["manifest_path"])) for p in members)
    if cargos != spelled_members() or len(members) != len(meta["workspace_members"]):
        spelled = spelled_members()
        diff = ([f"- {n} {m}" for n, m in spelled if (n, m) not in cargos]
                + [f"+ {n} {m}" for n, m in cargos if (n, m) not in spelled])
        fail("cargo's workspace members are not the ones crates/Cargo.toml's members key "
             "names (a path dependency or a root package cargo takes for a member?):\n"
             + "\n".join(diff))
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


def check_facts(facts: list[str], kind: str = "") -> None:
    """The metadata facts (or, with `kind`, the money build's or the money tests') against
    their pins."""
    pinned = PINS.read_text().splitlines() if PINS.exists() else []
    old = {x for x in pinned if (x.startswith(kind) if kind else not x.startswith((BUILD, TESTS)))}
    new = set(facts)
    if old != new:
        diff = [f"- {x}" for x in sorted(old - new)] + [f"+ {x}" for x in sorted(new - old)]
        what = ("the money tests that ran differ from their pins" if kind == TESTS
                else "what the money crates are built from differs from its pins")
        fail(f"{what}:\n" + "\n".join(diff))


def facts() -> None:
    found, _, members = facts_now()
    check_facts(found)
    targets = test_targets(members)
    check_test_targets(targets)
    print(f"locked paths: {len(found)} facts match their pins, and the money crates' "
          f"{len(targets)} test targets are the ones pinned, read before any build")


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
        check_test_targets(test_targets(members))
    # The build and the test run go in a target directory made for this run alone, so no
    # build directory left in the checkout (by a CI cache, a stale local build, or anything
    # else git does not track) can stand in for a compile or a test binary. In CI a
    # compiler artifact reported `fresh` means one was reused all the same, and fails.
    build_dir = pathlib.Path(tempfile.mkdtemp(prefix="nfx-lock-target-"))
    try:
        compiled_in(pin, found, members, build_dir)
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


def compiled_in(pin: bool, found: list[str], members: list[dict], build_dir: pathlib.Path) -> None:
    target_dir = ["--target-dir", str(build_dir)]
    # What the money crates' own build compiled, target by target, failing closed.
    tracked = {(REPO / f).resolve() for f in run("git", "ls-files", "-z", cwd=REPO).split("\0") if f}
    money = {p["manifest_path"]: pathlib.Path(p["manifest_path"]).parent.resolve()
             for p in members if p["name"] in MONEY_CRATES}
    money_names = {p["manifest_path"]: p["name"] for p in members if p["name"] in MONEY_CRATES}
    targets = test_targets(members)
    test_binaries: dict[str, str] = {}  # a test binary's file name -> its target
    wire_dir = (CRATES / "nfx-pay-wire").resolve()
    out = run("cargo", "test", "-p", "nfx-pay", "-p", "nfx-pay-wire", "--all-targets", "--no-run",
              "--locked", "--offline", "--message-format=json", *target_dir)
    seen_targets = 0
    built = set()
    for line in out.splitlines():
        msg = json.loads(line)
        if msg.get("reason") != "compiler-artifact":
            continue
        if IN_CI and msg.get("fresh"):
            fail(f"a compiler artifact was reused, not built fresh, in CI: {msg['package_id']}; "
                 "the money crates must be built from scratch (a stale build directory?)")
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
        if msg["profile"]["test"] and msg.get("executable"):
            label = (f"{money_names[msg['manifest_path']]} {'/'.join(msg['target']['kind'])} "
                     f"{msg['target']['name']}")
            exe = pathlib.Path(msg["executable"]).name
            if exe in test_binaries or label in test_binaries.values():
                fail(f"{target} was built as a test binary twice")
            test_binaries[exe] = label
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
    # Every target cargo metadata lists was built as a test binary, and nothing else was.
    doc = {x for x in targets if x.split()[1] == "doc"}
    if set(test_binaries.values()) != set(targets) - doc:
        fail("the test binaries built are not the money crates' test targets:\n"
             f"built: {sorted(test_binaries.values())}\ntargets: {sorted(set(targets) - doc)}")

    named = subprocess.run(["git", "grep", "-nw", "nfx_pay", "--", "*.rs", *MONEY_USERS],
                           cwd=REPO, capture_output=True, text=True)
    if named.returncode == 0:
        fail("only nfx-pay and nfx-node's locked paths may name nfx_pay:\n" + named.stdout)
    if named.returncode != 1:  # 1 is "no match"; anything else is git failing to look
        fail(f"git grep for nfx_pay failed ({named.returncode}):\n{named.stderr}")

    # The runner judges a panic by where it was raised: a #[track_caller] function reports
    # its panics at its caller's line, so one in the mock would move them into the suite.
    marked = subprocess.run(["git", "grep", "-n", "track_caller", "--", *NOT_TRACK_CALLER],
                            cwd=REPO, capture_output=True, text=True)
    if marked.returncode == 0:
        fail("only the suite (crates/nfx-pay/src/adversary.rs) may name track_caller:\n"
             + marked.stdout)
    if marked.returncode != 1:
        fail(f"git grep for track_caller failed:\n{marked.stderr[-3000:]}")

    # The money tests ran, all of them: every test binary the build made, which is every
    # target cargo metadata lists, and then each library's doctests. `cargo test` exits 0
    # when a runner skips them, so each binary is matched to what it reported.
    want = test_counts()
    out = subprocess.run(["cargo", "test", "--color", "never", "--locked", "--offline",
                          *target_dir, "-p", "nfx-pay", "-p", "nfx-pay-wire", "--all-targets"],
                         cwd=CRATES, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if out.returncode != 0:
        fail(f"the money tests failed:\n{out.stdout[-4000:]}")
    docs = subprocess.run(["cargo", "test", "--color", "never", "--locked", "--offline",
                           *target_dir, "-p", "nfx-pay", "-p", "nfx-pay-wire", "--doc"],
                          cwd=CRATES, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if docs.returncode != 0:
        fail(f"the money crates' doctests failed:\n{docs.stdout[-4000:]}")
    doc_names = {x.split()[2].replace("-", "_"): x for x in doc}
    ran: dict[str, int] = {}
    current = None
    # One stream each, so each result follows its binary.
    for line in out.stdout.splitlines() + docs.stdout.splitlines():
        m = re.search(r"^\s*Running .*\((.+?)\)$", line)
        if m:
            # Keyed by the binary cargo actually ran: one the build made and checked.
            exe = pathlib.Path(m.group(1)).name
            if exe not in test_binaries:
                fail(f"a test binary ran that the money build did not make: {line.strip()}")
            current = test_binaries[exe]
        m = re.search(r"^\s*Doc-tests (\S+)$", line)
        if m:
            if m.group(1).replace("-", "_") not in doc_names:
                fail(f"doctests ran that are no money crate's: {line.strip()}")
            current = doc_names[m.group(1).replace("-", "_")]
        m = re.match(r"test result: (.*)$", line)
        if m:
            done = re.fullmatch(r"ok\. (\d+) passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;.*",
                                m.group(1))
            if not done:
                fail(f"{current}: not every test ran and passed: {line.strip()}")
            if current is None or current in ran:
                fail(f"a test result that follows no test binary of its own: {line.strip()}")
            ran[current] = int(done.group(1))
            current = None
    if set(ran) != set(targets):
        fail("the test binaries that ran are not the money crates' test targets:\n"
             f"ran: {sorted(ran)}\ntargets: {targets}")
    for name, n in want.items():
        got = [ran[x] for x in ran if x.split()[1:] == ["test", name]]
        if got != [n]:
            got = got[0] if len(got) == 1 else got
            fail(f"tests/{name}.rs: {n} tests declared, {got} ran and passed")
    tests = sorted(f"{TESTS}{label} {n}" for label, n in ran.items())

    if pin:
        found = sorted(found + list(built) + tests)
    else:
        check_facts(sorted(built), BUILD)
        check_facts(tests, TESTS)
    if pin:
        PINS.write_text("".join(f + "\n" for f in found))
        print(f"pinned {len(found)} facts in {PINS.relative_to(REPO)}")
        return
    counts = ", ".join(x[len(TESTS):] for x in tests)
    print(f"locked paths: {len(found)} facts and {len(tests)} test binaries match their pins; "
          f"every money target's compiled files are tracked and its own; the money tests ran "
          f"({counts})")


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
