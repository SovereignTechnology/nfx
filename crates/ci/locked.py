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
  macro named in the code of any other file fails (`suite_users`, which `test_counts`
  calls: in a check before any build; at a re-pin before the build too, where nothing is
  compared with the pins, and once more after the build, before the tests run and the
  pins are written). A scenario can be run one by one, so it is this, not the macro, that
  holds a harness file to the whole list, and keeps one from being pinned at whatever
  number of tests ran at its pin; the engine's harness file is named there when it is
  written (M2.1). The numbers declared, each read from the pinned sources (`test_counts`):
  - a harness file (`WHOLE_SUITE`): the scenarios in the suite's list, a name to a line.
    The file's code is inner `allow` attributes, plain `use` items and one invocation of
    the macro in parentheses whose arguments begin no `@` arm, and nothing else
    (`whole_use`): no attribute before the use, no item beside it, no test of its own;
    The scenarios the suite's file makes from its second list, each scenario whose seeders
    are paid run again at a second quoted mint (`scenarios_at_every_quoted_mint!`), are
    names of the list like any other, and the list's names of that kind must be that
    second list's, row for row;
  - the honest timings (`SUITE_BY_PARTS`): the list's length for each use of the whole
    suite, and one for each scenario named under an `@each` use. The uses read from the
    file's lines are the uses its code holds (`part_uses`), and its code names no `cfg`,
    no `macro_rules`, no module kept in another file and no test of its own;
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
  What "code" is: every tracked file of the two money crates is its crate's manifest or a
  Rust source read by a lexer (`as_code`): line comments, block comments with the ones
  nested in them, and the insides of string, raw string, byte string and character
  literals are no code; a lifetime is. What the lexer cannot place fails by name and is
  never guessed at: a comment or literal that does not end, a carriage return, a character
  in code that is not printable ASCII, and a line that begins `//` and yet holds code
  (inside a block comment or a string it is no line comment). On that code the name
  `test` stands only in an attribute that reads `#[test]`, a line of its own, in
  `cfg(test)`, as a macro's variable, and where the pay/1 vector tests give wasm's test
  attribute that name (`test_words`); no file is taken in by `include!`; and a test
  attribute stands only in the files the numbers above are read from, where the runner,
  the pay/1 vector tests and the library's test modules also define no macro and compile
  nothing on a condition. The older rules that go by lines stand beside these (a name
  after code on a line, in a block comment or in a string is refused by them, on the safe
  side); nothing they refused passes.

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
# - WHOLE_SUITE: the file's code is inner `allow` attributes, plain `use` items and one
#   invocation of the macro whose arguments begin no `@` arm, and nothing else
#   (`whole_use`); the file runs as many tests as the list has scenarios. THE ENGINE'S HARNESS FILE (M2.1,
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
# A line that is a test attribute and nothing else, and an attribute that names `test` as
# these three spellings do: on its item's line, by a path of plain segments, under a
# `cfg_attr` written on one line. In a file whose tests are counted the two numbers are
# equal. Other spellings (a space after `#`, a path that begins `::`, a `cfg_attr` over
# several lines, a renamed attribute) this pattern does not see: `test_words` refuses
# those, from the file's tokens.
TEST_LINE = r"^[ \t]*#\[test\]$"
TEST_WORD = r"#\[\s*(?:\w+\s*::\s*)*test\b|\bcfg_attr\([^\n]*,\s*(?:\w+\s*::\s*)*test\s*[,()]"
ENTRY = r"^    [a-z_0-9]+: [svrwlt]\([SV]::[A-Za-z0-9]+\) => [a-z_0-9]+,$"


# What follows reads a Rust source as code: its comments left out, its literals emptied.
# The rules above it in this file's history go by lines (`names_suite`, `code_of`,
# `test_lines`), and stand as they were: what they refuse is refused. These stand beside
# them, and hold the line rules to what a line is: a line that begins `//` holds no code
# (`as_code`), so none of them is told that code is a comment.
MONEY_DIRS = ["crates/nfx-pay", "crates/nfx-pay-wire"]
# The files of the money crates whose code may hold test attributes, counted where the
# docstring says: the others hold none.
TESTS_COUNTED_IN = ("crates/nfx-pay/tests/runner.rs", "crates/nfx-pay-wire/tests/pay1.rs",
                    "crates/nfx-pay/tests/mutants.rs")
