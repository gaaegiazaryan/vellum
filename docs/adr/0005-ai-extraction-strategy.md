# 0005. AI extraction strategy

## Status

Accepted, 2026-05-19.

## Context

Vellum's name is "AI bookkeeper". The differentiator over "bookkeeper with auth" is that an uploaded receipt or invoice gets turned into a structured journal entry without manual data entry. Several decisions had to land before code could be written:

- **Where extraction lives in the codebase.** Inside the API service vs in a separate package vs as a separate process.
- **Which vision model.** Anthropic Claude, OpenAI GPT-4o-class, Google Gemini, or self-hosted.
- **Cost tracking model.** Per-call, per-month, per-user, per-request-batch.
- **Failure model.** What happens when the provider times out, returns garbage, refuses, or charges more than budgeted.
- **Audit and replay.** Can a future bug fix re-run a year's worth of extractions against a new model, and how does the application prove what was extracted from what.

These choices interact. The wrong shape locks in pain that compounds over thousands of extracted receipts.

## Decision

**A separate `packages/extraction` workspace** owns the schemas, provider abstraction, and concrete provider implementations. The application (`apps/api`) imports the abstract `ExtractionProvider` and constructs a concrete one at wiring time. This keeps the dependency on `@anthropic-ai/sdk` and any future provider SDKs out of the API's main runtime path, and lets the extraction code be tested in isolation.

**Anthropic Claude Sonnet is the primary model.** OpenAI is a planned fallback that lands when a real failure case shows up. Default model is `claude-sonnet-4-5-20251022`; haiku and opus rates are in the pricing table for future per-receipt selection (cheap model first, expensive on retry when confidence is low).

**Cost is a first-class part of the provider contract.** Every `ExtractionResult` carries a `CostBreakdown { inputTokens, outputTokens, estimatedUsd }`. The estimate is in a decimal string, not a float, because we accumulate these across thousands of calls and float arithmetic on money is wrong. The pricing table lives in code; historical results stay pinned to their captured cost.

**Confidence is provider-projected from `stop_reason`,** not a real model score. The application thresholds it. Receipts above the threshold auto-confirm into the ledger; receipts below go to a human-review queue.

**Failure surfaces are named errors.** `UnreadableImageError`, `ProviderTimeoutError`, `InvalidProviderResponseError`, `BudgetExceededError`. Application code routes each to a specific response: retry, surface to user, drop and log.

**Audit log persists the hash of the raw model response,** not the response itself. The full response goes to object storage under the same hash. Audit row stays small; full response stays replayable.

**Prompt is versioned in code.** `PROMPT_VERSION = '2026-05-19.v1'`. Every change to the system prompt is a commit. Every extraction logs the version it ran against. Bug fixes a year later can diff prompt versions and decide which receipts to re-run.

## Options considered

**Self-hosted vision model.** Open-source vision LLMs (Qwen2-VL, Llama 3.2 Vision) are getting good. Self-hosting kills the per-call cost and the data-leaves-the-building concern. Rejected for v1: operational weight (GPU host, model serving, scaling), and the accuracy gap on irregular receipt layouts is still wide enough that we would feed the failures back through a hosted model anyway. Revisit when we have a corpus of failures to fine-tune against.

**Single provider with no abstraction.** Saves ~150 lines of interface and `MockProvider` plumbing. Rejected because the application then either makes real API calls in tests (cost + flakiness + secrets) or mocks the SDK directly at every call site. The abstraction earns its keep on the first test, not later.

**Cost tracking as a side-channel log.** Some teams write `provider.cost.usd` to a metrics sink and call it done. Rejected because that decouples cost from the result it belongs to. Per-receipt cost in the audit log is the right granularity for "this user's bill" and "this model is too expensive on this kind of receipt".

**Confidence as a real 0..1 model score.** Models do not return one. Some return logprobs that can be massaged into a score; that variation across providers makes a stable application-level threshold harder. Projecting `stop_reason` is a deliberate simplification; we replace it with a richer signal when we have data on where it misleads us.

**Persisting raw responses in the database.** Rejected for size reasons. Vision API responses for a typical receipt are 1-5 KB but multi-page invoices can be 20+ KB; over a year, that bloats the DB row size and slows the audit-log scan paths. Hash in DB, raw response in object storage indexed by hash, fetched only when investigating.

## Consequences

The extraction code is reviewable in isolation: `pnpm test packages/extraction` runs the unit suite against `MockProvider` and a fake Anthropic client in under a second. No API keys, no network, no flakiness.

Adding a second provider is cheap: implement `ExtractionProvider`, ship it, application wires it as the primary or fallback. The application-level routing layer (cheap-first-then-expensive, primary-then-fallback) is a separate concern that does not require provider changes.

Cost is impossible to ignore. Every result includes the cost; budget enforcement is a wrapper that adds up costs against a limit and throws `BudgetExceededError`. We will not silently spend $100 a day on extraction because no-one was looking.

Audit-log replay is possible. With prompt version, model id, response hash, and the input image stored, we can re-run any extraction against a newer prompt or model and diff the result. This is how we improve accuracy over time without losing the data we already have.

Two things we accept as known limits:

- **Confidence projection is crude.** When we have enough data to know where it misleads us, we replace it with a real signal.
- **PDF handling is deferred.** PNG/JPEG/WebP only at runtime. PDF needs a separate content block in the Anthropic SDK and an upstream chunking strategy for multi-page invoices. Not blocking v1.
