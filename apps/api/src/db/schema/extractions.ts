import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * One row per AI extraction attempt against an uploaded receipt.
 *
 * The receipt itself is stored as jsonb so the application can pull
 * it back without re-running the model. The hash of the model's raw
 * response is stored separately so a future replay against a newer
 * model can be tied back to the input that produced the captured
 * receipt (the raw response lives in object storage under the same
 * hash; out of scope for this PR).
 *
 * status discriminates between pending (created but not yet run),
 * succeeded (model returned, schema validated), failed (provider or
 * parse error; receipt is null), needs_review (succeeded but confidence
 * below the application threshold; the human queue picks it up).
 *
 * cost_input_tokens / cost_output_tokens / cost_estimated_usd are the
 * per-call price as captured at extraction time. They never get
 * recomputed; a future rate change does not retroactively change
 * historical accounting.
 *
 * No FK from created_by_id to users.id in the Drizzle schema (same
 * cross-file-schema workaround as elsewhere); migration SQL adds it
 * by hand.
 */

export const extractionStatusEnum = pgEnum('extraction_status', [
  'pending',
  'succeeded',
  'failed',
  'needs_review',
]);

export const extractions = pgTable(
  'extractions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    uploadId: text('upload_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    requestHash: text('request_hash').notNull(),
    responseHash: text('response_hash'),
    costInputTokens: integer('cost_input_tokens').notNull().default(0),
    costOutputTokens: integer('cost_output_tokens').notNull().default(0),
    costEstimatedUsd: numeric('cost_estimated_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    status: extractionStatusEnum('status').notNull().default('pending'),
    receipt: jsonb('receipt'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdById: text('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    journalEntryId: text('journal_entry_id'),
    confirmedById: text('confirmed_by_id'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('extractions_upload_idx').on(table.uploadId),
    index('extractions_created_by_idx').on(table.createdById),
    index('extractions_status_idx').on(table.status),
    index('extractions_journal_entry_idx').on(table.journalEntryId),
    // Partial composite index for /accounts/suggest: the query filters
    // by (created_by_id, journal_entry_id is not null) before grouping
    // by ledger lines. As confirmed history grows, this is the hot
    // path; a partial index keeps it smaller than a plain composite
    // would by excluding the never-confirmed rows that dominate the
    // table for users mid-onboarding.
    index('extractions_created_by_confirmed_idx')
      .on(table.createdById)
      .where(sql`${table.journalEntryId} is not null`),
  ],
);

// Re-export bigint so callers do not need to remember which schema
// file it lives in.
export { bigint };
