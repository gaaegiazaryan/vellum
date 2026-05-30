# 0010. Bundle decorator metadata emission

## Status

Accepted, 2026-05-30. Refines ADR-0009.

## Context

ADR-0009 chose esbuild as the api production bundler on the strength of a spike that bundled the api and successfully booted Nest. The ADR concluded that esbuild's native `emitDecoratorMetadata` support (claimed in esbuild's 0.21 changelog) was enough to make Nest DI work without any plugin.

The spike was insufficient. It validated that the bundle compiled and that the module graph initialized; it never made a real HTTP request through a Nest interceptor stack. When the bundle was first run end to end against real Postgres and Redis, every request 500'd with `Cannot read properties of undefined (reading 'get')` thrown from `IdempotencyInterceptor.intercept`. The interceptor's constructor depends on `Reflector` and `IdempotencyService` by type, not by `@Inject(token)`, so it relies on the TypeScript compiler emitting `Reflect.metadata('design:paramtypes', ...)` for Nest's DI to know what to pass.

Inspecting the bundle confirmed the cause: zero `__metadata` calls anywhere in `dist/main.js`. esbuild does not implement `emitDecoratorMetadata` (the project's own documentation now states this explicitly). Classes that wire their dependencies through explicit `@Inject(TOKEN)` decorators on constructor params keep working in the bundle because those `Inject` calls are emitted as decorator metadata; classes that rely on the constructor parameter types alone do not.

## Decision

**Run every `.ts` file through TypeScript's `transpileModule` before esbuild bundles it.** The build defines a small inline esbuild plugin that intercepts `.ts` loads, calls `ts.transpileModule` with `experimentalDecorators` and `emitDecoratorMetadata` on (and `module: ESNext` so the output stays compatible with esbuild's ESM bundling), and returns the emitted JS to esbuild for bundling. The plugin lives next to `build.mjs` so the build keeps reading as one file; the only new runtime dependency is `typescript`, which the repo already needs for `tsc --noEmit`.

**Add a bundle smoke test** (`apps/api/src/bundle.db.test.ts`) that runs `node build.mjs`, spawns `node dist/main.js` against real Postgres and Redis containers, and round-trips a `GET /healthz`. `bootstrap.db.test.ts` exercises the TS source through `Test.createTestingModule`, which does not catch problems that only appear in the bundle (the missing metadata being the obvious one). The bundle smoke test is the only place that does.

## Options considered

**`esbuild-plugin-tsc` and `@anatine/esbuild-decorators`.** Both implement essentially the same loader shape this ADR commits to. The published plugins defaulted to CJS output, which then collided with esbuild's ESM bundling (`exports is not defined in ES module scope` at runtime), and overriding their compiler options from the outside did not stick. A 20-line inline plugin under the project's own control was clearer than fighting the published ones' defaults.

**Switch to SWC for the api compile step.** SWC supports decorator metadata natively. Rejected for the same reason ADR-0009 rejected tsc project references: the api compile is one piece of a monorepo build that includes Vitest, the web app, and dev tooling, and adding SWC as a second compiler increases drift between what the build emits and what tsx runs in development.

**Make every Nest-managed class explicit with `@Inject(ClassName)` on each constructor param.** Two lines per class. Rejected because it is patchwork: every future class that forgets the explicit `@Inject` re-introduces the bug, and the bundle smoke test would catch it only after merge. Emitting metadata at the build level is one decision that protects the whole codebase.

**Replace ADR-0009 entirely.** Considered. The architecture (esbuild bundle, workspace packages inlined, real npm deps external) was right; the specific claim about how decorator metadata gets emitted was wrong. A new ADR that refines the implementation detail is more honest than rewriting history.

## Consequences

The build picks up a `typescript` dev dependency on the api package and an inline plugin in `build.mjs`. Build time grows by a small amount (TypeScript transpiles each file before esbuild bundles); the api build still finishes well under a second on a developer laptop and inside CI's budget.

The bundle smoke test is the canonical regression for "the build artifact actually runs as a deploy artifact." Future bundle-only regressions (a banner that breaks, a plugin update that drops metadata again, an external that should not be external) fail in CI rather than at deploy time. The test takes roughly one Postgres plus one Redis container plus one spawned Node process; expensive but the only honest test for what ships.

One known limit: the inline plugin processes each file with `transpileModule`, which has no project-wide view. Cross-file type-only oddities (re-exports of types as if they were values, isolated-modules violations) surface as esbuild warnings in the build output. The current codebase has none that fail the build; we will revisit if the warning list grows beyond what is reasonable to ignore.
