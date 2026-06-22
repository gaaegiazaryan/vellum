# 0018. Plaid sandbox import for bank transactions

## Status

Accepted, 2026-06-22.

## Context

A receipt confirm posts the receipt total against the user's payment account today, but the actual card or bank transaction that paid for it is invisible to the system. The reviewer cross-checks the entries against their bank statement by hand. For a freelancer who runs ten cards across two accounts that is an hour a week of clerical work, exactly the work this project exists to remove.

The roadmap names Plaid sandbox as the next imported source. Real banks come later. Sandbox lets the design ship without any compliance commitments and lets the matching logic (a separate ADR) develop against deterministic fixture data instead of moving production data.

Question worth fixing in writing before any code: where does the Plaid token live, what does the wire shape look like for connecting an account, what is the import cadence, where do the transactions land in the data model, and what is explicitly out of scope so the scope does not creep.

## Decision

**Sandbox first, real-bank later, on the same code path.** The Plaid SDK supports a `sandbox` environment that returns deterministic fixture data via the same endpoints production uses. Code is environment-agnostic; the operator picks which environment via `PLAID_ENV=sandbox|development|production` with the same SDK calls. v1 ships sandbox only; flipping to development for a small private deploy is one env var.

**Three tables: `plaid_items`, `plaid_accounts`, `bank_transactions`.** A "Plaid item" is one bank login, owns N "accounts" (checking, savings, credit card), each of which contains M "transactions". This is the model Plaid itself uses; mirroring it locally avoids translation overhead when the cursor-based transaction sync pulls a delta.

- `plaid_items` (id, user_id, plaid_item_id, encrypted_access_token, institution_name, status, last_sync_at, last_sync_cursor, created_at)
- `plaid_accounts` (id, plaid_item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance_minor, currency, ledger_account_id NULLABLE)
- `bank_transactions` (id, plaid_account_id, plaid_transaction_id UNIQUE, occurred_at, amount_minor, currency, merchant_name, raw_jsonb, journal_entry_id NULLABLE, matched_at NULLABLE, created_at)

The `journal_entry_id` link on `bank_transactions` is what closes the reconciliation loop later. v1 imports leave it null; the matching ADR fills it.

**The access token is encrypted at rest with a key derived from `AUTH_SECRET`.** No new key material in env. The same secret already lives on both web and api per ADR-0003, so deploying a Plaid-enabled instance does not need extra rotation. AES-256-GCM via Node's `crypto.subtle`; the IV stored alongside the ciphertext.

**Three wire endpoints.** All under `/plaid`, all behind `AuthGuard`:

- `POST /plaid/link-token` returns a short-lived Plaid Link token the web app hands to the Plaid Link drop-in. Bound to the requesting user via `client_user_id`.
- `POST /plaid/exchange` takes the `public_token` the Link flow returns, exchanges it for the long-lived `access_token`, encrypts and stores it, fetches the account list, persists `plaid_accounts`.
- `GET /plaid/items` lists the user's connected items + accounts. `DELETE /plaid/items/:id` revokes the access token at Plaid and removes the row (cascade to accounts and transactions).

The transactions endpoint is not a wire endpoint; sync runs in a worker.

**Transaction sync runs on a cron, not on demand.** A worker fires every 15 minutes for every item whose `last_sync_at` is older than 10 minutes. Plaid's `/transactions/sync` is cursor-based: each call returns added/modified/removed sets since the stored cursor; the worker writes those to `bank_transactions` and updates `last_sync_cursor` atomically. A first-time sync after `exchange` runs immediately, not on the cron.

**No raw-bank-account-number storage. PAN/CVV never enter the system.** CLAUDE.md anti-pattern #1 reiterated: Plaid returns tokenized account refs (`account_id`), the public mask (last 4 of account number), and balances. That is all Vellum stores. A `mask` column is just `'1234'`-style; the full PAN is never even read from the Plaid response.

