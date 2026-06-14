# Contributing

Bug reports and patches welcome. For larger changes (new feature, architectural decision), open an issue first so we can agree on the approach before code lands.

## Development setup

You need Node 20 (see `.nvmrc`), pnpm 10, and a working Docker daemon (the integration suite spins up Postgres and Redis via Testcontainers). On macOS, OrbStack and Docker Desktop both work; the suite reads `DOCKER_HOST` so any setup that exposes the socket is fine.

```bash
nvm use            # picks the version from .nvmrc
pnpm install
cp .env.example .env   # then fill in real values for local dev
pnpm verify            # lint + format:check + typecheck + unit tests
pnpm test:db           # postgres-backed integration tests (Docker required)
pnpm test:watch        # iterate on unit tests
```

`pnpm verify` does not run the integration suite (it would slow the inner loop too much). CI runs both; if you touch a controller or a service, run `pnpm test:db` locally before pushing.

## Pull requests

Run `pnpm verify` locally before pushing. CI runs the same checks plus `pnpm test:db`; if any fail you will need to fix and push again.

Use [conventional commit](https://www.conventionalcommits.org/) messages: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `ci:`, `perf:`, `build:`. The commit-msg hook enforces this; the subject must also be lowercase.

Keep PRs focused. One logical change per PR makes review faster and the history easier to read later. The current main goes through squash-merge; the title becomes the commit message, so write a useful title.

## Architecture decisions

Significant choices (new database, new external service, change to the ledger model, anything that future contributors would scratch their head about) get an ADR in [`docs/adr/`](./docs/adr/). See [`docs/adr/0000-record-architecture-decisions.md`](./docs/adr/0000-record-architecture-decisions.md) for the format.

## Reporting security issues

Do not open a public issue for security problems. Use [GitHub's private vulnerability reporting](https://github.com/gaaegiazaryan/vellum/security/advisories/new) or email gaaegiazaryan@gmail.com.
