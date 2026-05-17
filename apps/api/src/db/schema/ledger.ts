import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * No cross-file import for users.id; drizzle-kit's CJS loader does not
 * resolve NodeNext .js extensions across schema files. The created_by_id
 * column stays a plain text reference here; the actual FK to users(id) is
 * added in the migration SQL by hand. Lossless: drizzle-orm queries still
 * compose; only the introspected relation graph is missing the link, which
 * does not affect the typed query builder we use.
 */

export const accountTypeEnum = pgEnum('account_type', [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
]);

export const ledgerSideEnum = pgEnum('ledger_side', ['DEBIT', 'CREDIT']);

/**
 * Chart of accounts. Codes are user-facing identifiers (e.g. 1000 for cash);
 * IDs are stable surrogate keys used by foreign keys.
 * parent_id forms a tree (one root per type by convention; not enforced in
 * the schema because alternative chart layouts exist).
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    parentId: text('parent_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'restrict',
    }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounts_code_idx').on(table.code),
    index('accounts_parent_idx').on(table.parentId),
  ],
);

/**
 * A single business event. All lines under one entry share a currency.
 * Cross-currency operations are modelled as two entries linked by an FX
 * transfer entry, not as mixed lines.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    description: text('description').notNull(),
    currency: text('currency').notNull(),
    createdById: text('created_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('journal_entries_occurred_idx').on(table.occurredAt),
    check('journal_entries_currency_format', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('journal_entries_description_nonempty', sql`length(${table.description}) > 0`),
  ],
);

/**
 * Lines of a journal entry. Amount is the integer minor unit in the entry's
 * currency. Sign is carried by `side`, not by the amount: a single-row CHECK
 * enforces amount > 0.
 *
 * The cross-row invariant (sum of debits = sum of credits per entry) is not
 * expressible as a single-row CHECK. A deferred constraint trigger lands in
 * a follow-up PR alongside the Testcontainers integration test that proves
 * it actually fires; without that test the trigger would be theatre.
 */
export const ledgerLines = pgTable(
  'ledger_lines',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    side: ledgerSideEnum('side').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    memo: text('memo'),
    position: integer('position').notNull(),
  },
  (table) => [
    check('ledger_lines_amount_positive', sql`${table.amount} > 0`),
    uniqueIndex('ledger_lines_entry_position_idx').on(table.journalEntryId, table.position),
    index('ledger_lines_account_idx').on(table.accountId),
  ],
);
