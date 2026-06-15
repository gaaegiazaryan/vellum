# 0017. Multi-line journal entry from a single receipt

## Status

Accepted, 2026-06-15.

## Context

The confirm flow shipped in ADR-0006 turns a receipt into a two-line journal entry: one debit to the chosen expense account, one credit to the chosen payment account, both for the receipt's total. That was the right v1 because it covered the common case (a single-category receipt paid with a single instrument) without forcing the reviewer to think about taxes.

A year of usage notes that the two-line shape is wrong for two common receipts:

- **A receipt with separately-stated tax.** A $11 invoice = $10 software + $1 VAT should post as two debits ($10 to Software, $1 to VAT Receivable) and one credit ($11 to Card). Booking the $11 as a single Software debit overstates the expense and hides the tax claim entirely.
- **A receipt that mixes categories.** A grocery run buys $20 of office supplies and $30 of personal items charged to the wrong card; the personal half belongs to a different account, not "Meals" by force of the single-account picker.

The vision extractor already captures the receipt's structure (`subtotalMinor`, `taxes: [{ name, amountMinor }]`, `lineItems: [...]`). The ledger schema already allows N >= 2 lines per entry with the deferred-trigger invariant from ADR-0001. The gap is exactly the confirm endpoint and the review UI: both still assume the two-line shape.

This ADR settles the contract for the upgrade. Question worth fixing in writing: what does the confirm wire payload look like, how is backward compatibility maintained for clients that still send the two-line shape, what shape does the audit trail take when a tax claim is later corrected, and how does the budget cap interact with split entries (it does not, but worth stating).

## Decision

**Confirm accepts an optional `lines` array; the existing single-account body keeps working.** A request that includes `{ debitAccountId, creditAccountId, totalMinor }` produces the existing two-line entry. A request that includes `{ lines: [{ side, accountId, amountMinor, memo? }, ...], creditAccountId }` (or `{ lines: [...] }` directly with both sides) produces an N-line entry. Either body validates the same invariant: sum of debit amounts equals sum of credit amounts, currency is single per entry, every account exists and belongs to the user. The two paths share a single posting function; the two-line body is just a sugar form that the controller expands into the N-line form before validation.

**Tax breakdown is the typical path, not a special case.** The reviewer sees one row per `taxes[]` entry from the extracted receipt, each pre-filled with the parsed `amountMinor` and an account picker that defaults to a suggested "VAT Receivable" / "Sales Tax Payable" / similar. The subtotal becomes the first debit row, suggested via the existing vendor->account suggestion (ADR-0013). The credit side stays a single row by default; a power user can split that too (rare).

**Single currency per entry. Period.** ADR-0006's third known limit stays. A receipt in EUR posts as a single-currency EUR entry; converting to the books' base currency is an explicit FX-transfer entry, not part of this flow. The split applies within one entry, not across currencies.

**Audit integrity holds.** The stored `receipt` jsonb is never mutated, per ADR-0005. The reviewer's split lives on the journal entry, and the gap between the extracted shape and the entry's lines is the record of what the human chose. A later correction edits the entry, not the receipt; the receipt remembers what the model saw.

**Account suggestion runs on each row independently.** The vendor->account suggestion (ADR-0013) returns one debit candidate today. For the multi-line confirm, the suggestion runs per category (per `taxes[]` row, per `lineItems[].category` if present), reusing the same vendor name but scoped by the extra context. When no per-row signal exists, the row falls back to the empty picker.

**Budget cap is per receipt, not per line.** The receipt's total is still what hit the AI cost ceiling at extraction time; the split into N lines is bookkeeping, not new AI work. ADR-0011 and ADR-0014 do not need to change.

## Options considered

**Make the two-line shape a legacy mode and force the array on every client.** Cleaner contract but breaks every existing client (the web's confirm form, any future scripted poster) on rollout. Rejected; the sugar form is one if-branch in the controller and zero burden on the typical caller who only needs the simple shape.

**Split into N separate entries instead of N lines on one entry.** Pro: each tax line has its own posting date, each subtotal line has its own audit trail. Con: a single receipt is one business event; splitting into N entries loses that grouping and breaks the obvious "this confirm produced this entry" link. The ledger model is built around one-entry-per-event; lean on it. Rejected.

**Expose tax computations as a derived ledger line, computed at read time from the receipt's `taxes[]`.** Pro: no extra columns, the source of truth stays the receipt. Con: a downstream report that filters by account misses the tax line entirely (it's not in `ledger_lines`). Tax is a real account movement, not a presentation concern. Rejected.

**A separate `receipt_lines` mapping table.** Pro: rich per-line metadata (which `taxes[]` row produced which ledger line). Con: every read path now has to know about a second join. The ledger lines themselves already carry the right info in `memo`; using a short, structured memo (`vat:standard:eu`, `subtotal`, etc.) keeps the data model flat. Rejected.

**Auto-confirm a tax breakdown without the human picking accounts.** A vendor suggestion plus the receipt's parsed taxes is often enough to predict every account. Acceptable for a future ADR once we have data on per-vendor account stability, but not v1; CLAUDE.md anti-pattern #2 says no auto-confirm without human review and that includes implicit auto-confirm of a multi-line shape. Rejected.

## Consequences

`ExtractionsService.confirm` grows one method (or one branch) that accepts either body shape and converts the sugar form to the array before posting. The posting function (the existing inner of confirm) becomes "post N balanced lines"; the two-line case is just `N = 2`. The deferred-trigger invariant catches any unbalanced submission at the database level (defense in depth on top of the application validation).

A new schema validator in `apps/api/src/extractions/extractions.controller.ts` accepts either body. The Zod union resolves to a single internal shape after parsing; the rest of the service does not have to know which form arrived on the wire.

The web confirm form (`apps/web/src/app/app/extractions/[id]/confirm-form.tsx`) grows the row-add affordance: a "+ split" button under the existing single-debit picker that turns the debit side into a small table with subtotal + per-tax rows. Sum-of-debits is computed live and the submit button is disabled until it matches the credit side's amount. The single-account form remains visually unchanged for receipts that don't need a split.

Three known limits, in order of how much they will hurt:

- **No automatic per-tax account mapping.** v1 still asks the human to pick the VAT Receivable / Sales Tax Payable account on each row. A follow-up ADR adds "remember this vendor's tax accounts" once enough confirms accumulate, mirroring the ADR-0013 pattern.
- **No support for one receipt producing multiple journal entries.** A receipt that mixes business and personal items still posts as one entry; the personal half just lands in a different account. Splitting across entries (one business, one personal) is a separate concern about source-of-truth ownership.
- **No retroactive split of existing two-line entries.** A user who confirmed a $11 receipt as a single Software debit last month cannot click "expand into tax breakdown" today; they correct the entry through the normal manual-edit path. The split affordance applies to new confirms only.

Impl PRs follow this one.
