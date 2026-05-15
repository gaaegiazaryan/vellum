# @vellum/api

NestJS HTTP API on top of Fastify, with pino structured logging. Lives in the monorepo at `apps/api`.

## Stack

- NestJS 11 on the Fastify adapter (lower overhead than Express; chosen at the apps level, not via ADR)
- pino + nestjs-pino for structured logs; pretty output in development, JSON in production
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
```

## Tests

Unit tests live alongside source files (`*.test.ts`). The healthz controller has no dependencies, so its test instantiates the class directly without spinning up the Nest DI container. Once we wire controllers with real dependencies, those tests will use `@nestjs/testing`'s `Test.createTestingModule`.

Run from the repo root: `pnpm test apps/api`.

## Configuration

| Variable    | Default                        | Purpose                                  |
| ----------- | ------------------------------ | ---------------------------------------- |
| `PORT`      | `3001`                         | HTTP listen port                         |
| `LOG_LEVEL` | `debug` in dev, `info` in prod | pino level                               |
| `NODE_ENV`  | unset                          | switches log transport and default level |
