# 0001. Monorepo layout

## Status

Accepted, 2026-05-14.

## Context

Vellum will have at minimum a Next.js frontend and a NestJS API that share types and domain logic (ledger invariants, transaction shapes, extraction result types). Splitting them into separate repos would mean copy-pasting types, two separate CI pipelines, and version drift between them. A single repo with a workspace tool keeps them in lockstep without the operational cost of multi-repo.

Options considered:

- **Single package, both apps under `src/`.** Rejected because Next.js and NestJS have incompatible build setups (different module resolution, different decorators behavior, different dev servers).
- **Multi-repo with a shared types package published to a private registry.** Rejected as overkill for a project this size and stage.
- **pnpm workspaces.** Picked.
- **Nx or Turborepo on top of pnpm workspaces.** Considered for build caching later. Premature for current size; we add it if cold builds get painful.

## Decision

Single repository, pnpm workspaces. Layout:

```
apps/
  web/          Next.js 14 frontend
  api/          NestJS backend
packages/
  core/         Domain logic (ledger invariants, shared types) used by web and api
  extraction/   AI extraction pipeline (Zod schemas, prompts, model adapters)
```

Dependency rules:

1. Apps depend on packages. Packages do not depend on apps.
2. Packages do not depend on each other unless explicitly justified in code review.
3. `packages/core` has zero runtime dependencies beyond `zod` and standard types.

## Consequences

A single `pnpm install` brings everything up. TypeScript project references can wire incremental compilation across packages when we feel the need. If a package needs to be open-sourced separately later (extraction is a plausible candidate), the boundary discipline above lets us lift it out cleanly. No build tool yet beyond `tsc`; if cold builds get slow we revisit and consider Turborepo. Apps not yet created in this PR; layout is enforced by convention until `apps/*` directories exist.
