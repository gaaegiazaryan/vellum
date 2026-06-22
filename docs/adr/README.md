# Architecture Decision Records

We use ADRs to record the technical choices that shape Vellum: what we picked, what we considered, and why. Each ADR is short and focused on one decision.

## Format

Michael Nygard's template: Status, Context, Decision, Consequences. Markdown files in this directory, numbered sequentially.

## Lifecycle

An accepted ADR is immutable. If we change our minds, we write a new ADR that supersedes the old one and link both ways. Old ADRs stay in the repo as part of the reasoning history.

## Index

- [0000](./0000-record-architecture-decisions.md): Record architecture decisions
- [0001](./0001-monorepo-layout.md): Monorepo layout
- [0002](./0002-orm-drizzle.md): Use Drizzle as the ORM
- [0003](./0003-auth-strategy.md): Authentication and session strategy
- [0004](./0004-migration-application-strategy.md): Migration application strategy
- [0005](./0005-ai-extraction-strategy.md): AI extraction strategy
- [0006](./0006-receipt-to-journal-entry.md): Receipt to journal entry mapping
- [0007](./0007-async-extraction-pipeline.md): Async extraction pipeline
- [0008](./0008-object-storage-driver.md): Object storage driver
- [0009](./0009-production-build.md): Production build for the api
- [0010](./0010-bundle-metadata-emission.md): Bundle decorator metadata emission
- [0011](./0011-extraction-budget.md): Daily budget cap on extraction spend
- [0012](./0012-websocket-status.md): WebSocket-pushed extraction status
- [0013](./0013-category-suggestion.md): Vendor-to-account suggestion at confirm time
- [0014](./0014-per-user-budget.md): Per-user budget cap layered on top of the system cap
- [0015](./0015-provider-fallback.md): Provider fallback strategy
- [0016](./0016-error-response-envelope.md): Error response envelope
- [0017](./0017-receipt-multi-line-confirm.md): Multi-line journal entry from a single receipt
- [0018](./0018-plaid-sandbox-import.md): Plaid sandbox import for bank transactions
