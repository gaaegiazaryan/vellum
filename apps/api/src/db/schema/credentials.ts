import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Password credentials kept out of the Auth.js standard users table so
 * the @auth/drizzle-adapter contract stays clean. One row per user that
 * has a password set; OAuth-only users have no row here.
 *
 * Mirrors apps/web/src/db/schema/credentials.ts. The web app owns the
 * actual provider that writes here (signup / Credentials provider in
 * Auth.js); apps/api includes the same schema so its Drizzle queries
 * stay typed. The right long-term home is a packages/db extraction;
 * tracked.
 *
 * The FK to users(id) is added in the migration SQL by hand because
 * drizzle-kit's CJS loader does not resolve NodeNext .js extensions
 * across schema files (same workaround as in ledger.ts).
 */
export const userCredentials = pgTable('user_credentials', {
  userId: text('user_id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  passwordSetAt: timestamp('password_set_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});
