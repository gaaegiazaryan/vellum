# 0009. Production build for the api

## Status

Accepted, 2026-05-28.

## Context

The api ships TypeScript and runs in development via `tsx watch src/main.ts`. `docs/deploying.md` has flagged this as a pre-alpha-only path from day one: a deploy should run a compiled, self-contained artifact, not a TS source loader.

Two constraints make the build less obvious than "run `tsc`":

- The api imports two workspace packages (`@vellum/core`, `@vellum/extraction`) whose `package.json` `main` points at TS source (`./src/index.ts`). At runtime under tsx that resolves to a real file; Node loading a compiled api would hit `.ts` files it cannot run.
- NestJS dependency injection needs `emitDecoratorMetadata`. Type-injected constructor parameters (e.g. `private uploadsService: UploadsService`, no explicit `@Inject`) only resolve when the compiler emits parameter-type metadata.

A third constraint is monorepo-wide: the web app consumes `@vellum/core` through Next's `transpilePackages` plus a webpack `extensionAlias` that reads `.js` imports as `.ts` on disk. Changing the package's `main` to a compiled output would force the web build to follow and tie the two builds together with a strict order.

## Decision

**Bundle the api with esbuild into a single `dist/main.js`.** One build command in `apps/api`, no per-package builds, no changes to the workspace packages' `main` field.

**Bundle the workspace packages into the api output;** mark real npm dependencies as external so Node resolves them from `node_modules` at runtime. Concretely: `external = Object.keys(pkg.dependencies).filter(d => !d.startsWith('@vellum/'))`. The bundle is self-contained for application code; `node_modules` is still required at runtime for Nest, fastify, drizzle, bullmq, etc.

**Rely on esbuild's native `emitDecoratorMetadata` support** (esbuild 0.21+). The api's `tsconfig.json` already sets `experimentalDecorators: true` and `emitDecoratorMetadata: true`; esbuild reads both and emits the metadata Nest needs. Verified by a spike that bundled the api and successfully resolved the full DI graph against real Postgres and Redis. No plugin (`esbuild-plugin-tsc`, `@anatine/esbuild-decorators`) is needed.

**Format: ESM, platform: node, target: node20.** The repo is ESM-first (`"type": "module"`), and the runtime is pinned at node 20 (`.nvmrc`). A small banner injects `createRequire` so any bundled code that uses `require` keeps working under ESM.

**Source maps are emitted alongside `dist/main.js`** so production stack traces map back to the original TS.

## Options considered

**tsc project references / composite build.** The boring, idiomatic monorepo build. Rejected because making it work end to end forces the workspace packages to expose compiled output through `main`, which breaks the web's `transpilePackages` + `extensionAlias` setup and forces a coordinated cross-package build order on every change. Same end result (a runnable artifact) with a much larger blast radius across the dev and test paths.

**SWC.** Supports `emitDecoratorMetadata` natively and is fast. Rejected because SWC compiles file-by-file without bundling, so the workspace packages still need their own builds and the `main`-field problem comes back unchanged.

**esbuild plus a decorator-metadata plugin (`esbuild-plugin-tsc`, `@anatine/esbuild-decorators`).** Was the plan before the spike. Rejected once esbuild 0.21+ proved to emit metadata natively. The plugins are unnecessary maintenance.

**Keep running TS in production via a hardened tsx-style loader.** Rejected as not a real fix: it leaves devDependencies on the runtime path and pays the TS-transpile cost on every cold start.

## Consequences

A deploy runs `pnpm --filter @vellum/api build` and then `node apps/api/dist/main.js`. The dev path (`tsx watch`) is unchanged; tests are unchanged; the web build is unchanged. The api's bundle is roughly 750KB plus a source map, which is reasonable for a Node service and small enough that the runtime image will be dominated by `node_modules`, not the application code.

The Docker runtime image still needs `node_modules` (the externals). A multi-stage Dockerfile is the natural shape: a builder stage installs all deps and runs the build, a runtime stage copies `dist/` plus a production-only `node_modules` and the trimmed lockfile.

Three known limits:

- **Optional Nest packages.** `@nestjs/microservices`, `@nestjs/websockets`, `cache-manager`, `class-transformer`, `class-validator` are dynamically required by `@nestjs/core` only when their features are used. They are not in `dependencies` and not bundled; Nest's conditional require gracefully fails when those features are not in play. We accept any warning noise this surfaces in logs.
- **No tree-shaking of the workspace packages.** Both `@vellum/core` and `@vellum/extraction` get bundled in full. They are small today; if either grows to multiple megabytes, splitting the build is a follow-up.
- **`dist/` is gitignored.** Reproducible builds are everyone's responsibility; the Dockerfile in the follow-up PR pins the exact build command so CI and prod produce the same artifact.
