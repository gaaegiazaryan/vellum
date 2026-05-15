# @vellum/web

Vellum's web app. Next.js 15 on the App Router, React 19. Lives in the monorepo at `apps/web`.

## Stack

- Next.js 15, App Router, React Server Components by default
- React 19
- `@vellum/core` as a workspace dependency for shared domain types
- Plain CSS for now; a design system (Tailwind 4 or shadcn) is a later decision when the landing turns into a real UI
- TypeScript with its own `tsconfig.json` (bundler resolution, `jsx: preserve`, paths alias `@/*`)

## Local

```bash
pnpm install                          # from repo root
pnpm --filter @vellum/web dev         # http://localhost:3000
pnpm --filter @vellum/web build       # production build
pnpm --filter @vellum/web typecheck   # standalone tsc, also reached by root pnpm typecheck
```

## Notes

- Bumped from the originally planned Next.js 14 to 15. 14 is from October 2023 and now over a year old. 15 has stable RSC, the typed-routes flag enabled in `next.config.ts`, and React 19 by default. The cost of the bump is lowest at the skeleton stage and rises after we have screens.
- `tsconfig.json` does not extend the root base. Next needs `moduleResolution: bundler` and JSX preserve; the root base uses NodeNext (right for the Node-side packages). Each side owns its own settings.
- No tests in this PR. Adding Playwright or Vitest+React Testing Library is the next step once there are routes worth asserting against.
