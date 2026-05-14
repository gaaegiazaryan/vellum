# Contributing

Bug reports and patches welcome. For larger changes (new feature, architectural decision), open an issue first so we can agree on the approach before code lands.

## Development setup

```bash
pnpm install
pnpm verify        # lint + format:check + typecheck + test
pnpm test:watch    # iterate
```

## Pull requests

Run `pnpm verify` locally before pushing. CI runs the same checks; if they fail you'll need to fix and push again.

Use [conventional commit](https://www.conventionalcommits.org/) messages: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `perf:`, `build:`. The commit-msg hook enforces this.

Keep PRs focused. One logical change per PR makes review faster and the history easier to read later.

## Architecture decisions

Significant choices (new database, new external service, change to the ledger model, anything that future contributors would scratch their head about) get an ADR in [`docs/adr/`](./docs/adr/). See [`docs/adr/0000-record-architecture-decisions.md`](./docs/adr/0000-record-architecture-decisions.md) for the format.

## Reporting security issues

Do not open a public issue for security problems. Use [GitHub's private vulnerability reporting](https://github.com/gaaegiazaryan/vellum/security/advisories/new) or email gaaegiazaryan@gmail.com.
