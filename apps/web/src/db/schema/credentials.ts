import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './auth';

/**
 * Password credentials kept out of the Auth.js standard users table so
 * the @auth/drizzle-adapter contract stays clean. One row per user that
 * has a password set; OAuth-only users have no row here.
 *
 * Hashes are Argon2id encoded strings. Encoding the algorithm + params
 * inside the hash string is the documented Argon2 PHC pattern; lets us
 * change parameters in the future without a column-level migration.
 */
export const userCredentials = pgTable('user_credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  passwordSetAt: timestamp('password_set_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});
