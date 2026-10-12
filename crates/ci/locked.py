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
  re-pinned, and then shows in the pins' diff. A file that runs the adversary suite
  through its macro is one of the test files this script names (`WHOLE_SUITE`,
  `SUITE_BY_PARTS`), and its number is derived from the suite's list of scenarios: the
  macro named in the code of any other file fails, before any build and at a re-pin too
  (`suite_users`). A scenario can be run one by one, so it is this, not the macro, that
  holds a harness file to the whole list, and keeps one from being pinned at whatever
  number of tests ran at its pin; the engine's harness file is named there when it is
  written (M2.1). The numbers declared, each read from the pinned sources (`test_counts`):
  - a harness file (`WHOLE_SUITE`): the scenarios in the suite's list, a name to a line.
    The scenarios the suite's file makes from its second list, each scenario whose seeders
    are paid run again at a second quoted mint (`scenarios_at_every_quoted_mint!`), are
    names of the list like any other, and the list's names of that kind must be that
    second list's, row for row;
  - the honest timings (`SUITE_BY_PARTS`): the list's length for each use of the whole
    suite, and one for each scenario named under an `@each` use;
  - the mutants: one for each entry of the registry, in its form at every mint
    (`catches!`) and in its form of other mints (`catches_at_other_mints!`), and one for
    each row of the suite's second list, which the file takes once to check that what a
    scenario judges at its seeders' first mint it judges at their second. The file's code
    has a test attribute in those three macros and nowhere else, uses each once, and holds
    nothing in the two registries but entries;
  - the runner, and the pay/1 vector tests: the test attributes of the file;
  - nfx-pay's own unit tests: the test attributes of the library's test modules
    (src/adversary/), the rest of src/ holding none in its code but the one the suite's
    macro gives each scenario where a test file uses it.
  The suite's second list is held as its macro is: named in the code of no file but the
  suite's own (where it is defined and used once) and the mutants' (used once).

Every path package must be a workspace member: a crate outside the workspace, wired in
by path, would escape every check here. And every workspace member must be one the
workspace manifest's `members` key names (the derived pin holds that key), read at the
path it names: cargo also takes for a member a path dependency that lies under crates/
or names this workspace as its own, and a package in the workspace's own manifest, none
of which the key names. `sources` refuses those by name, from Cargo.lock; `facts` by name
and manifest, from cargo metadata. So a package cargo takes for a member under the name of
one the key spells passes `sources`, and is refused by `facts`, which compares the manifest
too. The money crates are locked whole
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
- the suite, the mutants, the runner they share, nfx-pay's unit tests and the pay/1
  vector tests each reported exactly the number of tests their pinned sources declare
  (above). A test runner that runs
  nothing fails. What the numbers do not say is which tests ran: a file that defined as
  many tests of other names would report the same number, and is caught by its pin and
  by whoever reads the diff of a re-pin, not here.

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


