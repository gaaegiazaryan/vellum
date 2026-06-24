-- Add the FK on bank_transactions.journal_entry_id that ADR-0019 specified
-- but the schema PR (#121) omitted. The Drizzle schema cannot express this
-- across files (plaid.ts vs ledger.ts) without a circular import; the
-- cross-file FK pattern is to add it in raw SQL here. The audit on #128
-- flagged the missing referential integrity; this closes that item.
--
-- ON DELETE SET NULL is the right choice. Journal entries are append-only
-- in normal flow, but a future operator-deletes-by-mistake path should
-- leave the bank transaction orphaned in the unmatched pool rather than
-- cascading the bank import away. The matched_at column is left intact;
-- the unpair flow nulls it explicitly when the user does this on purpose.
ALTER TABLE "bank_transactions"
  ADD CONSTRAINT "bank_transactions_journal_entry_id_fk"
  FOREIGN KEY ("journal_entry_id")
  REFERENCES "journal_entries"("id")
  ON DELETE SET NULL;
