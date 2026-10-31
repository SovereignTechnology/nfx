#!/bin/bash -p
# -p: no BASH_ENV, and no shell functions imported from the environment. Run through its
# shebang (or `bash -p`) only: through plain `bash`, BASH_ENV runs first and could make it
# say anything, so it refuses.
if [[ $- != *p* ]]; then
  builtin echo "locked paths: run this as crates/ci/check-locked.sh, not through plain bash" >&2
  builtin exit 1
fi
if [[ -n $(builtin declare -F) ]]; then
  builtin echo "locked paths: shell functions are defined before the check runs" >&2
  builtin exit 1
fi
# The locked paths (docs/nfx/m2-plan.md; ADR 0008 §4). Money code is written only in the M2
# security stage, and sovtech reads every change to it.
#
#   check-locked.sh              the pinned files and the build environment. check.sh runs
#                                this first, before any unpinned code.
#   check-locked.sh --sources    the same, then every cached .crate against Cargo.lock (in
#                                CI, extracted sources are then deleted, so cargo re-extracts
#                                from verified archives: only from the job's own CARGO_HOME
#                                inside the checkout, and a CI-mode run with a shared one
#                                refuses). check.sh runs this before cargo.
#   check-locked.sh --facts      the same, then what the money crates are built from, and
#                                which test targets they have, read from cargo metadata
#                                without compiling anything (locked.py facts).
#   check-locked.sh --compiled   the same, then builds every target of nfx-pay and
#                                nfx-pay-wire alone, checks what the compiler read for each
#                                (failing closed on a target without dep-info) and that
#                                every money test ran, each test binary reporting the
#                                number of tests pinned for it, and checks the pinned files
#                                again (locked.py). The lock job runs --facts, then this;
#                                check.sh runs it last.
#   LOCKED_DIRS_UNLOCKED=1 check-locked.sh --pin
#                                the security stage, after sovtech has read the diff:
#                                re-pin both, the compiled facts first (their file is one
#                                of the pinned files, read as just written, not as
#                                committed: the re-pin commits it with the pins).
#                                Refused wherever CI, GITLAB_CI or CI_JOB_ID is
#                                non-empty, as in every CI job, so no job makes it unless
#                                its command unsets them, as the re-pin's manually
#                                dispatched probe does: a guard against a re-pin by
#                                accident, not a control. The control is sovtech's review
#                                of every change to the pins (below). A re-pin does the
#                                build and money tests of the lock job's --compiled, and
#                                its time varies as much from runner to runner (65 min for
#                                the re-pin on 49ae389, run 40705674410, against 56 min
#                                for the lock job's --compiled on the same code, run
#                                40811478196): dispatch it with `timeout` at least the
#                                lock job's last time plus a third, under probe.yml's
#                                limit, which is the lock job's.
#
# crates/ci/locked.sha256 pins, by git mode and content:
#   - the locked paths (stubs until the security stage);
#   - everything that decides how the money code is compiled and tested: the two money
#     crates whole, every tracked file in them and no untracked one: crates/nfx-pay
#     (manifest, contracts, mock, suite, tests) and crates/nfx-pay-wire (the pay/1 parser,
#     the modules it rests on, its vector test); the pay/1 vectors and their reference
#     reader; the workspace manifest's profile, patch, replace, lints, resolver, members
#     and package;
#   - this check, its helpers, the CI that runs them (.github/workflows whole: ci.yml runs
#     them, and a workflow added beside it is a change too; and crates/ci/gitlab-ci.yml, the
#     same jobs for GitLab, dormant), and locked-compiled.txt.
# crates/ci/locked-compiled.txt pins the money crates' resolved dependency closure with
# its features (nfx-pay's and nfx-pay-wire's, test dependencies included), the workspace
# crates that may depend on nfx-pay, the workspace's build scripts and proc-macros, the
# toolchain, and every test binary of the money crates with the number of tests it runs.
#
# What the lock reads that no pin covers whole, and what holds each instead:
#   - crates/ci/locked.sha256 itself, which cannot pin itself. It must be a tracked regular
#     file of mode 100644, so the pins are read from, and a re-pin written to, the one path
#     whose every change sovtech reviews (below), never through a link to another;
#   - the manifests and the lock file cargo reads for the workspace: crates/Cargo.toml,
#     crates/Cargo.lock and each member's Cargo.toml (the money crates' own are pinned
#     whole). What they do to the money crates is pinned: the workspace manifest's profile,
#     patch, replace, lints, resolver, members and package by the derived line; the
#     dependency closure with its sources, checksums and features, and which crates depend
#     on nfx-pay or run code at build time, by the facts. Each must be tracked at the path
#     cargo reads it from, and every tracked Cargo.toml and Cargo.lock must be a regular
#     file of mode 100644, so none is read through a link either;
#   - the crate archives in CARGO_HOME, checked against Cargo.lock's checksums (--sources),
#     which the facts pin for the money closure;
#   - the other crates' Rust files, which are only searched for `nfx_pay` (below).
# With git's index and the pinned paths, that is all these scripts, and the cargo commands
# they run, read from the checkout and CARGO_HOME. The programs they run (bash, git,
# python3, cargo, rustc) are the image's, which ci.yml pins by digest; the toolchain is a
# fact as well.
#
# Anything else fails:
#   - an edited, added, removed, renamed or symlinked file (listed from git), before the
#     build and again after the tests;
#   - a file the lock reads from git's listing (every pinned file, the pins file, every
#     tracked Cargo.toml and Cargo.lock) whose checkout is not its blob in git's index byte
#     for byte, as `git hash-object --no-filters` reads it: an attribute that rewrites a
#     file on checkout (`ident`, `eol`, `text`, `working-tree-encoding` or a filter, from a
#     tracked .gitattributes, .git/info/attributes or git's own config), which no diff of
#     the commit shows, would otherwise have the pins, the build and the tests read bytes
#     nobody reviewed. In CI the index is the commit's (lock-job.sh); outside it the
#     index is whatever is staged, so a file edited and staged passes as its blob there;
#   - crates/ci/locked.sha256 not a tracked regular file of mode 100644 (a link, an
#     untracked file, another mode); the workspace's manifest, its lock file or a member's
#     manifest not tracked at its path; any tracked Cargo.toml or Cargo.lock that is a link
#     or of another mode;
#   - a Cargo config or toolchain file, tracked or not, anywhere cargo or rustup would
#     read one (crates/ and every directory above it, and CARGO_HOME); a tracked path
#     named .cargo or .cargo-home anywhere, or below one, whatever it is (a link too: CI's
#     CARGO_HOME is .cargo-home in the checkout, which the tree never supplies);
#   - a CARGO_*, RUST* or RUSTC* variable outside the allow-list below (a target runner in
#     the environment can make `cargo test` run nothing and still pass), and any variable
#     whose name is not a plain identifier (an exported bash function, say); in CI, any
#     variable outside the allow-list at all;
#   - for any target of nfx-pay or nfx-pay-wire: no dep-info, a compiled file that is
#     untracked, or one outside its own crate (only nfx-pay-wire's integration tests may
#     read outside it, and only spec/test-vectors/pay1.json). This catches #[path],
#     include! and every spelling of them in the money crates, on the host build CI tests;
#   - a money crate depending on a workspace crate other than the money crates;
#   - `nfx_pay` named in any Rust file outside nfx-pay and nfx-node's locked paths;
#   - a path package that is not a workspace member, or a workspace member that the
#     workspace manifest's pinned `members` key does not name, at the path it names (cargo
#     makes a member of a path dependency that lies under crates/ or names this workspace
#     as its own, and of a package in the workspace's own manifest);
#   - a test target of a money crate added, removed or renamed without a re-pin (read from
#     cargo metadata, before any build); a test binary that did not run, that the build did
#     not make, or that reported another number of tests than the one pinned for it (or, for
#     the suite's files and nfx-pay's unit tests, than its sources declare); a test ignored
#     or filtered out. The lock runs every target of the two crates as a test binary, and
#     their doctests;
#   - the adversary suite's macro (`adversary_suite`) named in the code of any file but the
#     suite's own and the test files locked.py names as running it (read before any build
#     in a check; at a re-pin before the build too, and again before the tests run). Each
#     of those is held to a number of tests the suite's list of scenarios gives: the whole
#     list for a harness file, whose code is inner `allow` attributes, plain `use` items
#     and one invocation of the macro with no `@` arm, and nothing else; every use counted
#     for the file that runs the honest timings, whose code holds the uses its lines show. A scenario can be run one by one, so it is this, not
#     the macro, that holds a harness file to the whole list: a new one cannot be pinned
#     at whatever number of tests ran, and the engine's (M2.1) is named in locked.py when
#     it is written;
#   - the suite's second list (`scenarios_at_every_quoted_mint`: each scenario whose
#     seeders are paid, and its name at a second quoted mint) named in the code of any file
#     but the suite's own and tests/mutants.rs, or there otherwise than on two lines of
#     the suite's own (defined, and used once) and one of the mutants' (used once); a name
#     of the suite's list at a second mint that is no row of it, or a row that is none of
#     the list's;
#   - a number of tests declared that differs from its pin (before any build) or from what
#     ran: for a harness file the names in the suite's list; for the honest timings that
#     number for each use of the whole suite and one for each scenario named one by one;
#     for the mutants one for each entry of the two registries (at every mint, at other
#     mints) and one for each row of the suite's second list; for the runner, the pay/1
#     vector tests and nfx-pay's unit tests (src/adversary/) their test attributes. A test
#     attribute where the count does not look (outside the mutants' three macros, in
#     another source of the library, in a harness file or the honest timings' file, in any
#     other file of the money crates, written otherwise than as a line of its own), a use
#     of a registry's macro beside the registry, or a line of a registry or of a list
#     that is no entry of it, fails rather than go uncounted;
#   - a file of the money crates that is neither its crate's manifest nor a Rust source the
#     lock can read as code. locked.py reads each with a lexer of its own (line comments,
#     nested block comments, string, raw string, byte string and character literals,
#     lifetimes): a comment or literal that does not end, a carriage return, a character in
#     code that is not printable ASCII, or a line that begins `//` and holds code (it ends
#     a block comment or a string) fails by name, never guessed at. On that code the name
#     `test` anywhere but in a line that reads `#[test]`, in `cfg(test)`, as a macro's
#     variable or in the pay/1 vector tests' one renaming for wasm fails (so a path that
#     ends in it, `cfg_attr`, `# [test]`, a renamed or handed attribute); so does
#     `include!`; and so does a macro defined, or anything compiled on a condition, in the
#     runner, the mutants (beyond their three macros) or the library's test modules.
#
# CI is recognised by CI, GITLAB_CI or CI_JOB_ID. The pinned .github/workflows/ci.yml runs
# this with CI=true: its lock job under env -i, its check job with LOCKED_DIRS_UNLOCKED
# emptied (as the dormant gitlab-ci.yml does, so a pipeline variable cannot unset CI).
#
# What it guarantees: the money code (every pinned file) and what it is built and tested
# with cannot change without a re-pin, and its tests ran in full. What it does not:
#   - code outside the money crates is out of scope. Another crate may compile a pinned
#     file (by #[path], on any target), but cannot change it, and money logic written
#     afresh anywhere is a change no lock can tell from other code. Inside one crate a
#     module can change how another compiles (a macro in textual scope, an inherent
#     method shadowing a derived one), which is why the money crates are pinned whole and
#     depend on no other workspace crate. nfx-proto re-exports nfx-pay-wire and is not a
#     money crate;
#   - nfx-node's locked paths (below) sit inside nfx-node, which is not pinned, so an
#     nfx-node module could shadow a macro they use or add a method to a type they use.
#     They hold no code, and cannot gain any without a re-pin: before M2.1 writes code
#     there, they move into a money crate of their own (docs/nfx/m2-plan.md);
#   - other Cargo workspaces (crates/desktop, crates/spikes) build the money crates with
#     their own dependency resolution. The lock checks the main workspace's, which CI
#     tests;
#   - whoever can push can also re-pin, and the CI configuration lives in the branch it
#     checks. This makes money-code changes loud and reviewable; the control is sovtech's
#     review of every change to the pins. An edit to the CI configuration fails its pin
#     wherever the lock still runs (the lock job, and the check job's lock steps). One that
#     stops the lock job running this check, or heeding it, the lock job cannot catch:
#     only the check job's lock steps, if the edit leaves them running, and that review;
#   - the verdict is the CI lock job's (env -i, bash -p, no unpinned code before it). A
#     local run, or the check job's lock steps after unpinned code has run, is a second
#     look;
#   - the lock job runs on the tip of a branch push, on a pull request's merge commit and
#     on the tip of a ref it is dispatched on, and on no other commit. So these get no lock
#     verdict: a commit pushed below the tip of its push (several commits pushed at once
#     run once, on the last); a tag push; a push whose tip's message carries one of GitHub's
#     skip instructions (`[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`,
#     `[actions skip]`, or a `skip-checks: true` trailer; a pull request whose head commit
#     carries one runs none either); and a push to a probe/** branch (ci.yml leaves those
#     out). A commit counts as locked only once a lock job passed on it. GitLab's pipeline
#     variables are that project's settings to close (gitlab-ci.yml);
#   - ci.yml's lock job skips this check only on a branch that never held money code: no
#     commit in its history changed a file of the lock or a path of the money code, and its
#     tree names no money crate, in the bytes of its Rust files, manifests and lock files
#     or as cargo reads those manifests and lock files (one the guard cannot read, and a
#     submodule, count as naming one). Money logic written afresh under other names on such
#     a branch runs no lock: it is the change no lock can tell from other code (above).
set -euo pipefail
# A failure inside a plain x=$(...) fails the script, not just the subshell. Where bash
# ignores -e (a condition, a command followed by && or ||) it ignores it inside the
# substitution too, so a function that must stop at its first failure is assigned first.
shopt -s inherit_errexit
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
py="${PYTHON:-python3} -I -S"   # isolated, and no site: locked.py needs only the stdlib
pins=crates/ci/locked.sha256
locked=(
  crates/nfx-pay/src/engine
  crates/nfx-pay/src/wallet
  crates/nfx-pay/src/protocol
  crates/nfx-node/src/pay
  crates/nfx-node/src/origin_pay.rs
)
guarded=(
  crates/nfx-pay
  crates/nfx-pay-wire
  spec/test-vectors/pay1.py
  spec/test-vectors/pay1.json
  crates/ci/check-locked.sh
  crates/ci/lock-job.sh
  crates/ci/locked.py
  crates/ci/check.sh
  crates/ci/gitlab-ci.yml
  crates/ci/locked-compiled.txt
  .github/workflows
)
must_be_absent=(crates/nfx-pay/build.rs crates/nfx-pay-wire/build.rs)
paths=("${locked[@]}" "${guarded[@]}")
mode=${1:-}

