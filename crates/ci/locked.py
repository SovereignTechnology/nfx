#!/usr/bin/env python3
"""The parts of the locked-path check that need a parser (crates/ci/check-locked.sh).

    locked.py manifest            the derived pin lines for crates/ci/locked.sha256
    locked.py compiled [--pin]    after a build: check what the compiler actually read and
                                  what the money crate is built from, against
                                  crates/ci/locked-compiled.txt (or rewrite it)

`compiled` pins, one fact per line:
- `build-script <crate>` and `proc-macro <crate>`: workspace crates that run code at build
  time. Any new one fails.
- `depends-on-nfx-pay <crate>`: workspace crates that may use the money crate.
- `nfx-pay-dep <name> <version> <source> <checksum>`: nfx-pay's resolved dependency
  closure (all kinds for nfx-pay itself, normal and build below it). A version bump, a
  swapped source or a [patch] fails.

It also checks, without pins:
- every source file the compiler read for nfx-pay (its dep-info) is a tracked file
  under crates/nfx-pay, so it is pinned;
- nothing compiled into nfx-node's library comes from outside crates/nfx-node (its tests
  may read fixtures);
- no file outside nfx-pay and nfx-node's locked paths names `nfx_pay`.
"""

import hashlib
import json
import pathlib
import subprocess
import sys
import tomllib

REPO = pathlib.Path(
    subprocess.run(["git", "-C", str(pathlib.Path(__file__).parent), "rev-parse", "--show-toplevel"],
                   check=True, capture_output=True, text=True).stdout.strip())
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
        fail(f"{' '.join(args)} failed:\n{r.stderr[-2000:]}")
    return r.stdout


def manifest() -> None:
    """Sections of the workspace manifest that change how every crate compiles."""
    with open(CRATES / "Cargo.toml", "rb") as f:
        ws = tomllib.load(f)
    sections = {k: ws.get(k) for k in ("profile", "patch", "replace")}
    sections["workspace.lints"] = ws.get("workspace", {}).get("lints")
    text = json.dumps(sections, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(text.encode()).hexdigest()
    print(f"derived {digest} crates/Cargo.toml#profile,patch,replace,workspace.lints")


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
        out.append(f"nfx-pay-dep {p['name']} {p['version']} {source} {checksum}")
    return out


def dep_info_files(package: str, cargo_args: list[str]) -> list[pathlib.Path]:
    """The dep-info files of every target cargo builds for `package` with `cargo_args`."""
    out = run("cargo", *cargo_args, "-p", package, "--locked", "--offline", "--message-format=json")
    files = []
    for line in out.splitlines():
        msg = json.loads(line)
        if msg.get("reason") != "compiler-artifact" or msg["target"]["name"] == "build-script-build":
            continue
        if msg["manifest_path"] != str(CRATES / package / "Cargo.toml"):
            continue
        for f in msg["filenames"] + ([msg["executable"]] if msg.get("executable") else []):
            p = pathlib.Path(f)
            if p.parent.name != "deps":
                continue
            stem = p.name.split(".")[0]
            stem = stem[3:] if stem.startswith("lib") and p.suffix in (".rlib", ".rmeta") else stem
            d = p.parent / f"{stem}.d"
            if d.exists():
                files.append(d)
    if not files:
        fail(f"no dep-info found for {package}")
    return sorted(set(files))


def sources(dep_file: pathlib.Path) -> set[pathlib.Path]:
    """The files a dep-info file says the compiler read (each is listed as `path:`)."""
    out = set()
    for line in dep_file.read_text().splitlines():
        if line.startswith("#") or not line.endswith(":") or line == ":":
            continue
        path = line[:-1].replace("\\ ", " ")
        p = pathlib.Path(path)
        out.add((p if p.is_absolute() else CRATES / p).resolve())
    return out


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
    facts = sorted(facts)

    tracked = {(REPO / f).resolve() for f in run("git", "ls-files", "-z", "--", "crates/nfx-pay",
                                                  cwd=REPO).split("\0") if f}
    pay_dir, node_dir = (CRATES / "nfx-pay").resolve(), (CRATES / "nfx-node").resolve()
    for d in dep_info_files("nfx-pay", ["test", "--no-run"]):
        for src in sources(d):
            if src not in tracked:
                fail(f"nfx-pay compiled {src}, which is not a tracked file under crates/nfx-pay "
                     f"(dep-info {d.name})")
    for d in dep_info_files("nfx-node", ["build", "--lib"]):
        for src in sources(d):
            inside_repo = REPO.resolve() in src.parents
            if inside_repo and node_dir not in src.parents and (CRATES / "target").resolve() not in src.parents:
                fail(f"nfx-node compiled {src}, from outside crates/nfx-node (dep-info {d.name})")
    named = subprocess.run(["git", "grep", "-nw", "nfx_pay", "--", "crates", *MONEY_USERS],
                           cwd=REPO, capture_output=True, text=True)
    if named.returncode == 0:
        fail("only nfx-pay and nfx-node's locked paths may name nfx_pay:\n" + named.stdout)

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
    print(f"locked paths: {len(facts)} compiled facts match their pins; "
          "nfx-pay compiled only its own pinned files")


def main() -> None:
    args = sys.argv[1:]
    if args == ["manifest"]:
        manifest()
    elif args and args[0] == "compiled" and set(args[1:]) <= {"--pin"}:
        compiled("--pin" in args)
    else:
        fail(__doc__.strip().splitlines()[2].strip())


if __name__ == "__main__":
    main()
