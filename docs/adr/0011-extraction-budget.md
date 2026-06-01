# 0011. Daily budget cap on extraction spend

## Status

Accepted, 2026-06-01.

## Context

Every extraction logs its model cost as `cost_estimated_usd` on the `extractions` row (ADR-0005, Day 8). The logging is already an invariant of the project ("Не игнорировать стоимость AI вызовов" in CLAUDE.md). What is missing is enforcement. A runaway worker, a misbehaving client, or a user who uploads ten thousand receipts in a loop can rack up a real bill before anyone notices, and the current code path will happily call the provider for every one.

A self-hostable bookkeeper aimed at freelancers and small teams cannot ship a feature where one client can drain the operator's wallet. The provider's own quota limits eventually fire, but they fire after a lot of money, with no friendly error message at the application layer, and the operator only finds out from a billing alert. A budget that lives in our code is the right place for the cap.

## Decision

**A daily USD cap, scoped to the whole api process, enforced at two points.** `EXTRACTION_DAILY_BUDGET_USD` is an env var. When unset, no enforcement runs and the current behaviour stays unchanged. When set to a positive decimal string, the api refuses to start new extractions once the day's cumulative `cost_estimated_usd` reaches the cap.

**Today is UTC midnight to UTC midnight.** Timezone-aware budgets need per-user configuration we are not going to add for v1. UTC keeps the rule trivial to compute and to reason about during an incident at 02:00 wherever the operator happens to live.

**Check at enqueue and again in the worker.** Enqueue is the cheap, client-facing check: `POST /extractions` returns 429 with a `Retry-After` for the next UTC midnight when the budget is already gone, so the client never gets a fake `202` for a job that will only be cancelled. The worker re-checks immediately before calling the provider so a long queue cannot quietly slip past the cap built up while jobs were in flight.

**HTTP 429 with `Retry-After`.** Semantically the budget is a rate limit, not a server error. The body carries `error: 'budget_exceeded'`, the cap in USD, the current spend, and the reset time, so a client logging the error can show the operator what is going on without guessing.

**Postgres is the source of truth.** `SELECT sum(cost_estimated_usd)` over today's rows is one indexed range scan; for the order of magnitude of receipts a self-hoster runs, this is fast enough. Redis caching is a follow-up if the query ever shows up in a flame graph.

**Mock provider extractions are counted at zero.** `cost_estimated_usd` is already `0` for `MockProvider`; the budget sum is correct without a special case.

## Options considered

**Per-user budgets.** Right for a multi-tenant SaaS, wrong for self-hosted where the operator and the user are usually the same person. A per-user cap also moves the configuration into the database, which we do not need yet.

**Hourly buckets.** Tighter cap but trades a clean ruleset for one that needs an explicit story about clock skew and DST. Daily is the granularity an operator picks naturally ("I am ok spending up to X per day on this").

**Budget at the worker only.** Lets the user enqueue then sees the job fail. Worse UX for the caller and more work for the worker, which still has to do the check.

**Budget at the queue only.** Cannot prevent a long queue from draining the budget. Combining both checks makes neither expensive.

**A Redis-backed counter that the worker updates as it spends.** Faster than the Postgres sum, but introduces a second source of truth that has to stay consistent with the database. v1 keeps Postgres as the only source; Redis becomes the cache later if needed.

## Consequences

Operators get a one-line setting that puts a hard ceiling on AI cost. The default (no setting) preserves current behaviour, so existing deploys do not have to think about it. Adding the cap is opt-in and trivially reversible.

`POST /extractions` may now return 429 with `error: 'budget_exceeded'`. Clients (web upload, future CLI) should translate that into a friendly message. The reset time in the body is the simple version of `Retry-After` that a typical client can show without parsing HTTP headers.

The worker can throw `BudgetExceededError` mid-stream. The existing failure-handling path persists a `failed` row with the error code, so the audit trail records exactly what happened. The error is non-retryable (retry would just hit the cap again until midnight).

Three known limits:

- **No per-user breakdown.** The cap is system-wide. A heavy user can starve a light user. The fix is per-user caps, which is a follow-up after we have a multi-tenant story.
- **No cost prediction.** The check uses already-spent dollars, not predicted next-call cost. A user can start a job that pushes the day over the cap by, say, 30 cents. Acceptable: the daily total stays close to the cap, never far above.
- **UTC only.** Mentioned above; timezone-aware is per-user config, deferred.
