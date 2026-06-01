# syntax=docker/dockerfile:1.7

# Multi-stage build for the web app. The first stage installs every
# workspace dep needed to build, the second runs next build, the third
# uses pnpm deploy to flatten the web app into a runtime directory,
# and the final stage runs that directory under pnpm start.

FROM node:20.19.6-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter "@vellum/web..." --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/core ./packages/core
# getDb in apps/web/src/db/client.ts returns a postgres-js client with a
# placeholder URL when DATABASE_URL is unset and NEXT_PHASE flags the
# build phase, so next build can collect page data without real env.
ENV NODE_ENV=production
RUN pnpm --filter @vellum/web build
# next.config.mjs is ESM JavaScript, so next start does not need
# typescript at runtime and --prod is safe to keep.
RUN pnpm --filter @vellum/web --legacy deploy --prod /deploy/web

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /deploy/web ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
