-- Partial unique index on bank_transactions.journal_entry_id per ADR-0019:
-- one journal entry can be claimed by at most one bank transaction.
-- Without this constraint, two browser tabs could pair the same entry
-- concurrently and produce two matched rows; with it the second insert
-- fails with 23505, which the matching controller maps to a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "bank_transactions_journal_entry_id_unique_idx"
  ON "bank_transactions" ("journal_entry_id")
  WHERE "journal_entry_id" IS NOT NULL;
