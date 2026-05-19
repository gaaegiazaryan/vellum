# @vellum/extraction

AI extraction pipeline: schemas and provider abstraction for turning receipts and invoices into structured ledger-ready data. Lives inside the monorepo, not published to npm.

## What's here today

- `Receipt` and `LineItem` Zod schemas — the canonical structured shape we expect a vision LLM to return.
- `receiptTotalMismatch(receipt)` helper — vision models miscount; this returns the disagreement so callers can flag receipts for human review instead of silently accepting wrong numbers.

## What's coming

- `ExtractionProvider` interface and `MockProvider` for downstream development without API costs.
- `AnthropicProvider` and `OpenAIProvider` against the real vision APIs.
- Cost tracking: every call logs input/output tokens and computed USD cost. Cheap model first, expensive on retry when confidence is low.
- Audit log: model name, prompt version, request id, user id, raw response hash, all persisted so a future bug fix can re-run extractions over historical data.

## Conventions

- Money fields are minor units as strings. `BigInt(receipt.totalMinor)` round-trips through `@vellum/core`'s `Money`.
- Currency is the same 3-letter ISO 4217 code used everywhere else.
- The schema does NOT enforce `subtotal + tax === total`. Vision models miscount. Use `receiptTotalMismatch` to flag mismatches downstream instead of rejecting them at parse time.
- Quantity is a finite positive decimal because real receipts have "2.5 kg" or "1.25 hours".

## Tests

Run from the repo root: `pnpm test packages/extraction`.
