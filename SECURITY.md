# Security Policy

## Supported versions

NFX is pre-1.0: the releases so far are 0.1.x (see the README), and nothing is backported
to an earlier one. A table of supported versions starts when `1.0.0` ships.

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

The repository includes the NFX specification (`spec/`), the Rust crates (`crates/`)
and the browser test player (`web/player/`). Protocol-level weaknesses in the
specification are in scope, including ones that no implementation introduced.

NFX-specific security considerations live in the spec documents:

- NFX-02 §4, *Parse/verify algorithm*: when a catalog manifest is accepted;
- NFX-03 §7, *Security notes*: what a bad availability beacon can and cannot do;
- NFX-04 §2, *Rate limits (normative baselines)*: the limits a scoped relay enforces;
- NFX-05 §4, *Verification (the "Blossom rule")*: every file is checked against its
  signed sha256 before use or storage;
- NFX-07 §3, *Seeder duties*: open-mode payments (Draft);
- NFX-08 §1, *Trust posture (state it plainly)*, and §4.1, *Seeder verification
  (licensed)*: licensed mode (Draft).

## Money code

The paths that hold money code are locked. `crates/ci/check-locked.sh` lists them, pins
every file in them by hash (`crates/ci/locked.sha256`) and fails any change that has not
been reviewed and re-pinned. The payment rules themselves are in
[NFX-07](spec/nfx-07-open-payments.md), and the plan for the money path and its security
stage in [`docs/nfx/m2-plan.md`](docs/nfx/m2-plan.md).

Cryptography comes from libraries (ADR 0008 §4), with one recorded exception:
`crates/nfx-proto/src/nip44.rs` writes HMAC-SHA256 and HKDF out over RustCrypto's `sha2`,
for NIP-44 v2 (mesh signaling, NFX-10 §6), because the `hmac` crate would change the
money crates' pinned dependency closure; both are checked against RFC 4231, RFC 5869 and
the NIP-44 vectors. A contributor who finds any other hash, signature, blinding or
key-derivation primitive being implemented in this repository stops and reports it.

## The demo's threat model

Until 2026-10-11 this file also held the threat table (T1 to T16), the money-path
invariants and the locked directories of the TypeScript demo that was mirrored here.
They describe the demo, not NFX, and left with the mirror. They are in the demo's
repository (`nutflix-pear`, formerly `nutflix-demo`) and here at the tag `demo-base`:

```sh
git show demo-base:SECURITY.md
```