**Sandbox API key in env, never in code.** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` are required when `PLAID_ENABLED=true`. Same env-refine pattern as the existing `EXTRACTION_PROVIDER` knob. When the flag is off the module does not register, so the routes return 404 instead of a Plaid-not-configured 500.

**Per-currency money decisions stay in minor units.** Plaid returns `amount` as a decimal in major units; the import converts to minor units via `@vellum/core` `parseMajorUnits` against the per-account currency at the row's currency, so `bank_transactions.amount_minor` is BigInt-clean for downstream matching.

**Webhook handling is not in v1.** Plaid supports webhooks for new-transaction notifications. The cron-based pull covers the same need at the cost of a 15-minute latency. Webhooks need a public callback URL and a signing secret to verify; a self-hosted operator on a private network cannot use them. The cron is the right v1 default.

## Options considered

**Direct bank scraping.** Insanely fragile; banks rotate auth flows monthly. Rejected even as a fallback.

**CSV import only, no live API.** Comes back for free if the operator opts out of Plaid. Acceptable v0 but does not justify deferring v1 of the live path; the daily ritual the project removes is "download CSV from each bank, import, reconcile" which is precisely what Plaid replaces. Rejected as the only mechanism; planned as a future complement.

**Yodlee or commercial alternatives.** Plaid is the market standard for the US/Canada freelancer audience; pricing and SDK quality are both better at the scale this project targets. The `PLAID_ENV` knob already gives a clean upgrade path if the operator's market needs a different provider in a future ADR.

**Webhooks instead of cron pull.** Right for a production multi-tenant SaaS, wrong for a self-hosted instance behind a NAT. The cron loses 0-15 minutes of freshness but works without any inbound network configuration. A future ADR adds webhook handling as an optional path when the operator can expose a callback.

**Store the access token in plaintext on the row.** Simpler. Rejected because access tokens are persistent (until the user revokes) and grant read access to the user's bank transactions; a database dump leaking plaintext tokens is a much higher-blast-radius event than leaking the rest of the user's bookkeeping data. AES-GCM with the existing `AUTH_SECRET` derivation costs one method on the service layer and zero new operational concerns.

**Use a separate `plaid_link_tokens` table to track Link sessions.** Tokens are short-lived (4 hours) and tied to a single `client_user_id`; persisting them buys nothing over generating fresh on each request. Rejected.

**One big `bank_transactions` table with denormalised item/account fields, no separate `plaid_items`/`plaid_accounts`.** Simpler reads. Rejected because the cursor + status + access-token live on the item, and the balance + currency + mapping-to-ledger-account live on the account; collapsing them produces N copies of the same fields per item. The three-table shape matches Plaid's own model and keeps the cursor write path one row, not many.

**Auto-create a journal entry for every imported transaction.** Tempting because the user "wants" the bank side recorded; rejected because that violates CLAUDE.md anti-pattern #2 ("nothing posts a journal entry without a human submit"). The bank transactions sit in their own table; matching to receipts and posting offsetting entries is a separate explicit-confirm UI in a future ADR.

## Consequences

A new `PlaidModule` (api) registers the three endpoints under `/plaid`, owns the SDK client, and owns the AES-GCM encryptor. A `PlaidSyncWorker` consumes a new BullMQ queue and runs the `/transactions/sync` calls. Three migrations land the tables and indexes.

A new env block in `loadEnv`: `PLAID_ENABLED`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`. Refine: when `PLAID_ENABLED=true`, the three other vars are required. `.env.example` and `deploying.md` document them next to the existing AI provider knobs.

A new `BankTransactionsService` exposes the read paths the matching ADR will need: `listByAccount(accountId, since, until)`, `listUnmatched(userId)`. v1 implements the first; the second lives as a stub method that returns an empty list until matching ships.

The web side gets a `/app/banks` page with a Plaid Link launcher and a list of connected items. The Link drop-in is the official JS SDK; a thin React wrapper component that posts the resulting `public_token` to `/plaid/exchange` covers the lifecycle.

Three known limits, in order of how much they will hurt:

- **No matching to journal entries yet.** Bank transactions land in their own table; the operator can see them but cannot say "this Plaid row is the bank side of that confirmed receipt". The matching ADR closes this; it is the next-after-impl thing worth building.
- **No transaction de-categorisation override.** Plaid returns a `category` array (e.g., `['Food and Drink', 'Restaurants', 'Coffee Shop']`); v1 stores it on the raw_jsonb but does not surface it. The matching ADR uses it as a signal.
- **15-minute freshness window.** Acceptable for a bookkeeping app; the alternative is webhooks which need public inbound, which a self-host typically does not have.

Impl PRs follow this one: schema + migrations, then encryption helper, then the endpoints, then the sync worker, then the web page.
