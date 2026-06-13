# Vellum

[![CI](https://github.com/gaaegiazaryan/vellum/actions/workflows/ci.yml/badge.svg)](https://github.com/gaaegiazaryan/vellum/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

A self-hostable AI bookkeeper for freelancers and small teams. You drop a receipt or invoice (photo, PDF, email forward); Vellum extracts the line items with a vision LLM, files them as a balanced double-entry journal entry, and keeps a full audit trail of every AI decision.

## Status

Pre-alpha but functionally end-to-end on the local stack. The core path works: upload a receipt, the api extracts it via Anthropic Claude vision, you review and confirm, a balanced journal entry is posted. The self-hosted deploy story is documented in [docs/deploying.md](./docs/deploying.md); no hosted demo yet.

## Stack

Next.js 15 on the App Router. NestJS on the Fastify adapter. PostgreSQL with Drizzle for the ledger and the rest. Auth.js v5 for sessions. Redis for the BullMQ job queue and pub/sub. Anthropic Claude vision API for extraction (OpenAI fallback planned). S3-compatible object storage (filesystem in dev). Socket.IO for live extraction-status pushes. TypeScript strict everywhere.

See [docs/architecture.md](./docs/architecture.md) for how the pieces fit together, and [docs/adr/](./docs/adr/) for the specific choices and the trade-offs behind them.

## What works

- Double-entry ledger with sum-of-debits = sum-of-credits enforced by a deferred trigger (ADR-0001, ADR-0006)
- Receipt upload and Anthropic vision extraction running through a BullMQ queue (ADR-0005, ADR-0007)
- Review, edit, confirm UI that posts the journal entry (ADR-0006); confirmed receipts pre-fill account pickers from your own history (ADR-0013)
- Per-currency money formatting and parsing (JPY 0 decimals, BHD 3) via @vellum/core
- Daily extraction budget cap, system-wide and per-user, with predicted-cost gating at enqueue (ADR-0011, ADR-0014); `GET /budget/today` plus a header banner show live spend
- Live extraction status pushed over WebSocket with polling fallback (ADR-0012)
- Liveness `/healthz` (version + commit sha) and readiness `/readyz` (database + redis probes)
- S3-compatible storage backend; filesystem fallback for dev (ADR-0008)
- Production esbuild bundle with full Nest DI metadata + Dockerfile (ADR-0009, ADR-0010)

## Roadmap

- [ ] First hosted deploy (single-user) and demo URL
- [ ] OpenAI vision as a fallback provider behind the same interface
- [ ] Plaid sandbox import to seed bank transactions alongside receipts
- [ ] Natural language transaction queries
- [ ] Anomaly detection on transactions

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Architecture decisions are recorded in [docs/adr/](./docs/adr/).

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
