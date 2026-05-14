# Vellum

A self-hostable AI bookkeeper for freelancers and small teams. You drop a receipt or invoice (photo, PDF, email forward); Vellum extracts the line items with a vision LLM, files them as a balanced double-entry journal entry, and keeps a full audit trail of every AI decision.

## Status

Pre-alpha. Core ledger and extraction pipeline are in progress. Not yet usable, see roadmap.

## Stack

Next.js 14, NestJS, PostgreSQL, Redis, Anthropic + OpenAI vision APIs. TypeScript, strict mode.

## Roadmap

- [ ] Double-entry ledger with audit log
- [ ] Receipt upload and AI extraction pipeline
- [ ] Review queue UI
- [ ] Plaid sandbox integration
- [ ] Natural language transaction queries
- [ ] Anomaly detection on transactions

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