# The files that run the suite through its macro, `adversary_suite!`: test files of nfx-pay,
# tests/<name>.rs, each named here, since a scenario can be run one by one (the macro's
# `@each` arm is exported with it) and nothing in the macro holds a file to the whole list.
# The lock does: no other file may name the macro in its code (`suite_users`), so a harness
# file cannot be pinned with whatever number of tests ran at its pin.
# - WHOLE_SUITE: the file's code names the macro once, as one use of the whole list, and
#   the file runs as many tests as the list has scenarios. THE ENGINE'S HARNESS FILE (M2.1,
#   docs/nfx/m2-plan.md) IS ADDED HERE WHEN IT IS WRITTEN: "the suite green against the
#   real engine" is then the list's length by the lock, not by a reader's eye.
# - SUITE_BY_PARTS: the file's uses are counted one by one, the whole list for each use of
#   it and a test for each scenario named under an `@each` use; a use the count does not see
#   fails.
SUITE_MACRO = "adversary_suite"
SUITE_SOURCE = "crates/nfx-pay/src/adversary.rs"  # defines it, and keeps the list
WHOLE_SUITE = (
    "adversary",
    "round_trip",  # the same suite, the mint answering reads on a later poll
    "woken_answers",  # the same suite, every mint call answered from another thread
    "listings_at_start",  # the same suite, keyset listings asked at the start too
)
SUITE_BY_PARTS = (
    # the same suite against each honest engine and mint that take their time differently,
    # and the scenarios the file names one by one under a timing of their own
    # (`@each <harness>;`, a name to a line)
    "honest_timings",
)
# Where the macro may not be named in code but in the files above: the money crates, every
# tracked file of them (a test file may `include!` one that is no Rust file), and every
# Rust file elsewhere.
SUITE_NAMED_IN = ["crates/nfx-pay", "crates/nfx-pay-wire", "*.rs"]
# The suite's second list: the scenarios whose seeders are paid, each with its name at a
# second quoted mint. The suite's file makes those scenarios from it, and names them in the
# suite's list; the mutants take it once, for a test of each row. It is exported as the
# suite's macro is, and a file that took it could run its rows with no word of that macro,
# so it is held the same way: named in the code of the suite's own file on two lines, where
# it is defined and where the second scenarios are made from it, in the mutants' on one,
# and in no other file's.
PAIRS_MACRO = "scenarios_at_every_quoted_mint"
PAIRS_MADE = "scenarios_at_every_quoted_mint!(second_mint_scenarios);"
MUTANTS = "crates/nfx-pay/tests/mutants.rs"
PAIRS_JUDGED = "nfx_pay::scenarios_at_every_quoted_mint!(judged_at_each_quoted_mint);"
# nfx-pay's unit tests: the library's test modules, and its other sources, which hold none.
LIB = "nfx-pay lib nfx_pay"
LIB_TESTS_IN = "crates/nfx-pay/src/adversary/"
# A line that is a test attribute and nothing else, and an attribute that makes a test
# however it is written (on its item's line, by a path, under `cfg_attr`): in a file whose
# tests are counted the two numbers are equal, so none is written another way.
TEST_LINE = r"^[ \t]*#\[test\]$"
TEST_WORD = r"#\[\s*(?:\w+\s*::\s*)*test\b|\bcfg_attr\([^\n]*,\s*(?:\w+\s*::\s*)*test\s*[,()]"
ENTRY = r"^    [a-z_0-9]+: [svrwlt]\([SV]::[A-Za-z0-9]+\) => [a-z_0-9]+,$"


def names_suite(text: str, word: str = SUITE_MACRO) -> list[str]:
    """The lines of a file that name the suite's macro (or `word`) in what may be code:
    every line that holds the word but those that are a line comment from their start
    (`//`, `///`, `//!`). A line that begins so is no use of the macro wherever it stands
    (in a block comment or a string it is none either); a line that names it after code, in
    a block comment or in a string counts as one, which errs on the side of refusing."""
    return [line for line in text.splitlines()
            if re.search(rf"\b{word}\b", line) and not line.lstrip().startswith("//")]