fail() { printf 'locked paths: %s\n' "$*" >&2; exit 1; }

case $mode in
  '' | --pin | --sources | --facts | --compiled) ;;
  *) fail "usage: check-locked.sh [--sources | --facts | --compiled | --pin]" ;;
esac
in_ci=${CI:-}${GITLAB_CI:-}${CI_JOB_ID:-}
if [ -n "$in_ci" ] && { [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ] || [ "$mode" = --pin ]; }; then
  fail "unlocking and re-pinning are refused in CI"
fi
if [ "$mode" = --pin ] && [ "${LOCKED_DIRS_UNLOCKED:-0}" != 1 ]; then
  fail "--pin needs LOCKED_DIRS_UNLOCKED=1 (the security stage, after sovtech's review)"
fi

# The checkout of `path` is its blob in git's index, byte for byte (`entry` is its
# `git ls-files -s` line): no attribute rewrote it on checkout (the header). The index is
# the commit's only in CI (lock-job.sh).
as_indexed() {
  local blob=${1#* }
  blob=${blob%% *}
  [ "$(git hash-object --no-filters -- "$2")" = "$blob" ] \
    || fail "the checkout of $2 is not its blob in git's index: an attribute rewrote it, or it is edited"
}

# Every file under the paths, from git (NUL-separated, so no name can split a line), each
# read as indexed, but for the compiled facts in a re-pin: --pin has just written them
# (locked.py compiled --pin), so their checkout is the new pin, committed with the pins
# file, and not yet their blob. Every later check reads them as indexed again.
manifest() {
  local untracked fresh=
  [ "$mode" != --pin ] || fresh=crates/ci/locked-compiled.txt
  untracked=$(git ls-files -o -z -- "${paths[@]}" | tr '\0' '\n')
  [ -z "$untracked" ] || fail "untracked files in guarded paths: $untracked"
  git ls-files -s -z -- "${paths[@]}" | while IFS= builtin read -r -d '' entry; do
    mode=${entry%% *}
    path=${entry#*$'\t'}
    case $path in
      *[![:print:]]* | *' '*) fail "a guarded path has a space or unprintable name: ${path@Q}" ;;
    esac
    if [ "$mode" = 120000 ]; then
      fail "symlink in a guarded path: $path"
    fi
    [ -f "$path" ] && [ ! -L "$path" ] || fail "missing or not a regular file: $path"
    [ "$path" = "$fresh" ] || as_indexed "$entry" "$path"
    printf '%s %s %s\n' "$mode" "$(sha256sum < "$path" | cut -d' ' -f1)" "$path"
  done
  $py crates/ci/locked.py manifest
}

for p in "${must_be_absent[@]}"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || fail "$p must not exist"
done

# What no pin covers whole (the header lists it): the pins file, which cannot pin itself,
# and the manifests and lock files cargo reads. Each is a regular file of mode 100644 that
# git tracks, read at its own path: a link would move the pins, or a manifest, to a file
# whose changes nobody takes for a change to them. (locked.py manifest checks that the
# workspace's own manifests and lock file are tracked at the paths cargo reads.)
entry=$(git ls-files -s -- "$pins")
[[ $entry =~ ^100644\ [0-9a-f]+\ 0$'\t'crates/ci/locked\.sha256$ ]] \
  || fail "$pins must be a tracked regular file of mode 100644, not ${entry:-untracked or missing}"
[ -f "$pins" ] && [ ! -L "$pins" ] || fail "$pins must be a regular file, not a link"
as_indexed "$entry" "$pins"
# Each of the next two listings is piped into its loop, never read from a process
# substitution, whose exit status bash drops: there a git or an env that fails, or lists
# nothing, leaves its loop nothing to check, and the check passes. Piped, the failure is
# the script's (pipefail), and each loop counts what a listing that worked cannot lack.
git ls-files -s -z -- '*Cargo.toml' '*Cargo.lock' | {
  seen=0
  while IFS= builtin read -r -d '' entry; do
    path=${entry#*$'\t'}
    [[ $entry =~ ^100644\ [0-9a-f]+\ 0$'\t' ]] && [ -f "$path" ] && [ ! -L "$path" ] \
      || fail "a Cargo manifest or lock file must be a tracked regular file of mode 100644: ${entry@Q}"
    as_indexed "$entry" "$path"
    case $path in crates/Cargo.toml | crates/Cargo.lock) seen=$((seen + 1)) ;; esac
  done
  [ "$seen" = 2 ] || fail "git listed $seen of crates/Cargo.toml and crates/Cargo.lock"
}

# The build environment: nothing may redirect what cargo runs or compiles. In CI the lock
# job runs under `env -i` (ci.yml), and every variable must be on the list below.
allowed='CARGO_HOME CARGO_TERM_COLOR CARGO_BUILD_JOBS CARGO_PROFILE_DEV_DEBUG CARGO_PROFILE_TEST_DEBUG CARGO_INCREMENTAL CARGO_DENY_VERSION CARGO_DENY_SHA256 RUSTUP_HOME RUST_VERSION'
ci_allowed="$allowed PATH HOME CI CI_COMMIT_SHA PYTHON PWD OLDPWD SHLVL _ LOCKED_DIRS_UNLOCKED"
# Names from `env -0`, so no value can forge a line. A name that is not a plain
# identifier (BASH_FUNC_git%%, an exported function standing in for a command) fails. The
# listing is never empty: bash gives every command it runs `_`, at the least.
/usr/bin/env -0 | {
  seen=0
  while IFS= builtin read -r -d '' entry; do
    name=${entry%%=*}
    [[ $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "a variable that is not a plain name is set: ${name@Q}"
    if [ -n "$in_ci" ]; then
      case " $ci_allowed " in
        *" $name "*) ;;
        *) fail "in CI, a variable outside the allow-list is set: $name" ;;
      esac
    elif [[ $name =~ ^(__)?(CARGO|RUST) ]]; then
      case " $allowed " in
        *" $name "*) ;;
        *) fail "a build variable outside the allow-list is set: $name" ;;
      esac
    fi
    seen=$((seen + 1))
  done
  [ "$seen" -gt 0 ] || fail "/usr/bin/env listed no variable"
}
if [ -n "$in_ci" ] && [ -n "${LOCKED_DIRS_UNLOCKED:-}" ]; then
  fail "LOCKED_DIRS_UNLOCKED is set in CI"
