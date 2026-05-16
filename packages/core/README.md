# @vellum/core

Domain primitives shared between the Vellum API and web app. Lives inside the monorepo, not published to npm.

## What's here

- `Money` with bigint minor units and currency-safe arithmetic
- `Currency` as a branded 3-letter ISO 4217 code
- `Account`, `AccountType` (ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE), `Side` (DEBIT / CREDIT)
- `JournalEntry`, `LedgerLine`
- `assertBalanced(entry)` and `netBalance(lines)` for the double-entry invariant
- `normalBalanceFor(type)` returns the side on which an account's balance increases
- `CURRENCIES` registry plus `decimalsFor`, `formatMinorUnits`, `parseMajorUnits` for per-currency precision (USD = 2, JPY = 0, BHD = 3, etc.)
- Zod schemas for every shape; parsing produces typed domain objects with `Money` instances inside
- Domain errors (`InvalidCurrencyError`, `CurrencyMismatchError`, `EntryTooSmallError`, `MixedCurrencyEntryError`, `UnbalancedEntryError`, `NegativeLedgerAmountError`) for caller pattern matching

## Conventions

- Amounts are integer minor units of their currency. Use `formatMinorUnits` / `parseMajorUnits` from the currencies module to convert at the UI or API boundary; the per-currency decimal count comes from the `CURRENCIES` registry.
- A ledger line's `amount` is non-negative. Sign comes from `side`.
- `Money.toJSON()` serializes `amount` as a string so bigint round-trips through JSON.

## Example

```ts
import { Money, currency, assertBalanced, type JournalEntry } from '@vellum/core';

const USD = currency('USD');

const entry: JournalEntry = {
  id: 'je_invoice_42',
  occurredAt: new Date(),
  description: 'invoice #42 paid',
  lines: [
    { accountId: 'cash', side: 'DEBIT', amount: new Money(1500n, USD) },
    { accountId: 'revenue', side: 'CREDIT', amount: new Money(1500n, USD) },
  ],
};

assertBalanced(entry); // throws if the invariant fails
```

## Tests

Run from the repo root: `pnpm test packages/core`.
