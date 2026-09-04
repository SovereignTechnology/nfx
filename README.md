# nutflix

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

> Status: **scaffold**. The repository skeleton, license and contribution rules are in
> place; the application itself has not been designed yet.

## What this is

A placeholder for the `nutflix` project. Nothing has been committed to a language,
framework or architecture yet — that decision is deliberately deferred so the first
implementation choice can be made against a real requirement rather than a guess.

## What is decided

| Decision | Value |
| --- | --- |
| Licence | AGPL-3.0-or-later |
| Visibility | Public |
| Default branch | `main` |
| Canonical remote | <https://example.invalid/sovtech/nutflix> |

The AGPL is a deliberate choice: if this ever becomes a network-facing service, anyone
who runs a modified copy for others has to publish their changes. See §13 of the
[LICENSE](LICENSE).

## Getting started

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nfx
cd nfx
```

There is nothing to build or run yet. When a stack is chosen, this section gets the real
install/build/test commands.

There is deliberately **no `.gitlab-ci.yml`** yet: no CI runner is registered against this
namespace, so a pipeline definition would only produce jobs stuck in `pending`. It gets
added at the same time as a runner.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and note the
[Code of Conduct](CODE_OF_CONDUCT.md). Contributions are accepted under the AGPL-3.0.

## Roadmap

- [ ] Decide what nutflix does
- [ ] Choose a stack and record the reasoning in `docs/decisions/`
- [ ] Register a CI runner, then add `.gitlab-ci.yml` with lint/test/build jobs
- [ ] First release

## Licence

Copyright (C) 2026 sovtech.

This program is free software: you can redistribute it and/or modify it under the terms
of the GNU Affero General Public License as published by the Free Software Foundation,
either version 3 of the License, or (at your option) any later version. It is
distributed WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text.
