# 0019. Matching bank transactions to journal entries

## Status

Accepted, 2026-06-23.

## Context

ADR-0018 lands bank transactions in their own table with `journal_entry_id` nullable. A receipt confirm posts a journal entry. The reconciliation loop is closed when the two are linked: the user sees which journal entries have a matching bank row and which do not, and the bank statement is no longer a separate document the user reads with their finger.

Today the user has to do the cross-check by hand. The 80% case is a freelancer with one or two cards, ten to thirty transactions a week, a receipt for most of them. Reading down a bank statement, ticking off receipts, is the work this whole project exists to remove.

Question worth fixing in writing before any code: what counts as a "match", who triggers the link, what signals does the suggester use, what is the unhappy path when the system gets it wrong, what is explicitly deferred.

## Decision

**One-to-one match in v1.** One `bank_transactions` row links to at most one `journal_entries` row, and vice versa. Multi-tx-one-entry (split bill across two cards) and one-tx-multi-entry (combined Costco receipt that posts to several expense accounts) exist in real life and matter, but they are 20% of the cases and ten times the design surface. The matching ADR-0020 picks them up; v1 covers the 80% well.

**Match is an explicit user confirm, never automatic.** CLAUDE.md anti-pattern #2 stays in force: nothing posts or links without a human submit. The system surfaces ranked candidates; the user picks. Auto-link above some confidence threshold is tempting and will be revisited only after we have a measured accuracy number on real user data, which we cannot have before we ship the manual flow.

**Two entry points, one underlying operation:**

- **From the confirm-receipt UI.** When the user confirms an extraction, the review form shows up to three unmatched `bank_transactions` ranked by combined score. If one is the right one, the user clicks it before clicking confirm and the link is written in the same request that creates the journal entry.
- **From `/app/banks`.** Each unmatched `bank_transactions` row shows a "pair with entry" button. Clicking opens a small list of recent unmatched `journal_entries` ranked the same way. The user picks one or dismisses.

Both paths land in the same `MatchingService.pair(userId, journalEntryId, bankTransactionId)` operation. One UPDATE inside a tx that sets `journal_entry_id` and `matched_at` on the bank row, with a `WHERE journal_entry_id IS NULL` guard so a concurrent claim by another tab does not silently overwrite.

**Scoring is deterministic, no model.** Three signals combined linearly:

- **Amount.** Exact minor-unit match = 1.0. Within ±1¢ (rounding from major-unit conversion) = 0.9. Beyond that the score is 0; the user can still see the candidate but it will not be ranked.
- **Date.** Same day = 1.0. ±1 day = 0.8. ±3 days = 0.4. ±7 days = 0.1. Beyond = 0. Asymmetric: a receipt usually predates the posted bank charge by up to two days, so the future-bias is fine.
- **Vendor / merchant name.** Trim + lowercase equality of `receipt.vendor.name` against `bank_transactions.merchant_name` = 1.0. Containment either direction = 0.7. First-token equality after stripping punctuation = 0.3. Else 0.

Combined score = `0.5 * amount + 0.35 * date + 0.15 * vendor`. Surface only candidates with combined ≥ 0.5; show at most top three. Amount carries the most weight because for a real reconciliation a wrong amount is almost always a wrong match; vendor names are noisy because Plaid's `merchant_name` is often `AMAZON DIGITAL` while the receipt says `Amazon`.

The exact weights are a starting point. The deferred categorisation-override ADR mentioned in ADR-0018 ("Plaid returns a `category` array") becomes another signal here when it lands; the weight table is in code, not in the schema, so reweighting is one diff.

**Unique enforcement at the DB layer.** A partial unique index `bank_transactions_journal_entry_id_unique_idx` ON `(journal_entry_id) WHERE journal_entry_id IS NOT NULL`. Without it a concurrent pair operation on the same `journal_entry_id` from two browser tabs would happily produce two matched rows; with it the second one fails on insert with a 409, which the controller maps to a clear "already paired" error.

**Unmatch is an explicit operation.** `MatchingService.unpair(userId, bankTransactionId)` nulls both fields. The bank row returns to the suggestion pool. The journal entry stays; unmatch never deletes anything. v1 has no audit log of pair/unpair events; the auditability ADR-0021 covers that.

**Suggestion query is the hot read.** Two endpoints:

