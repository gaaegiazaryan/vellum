# Deploying Vellum

A practical guide for self-hosting Vellum. Aimed at someone who wants to run their own instance and is comfortable with a terminal, Postgres, and a hosting platform of their choice.

Vellum is pre-alpha. The deployment story below works, but expect rough edges; if you find one, please open an issue.

1. What you need

---

- A PostgreSQL 16+ database. CHECK constraints and the deferred constraint trigger on `ledger_lines` are core to the data model; SQLite is not an option and earlier Postgres versions are untested.
- A Redis instance. Used for the BullMQ job queue and pub/sub between API replicas. Single-process deploys can skip multi-replica concerns but still need Redis for the queue.
- A platform to run two long-lived Node processes (Next.js + NestJS). Railway, Fly.io, Render, and Kubernetes are all fine. Vercel-style edge-only does not fit because the API is a regular HTTP server with a persistent DB connection.
- Outbound network access to your chosen AI providers (Anthropic, OpenAI) and to the email-delivery service.

2. Environment variables

---

A copy of these lives in `.env.example` at the repo root. Set every variable below in the deploy environment of both the web and the api services.

| Variable               | Required    | Used by  | Notes                                                                                                                                   |
| ---------------------- | ----------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | yes         | web, api | `postgres://user:pass@host:port/db`. Same value on both services.                                                                       |
| `AUTH_SECRET`          | yes         | web, api | At least 32 random bytes. Encrypts the session JWE on web; the api uses it to decrypt the same cookie. **Same value on both services.** |
| `AUTH_URL`             | optional    | web      | Public base URL of the web app. Auth.js auto-detects on most hosts.                                                                     |
| `REDIS_URL`            | yes         | api      | `redis://host:port/db`. Used by BullMQ and the pub/sub fanout.                                                                          |
| `PORT`                 | optional    | api      | Defaults to `3001`. Set whatever your platform expects.                                                                                 |
| `NODE_ENV`             | yes         | web, api | `production` in prod. Switches log format and tightens defaults.                                                                        |
| `LOG_LEVEL`            | optional    | api      | `info` by default in prod, `debug` in dev.                                                                                              |
| `STORAGE_DRIVER`       | optional    | api      | `filesystem` (default) or `s3`. Use `s3` in prod so uploads survive restarts and span replicas (ADR-0008).                              |
| `UPLOAD_DIR`           | optional    | api      | Directory the `filesystem` driver writes receipts to. Defaults to `/tmp/vellum-uploads`. Ignored when `STORAGE_DRIVER=s3`.              |
| `S3_BUCKET`            | conditional | api      | Required when `STORAGE_DRIVER=s3`. Bucket receipts are written to.                                                                      |
| `S3_REGION`            | conditional | api      | Required when `STORAGE_DRIVER=s3`. Use `auto` for Cloudflare R2.                                                                        |
| `S3_ACCESS_KEY_ID`     | conditional | api      | Required when `STORAGE_DRIVER=s3`.                                                                                                      |
| `S3_SECRET_ACCESS_KEY` | conditional | api      | Required when `STORAGE_DRIVER=s3`.                                                                                                      |
| `S3_ENDPOINT`          | optional    | api      | Set for S3-compatible providers (R2, B2, MinIO). Leave unset for AWS S3.                                                                |
| `S3_FORCE_PATH_STYLE`  | optional    | api      | `true` for R2 and MinIO. Defaults to `false` (virtual-host style, AWS S3).                                                              |
| `EXTRACTION_PROVIDER`  | optional    | api      | `mock` (default) or `anthropic`. Mock skips API calls; anthropic requires `ANTHROPIC_API_KEY`.                                          |
| `ANTHROPIC_API_KEY`    | conditional | api      | Required when `EXTRACTION_PROVIDER=anthropic`. Get one from anthropic.com.                                                              |

Generate `AUTH_SECRET` once and treat it like a database password:

    openssl rand -base64 48

3. Database migrations

---

Migrations are SQL files in `apps/api/src/db/migrations/`, generated by drizzle-kit and committed to the repo. Apply them with:

    pnpm --filter @vellum/api db:migrate

