import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users, accounts, sessions, verificationTokens } from '@/db/schema/auth';
import { userCredentials } from '@/db/schema/credentials';
import { verifyPassword } from '@/auth/password';

/**
 * Auth.js v5 configuration with Credentials provider backed by Argon2id.
 *
 * Trust trade-offs (per ADR-0003):
 * - Session strategy is JWT. Cookie is the source of truth; API trusts
 *   the same cookie via shared AUTH_SECRET.
 * - Drizzle adapter wires OAuth account links and verification tokens
 *   (DB-backed) alongside the stateless JWT sessions.
 * - 7-day absolute lifetime, 30-minute sliding renewal.
 *
 * The Credentials provider's authorize() runs in the Node.js runtime
 * (not the edge), so Argon2 native bindings are available.
 */

const credentialsInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const authConfig = {
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60, updateAge: 30 * 60 },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsInputSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const db = getDb();
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            passwordHash: userCredentials.passwordHash,
          })
          .from(users)
          .innerJoin(userCredentials, eq(userCredentials.userId, users.id))
          .where(eq(users.email, email))
          .limit(1);

        const row = rows[0];
        if (!row) return null;

        const ok = await verifyPassword(password, row.passwordHash);
        if (!ok) return null;

        return { id: row.id, email: row.email, name: row.name ?? undefined };
      },
    }),
  ],
  pages: { signIn: '/signin' },
  trustHost: true,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