LEX_STOP = re.compile(r'//|/\*|"|\'|[^\t\n\x20-\x7e]|(?<![A-Za-z0-9_])(?:r|br|cr)(?=["#])')
LEX_STRING = re.compile(r'(?:[^"\\]|\\.)*"', re.S)
LEX_CHAR = re.compile(r"\\(?:'[^'\n]*|[^'\n]+)'|[^'\\\n]'")
LEX_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_]*|\S")
_LEXED: dict[tuple[str, str], str] = {}


def as_code(text: str, where: str) -> str:
    """A Rust source's code: the text with every comment (a line comment, a block comment
    with the ones nested in it) and the inside of every string, raw string, byte string and
    character literal turned to spaces, each line end kept, so a line of it is that line's
    code. A lifetime or a label is code; a raw identifier reads as `r`, `#` and its name.
    What it cannot place fails, by name: a comment, string or character literal that does
    not end, a quote that begins neither a character nor a lifetime, `r#` that begins
    neither a raw string nor a raw identifier, a carriage return anywhere, and any
    character in code that is not printable ASCII (a name is read by its ASCII spelling).
    And a line of the source that begins `//` must hold no code: inside a block comment or
    a string such a line is no line comment, and the rules that go by lines take it for
    one."""
    if (where, text) in _LEXED:
        return _LEXED[where, text]

    def no(what: str, at: int) -> None:
        fail(f"{where}, line {text.count(chr(10), 0, at) + 1}: {what}: the lock reads this file "
             "as Rust code, and will not guess at what it cannot place")

    def blank(part: str) -> str:
        return re.sub(r"[^\n]", " ", part)

    if "\r" in text:
        no("a carriage return", text.index("\r"))
    out, i = [], 0
    while True:
        m = LEX_STOP.search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i:m.start()])
        at, hit = m.start(), m.group()
        if hit == "//":
            end = text.find("\n", at)
            end = len(text) if end < 0 else end
            out.append(" " * (end - at))
            i = end
        elif hit == "/*":
            depth, j = 1, at + 2
            while depth:
                n = re.compile(r"/\*|\*/").search(text, j)
                if not n:
                    no("a block comment that does not end", at)
                depth += 1 if n.group() == "/*" else -1
                j = n.end()
            out.append(blank(text[at:j]))
            i = j
        elif hit == '"':
            n = LEX_STRING.match(text, at + 1)
            if not n:
                no("a string that does not end", at)
            out.append('"' + blank(text[at + 1:n.end() - 1]) + '"')
            i = n.end()
        elif hit == "'":
            n = LEX_CHAR.match(text, at + 1)
            if n:
                out.append("'" + " " * (n.end() - at - 2) + "'")
                i = n.end()
            elif LEX_NAME.match(text, at + 1):
                out.append("'")  # a lifetime or a label: its name is code
                i = at + 1
            else:
                no("a quote that begins neither a character literal nor a lifetime", at)
        elif hit in ("r", "br", "cr"):
            j = m.end()
            while text.startswith("#", j):
                j += 1
            hashes = j - m.end()
            if text.startswith('"', j):
                end = text.find('"' + "#" * hashes, j + 1)
                if end < 0:
                    no("a raw string that does not end", at)
                out.append(hit + "#" * hashes + '"' + blank(text[j + 1:end]) + '"' + "#" * hashes)
                i = end + 1 + hashes
            elif hit == "r" and hashes == 1 and LEX_NAME.match(text, j):
                out.append(hit)  # a raw identifier: `r`, then `#` and the name as code
                i = m.end()
            else:
                no(f"`{hit}#` that begins neither a raw string nor a raw identifier", at)
        else:
            no(f"a character that is not printable ASCII in code ({hit!r})", at)
    code = "".join(out)
    for n, (line, left) in enumerate(zip(text.split("\n"), code.split("\n")), 1):
        if line.lstrip().startswith("//") and left.strip():
            fail(f"{where}, line {n}: a line that begins `//` and holds code (it ends a block "
                 f"comment or a string: {left.strip()[:80]}): the lock's rules that go by lines "
                 "take such a line for a comment")
    _LEXED[where, text] = code
    return code


def tokens(code: str) -> list[str]:
    """The tokens of a source's code (`as_code`): names, numbers, and every other
    character alone."""
    return TOKEN.findall(code)