Per ADR-0004, run this as a **pre-deploy release task**, not at process startup. Railway calls this a `release_command`, Fly.io a `release_command`, Kubernetes a Job that runs before the rollout, Render a "pre-deploy command". The point is the same: one process applies the migrations, then the application processes start.

Migrations are forward-only. There are no automatic down migrations. If a deploy goes wrong after a migration that broke compatibility, the recovery path is restoring from a recent PITR backup, not running `down` migrations against live data. Make sure your hosted Postgres has point-in-time recovery turned on before you start writing real data.

After the first migration, seed the default chart of accounts so the web UI has something to pick from:

    pnpm --filter @vellum/api db:seed

The seed is idempotent (`ON CONFLICT (code) DO NOTHING`). Running it twice is safe; running it after you have customised the chart will only add new codes from the default set, not overwrite yours.

4. Build and start

---

    pnpm install --frozen-lockfile
    pnpm --filter @vellum/api build       # esbuild bundle -> apps/api/dist/main.js
    pnpm --filter @vellum/web build       # next build

    # then on each service:
    pnpm --filter @vellum/api start       # node apps/api/dist/main.js
    pnpm --filter @vellum/web start       # next start

The api build is described in ADR-0009 and ADR-0010: esbuild bundles `src/main.ts` with the workspace packages inlined, externalizes real npm deps, and runs every `.ts` file through TypeScript's `transpileModule` so `Reflect.metadata` is emitted for Nest DI. The compiled `dist/main.js` is what production runs.

5. Container build

---

`apps/api/Dockerfile` is a multi-stage build that produces a small runtime image:

    docker build -t vellum-api -f apps/api/Dockerfile .
    docker run --rm \
      -e DATABASE_URL=postgres://... -e REDIS_URL=redis://... \
      -e AUTH_SECRET=$(openssl rand -base64 48) \
      -e STORAGE_DRIVER=s3 -e S3_BUCKET=... -e S3_REGION=... \
      -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
      -e EXTRACTION_PROVIDER=anthropic -e ANTHROPIC_API_KEY=sk-ant-... \
      -p 3001:3001 vellum-api

The image runs `node dist/main.js` as PID 1 with `NODE_ENV=production`. It carries a Docker `HEALTHCHECK` that calls `GET /healthz` every 30 seconds, so orchestrators that read Docker health (Fly.io, Docker Compose, plain Docker) get liveness for free. Platforms with their own health-probe contracts (Railway, Kubernetes) should still hit `/healthz` directly.

6. What this guide does not cover yet

---

The following are real concerns we will document properly before the project is usable:

- A web Dockerfile. `apps/web` still deploys via `next build` and `next start` on a Node runtime today; a container build with the right build-time env handling lands next.
- Bind addresses and reverse-proxy headers. The api listens on `0.0.0.0` and trusts proxy headers (`trustProxy: true` in the Fastify adapter); your reverse proxy needs to set `X-Forwarded-For` and `X-Forwarded-Proto`.
- Session cookie domain. If web and api are on the same parent domain, the cookie just works. If they are on unrelated domains, you need a different cookie strategy and we will write that ADR when the situation arises.
- Email delivery. Auth.js verification and password reset both need a working transactional email provider. We default to Resend but the configuration is not yet exposed via env.
- Backups and PITR procedures.
- Observability: where the pino JSON stream goes in prod. Probably stdout into your platform's log aggregator; we will document the exact shape when we run the first deploy.

7. Sanity check

---

After the migration step finishes and both services are up:

    curl https://api.<your-domain>/healthz

should return a 200 with `{"status":"ok","uptimeSeconds":<n>,"timestamp":"..."}`. If you get a 5xx, check the api logs for env validation errors first; `loadEnv` fails loud on missing or malformed configuration.

The web app at `https://<your-domain>/` should render the landing page in less than a second. The `/api/auth/[...nextauth]` route should respond (even if no providers are wired yet, Auth.js's default error page renders).

Open an issue if anything in this guide is wrong, missing, or out of date. The repo is the source of truth; the docs are a snapshot.