fi
dir=$PWD/crates
while :; do
  for f in "$dir/.cargo/config" "$dir/.cargo/config.toml" "$dir/rust-toolchain" "$dir/rust-toolchain.toml"; do
    [ ! -e "$f" ] && [ ! -L "$f" ] || fail "a Cargo config or toolchain file where cargo reads one: $f"
  done
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
# The listing first, so that a git that fails is not taken for a grep that found nothing,
# and grep's count, never its silence: a here-string bash cannot set up leaves grep unrun
# with status 1, and a substitution bash cannot make a pipe for is empty with status 0.
# Either reads as a grep that found nothing, and neither prints a count.
# A tracked path named .cargo or .cargo-home fails whatever it is, not only a file below
# one: a link of that name (git lists it with no slash after it) would hand cargo a
# directory of the tree for its configuration, or for the CARGO_HOME CI gives it.
tracked=$(git ls-files -z | tr '\0' '\n')
[ -n "$tracked" ] || fail "git listed no tracked file"
config_re='(^|/)\.cargo(-home)?(/|$)|(^|/)rust-toolchain(\.toml)?$'
rc=0
found=$(grep -cE "$config_re" <<<"$tracked") || rc=$?
[ "$rc" -le 1 ] && [ -n "$found" ] \
  || fail "grep for tracked Cargo configuration or toolchain files failed or did not run ($rc)"