def named_in_code(text: str, word: str, where: str) -> int:
    """How many times a source's code names `word`: as a token of its own, so in no
    comment and no literal, and a raw identifier's name too."""
    return tokens(as_code(text, where)).count(word)


def test_words(text: str, where: str) -> int:
    """The test attributes a source's code holds, each read from its tokens as `#[test]`
    and nothing else. The name `test` stands in code only there, in `cfg(test)`, as a macro
    variable (`$test`) and where the pay/1 vector tests give wasm's test attribute that name:
    anywhere else fails, by name, so no test is made by a spelling the count does not take
    (a path that ends in it, `cfg_attr`, a `use` that renames it, a macro handed it). And
    each is a line of its own that reads `#[test]`, as the count goes by those lines; a
    file `include!`d into another would be counted in neither, so no code names `include`
    as a macro."""
    t = tokens(as_code(text, where))
    attributes = 0
    for i, word in enumerate(t):
        before, after = t[max(0, i - 2):i], t[i + 1:i + 2]
        if word == "include" and after == ["!"]:
            fail(f"{where} takes a file in by include!: the lock counts a file's tests where "
                 "they are written")
        if word != "test":
            continue
        if before == ["#", "["] and after == ["]"] and t[max(0, i - 3):i - 2] != ["!"]:
            attributes += 1
        elif not (before[-1:] == ["$"] or (before == ["cfg", "("] and after == [")"])
                  or (where.endswith("nfx-pay-wire/tests/pay1.rs")
                      and t[max(0, i - 2):i + 2] == ["wasm_bindgen_test", "as", "test", ";"])):
            fail(f"{where} names `test` in its code where the lock does not know it "
                 f"(`{' '.join(t[max(0, i - 4):i + 3])}`): a test is made by a line that reads "
                 "#[test], which the lock counts, and the name stands elsewhere only in "
                 "cfg(test) and as a macro's variable")
    lines = len(re.findall(TEST_LINE, code_of(text), re.M))
    plain = len(re.findall(TEST_LINE, as_code(text, where), re.M))
    if not attributes == plain == lines:
        fail(f"{where} has {attributes} test attributes in its code, {plain} of them a line of "
             f"their own, and {lines} lines that read #[test] and nothing else, in a comment or "
             "not: the lock counts a file's tests by those lines, so the three are one number")
    return attributes


def money_sources() -> dict[str, str]:
    """Every tracked file of the two money crates, read: each is its crate's manifest or a
    Rust source the lock can read as code (`as_code`), and a source's code holds test
    attributes only where they are counted (`test_words`): the files this script counts
    them in, and nfx-pay's own sources, which `lib_tests` holds to their numbers."""
    files = [f for f in run("git", "ls-files", "-z", "--", *MONEY_DIRS, cwd=REPO).split("\0") if f]
    sources = {}
    for f in sorted(files):
        if f in [f"{d}/Cargo.toml" for d in MONEY_DIRS]:
            continue
        if not f.endswith(".rs"):
            fail(f"{f} is a file of a money crate that is neither its manifest nor a Rust "
                 "source: the lock reads every file of those crates as code")
        with open(REPO / f, encoding="utf-8", errors="replace", newline="") as source:
            text = source.read()  # its line ends as they are: none is a carriage return
        n = test_words(text, f)
        if n and f not in TESTS_COUNTED_IN and not f.startswith("crates/nfx-pay/src/"):
            fail(f"{f} has {n} test attributes in its code, and the lock counts none there: a "
                 "file that runs the suite takes its tests from the suite's macro alone")
        # Where tests are counted by their lines (the runner, the pay/1 vector tests, the
        # library's test modules), no macro is defined and nothing is compiled on a
        # condition: one line would make several tests, or none. The pay/1 vector tests
        # name wasm's test attribute on a condition, and no other.
        if f in TESTS_COUNTED_IN[:2] or f.startswith(LIB_TESTS_IN):
            t = tokens(as_code(text, f))
            odd = [w for w in ("macro_rules", "cfg", "cfg_attr") if w in t]
            if f == TESTS_COUNTED_IN[1] and t.count("cfg") == 1 and "cfg_attr" not in t:
                at = t.index("cfg")
                if t[at - 2:at + 6] == ["#", "[", "cfg", "(", "target_arch", "=", '"', '"']:
                    odd = [w for w in odd if w != "cfg"]
            if odd:
                fail(f"{f} names {odd} in its code, and the lock counts its tests by the lines "
                     "that read #[test]: a macro or a condition would make several tests of "
                     "one line, or none")
        sources[f] = text
    return sources


