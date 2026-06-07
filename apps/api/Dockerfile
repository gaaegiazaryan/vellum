# syntax=docker/dockerfile:1.7

# Multi-stage build for the api. The first stage installs every
# workspace dep needed to build, the second runs the esbuild bundle,
# the third uses pnpm deploy to flatten just the api into a runtime
# directory with only its production dependencies, and the final
# stage copies that directory into a minimal image.

FROM node:20.19.6-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/core/package.json ./packages/core/
COPY packages/extraction/package.json ./packages/extraction/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --filter "@vellum/api..." --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/core ./packages/core
COPY packages/extraction ./packages/extraction
RUN pnpm --filter @vellum/api build
# The bundle already inlines @vellum/* workspace packages, so the
# deploy directory only needs npm deps. --legacy keeps pnpm v10 from
# requiring inject-workspace-packages on every workspace.
RUN pnpm --filter @vellum/api --legacy deploy --prod /deploy/api

FROM node:20.19.6-alpine AS runtime
WORKDIR /app
# Optional build-arg so /healthz can report which commit this image is.
# Pass at build time: --build-arg GIT_SHA=$(git rev-parse HEAD).
ARG GIT_SHA=""
ENV NODE_ENV=production
ENV PORT=3001
ENV GIT_SHA=$GIT_SHA
COPY --from=build /deploy/api/dist ./dist
COPY --from=build /deploy/api/node_modules ./node_modules
COPY --from=build /deploy/api/package.json ./package.json
EXPOSE 3001
# Node 20 has a global fetch; the healthcheck stays inside the image
# without needing wget or curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
