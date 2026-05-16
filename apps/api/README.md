# @vellum/api

NestJS HTTP API on top of Fastify, with pino structured logging. Lives in the monorepo at `apps/api`.

## Stack

- NestJS 11 on the Fastify adapter (lower overhead than Express; chosen at the apps level, not via ADR)
- pino + nestjs-pino for structured logs; pretty output in development, JSON in production
- Drizzle ORM with postgres-js driver, migrations under `src/db/migrations/`
- `@vellum/core` as a workspace dependency for domain types
- ESM, NodeNext module resolution, decorator metadata for Nest DI
- tsx for dev (no nest-cli yet; plain TypeScript runner keeps the toolchain thin)

## Endpoints

- `GET /healthz`: liveness probe. Returns `{ status, uptimeSeconds, timestamp }`.

More endpoints land alongside the Drizzle schema in a follow-up PR.

## Local

```bash
pnpm install                              # from repo root
pnpm --filter @vellum/api dev             # tsx watch, port 3001 by default
PORT=4000 pnpm --filter @vellum/api dev   # override port
curl http://localhost:3001/healthz

# Database (see src/db/README.md for the full workflow)
pnpm --filter @vellum/api db:generate     # generate a migration from schema changes
pnpm --filter @vellum/api db:migrate      # apply migrations against DATABASE_URL
pnpm --filter @vellum/api db:push         # push schema directly (local dev only)
```

## Tests

Two layers, both Vitest:

- `*.test.ts` are unit tests next to the source. They instantiate classes directly without a DI container; fast and simple.
- `*.integration.test.ts` boot a real Fastify pipeline via `Test.createTestingModule` and `fastify.inject()`. No HTTP socket, no flakiness, full middleware and routing surface exercised.

Run from the repo root: `pnpm test apps/api`.

## Configuration

| Variable       | Default                        | Purpose                                  |
| -------------- | ------------------------------ | ---------------------------------------- |
| `DATABASE_URL` | required                       | `postgres://...` connection string       |
| `PORT`         | `3001`                         | HTTP listen port                         |
| `LOG_LEVEL`    | `debug` in dev, `info` in prod | pino level                               |
| `NODE_ENV`     | `development`                  | switches log transport and default level |