def whole_use(name: str, text: str) -> None:
    """A file declared to run the whole suite once is, in its code, inner `allow`
    attributes, plain `use` items, and one invocation of the suite's macro, in parentheses,
    whose arguments begin no `@` arm: nothing before it that could switch it off, nothing
    beside it or after it that could make a test."""
    where = f"tests/{name}.rs"
    t = tokens(as_code(text, f"crates/nfx-pay/{where}"))

    def closes(at: int) -> int:
        """Where the bracket opened at `at` closes: the index past it, or past the end."""
        depth = 0
        for j in range(at, len(t)):
            depth += (t[j] in ("(", "[", "{")) - (t[j] in (")", "]", "}"))
            if depth == 0:
                return j + 1
        return len(t) + 1

    i = 0
    while True:
        if t[i:i + 4] == ["#", "!", "[", "allow"]:
            i = closes(i + 2)
        elif t[i:i + 1] == ["use"] and ";" in t[i:]:
            end = t.index(";", i)
            if any(x == "as" or not (LEX_NAME.fullmatch(x) or x == ":") for x in t[i + 1:end]):
                break
            i = end + 1
        else:
            break
    use = t[i:]
    if (use[:6] != ["nfx_pay", ":", ":", SUITE_MACRO, "!", "("] or use[6:7] in (["@"], [")"])
            or closes(i + 5) != len(t) - 1 or use[-1:] != [";"] or ";" in use[:-1]
            or t.count(SUITE_MACRO) != 1):
        fail(f"{where} is declared to run the whole suite once (crates/ci/locked.py, "
             "WHOLE_SUITE), and its code is not inner `allow` attributes, plain `use` items and "
             f"then `nfx_pay::{SUITE_MACRO}!(<a harness>);` alone, with no `@` arm: "
             f"{' '.join(use[:14])[:120]}")


def part_uses(name: str, text: str) -> tuple[int, int]:
    """The tests a file counted use by use takes from the suite's macro, read from its
    code: every naming of the macro is `nfx_pay::adversary_suite!(` and then a harness (the
    whole list) or `@each <a harness>;` and scenarios' names, a comma after each. Its code
    names no `cfg`, no `macro_rules`, no module kept in another file: nothing that could
    switch a use off or make a test beside them. Gives the uses of the whole list, and
    the scenarios named one by one."""
    where = f"tests/{name}.rs"
    t = tokens(as_code(text, f"crates/nfx-pay/{where}"))
    for i, word in enumerate(t):
        if word in ("cfg", "cfg_attr", "macro_rules") or (word == "mod" and t[i + 2:i + 3] != ["{"]):
            fail(f"{where} is counted use by use of the suite's macro, and its code names "
                 f"`{word}` (`{' '.join(t[max(0, i - 2):i + 4])}`): a use could be switched off, "
                 "or a test made, where the count does not look")
    whole = named = 0
    for i, word in enumerate(t):
        if word != SUITE_MACRO:
            continue
        j = i + 3
        ok = t[max(0, i - 3):i] == ["nfx_pay", ":", ":"] and t[i + 1:j] == ["!", "("]
        if ok and t[j:j + 1] not in (["@"], [")"]):
            whole += 1
            continue
        if ok and t[j:j + 2] == ["@", "each"] and ";" in t[j:]:
            j = t.index(";", j) + 1
            names = 0
            while j < len(t) and LEX_NAME.fullmatch(t[j]) and t[j + 1:j + 2] == [","]:
                names, j = names + 1, j + 2
            ok = names > 0 and t[j:j + 2] == [")", ";"]
            named += names
        else:
            ok = False
        if not ok:
            fail(f"{where} names {SUITE_MACRO} in its code otherwise than as a use of the whole "
                 f"suite or of scenarios named one by one, a comma after each: "
                 f"{' '.join(t[max(0, i - 3):i + 8])[:120]}")
    return whole, named