[ "$found" = 0 ] \
  || fail "tracked Cargo configuration, Cargo home or toolchain files: $(grep -E "$config_re" <<<"$tracked" || true)"
home=${CARGO_HOME:-$HOME/.cargo}
for f in "$home"/config "$home"/config.toml; do
  [ ! -e "$f" ] && [ ! -L "$f" ] || fail "a Cargo config in CARGO_HOME: $f"
done

if [ "$mode" = --pin ]; then
  $py crates/ci/locked.py compiled --pin
  # Whole, then written: a manifest that fails leaves the pins as they were.
  repinned=$(manifest)
  printf '%s\n' "$repinned" > "$pins"
  echo "pinned $(wc -l < "$pins") guarded files and sections in $pins"
  exit 0
fi
current=$(manifest)
if [ "${LOCKED_DIRS_UNLOCKED:-0}" = 1 ]; then
  echo "locked paths: UNLOCKED (the M2 security stage); re-pin after review"
  exit 0
fi
if [ "$current" != "$(cat "$pins")" ]; then
  echo "locked paths: guarded files differ from their pins:" >&2
  diff <(cat "$pins") <(printf '%s\n' "$current") >&2 || true
  exit 1
fi
echo "locked paths: $(wc -l < "$pins") guarded files and sections match their pins"
case $mode in
  --sources)
    $py crates/ci/locked.py sources
    if [ -n "$in_ci" ]; then
      # Only the job's own extracted sources, inside the checkout: never a shared one,
      # whether CARGO_HOME or any directory below it is a link to one.
      src=$(realpath -m -- "$home/registry/src")
      case $src in
        "$(pwd -P)"/?*) ;;
        *) fail "in CI, the extracted sources must be the job's own, inside the checkout (ci.yml), not $src" ;;
      esac
      rm -rf -- "${src:?}"
      echo "locked paths: extracted sources removed; cargo re-extracts from verified archives"
    fi
    ;;
  --facts) $py crates/ci/locked.py facts ;;
  --compiled)
    $py crates/ci/locked.py compiled
    # The tests ran code: the pinned files must still be the pinned files. Assigned first,
    # as `current` is above: in a command followed by `||` bash ignores -e, inside its
    # substitutions too, and manifest() would go on past a git that could not list the
    # untracked files as if the tree held none.
    again=$(manifest)
    [ "$again" = "$(cat "$pins")" ] || fail "guarded files changed during the build or the tests"
    echo "locked paths: the guarded files still match their pins"
    ;;
esac
