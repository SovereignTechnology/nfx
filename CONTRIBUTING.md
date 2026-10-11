# Contributing to nfx

Thanks for taking an interest. Where the work stands is in
[`docs/nfx/status.md`](docs/nfx/status.md), and what the protocol is, in
[`spec/`](spec/README.md).

## Ground rules

- By contributing you agree your work is licensed under **AGPL-3.0-or-later**, the same
  licence as the project. There is no CLA and copyright stays with you.
- Be civil. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Never commit secrets: API tokens, private keys, `.env` files, credentials of any kind.
  `.gitignore` blocks the common cases, but it is not a safety net you should rely on.

## Workflow

1. Open an issue first for anything non-trivial, so design discussion happens before the
   code exists.
2. Branch off `main`. Use a descriptive name: `feat/media-indexer`,
   `fix/thumbnail-race`, `docs/readme-setup`.
3. Keep commits focused and the history readable. Rebase rather than merge `main` into
   your branch.
4. Open a merge request against `main`. Explain *why*, not just *what* — the diff already
   shows what changed.
5. CI must pass. Review must approve. Then it merges. CI is `crates/ci/check.sh`, which
   you can run yourself before you push.

The money code is locked: a change under `crates/nfx-pay`, `crates/nfx-pay-wire` or any
other path that `crates/ci/check-locked.sh` lists fails CI until it has been reviewed and
re-pinned. See [`docs/nfx/m2-plan.md`](docs/nfx/m2-plan.md) before you touch it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short imperative summary>

<optional body explaining motivation and context>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`.

Subject line: imperative mood, no trailing full stop, ideally under 72 characters.

Do **not** add `Co-Authored-By` trailers or tool-attribution lines.

## Architectural decisions

Anything that constrains the project long-term — language, framework, datastore,
protocol — gets a short record in `docs/decisions/NNNN-title.md` covering the context,
the decision and the consequences. Future contributors need to know why, not just what.

## Reporting a security issue

Do not open a public issue for a vulnerability. Email <git@sovit.xyz> with details and
reproduction steps, and allow reasonable time for a fix before disclosing.