def names_suite(text: str, word: str = SUITE_MACRO) -> list[str]:
    """The lines of a file that name the suite's macro (or `word`) in what may be code:
    every line that holds the word but those that begin `//` (`//`, `///`, `//!`). Such
    a line is a line comment unless it stands inside a block comment or a string, where
    it may end that and go on as code: `as_code` refuses every file of the money crates,
    and every file this is asked about, in which a line that begins `//` holds code, so
    here it is a comment. A line that names the word after code, in a block comment or in
    a string counts as one, which errs on the side of refusing."""
    return [line for line in text.splitlines()
            if re.search(rf"\b{word}\b", line) and not line.lstrip().startswith("//")]


def code_of(text: str) -> str:
    """A file's lines but those that begin `//`: line comments, in a file `as_code` has
    read (it refuses one where such a line holds code). Block comments and strings stay."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//"))


def test_lines(text: str, where: str) -> int:
    """The tests a file declares, one for each line that is a test attribute and nothing
    else: a file that holds the word in an attribute written in one of the other ways
    `TEST_WORD` sees fails, since its count would not follow it. Every other spelling, and
    such a line inside a block comment, `test_words` refuses."""
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
        if f.endswith(".rs") and named_in_code((REPO / f).read_text(errors="replace"), SUITE_MACRO, f):
            fail(f"{f} names {SUITE_MACRO} in its code, on a line that reads as a comment's, and "
                 "the lock declares no count for it: only a test file of nfx-pay that "
                 "crates/ci/locked.py names may use the suite's macro")
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
        if f.endswith(".rs") and named_in_code((REPO / f).read_text(errors="replace"), PAIRS_MACRO, f):
            fail(f"{f} names {PAIRS_MACRO} in its code, on a line that reads as a comment's: "
                 "only the suite's own file and tests/mutants.rs may")


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
    if named_in_code(adversary, PAIRS_MACRO, SUITE_SOURCE) != 2:
        fail(f"{SUITE_SOURCE} names {PAIRS_MACRO} in its code otherwise than on those two lines, "
             "once each")
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
    # Its code, read as code: each of the three macros named where it is defined and where
    # it is used once (the third also names the module it makes), the suite's second list
    # once, three macros defined and no more, and nothing that could switch one of them off
    # or keep tests in another file.
    t = tokens(as_code(mutants, MUTANTS))
    want = {"catches": 2, "catches_at_other_mints": 2, "judged_at_each_quoted_mint": 3,
            PAIRS_MACRO: 1, "macro_rules": 3, "cfg": 0, "cfg_attr": 0}
    got = {word: t.count(word) for word in want}
    filed = [i for i, word in enumerate(t) if word == "mod" and t[i + 2:i + 3] != ["{"]]
    if got != want or filed:
        fail(f"tests/mutants.rs names in its code {got}, and the lock counts its tests by "
             f"{want}, with no module kept in another file ({len(filed)}): a macro used twice, "
             "one more defined, or a use switched off would not be counted")
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
    # Every file of the money crates is read as code first: what cannot be read fails.
    money_sources()
    read = re.search(r"adversary_suite!\(@each \$h;\n(.*?)\n\s*\);", as_code(adversary, SUITE_SOURCE), re.S)
    if not read or re.findall(r"^\s+([a-z_0-9]+),$", read.group(1), re.M) != names:
        fail("the adversary_suite! list read from the suite's code is not the list read from "
             "its lines: a name of it stands in a comment or a string")
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
    if named_in_code(adversary, SUITE_MACRO, SUITE_SOURCE) != 2:
        fail(f"{SUITE_SOURCE} names {SUITE_MACRO} in its code otherwise than on those two lines, "
             "once each")
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
        whole_use(name, suite_file(name))
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
        named = sum(len(re.findall(r"^\s+[a-z_0-9]+,$", names, re.M)) for names in each)
        if part_uses(name, text) != (len(whole), named):
            fail(f"tests/{name}.rs: the lock counts {len(whole)} uses of the whole suite and {named} "
                 f"scenarios named one by one from its lines, and its code holds "
                 f"{part_uses(name, text)}: a use that is not what its line looks like")
        counts[name] = scenarios * len(whole) + named
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
    else:
        # A re-pin compares nothing with the pins, but what the sources must be is read
        # here all the same, before any build: a file that uses the suite's macro
        # undeclared, or a test made where no count looks, is not pinned at what ran.
        test_counts()
        lib_tests()
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
