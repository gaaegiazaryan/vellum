-- Deferred constraint trigger enforcing the double-entry invariant at the
-- database level: per journal_entry, sum(debits) = sum(credits) and a single
-- currency across all lines.
--
-- Single-row CHECKs added in 0001_cold_anthem.sql already enforce per-line
-- invariants (amount > 0, currency format). This trigger covers the
-- cross-row invariant that no per-row CHECK can express.
--
-- Fires on ledger_lines INSERT/UPDATE/DELETE. DEFERRABLE INITIALLY DEFERRED
-- means the check runs at COMMIT, so a multi-row transaction that ends up
-- balanced is accepted even if individual statements transiently leave
-- the entry unbalanced. A single bad commit fails the whole transaction.

CREATE OR REPLACE FUNCTION journal_entry_balance_check() RETURNS TRIGGER AS $$
DECLARE
  entry_id text;
  debit_total bigint;
  credit_total bigint;
  currency_count int;
BEGIN
  entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  SELECT
    COALESCE(SUM(CASE WHEN side = 'DEBIT' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN side = 'CREDIT' THEN amount ELSE 0 END), 0)
  INTO debit_total, credit_total
  FROM ledger_lines
  WHERE journal_entry_id = entry_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal_entry % is unbalanced: debits=% credits=%',
      entry_id, debit_total, credit_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- Same currency across all lines of an entry.  Belongs here rather than as
  -- a column CHECK because the constraint is across rows.
  SELECT COUNT(DISTINCT je.currency) INTO currency_count
  FROM journal_entries je
  WHERE je.id = entry_id;

  IF currency_count > 1 THEN
    RAISE EXCEPTION 'journal_entry % has mixed currencies', entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balance_check();
