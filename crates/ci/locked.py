#!/usr/bin/env python3
"""The parts of the locked-path check that need a parser (crates/ci/check-locked.sh).

    locked.py manifest            the derived pin lines for crates/ci/locked.sha256
    locked.py sources             every cached .crate matches its Cargo.lock checksum
    locked.py compiled [--pin]    after the build: check what the compiler actually read,
                                  what the money crate is built from, and that its tests
                                  really ran, against crates/ci/locked-compiled.txt (or
                                  rewrite it)

`compiled` pins, one fact per line:
- `build-script <crate>` and `proc-macro <crate>`: workspace crates that run code at build
  time. Any new one fails.
- `depends-on-nfx-pay <crate>`: workspace crates that may use the money crate.
- `nfx-pay-dep <name> <version> <source> <checksum> <features>`: nfx-pay's resolved
  dependency closure (all kinds for nfx-pay itself, normal and build below it), with the
  features the workspace build unifies onto each. A version bump, a swapped source, a
  [patch] or a feature switched on elsewhere fails.

It also checks, without pins, on the workspace build CI runs (`cargo test --workspace`):
- every file any workspace library or binary compiles is a tracked file inside its own
  crate; nfx-pay's tests read only nfx-pay's tracked files; other tests read tracked
  files only (fixtures);
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
PINS = CRATES / "ci" / "locked-compiled.txt"
MONEY_USERS = [":!crates/nfx-pay", ":!crates/nfx-node/src/pay", ":!crates/nfx-node/src/origin_pay.rs",
               ":!crates/ci"]


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
    sections.update({f"workspace.{k}": w.get(k) for k in ("lints", "resolver", "members")})
    text = json.dumps(sections, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(text.encode()).hexdigest()
    print(f"derived {digest} crates/Cargo.toml#profile,patch,replace,workspace.lints,resolver,members")


def sources() -> None:
    """Every .crate in CARGO_HOME's cache that Cargo.lock names matches its checksum, so
    sources extracted from the cache are the published ones."""
    with open(CRATES / "Cargo.lock", "rb") as f:
        lock = tomllib.load(f)
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


def closure(meta: dict, lock: dict) -> list[str]:
    pkgs = {p["id"]: p for p in meta["packages"]}
    root = next(p["id"] for p in meta["packages"] if p["name"] == "nfx-pay" and p["source"] is None)
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    checksums = {(p["name"], p["version"], p.get("source")): p.get("checksum", "-")
                 for p in lock.get("package", [])}
    seen, todo = {root}, [root]
    while todo:
        cur = todo.pop()
        for dep in nodes[cur]["deps"]:
            kinds = {k["kind"] for k in dep["dep_kinds"]}
            if cur != root and kinds <= {"dev"}:
                continue
            if dep["pkg"] not in seen:
                seen.add(dep["pkg"])
                todo.append(dep["pkg"])
    out = []
    for pid in seen - {root}:
        p = pkgs[pid]
        source = p["source"] or "workspace"
        checksum = checksums.get((p["name"], p["version"], p["source"]), "-")
        features = ",".join(sorted(nodes[pid].get("features", []))) or "-"
        out.append(f"nfx-pay-dep {p['name']} {p['version']} {source} {checksum} {features}")
    return out


def sources_read(dep_file: pathlib.Path) -> set[pathlib.Path]:
    """The files a dep-info file says the compiler read (each is listed as `path:`)."""
    out = set()
    for line in dep_file.read_text().splitlines():
        if line.startswith("#") or not line.endswith(":") or line == ":":
            continue
        path = line[:-1].replace("\\ ", " ")
        p = pathlib.Path(path)
        out.add((p if p.is_absolute() else CRATES / p).resolve())
    return out


def dep_info(filenames: list[str]) -> list[pathlib.Path]:
    found = []
    for f in filenames:
        p = pathlib.Path(f)
        if p.parent.name != "deps":
            continue
        stem = p.name.split(".")[0]
        stem = stem[3:] if stem.startswith("lib") and p.suffix in (".rlib", ".rmeta", ".so") else stem
        d = p.parent / f"{stem}.d"
        if d.exists():
            found.append(d)
    return found


def test_counts() -> dict[str, int]:
    """The number of tests each pinned test binary declares."""
    adversary = (CRATES / "nfx-pay" / "src" / "adversary.rs").read_text()
    listed = re.search(r"adversary_suite!\(@each \$h;\n(.*?)\n\s*\);", adversary, re.S)
    if not listed:
        fail("cannot find the adversary_suite! list")
    mutants = (CRATES / "nfx-pay" / "tests" / "mutants.rs").read_text()
    pay1 = (CRATES / "nfx-proto" / "tests" / "pay1.rs").read_text()
    return {
        "adversary": len(re.findall(r"^\s+[a-z_0-9]+,$", listed.group(1), re.M)),
        "mutants": len(re.findall(r"^\s+[a-z_0-9]+: [sv]\(", mutants, re.M)),
        "pay1": len(re.findall(r"^#\[test\]$", pay1, re.M)),
    }


def compiled(pin: bool) -> None:
    meta = json.loads(run("cargo", "metadata", "--format-version", "1", "--locked", "--offline"))
    with open(CRATES / "Cargo.lock", "rb") as f:
        lock = tomllib.load(f)
    members = [p for p in meta["packages"] if p["id"] in meta["workspace_members"]]
    facts = []
    for p in members:
        kinds = {k for t in p["targets"] for k in t["kind"]}
        if "custom-build" in kinds:
            facts.append(f"build-script {p['name']}")
        if "proc-macro" in kinds:
            facts.append(f"proc-macro {p['name']}")
        if p["name"] != "nfx-pay" and any(d["name"] == "nfx-pay" for d in p["dependencies"]):
            facts.append(f"depends-on-nfx-pay {p['name']}")
    facts += closure(meta, lock)
    version = run("rustc", "-vV")
    release = re.search(r"^release: (\S+)$", version, re.M)
    commit = re.search(r"^commit-hash: (\S+)$", version, re.M)
    if not (release and commit):
        fail("cannot read the toolchain's release and commit")
    facts.append(f"toolchain rustc {release.group(1)} {commit.group(1)}")
    facts = sorted(facts)

    # What the workspace build CI runs actually compiled.
    tracked = {(REPO / f).resolve() for f in run("git", "ls-files", "-z", cwd=REPO).split("\0") if f}
    crate_dirs = {p["manifest_path"]: pathlib.Path(p["manifest_path"]).parent.resolve() for p in members}
    pay_dir = (CRATES / "nfx-pay").resolve()
    out = run("cargo", "test", "--workspace", "--no-run", "--locked", "--offline", "--message-format=json")
    seen_targets = 0
    for line in out.splitlines():
        msg = json.loads(line)
        if msg.get("reason") != "compiler-artifact" or msg["manifest_path"] not in crate_dirs:
            continue
        crate = crate_dirs[msg["manifest_path"]]
        is_test = msg["profile"].get("test", False)
        for d in dep_info(msg["filenames"] + ([msg["executable"]] if msg.get("executable") else [])):
            seen_targets += 1
            for src in sources_read(d):
                if src not in tracked:
                    fail(f"{crate.name} compiled {src}, which is not a tracked file ({d.name})")
                own = crate in src.parents
                if crate == pay_dir and not own:
                    fail(f"nfx-pay compiled {src}, from outside crates/nfx-pay ({d.name})")
                if not is_test and not own:
                    fail(f"{crate.name}'s library or binary compiled {src}, from outside its crate ({d.name})")
    if seen_targets == 0:
        fail("found no dep-info for the workspace build")

    named = subprocess.run(["git", "grep", "-nw", "nfx_pay", "--", "crates", *MONEY_USERS],
                           cwd=REPO, capture_output=True, text=True)
    if named.returncode == 0:
        fail("only nfx-pay and nfx-node's locked paths may name nfx_pay:\n" + named.stdout)

    # The money tests ran, all of them. `cargo test` exits 0 when a runner skips them.
    want = test_counts()
    out = subprocess.run(["cargo", "test", "--locked", "--offline", "-p", "nfx-pay", "-p", "nfx-proto",
                          "--test", "adversary", "--test", "mutants", "--test", "pay1"],
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

    text = "".join(f + "\n" for f in facts)
    if pin:
        PINS.write_text(text)
        print(f"pinned {len(facts)} compiled facts in {PINS.relative_to(REPO)}")
        return
    if not PINS.exists() or PINS.read_text() != text:
        old = set(PINS.read_text().splitlines()) if PINS.exists() else set()
        new = set(facts)
        diff = [f"- {x}" for x in sorted(old - new)] + [f"+ {x}" for x in sorted(new - old)]
        fail("what nfx-pay is built from differs from its pins:\n" + "\n".join(diff))
    counts = ", ".join(f"{k} {v}" for k, v in want.items())
    print(f"locked paths: {len(facts)} compiled facts match their pins; every compiled file is "
          f"tracked and in its crate; the money tests ran ({counts})")


def main() -> None:
    args = sys.argv[1:]
    if args == ["manifest"]:
        manifest()
    elif args == ["sources"]:
        sources()
    elif args and args[0] == "compiled" and set(args[1:]) <= {"--pin"}:
        compiled("--pin" in args)
    else:
        fail(__doc__.strip().splitlines()[2].strip())


if __name__ == "__main__":
    main()