- `GET /matching/suggest-for-entry/:journalEntryId` returns top-3 unmatched bank rows ranked by score. Backs the confirm-receipt UI.
- `GET /matching/suggest-for-bank/:bankTransactionId` returns top-3 unmatched journal entries ranked the same way. Backs the `/app/banks` pair button.

Both paginate within the user's own data (`WHERE user_id = ...` derived from joining through `plaid_accounts -> plaid_items` for bank rows and direct on `journal_entries` for entries). The partial index `bank_transactions_unmatched_idx` from #121 was already sized for this read; the entry side uses the existing `journal_entries_user_idx`.

## Options considered

**Auto-link above a confidence threshold.** Tempting. Rejected for v1 because (a) CLAUDE.md anti-pattern #2 makes it a hard line, (b) we have no measured accuracy number to set the threshold against, (c) the failure mode (a wrong auto-link the user does not notice until reconciliation a month later) is worse than the alternative (one extra click). Revisited after the manual flow has produced a labeled dataset.

**ML scoring.** Considered for vendor similarity (real merchant strings are noisy: `AMAZON DIGITAL`, `AMZ*MARKETPL`, `TST* CAFE DU MONDE`). Rejected for v1: a deterministic substring/token matcher is good enough on the 80% case, model serving adds infra and cost (ADR-0011 budget cap), and a normalization table covers most of the long tail when it grows. The deferred fuzzy vendor ADR (Day 16 next-action #5) addresses this directly.

**Match at sync time.** The PlaidSyncWorker could attempt matches as it writes new bank rows. Rejected because it bypasses the human-in-the-loop moment; the user has to see the suggestion to learn whether it was right. Async background suggestion writes also fight the partial unique index when the same bank row is offered to two distinct entries.

**Many-to-many in v1.** Splits and combined receipts genuinely happen. Rejected for v1 because they multiply both the data model (a `match_links` join table with proportional `amount_minor` per side) and the UX (the user has to manually split a `bank_transactions.amount_minor` of $147 across two journal entries of $99 and $48). The data we have today does not even let us tell whether a user actually wants this; v1 measures the demand, ADR-0020 satisfies it.

**Score the bank row against the whole entry, not just the payment side.** A journal entry has N >= 2 ledger lines; the bank charge corresponds to one of them (the payment account). For v1 we score against the entry's total + occurred_at, because that maps to the bank charge directly. The richer ledger structure is preserved; nothing on the entry side changes.

**Make the suggest endpoint POST instead of GET.** The arguments are short (one id, scoped by user via session). GET stays cacheable in the browser if we ever want to cache, and it matches the existing `/accounts/suggest` shape from ADR-0013.

**Store the score on the matched row.** Rejected because it ages: a re-score after a weight change would not back-propagate. The score is a UI/ranking concern, not a record-keeping one.

## Consequences

A new `MatchingModule` (api) registers `MatchingService` and a `MatchingController` exposing the two suggest endpoints, a `POST /matching/pair` for the link, and a `DELETE /matching/pair/:bankTransactionId` for the unmatch. All four behind `AuthGuard`. The two suggest endpoints are cheap; pair and unpair are tx-bounded UPDATEs.

A migration adds the partial unique index on `bank_transactions.journal_entry_id`. The matched_at column is already there from #121; no schema change for the columns themselves.

The confirm-receipt UI grows a small "Matching bank row" section above the submit button. The `/app/banks` page grows a "pair" affordance per unmatched row that opens an inline picker. Both UI changes are additive; the existing flows stay if the user ignores the new sections.

A new env knob is not introduced. Matching is on whenever a user has both unmatched bank rows and unmatched journal entries; nothing to configure.

Three known limits, in order of how much they will hurt:

- **Single-currency match only.** A USD receipt matches against a USD bank charge; FX-converted charges (a EUR receipt paid by USD card) fall outside the v1 scorer. The FX matching ADR picks this up; in the meantime the user pairs manually via the bank page.
- **No multi-tx splits.** ADR-0020 above; v1 punts.
- **Vendor name signal is noisy.** The 0.15 weight reflects this; the fuzzy vendor ADR will sharpen it. v1 still beats manual reconciliation because the amount + date signal carries most of the discrimination.

Impl PRs follow this one: migration + partial unique index, then MatchingService + endpoints + db tests, then the two web touch-points (confirm-receipt pair suggestion, `/app/banks` pair button).
