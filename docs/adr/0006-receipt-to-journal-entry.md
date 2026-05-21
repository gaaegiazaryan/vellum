# 0006. Receipt to journal entry mapping

## Status

Accepted, 2026-05-20.

## Context

ADR-0005 took an uploaded receipt as far as a structured `Receipt` object stored as jsonb on an `extractions` row. That is half the product. The other half is turning that object into a balanced double-entry that lands in the ledger, because a bookkeeper's output is journal entries, not parsed JSON.

A `Receipt` is not a journal entry and the gap is not cosmetic:

- A receipt has a vendor, a date, a currency, a total, a list of line items, and some taxes. It has no notion of accounts. A journal entry is two or more ledger lines that reference accounts and balance to zero.
- Nothing in the receipt says which expense account the spend belongs to, or which asset/liability account paid for it. That mapping is a bookkeeping judgement, not data present in the image.
- The `subtotal + tax === total` relationship is not enforced on the receipt (ADR-0005: vision models miscount, we surface rather than reject). An entry built from a receipt has to pick one authoritative amount.

So the open questions: how many lines does a receipt become, who chooses the accounts, what happens to taxes and per-item detail, and how does the confirm operation stay correct under retries.

## Decision

**A receipt becomes a single two-line entry in v1.** Debit one expense account for the full `totalMinor`, credit one payment account (an asset like cash/bank, or a liability like a credit card) for the same amount. Two lines, one currency, equal amounts. The entry balances by construction.

**The human picks both accounts at confirm time.** The `POST /extractions/:id/confirm` body carries `debitAccountId` and `creditAccountId`. There is no vendor-to-account auto-mapping in v1; we have no learned mapping and no data to build one from. The review screen shows the parsed receipt and asks the one question the image cannot answer: which two accounts.

**No auto-confirm. Ever, in v1.** This reaffirms the project invariant and supersedes ADR-0005's "receipts above the threshold auto-confirm into the ledger" for the v1 timeline. Confidence affects how a receipt is presented in the review queue (low-confidence rows are flagged, sorted up, shown with the total-mismatch warning), never whether it posts without a human. Auto-confirm returns only after we have an eval dataset and a measured error rate.

**Taxes fold into the total in v1.** The entry uses `totalMinor` as the single amount; the per-tax breakdown stays on the receipt jsonb for the audit trail but does not become its own ledger line. Splitting recoverable input tax (VAT/GST reclaim) into a tax-receivable line is jurisdiction-specific and premature before we know which jurisdictions we serve.

**Line-item detail stays on the receipt, not the entry.** A grocery receipt with twelve items becomes one expense line, not twelve. The items remain queryable on the jsonb. Per-item or per-category splitting is a later feature that needs category suggestion to avoid asking the user twelve account questions per receipt.

**Confirm is one atomic transaction.** The journal-entry insert (entry + two lines) and the extraction-to-entry link (`journal_entry_id`, `confirmed_at`, `confirmed_by_id`) happen inside a single database transaction. Balance is guaranteed by construction and the existing per-entry balance trigger is the backstop, so the application does not re-run `assertBalanced` for this path. A second confirm on an already-linked extraction is rejected before any insert, so a client retry cannot produce a duplicate entry.

**Entry metadata derives from the receipt.** `occurredAt` is the receipt date, `currency` is the receipt currency, and `description` defaults to the vendor name. The confirm body may override the description; everything else comes from the parsed receipt.

## Options considered

**Per-line-item split.** Map every receipt line item to its own ledger line and account. Rejected for v1: the receipt carries no account per item, so an N-item receipt becomes N account questions at review time, which is slower than the manual entry it replaces. The right version of this needs category auto-suggestion (learned vendor + description to account), which needs data we do not have yet.

**Auto-map vendor to account.** Remember that "Blue Bottle" last went to "Meals & Coffee" and pre-fill it. Rejected for v1 only because there is no history to learn from on day one; the confirm contract already takes explicit account ids, so a suggestion layer can sit in front of it later without an API change.

**Separate tax line.** Debit expense for the subtotal, debit a tax-receivable asset for the tax, credit payment for the total. Correct for VAT-registered businesses reclaiming input tax, wrong or noise for everyone else, and the rules differ per country. Rejected for v1 as jurisdiction-specific scope that would block a generally-useful feature on a specialised one.

**Two client calls instead of one endpoint.** Have the web app fetch the extraction, build the entry payload, `POST /journal-entries`, then separately mark the extraction confirmed. Rejected on correctness: the two writes are not atomic, so a crash between them orphans an entry and leaves the extraction unconfirmed, and the retry creates a second entry. A single server-side endpoint in one transaction removes the window.

## Consequences

The end-to-end loop closes: upload a receipt, the model extracts it, a human picks two accounts and confirms, and a balanced journal entry exists in the ledger linked back to the extraction that produced it. The extraction row records who confirmed it and when, which is the audit trail the glossary calls for.

Confirm is idempotent in the way that matters: an extraction can be confirmed once. Re-posting the same confirm is a no-op error, not a duplicate entry.

The mapping is deliberately coarse. A confirmed entry is a single expense against a single payment source for the receipt total. That is the correct granularity for a freelancer expensing a coffee or a software subscription, which is the v1 user. It is too coarse for inventory accounting or split-tax reclaim, and those are explicitly out of scope until there is a user asking for them.

Three things we accept as known limits:

- **No edit-before-confirm.** v1 confirms the extracted total as-is. If the model misread the total, the user confirms then edits the resulting journal entry through the normal entry path. An inline correction step on the review screen is a follow-up.
- **No category intelligence.** Every confirm is two manual account picks. The suggestion layer that makes this one click is the next thing worth building once confirmations accumulate into training signal.
- **Single-currency per entry.** A receipt in a foreign currency becomes an entry in that currency; converting to the books' base currency is the existing FX-transfer-entry concern from the ledger schema, not solved here.
