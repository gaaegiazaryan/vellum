import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Schema for Auth.js v5 with the Drizzle adapter. Column names and types
 * match the adapter's expectations so it can read and write these tables
 * without a custom mapping layer.
 *
 * This file mirrors apps/api/src/db/schema/auth.ts on purpose: both apps
 * share the same database, both need typed access to the same tables,
 * but apps cannot import from each other in the monorepo. The right
 * long-term home is a packages/db extraction; tracked as a follow-up.
 * If you change one of these files, change the other in the same PR.
 */

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name'),
    email: text('email').notNull(),
    emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

export const accounts = pgTable(
  'auth_accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    primaryKey({ name: 'auth_accounts_pk', columns: [table.provider, table.providerAccountId] }),
  ],
);

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'verification_tokens_pk',
      columns: [table.identifier, table.token],
    }),
  ],
);
