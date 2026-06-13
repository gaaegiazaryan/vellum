# 0015. Provider fallback strategy

## Status

Accepted, 2026-06-13.

## Context

ADR-0005 picked Anthropic Claude vision as the primary extraction provider and named OpenAI as a fallback "for the day Claude is down". A year into the project the day Claude is down has not happened often, but it has happened, and the v1 behaviour on that day is bad: every extraction in flight fails with `InvalidProviderResponseError`, the budget records the input-token cost on the failed rows, and the operator has no recourse but to wait for upstream to recover.

The roadmap promised an OpenAI fallback. This ADR settles the design questions before the implementation lands: when does the fallback kick in, who decides, what does the audit trail look like when two providers were involved in one extraction, and how does the budget cap account for the doubled cost.

## Decision

**Two providers, one router, primary-first with a single fallback hop.** The api keeps a "primary" provider (the one named by `EXTRACTION_PROVIDER`) and an optional "secondary" provider (named by a new `EXTRACTION_FALLBACK_PROVIDER`). On every extraction the router calls the primary; if and only if the primary throws a retryable infrastructure error, the router immediately tries the secondary. A non-retryable error (unreadable image, schema mismatch, budget exceeded) is final on the primary attempt; the secondary is not invoked because the receipt itself is the problem, not the provider.

**Retryable means: the primary did not produce a usable response for a reason that has a chance of being different on the secondary.** That is `ProviderTimeoutError` and `InvalidProviderResponseError` per the existing taxonomy. Validation failures (`UnreadableImageError`, schema mismatch on the parsed receipt, `BudgetExceededError`) tell us the request itself is bad; sending it to a second provider just doubles the cost without doubling the chance of success.

**One fallback hop. No N-tier rotation.** Beyond N=2 the user experience and the audit trail both get tangled (which provider's confidence do we record? whose model name?). If a second fallback ever earns its keep, that is a separate ADR; v1 is the simpler shape.

**Both attempts are billed and accounted.** The primary's cost row is logged regardless of outcome (the tokens were sent, the provider charged us). When the secondary then succeeds, its cost is added to the same `extractions` row's `cost_estimated_usd` and `cost_input_tokens` / `cost_output_tokens` counters. The audit trail captures both: `provider` and `model` are the secondary's (the response that produced the receipt), but a new `fallback_from_provider` column records the primary's name and a new `fallback_reason` column records the error class that triggered the hop. ADR-0005's audit-integrity invariant ("never mutate the captured receipt") still holds.

**Predicted-cost gating runs against the worst case.** ADR-0011 known limit #2 was closed by `predictedMaxCostUsd` (#92). The router's predicted cost for budget purposes is `primary.predictedMaxCostUsd() + secondary.predictedMaxCostUsd()` so the cap cannot be tipped by the fallback path silently. Mocks contribute zero so the dev path keeps its current behaviour.

**Fallback runs in the worker, not the request handler.** The HTTP boundary stays single-attempt to keep the `POST /extractions` response time bounded. The worker is where retry policy already lives (BullMQ attempts: 3 with exponential backoff per ADR-0007); the fallback fits naturally as a second attempt inside one job. The first BullMQ attempt is the primary; if that throws a retryable error, the worker tries the secondary before letting BullMQ count it as a failure.

**The secondary is configured exactly like the primary.** `EXTRACTION_FALLBACK_PROVIDER=openai` requires `OPENAI_API_KEY` per the same env-refine pattern. When the env var is unset, the router has no secondary and behaves exactly as it does today (single-attempt). Self-host operators who only want one provider get the v1 path; those who want resilience opt in with one env line.

## Options considered

**Retry the primary three times before falling back.** Reasonable in a noisy network, but the existing BullMQ retry already covers transient noise (backoff: exponential, 3 attempts). Layering a manual retry-then-fallback on top means a single broken provider eats nine API calls (3 attempts x 3 BullMQ retries) before the secondary sees the request. Rejected; the fallback is the retry.

**Race both providers in parallel and take the first response.** Faster perceived latency on a healthy day but doubles every receipt's cost and tokens, even when the primary succeeded. A self-hostable bookkeeper aimed at freelancers does not want the bill that comes from a second always-on vision API. Rejected.

**A separate `fallback_extractions` table mirroring the primary attempt.** Cleaner audit story (one row per provider call) but means every downstream read has to know about the two-table shape, and a confirmed extraction still has to choose which row is "the" receipt. Putting the two cost columns onto the existing row and adding the two audit columns is the smaller change. Save the separate-table shape for an event-sourced rewrite if we ever do one.

**Let the provider decide if its error is retryable by exposing `isRetryable()` on the provider interface.** Tempting but couples the routing policy to the provider implementation; the router would have to trust the provider's classification even when the operator wants to override it (e.g., a known-bad provider whose timeouts are not worth retrying via the secondary). The error taxonomy already lives in `@vellum/extraction/errors.ts` (`ProviderTimeoutError`, `InvalidProviderResponseError`); the router uses that as its decision rule.

**OpenAI as primary, Anthropic as secondary.** Symmetric, future versions can pick. ADR-0005's reasoning (Claude vision strict-JSON behaviour) still stands as the default. The env knob lets operators choose; the ADR's default does not.

## Consequences

`@vellum/extraction` gets an `OpenAIProvider` class implementing the same `ExtractionProvider` interface (constructor takes apiKey + model, `extract()` returns the same `ExtractionResult` shape, `predictedMaxCostUsd()` returns OpenAI's own per-call upper bound). The Anthropic-style strict-JSON prompt is reused; OpenAI's vision API accepts the same image-block + text-block content shape with a different SDK call.

The api gets a `ProviderRouter` (or just `RoutedProvider implements ExtractionProvider`) that wraps `(primary, secondary?)`. It is constructed in `ExtractionsModule.forRoot` from the two env-selected providers. The existing call site (`ExtractionsService.runExtraction` / the worker) does not change shape: it still calls `this.provider.extract(...)` once. The complexity stays inside the router.

Two new DB columns on `extractions`:

- `fallback_from_provider text` - null on the happy path, the primary's name when the secondary produced the response
- `fallback_reason text` - null on the happy path, the error class that caused the hop

A new migration adds them; the existing rows backfill to null. No downtime needed (NULLABLE columns, default NULL).

Three known limits, in order of how much they will hurt:

- **No partial fallback for a multi-part receipt.** v1 sends the whole receipt to the secondary; if the primary partially succeeded and only one tax line came back garbled, the whole receipt is reprocessed. Acceptable because the receipt is the unit of extraction; this only stops being acceptable if a single receipt with twenty line items becomes common.
- **The secondary's confidence is taken at face value.** A fall-back path that happens to land an OpenAI response with low confidence still posts as `needs_review` exactly like a primary-only path. No cross-provider confidence calibration; that is a research project.
- **The router has no health-check.** A consistently-failing primary still gets every first attempt, even when the operator could see in `/budget/today` that 100% of calls today have hit the fallback. A future ADR adds a sliding-window failure-rate cutoff; for now the operator notices via logs and switches `EXTRACTION_PROVIDER` to the secondary manually.