def code_of(text: str) -> str:
    """A file's lines but those that are a line comment from their start."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//"))


def test_lines(text: str, where: str) -> int:
    """The tests a file's code declares, one for each line that is a test attribute and
    nothing else: a file that holds the word in an attribute written any other way fails,
    since its count would not follow it."""
    code = code_of(text)
    lines = len(re.findall(TEST_LINE, code, re.M))
    words = len(re.findall(TEST_WORD, code))
    if lines != words:
        fail(f"{where} has {words} attributes that name `test` in its code, and {lines} of them "
             "are a line of their own that reads #[test]: the lock counts a file's tests by "
             "those lines")
    return lines


def suite_file(name: str) -> str:
    """A test file of nfx-pay that runs the suite, read."""
    path = CRATES / "nfx-pay" / "tests" / f"{name}.rs"
    if not path.is_file():
        fail(f"tests/{name}.rs is declared to run the suite (crates/ci/locked.py) and is "
             "no file of nfx-pay")
    return path.read_text()


def suite_users() -> None:
    """No file names the suite's macro in its code but the suite's own and the test files
    declared above: a file that runs the suite, whole or scenario by scenario, has a count
    the lock derives from the list, never one that is only what ran when it was pinned."""
    declared = {f"crates/nfx-pay/tests/{name}.rs" for name in WHOLE_SUITE + SUITE_BY_PARTS}
    found = subprocess.run(["git", "grep", "-l", "-z", "-w", "-e", SUITE_MACRO, "--", *SUITE_NAMED_IN],
                           cwd=REPO, capture_output=True, text=True)
    if found.returncode != 0:  # 1 is "no match": the suite's own file names it
        fail(f"git grep for {SUITE_MACRO} failed or found nothing ({found.returncode}):\n"
             f"{found.stderr[-3000:]}")
    for f in sorted(x for x in found.stdout.split("\0") if x):
        if f == SUITE_SOURCE or f in declared:
            continue
        lines = names_suite((REPO / f).read_text(errors="replace"))
        if lines:
            fail(f"{f} names {SUITE_MACRO} in its code, and the lock declares no count for it "
                 f"({len(lines)} lines, the first: {lines[0].strip()[:120]}). Only a test file of "
                 "nfx-pay that crates/ci/locked.py names may use the suite's macro: in "
                 "WHOLE_SUITE if it runs the whole list once, in SUITE_BY_PARTS if its uses "
                 "are counted one by one; a file pinned without either would be held to "
                 "whatever number of tests ran at its pin")
    # The suite's second list, the same way: the suite's own file and the mutants' name it,
    # each on the lines `pairs` and `mutant_tests` hold them to, and no other file does.
    found = subprocess.run(["git", "grep", "-l", "-z", "-w", "-e", PAIRS_MACRO, "--", *SUITE_NAMED_IN],
                           cwd=REPO, capture_output=True, text=True)
    if found.returncode != 0:
        fail(f"git grep for {PAIRS_MACRO} failed or found nothing ({found.returncode}):\n"
             f"{found.stderr[-3000:]}")
    for f in sorted(x for x in found.stdout.split("\0") if x):
        if f in (SUITE_SOURCE, MUTANTS):
            continue
        lines = names_suite((REPO / f).read_text(errors="replace"), PAIRS_MACRO)
        if lines:
            fail(f"{f} names {PAIRS_MACRO} in its code ({len(lines)} lines, the first: "
                 f"{lines[0].strip()[:120]}). Only the suite's own file, which makes the scenarios "
                 "at a second quoted mint from that list, and tests/mutants.rs, which takes it "
                 "once, may: a file that ran its rows would be held to whatever number of "
                 "tests ran at its pin")


def pairs(adversary: str, listed: list[str]) -> int:
    """The rows of the suite's second list, each a scenario whose seeders are paid and its
    name at a second quoted mint: read from the macro that keeps it, a row to a line. The
    suite's file names that macro in its code where it defines it and where it makes the
    second scenarios from it, and nowhere else; and the names of that kind in the suite's
    list are the rows' second names, each row's first name a scenario of the list too."""
    own = names_suite(adversary, PAIRS_MACRO)
    if [x.strip() for x in own] != [f"macro_rules! {PAIRS_MACRO} {{", PAIRS_MADE]:
        fail(f"{SUITE_SOURCE} names {PAIRS_MACRO} on {len(own)} lines of its code, where it "
             "defines the macro and makes the scenarios at a second quoted mint from its list "
             "(2), or not as those two: " + " | ".join(x.strip()[:80] for x in own[:5]))
    kept = re.search(rf"^macro_rules! {PAIRS_MACRO} \{{\n    \(\$with:ident\) => \{{\n"
                     r"        \$with! \{\n(.*?)\n        \}\n    \};\n\}$", adversary, re.M | re.S)
    if not kept:
        fail(f"cannot find the list {PAIRS_MACRO}! keeps")
    rows = []
    for line in kept.group(1).splitlines():
        row = re.fullmatch(r"            ([a-z_0-9]+), ([a-z_0-9]+): [a-z_0-9]+(?: \+ [A-Za-z]+)?;", line)
        if not row:
            fail(f"a line of {PAIRS_MACRO}!'s list that is no row of it: {line.strip()[:120]}")
        rows.append(row.groups())
    firsts, seconds = [a for a, _ in rows], [b for _, b in rows]
    made = [name for name in listed if name.endswith("_at_a_second_mint")]
    if (sorted(seconds) != sorted(made) or len(set(firsts + seconds)) != 2 * len(rows)
            or not set(firsts) <= set(listed) or any(b != f"{a}_at_a_second_mint" for a, b in rows)):
        fail(f"{PAIRS_MACRO}!'s {len(rows)} rows and the suite's list disagree: the list names "
             f"{len(made)} scenarios at a second mint, and each row is a scenario of the list and "
             "its name there, once")
    return len(rows)


def mutant_tests(mutants: str, rows: int) -> int:
    """The tests tests/mutants.rs declares: its registry's entries, at every mint and at
    other mints, and one for each row of the suite's second list, which it takes once. The
    file's code has a test attribute in the three macros that make those, one each, and
    nowhere else; it uses each once; and the two registries hold entries and nothing more."""
    code = code_of(mutants)
    makers = ("catches", "catches_at_other_mints", "judged_at_each_quoted_mint")
    for macro in makers:
        body = re.findall(rf"^macro_rules! {macro} \{{\n(.*?)\n\}}$", code, re.M | re.S)
        if len(body) != 1 or len(re.findall(TEST_LINE, body[0], re.M)) != 1:
            fail(f"tests/mutants.rs defines {macro}! {len(body)} times, or not with one test "
                 "attribute in it")
    if test_lines(mutants, "tests/mutants.rs") != len(makers):
        fail("tests/mutants.rs has a test attribute outside the three macros that make its "
             "tests, whose uses the lock counts")
    entries = 0
    for macro in makers[:2]:
        uses = re.findall(rf"\b{macro}!\s*[(\[{{]", code)
        block = re.findall(rf"^{macro}!\(\n(.*?)\n\);$", code, re.M | re.S)
        if len(uses) != 1 or len(block) != 1:
            fail(f"tests/mutants.rs uses {macro}! {len(uses)} times in its code, and the lock "
                 f"counts the entries of one use, the registry ({len(block)} found)")
        lines = [line for line in block[0].splitlines() if line.strip()]
        odd = [line for line in lines if not re.match(ENTRY, line)]
        if odd:
            fail(f"tests/mutants.rs: a line of {macro}!'s registry that is no entry of it, a "
                 f"name, a harness kind, a defect and a scenario: {odd[0].strip()[:120]}")
        entries += len(lines)
    if entries != len(re.findall(r"^\s+[a-z_0-9]+: [svrwlt]\(", code, re.M)):
        fail("tests/mutants.rs has a line that reads as a registry entry outside its two registries")
    taken = names_suite(mutants, PAIRS_MACRO)
    if taken != [PAIRS_JUDGED] or re.findall(rf"\b{makers[2]}!\s*[(\[{{]", code):
        fail(f"tests/mutants.rs takes the suite's second list once, as `{PAIRS_JUDGED}`, and its "
             f"code names {PAIRS_MACRO} on {len(taken)} lines, or uses {makers[2]}! by hand: "
             + " | ".join(x.strip()[:80] for x in taken[:4]))
    return entries + rows


def lib_tests() -> int:
    """nfx-pay's unit tests: the test attributes of the library's test modules. No other
    source of the crate has one in its code but the suite's file, in the arm of its macro
    that gives each scenario its test where a test file uses it."""
    files = [f for f in run("git", "ls-files", "-z", "--", "crates/nfx-pay/src", cwd=REPO).split("\0") if f]
    count = 0
    for f in sorted(files):
        n = test_lines((REPO / f).read_text(errors="replace"), f)
        if f.startswith(LIB_TESTS_IN):
            count += n
        elif n != (1 if f == SUITE_SOURCE else 0):
            fail(f"{f} has {n} test attributes in its code: the library's unit tests are counted "
                 f"in {LIB_TESTS_IN}, and the suite's file has the one its macro gives a scenario")
    return count


def test_counts() -> dict[str, int]:
    """The number of tests each pinned test file declares (the module's doc says how each
    is read; nfx-pay's unit tests are `lib_tests`). Every file that uses the suite's macro
    is among them (`suite_users`)."""
    adversary = (CRATES / "nfx-pay" / "src" / "adversary.rs").read_text()
    listed = re.search(r"adversary_suite!\(@each \$h;\n(.*?)\n\s*\);", adversary, re.S)
    if not listed:
        fail("cannot find the adversary_suite! list")
    mutants = (CRATES / "nfx-pay" / "tests" / "mutants.rs").read_text()
    runner = (CRATES / "nfx-pay" / "tests" / "runner.rs").read_text()
    pay1 = (CRATES / "nfx-pay-wire" / "tests" / "pay1.rs").read_text()
    names = re.findall(r"^\s+([a-z_0-9]+),$", listed.group(1), re.M)
    scenarios = len(names)
    if len(set(names)) != scenarios or scenarios != len([x for x in listed.group(1).splitlines() if x.strip()]):
        fail("the adversary_suite! list has a line that is no scenario's name, or a name twice")
    suite_users()
    # The suite's own file names the macro in its code twice: where it defines it, and where
    # its first arm hands the list to the second. A third would be another way in (a macro
    # beside it that passes some scenarios on, say), which no file's count would follow.
    own = names_suite(adversary)
    if len(own) != 2:
        fail(f"{SUITE_SOURCE} names {SUITE_MACRO} on {len(own)} lines of its code, where it "
             "defines the macro and hands its list on (2): " + " | ".join(x.strip()[:80] for x in own[:5]))
    if set(WHOLE_SUITE) & set(SUITE_BY_PARTS):
        fail(f"crates/ci/locked.py names {sorted(set(WHOLE_SUITE) & set(SUITE_BY_PARTS))} both "
             "as running the whole suite once and as counted use by use")
    counts = {}
    for name in WHOLE_SUITE:
        lines = names_suite(suite_file(name))
        if len(lines) != 1 or not re.match(r"[ \t]*nfx_pay::adversary_suite!\((?!@)", lines[0]):
            fail(f"tests/{name}.rs is declared to run the whole suite once (crates/ci/locked.py, "
                 f"WHOLE_SUITE), and its code names {SUITE_MACRO} on {len(lines)} lines, or not as "
                 "one use of the whole list: " + " | ".join(x.strip()[:80] for x in lines[:4]))
        counts[name] = scenarios
    for name in SUITE_BY_PARTS:
        text = suite_file(name)
        whole = re.findall(r"^\s+nfx_pay::adversary_suite!\((?!@)", text, re.M)
        each = re.findall(r"^\s+nfx_pay::adversary_suite!\(@each [^;]*;\n(.*?)\n\s*\);", text, re.M | re.S)
        lines = names_suite(text)
        if len(lines) != len(whole) + len(each):
            fail(f"tests/{name}.rs names {SUITE_MACRO} on {len(lines)} lines of its code, and the "
                 f"lock counts {len(whole)} uses of the whole suite and {len(each)} of scenarios "
                 "named one by one: a use its count does not see")
        counts[name] = (scenarios * len(whole)
                        + sum(len(re.findall(r"^\s+[a-z_0-9]+,$", names, re.M)) for names in each))
    counts.update({
        "mutants": mutant_tests(mutants, pairs(adversary, names)),
        "runner": test_lines(runner, "tests/runner.rs"),
        "pay1": test_lines(pay1, "nfx-pay-wire's tests/pay1.rs"),
    })
    return counts


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
    suite's files, and nfx-pay's unit tests, declares the number of tests pinned for it:
    both known before any build."""
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
    n = lib_tests()
    if pinned.get(LIB) != n:
        fail(f"nfx-pay's unit tests ({LIB_TESTS_IN}) declare {n} tests, and their pin counts "
             f"{pinned.get(LIB)}")


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
    want, want_lib = test_counts(), lib_tests()
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
    if ran.get(LIB) != want_lib:
        fail(f"nfx-pay's unit tests ({LIB_TESTS_IN}): {want_lib} tests declared, {ran.get(LIB)} ran "
             "and passed")
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
