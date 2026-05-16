import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Idempotency keys for mutating HTTP endpoints. The client sends an
 * `Idempotency-Key` header on POST/PATCH/DELETE; the server reads the
 * row keyed by (key, route_path, method) and:
 *
 * - if absent, processes the request, then stores the response under
 *   the key with the request body hash
 * - if present and the request hash matches, returns the cached
 *   response without re-running the handler
 * - if present and the request hash differs, rejects with 409 to
 *   prevent silently overwriting a different intent under the same key
 *
 * The middleware that enforces this lands in a follow-up PR; this PR
 * only ships the table so migrations stay in sequence.
 *
 * Rows expire on `expires_at`; a partial index keeps cleanup cheap.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    userId: text('user_id'),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_idx').on(table.key, table.method, table.path),
    index('idempotency_keys_expires_unexpired_idx')
      .on(table.expiresAt)
      .where(sql`${table.responseStatus} is null`),
  ],
);
