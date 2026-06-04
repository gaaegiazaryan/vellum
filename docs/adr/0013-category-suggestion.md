# 0013. Vendor-to-account suggestion at confirm time

## Status

Accepted, 2026-06-04.

## Context

ADR-0006 left a known limit at the top of the list: every confirm asks the human to pick the expense account and the payment account. For a freelancer expensing the same coffee shop every Tuesday, that picker is the same two choices every Tuesday, and the friction adds up. The data to fix this already lives in the database. Every confirmed extraction left behind a journal entry that points to one debit account and one credit account, plus the vendor name that lived on the parsed receipt. After ten confirms with "Blue Bottle" going to "5000 Meals & Coffee", the right pre-fill for the next one is obvious.

The interesting parts are which scope the suggestion ranges over, how ties break, what happens on day one when there is no history, and how the suggestion ends up on the UI without scope-creeping into a full categorization product.

## Decision

**Suggest from the user's own confirmed history, scoped to the vendor name on the receipt jsonb.** A query that groups by `(created_by_id, receipt->>vendor->>name, debit_account_id)` over `extractions` joined to `journal_entries` returns one count per (vendor, account) pair for the current user. The most-frequent account wins, and the suggestion is that account.

The same query runs for the credit side; both suggestions can come back. In practice the debit (expense) side varies by vendor and the credit (payment source) side varies by user habit (their default credit card), so both deserve a suggestion path even though they will often have different ranking shapes.

**One endpoint, `GET /accounts/suggest?vendor=<name>`.** Returns a small JSON: `{ debit: { accountId, count } | null, credit: { accountId, count } | null }`. Null means "no history; the picker stays empty". The endpoint is cheap (one indexed group-by per side) and idempotent; no caching layer in v1.

**Top-1 by count, ties broken by most-recent.** If two accounts tie at three confirms each, the one used in the more recent journal entry wins. This favours the user's current habit over a stale one without storing extra state.

**Vendor matching is case-insensitive exact on the trimmed string.** "Blue Bottle" and "blue bottle" hit the same group; "Blue Bottle Coffee" does not. Fuzzy matching (LIKE, levenshtein, embeddings) is deferred because the first version of any auto-fill has to be predictable; the user has to be able to predict why the pre-fill picked what it picked.

**The web side pre-fills the account picker but never auto-confirms.** The suggestion populates the `<select>` default value when the review page loads. The user still clicks confirm. This is the same invariant CLAUDE.md anti-pattern #2 protects: nothing posts a journal entry without a human submit.

**No bootstrap data.** A fresh deploy has zero confirms, so every suggestion endpoint returns `{ debit: null, credit: null }` and the UI behaves exactly as it does today. Suggestion quality grows with use; there is no seed list of "Starbucks goes here" baked in.

## Options considered

**Global suggestion across all users on the deploy.** Faster cold start, since one team's confirms warm up the next. Rejected: a self-hosted bookkeeper is single-tenant in practice, and even on a deploy with multiple users their charts of accounts can differ (one user's "Software" is another's "5400 Software & Subscriptions"). Scoping by user keeps each chart honest. Falling back to global-when-empty is a future enhancement, not a v1.

**LLM-driven categorization.** The vision model could be prompted to suggest a category, the api could embed vendor names and match nearest-neighbour. Both work. Rejected for v1 because they spend tokens or compute on every suggestion, which makes the budget cap from ADR-0011 fight with itself, and because the "majority vote of your own confirms" baseline is provably correct in a way an LLM suggestion is not.

**Weighted recency (exponential decay).** Recent confirms count more than old ones. Defensible but adds a tuning knob nobody has data to set yet. The simpler "ties broken by recency" rule captures the practical intuition without picking a half-life out of the air. Revisit if the simple rule starts mis-suggesting after a habit change.

**A separate suggestions table.** Precomputed pairs updated on every confirm, served by a single point-lookup. Faster but harder to keep in sync, and the live group-by query is already an indexed scan over tens of confirms per user. Save the table for when the volume justifies it.

**Inline suggestion on POST /extractions itself.** Return the suggestion as part of the extraction row. Rejected because the suggestion belongs to the confirm flow, not the extraction flow; bundling them would force the worker to know about accounts.

## Consequences

The endpoint adds one new method on `AccountsService` (`suggestForVendor(userId, vendor)`) and one new controller route. The review page issues a small request alongside its existing `/accounts` fetch and pre-fills the picker defaults from it. The first time a user lands on a receipt from a new vendor, nothing changes. Every confirm after that nudges the next confirm a little closer to one-click.

A user who changes habit (now puts coffee on a different account) confirms once with the new account, ties have to be broken on the next visit, and the recency tiebreak immediately follows the new habit. No retraining, no admin step.

Three known limits, in order of how much they will hurt:

- **No fuzzy vendor matching.** "Blue Bottle" and "Blue Bottle Coffee" are different groups. A user with inconsistent OCR results sees no suggestion until they confirm enough variants. A future ADR pulls in a normalisation step (lowercase, strip "the", strip legal suffix) once we have a feel for which mismatches actually bite.
- **Suggestion only on debit (expense) and credit (payment) accounts.** The receipt total still goes in as one number; the suggestion does not yet split a multi-category receipt into multiple lines.
- **No way to dismiss a suggestion permanently.** A user who confirmed once by mistake will see that wrong account suggested until they confirm the right one enough times to overtake it. Acceptable; the wrong-account confirm is one click away from "obviously not that one".
