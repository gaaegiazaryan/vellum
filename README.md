# Vellum

[![CI](https://github.com/gaaegiazaryan/vellum/actions/workflows/ci.yml/badge.svg)](https://github.com/gaaegiazaryan/vellum/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

A self-hostable AI bookkeeper for freelancers and small teams. You drop a receipt or invoice (photo, PDF, email forward); Vellum extracts the line items with a vision LLM, files them as a balanced double-entry journal entry, and keeps a full audit trail of every AI decision.

## Status

Pre-alpha. Core ledger and extraction pipeline are in progress. Not yet usable, see roadmap.

## Stack

Next.js 14, NestJS, PostgreSQL, Redis, Anthropic + OpenAI vision APIs. TypeScript, strict mode. See [docs/architecture.md](./docs/architecture.md) for how it fits together.

## Roadmap

- [ ] Double-entry ledger with audit log
- [ ] Receipt upload and AI extraction pipeline
- [ ] Review queue UI
- [ ] Plaid sandbox integration
- [ ] Natural language transaction queries
- [ ] Anomaly detection on transactions

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Architecture decisions are recorded in [docs/adr/](./docs/adr/).

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
