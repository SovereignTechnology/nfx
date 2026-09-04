# 1. Record architecture decisions

Date: 2026-09-04

## Status

Accepted

## Context

`nutflix` starts as an empty scaffold with the stack deliberately undecided. Decisions
made from here — language, framework, datastore, transport, deployment target — will
constrain everything built afterwards. Reconstructing the reasoning behind such choices
from a diff is close to impossible six months later, and the usual outcome is that a
constraint gets cargo-culted long after the reason for it has expired.

## Decision

Every decision that is expensive to reverse is recorded as a short markdown file in
`docs/decisions/`, numbered sequentially, in the format described by Michael Nygard's
"Documenting Architecture Decisions".

Each record has: a title, a date, a status (`Proposed`, `Accepted`, `Deprecated`,
`Superseded by NNNN`), the context that forced the decision, the decision itself in
active voice, and the consequences — including the bad ones.

Records are immutable once accepted. A decision that no longer holds is not edited; it is
marked superseded and a new record is written.

## Consequences

- Contributors can find out *why* the project looks the way it does without asking.
- There is a small ongoing cost: a few paragraphs per significant decision.
- Trivial and easily reversible choices must be kept out, or the log becomes noise nobody
  reads.
