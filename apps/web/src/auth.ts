import NextAuth, { type NextAuthConfig } from 'next-auth';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { getDb } from '@/db/client';
import { users, accounts, sessions, verificationTokens } from '@/db/schema/auth';

/**
 * Auth.js v5 base configuration. This PR wires the adapter and the
 * session strategy; the credentials provider, OAuth providers, and the
 * actual sign-in flow land in PR #34.
 *
 * Trust trade-offs (documented here so a reviewer does not have to dig):
 * - Session strategy is JWT. Sessions are stateless on the server; the
 *   cookie is the source of truth. ADR-0003 picks this over DB sessions
 *   to reduce per-request DB load and to make API trust the same cookie
 *   via shared secret.
 * - The Drizzle adapter is still wired so OAuth account links and
 *   verification tokens persist. JWT strategy plus adapter is a
 *   supported Auth.js pattern.
 * - 30-minute sliding cookie, 7-day absolute lifetime (per ADR-0003).
 */

export const authConfig = {
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60, updateAge: 30 * 60 },
  providers: [],
  pages: { signIn: '/signin' },
  trustHost: true,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
