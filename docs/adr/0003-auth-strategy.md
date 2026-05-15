# 0003. Authentication and session strategy

## Status

Accepted, 2026-05-15.

## Context

Vellum's v1 client surface is browser-only: the Next.js web app talks to the NestJS API over the same origin via cookies. CLI, mobile, and integration clients are scoped out of v1 and will need a separate decision when they land.

Constraints that shaped this choice:

- Self-hostable, AGPL-3.0 project. We will not take a hard dependency on a paid SaaS provider for the auth path.
- Financial data with strict per-user isolation. A compromised session must be containable: short lifetime, server-side revocation possible, no long-lived bearer tokens floating in browser storage.
- Target users may not have OAuth accounts they want to link to their bookkeeping data. Email and password is the primary login flow; OAuth is optional.
- Web and API are both TypeScript in the same monorepo and can share types via `packages/core`.

## Decision

Use Auth.js v5 (`next-auth`) on the web app as the session authority.

- Auth.js owns the user, account, session, and verification token tables. Schema lives in `apps/api/src/db/schema/auth/` so Drizzle migrations include it.
- The Auth.js Drizzle adapter (first-party in the auth.js monorepo) reads and writes these tables.
- Sessions are cookie-based, JWT-encoded with HS256 and a shared secret from env. Cookie lifetime is 30 minutes with sliding renewal; absolute lifetime caps at 7 days.
- The Credentials provider handles email and password with Argon2id hashing. Email verification is required before first sign-in.
- Google OAuth is wired as a second provider, gated by an env flag so self-hosters can disable it.
- The NestJS API validates the same JWT cookie using the shared secret. An `AuthGuard` reads the cookie, verifies the signature, and attaches the user id to the request context. For browser-originated requests this is the only auth path in v1.
- API keys for CLI and integration clients are explicitly out of scope. A separate ADR will cover that when the CLI lands.

## Options considered

**Auth.js v5 (next-auth).** Mature, well-documented for Next.js App Router, first-party Drizzle adapter, large community. The downside is Next.js-centric design: making the NestJS API trust the same session means sharing a signing secret across both processes, which is a real coupling. Picked because the trade is acceptable for v1 and the well-trodden path saves us from auth bugs we cannot afford on financial data.

**Better Auth.** Framework-agnostic, TypeScript-first, has a Drizzle adapter. Strong fit on paper for a monorepo with two different runtimes. Held back because it is young (2024 onwards), the community is smaller, and we want fewer surprises on the most security-sensitive part of the stack. Kept on the watchlist as the upgrade path if Auth.js becomes a limitation.

**Clerk.** Best DX in the category. Rejected: a paid SaaS dependency on the auth critical path conflicts with the self-hostable AGPL positioning of the project. Adding it would change what Vellum is.

**Lucia.** The maintained library was archived in 2024; the author republished the codebase as a learning reference. We borrow session table design from Lucia patterns but do not take it as a dependency.

**Roll our own.** CSRF protection, session rotation, timing-safe comparisons, password reset token handling, email verification, secure cookie flags. Each of these is solvable, but solving them in parallel with the ledger work is the wrong allocation of attention.

**Keycloak, Ory Kratos.** Heavyweight identity servers. Out of proportion for a single-tenant SaaS at this stage; revisit if multi-tenant or SSO requirements arrive.

## Consequences

The web app is the session authority. NestJS trusts cookies issued by Auth.js and does not maintain its own session store. This is simpler than running two session systems and keeps the security surface in one place.

Coupling: the JWT signing secret has to match between Next.js and NestJS. Rotation means deploying both apps in lockstep with a brief overlap window where both old and new secrets are accepted on the API. We accept this for v1; if it becomes painful, asymmetric signing (EdDSA with a published JWKS endpoint from web to api) is the next step and does not require an ADR-level reversal.

Email delivery is now on the critical path. Verification and password reset both require a working SMTP or transactional email provider. We start on Resend's free tier and treat email delivery as a monitored dependency from day one; a failing email pipeline blocks signup entirely.

Cookie-based auth means CSRF protection is mandatory on every mutating endpoint. Auth.js handles this for its own routes; the NestJS API enforces it through a CSRF middleware applied to all `POST/PUT/PATCH/DELETE` handlers that accept cookie auth.

When the CLI or a mobile client arrives, we do not stretch Auth.js cookies to non-browser clients. API-key auth gets its own table, its own ADR, and its own rate-limit story.
