import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Plaid integration tables per ADR-0018. Three-table model mirrors
 * Plaid's own item-account-transaction shape so the cursor-based
 * transactions/sync writes one row instead of unpacking a join.
 *
 * No FKs to accounts.id (ledger account) or users.id at the Drizzle
 * level because of the same cross-file-schema workaround the rest
 * of the codebase uses; the migration SQL adds the FK on
 * plaid_accounts.ledger_account_id -> accounts.id.
 */

/**
 * One row per Plaid "item" (one bank login). Holds the long-lived
 * access_token (encrypted at rest, ADR-0018) and the cursor that
 * /transactions/sync advances. last_sync_at is the read side of the
 * "is this item due for a sync" check the worker makes.
 *
 * status mirrors what Plaid sends on item webhooks (ITEM_LOGIN_
 * REQUIRED, PENDING_EXPIRATION, etc.) so the operator can see why a
 * sync stopped without consulting Plaid's dashboard. v1 keeps it as
 * an opaque text column; a future ADR pins the enum if more than a
 * handful of values land in production.
 */
export const plaidItems = pgTable(
  'plaid_items',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text('user_id').notNull(),
    plaidItemId: text('plaid_item_id').notNull(),
    accessTokenCipher: text('access_token_cipher').notNull(),
    accessTokenIv: text('access_token_iv').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name'),
    status: text('status').notNull().default('ok'),
    lastSyncCursor: text('last_sync_cursor'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('plaid_items_plaid_item_id_idx').on(table.plaidItemId),
    index('plaid_items_user_idx').on(table.userId),
    index('plaid_items_last_sync_idx').on(table.lastSyncAt),
  ],
);

/**
 * One row per Plaid sub-account (checking, savings, credit card).
 * mask is the last-4 of the account number; the full PAN is never
 * fetched from Plaid in the first place (CLAUDE.md anti-pattern #1).
 *
 * ledger_account_id is the optional bridge to the Vellum ledger
 * chart of accounts. Set by the operator after the Plaid Link flow
 * via a "map this Card to account 2200-Credit Card" choice. The
 * matching ADR uses this to know which account the bank side of a
 * confirmed receipt should land in.
 */
export const plaidAccounts = pgTable(
  'plaid_accounts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    plaidItemId: text('plaid_item_id')
      .notNull()
      .references(() => plaidItems.id, { onDelete: 'cascade' }),
    plaidAccountId: text('plaid_account_id').notNull(),
    name: text('name').notNull(),
    officialName: text('official_name'),
    type: text('type').notNull(),
    subtype: text('subtype'),
    mask: text('mask'),
    currency: text('currency').notNull(),
    currentBalanceMinor: bigint('current_balance_minor', { mode: 'bigint' }),
    ledgerAccountId: text('ledger_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('plaid_accounts_plaid_account_id_idx').on(table.plaidAccountId),
    index('plaid_accounts_item_idx').on(table.plaidItemId),
    index('plaid_accounts_ledger_account_idx').on(table.ledgerAccountId),
  ],
);

/**
 * Imported bank transactions. occurred_at is the posting date (or
 * authorized date if posting is unavailable, matching Plaid's own
 * field semantics). amount_minor is the absolute value; the
 * direction lives implicitly in the Plaid amount sign which the
 * import normalizes via raw_jsonb. Storing the raw response leaves
 * room for the matching ADR to use fields not yet surfaced (mcc,
 * category[], counterparties[]).
 *
 * journal_entry_id and matched_at are null on import per ADR-0018
 * (no auto-create-journal-entry rule). The matching flow fills
 * both atomically.
 *
 * plaid_transaction_id is unique because /transactions/sync delivers
 * stable ids across syncs; a re-emitted transaction overwrites rather
 * than duplicates.
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    plaidAccountId: text('plaid_account_id')
      .notNull()
      .references(() => plaidAccounts.id, { onDelete: 'cascade' }),
    plaidTransactionId: text('plaid_transaction_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    merchantName: text('merchant_name'),
    description: text('description'),
    raw: jsonb('raw').notNull(),
    journalEntryId: text('journal_entry_id'),
    matchedAt: timestamp('matched_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bank_transactions_plaid_transaction_id_idx').on(table.plaidTransactionId),
    index('bank_transactions_account_idx').on(table.plaidAccountId),
    index('bank_transactions_occurred_idx').on(table.occurredAt),
    // Partial index covering the "show me unmatched bank rows" path the
    // matching ADR will use as its hot read.
    index('bank_transactions_unmatched_idx')
      .on(table.plaidAccountId)
      .where(sql`${table.journalEntryId} is null`),
    // Partial unique index per ADR-0019: one journal entry can be claimed
    // by at most one bank transaction. Without it, two browser tabs could
    // pair the same entry concurrently; the unique constraint stops that
    // at the DB layer rather than via app-level check-then-update.
    uniqueIndex('bank_transactions_journal_entry_id_unique_idx')
      .on(table.journalEntryId)
      .where(sql`${table.journalEntryId} is not null`),
  ],
);
