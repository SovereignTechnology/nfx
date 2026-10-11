# Security Policy

## Supported versions

The project is pre-release. There is no released version yet, so there is nothing to
backport fixes to. Once a `1.0.0` ships, this table gets filled in.

## Reporting a vulnerability

**Do not open a public issue.** Email <git@sovit.xyz> with:

- a description of the issue and its impact
- steps to reproduce, or a proof of concept
- affected commit or version
- any suggested remediation

You should get an acknowledgement within 7 days. Please allow a reasonable window for a
fix to be prepared and released before disclosing publicly. Reporters are credited in the
release notes unless they ask not to be.

## Scope

In scope: anything in this repository. Out of scope: the hosting infrastructure, and
issues that require an already-compromised machine or physical access.

## Money code

The paths that hold money code are locked. `crates/ci/check-locked.sh` lists them, pins
every file in them by hash (`crates/ci/locked.sha256`) and fails any change that has not
been reviewed and re-pinned. The payment rules themselves are in
[NFX-07](spec/nfx-07-open-payments.md), and the plan for the money path and its security
stage in [`docs/nfx/m2-plan.md`](docs/nfx/m2-plan.md).

Cryptography comes from libraries only (ADR 0008 §4); nothing here is hand-written. A
contributor who finds a hash, signature, blinding or key-derivation primitive being
implemented in this repository stops and reports it.

## The demo's threat model

Until 2026-10-11 this file also held the threat table (T1 to T16), the money-path
invariants and the locked directories of the TypeScript demo that was mirrored here.
They describe the demo, not NFX, and left with the mirror. They are in the demo's
repository (`nutflix-demo`) and here at the tag `demo-base`:

```sh
git show demo-base:SECURITY.md
```
