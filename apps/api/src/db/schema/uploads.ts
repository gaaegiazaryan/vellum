import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Uploaded receipt or invoice file. The actual bytes live in object
 * storage (filesystem in v1, S3-compatible in production); this row
 * is the durable handle and the index for the audit log.
 *
 * storage_key is opaque to the database: it could be a filesystem
 * path, an S3 key, or anything else the UploadsService understands.
 * The schema does not parse it.
 *
 * sha256 is the hash of the file bytes, hex-encoded. Useful for
 * deduplication (same receipt uploaded twice) and for tying the
 * extraction audit log to the input that produced it. Indexed for
 * the dedupe lookup.
 *
 * size_bytes is bigint because PDFs of multi-page invoices can run
 * tens of megabytes; we do not want to lose the upper bits.
 *
 * No FK from created_by_id to users.id in the Drizzle schema (same
 * drizzle-kit cross-file-schema workaround as elsewhere); the
 * migration SQL adds it manually.
 */
export const uploads = pgTable(
  'uploads',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    sha256: text('sha256').notNull(),
    createdById: text('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('uploads_sha256_idx').on(table.sha256),
    index('uploads_created_by_idx').on(table.createdById),
  ],
);
