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
