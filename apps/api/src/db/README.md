# apps/api/src/db

Drizzle schema and migrations for the Vellum API. The operational rules here come from [ADR-0002](../../../../docs/adr/0002-orm-drizzle.md) and [ADR-0004](../../../../docs/adr/0004-migration-application-strategy.md). Read those first.

## Layout

```
db/
  schema/        TypeScript schema definitions, one file per bounded context
    auth.ts      Auth.js v5 tables (users, auth_accounts, sessions, verification_tokens)
    index.ts     Barrel re-exports for drizzle-kit
  migrations/    Generated SQL migration files, committed to the repo
  client.ts      createDb() factory; opens a postgres-js pool and returns a typed Drizzle handle
  migrate.ts     CLI entrypoint for `pnpm db:migrate`
```

## Commands

Run from the repo root.

```bash
pnpm --filter @vellum/api db:generate   # generate a new migration from schema changes
pnpm --filter @vellum/api db:push       # push schema directly to local DB (no migration file)
pnpm --filter @vellum/api db:migrate    # apply migrations to DATABASE_URL
pnpm --filter @vellum/api db:studio     # browse the local DB
```

`DATABASE_URL` must be set for every command above.

## Workflow

- **On a feature branch, iterating on schema:** use `db:push`. Fast, no migration file produced. Stash these changes locally; do not commit a partial migration generated mid-iteration.
- **Before opening a PR:** run `db:generate`. Drizzle Kit produces a SQL file under `migrations/`. Read the SQL. Commit it as part of the PR.
- **In production:** the deploy pipeline runs `db:migrate` as a release task before any new application instance starts serving traffic. The app process itself never runs migrations.

## Rollback

Forward-only. If a migration is wrong, write a new migration that fixes it forward. Do not write `down.sql`. If the bad migration corrupted data, the recovery path is point-in-time restore from the database host, not a mechanical reversal.

The reasoning is in ADR-0004.

## Auth.js schema notes

Column names and types match what `@auth/drizzle-adapter` expects, so the adapter can be wired without a custom mapping layer. The `accounts` table is named `auth_accounts` in SQL to avoid colliding with the chart-of-accounts table that lands with the ledger schema.

`users.id` defaults to `gen_random_uuid()`, which is built into Postgres 13 and later. The project targets Postgres 16+; the `pgcrypto` extension is not required.
