# 0014. Per-user budget cap layered on top of the system cap

## Status

Accepted, 2026-06-12.

## Context

ADR-0011 shipped a single system-wide daily USD cap on extraction spend. That was the right v1: one knob, one operator, one bill. The known limit at the top of that ADR's list said per-user enforcement would land "in a follow-up ADR" when there was a real reason. That reason is now visible.

A self-hosted Vellum used by exactly one person is still the dominant case. But the moment a freelancer invites their accountant or a two-person studio shares the deploy, the system-wide cap stops being useful: a single careless upload loop by one user will block the other from doing real work for the rest of the UTC day. The fix is to keep the system cap (because the operator still cares about a wallet ceiling) and add a per-user cap underneath it.

The interesting parts are how the two caps compose, what happens when only one is configured, and whether per-user changes the response shape on the wire.

## Decision

**Two caps, both optional, both enforced.** `EXTRACTION_DAILY_BUDGET_USD` keeps its existing meaning (system-wide ceiling). A new `EXTRACTION_DAILY_BUDGET_PER_USER_USD` adds an optional cap on each user's own daily spend. A request is allowed only if it would not breach either cap. Unset = no enforcement for that scope, exactly like the existing variable.

**Per-user enforcement is the same shape as the system one.** Both checks query `SELECT sum(cost_estimated_usd)` over today's rows; the per-user one adds a `WHERE created_by_id = $1` predicate. Same UTC-day window, same `cost_estimated_usd` source of truth, same enqueue + worker double-check, same `429` response code. There is no second mechanism to reason about during an incident.

**The 429 body says which cap was hit.** A new `scope` field on the response object is either `"system"` or `"user"`. The current body shape stays valid (the `error`, `limitUsd`, `spentUsd`, `resetAt` fields keep their meaning); `scope` is added next to them. A client that does not know about `scope` keeps working. A client that does know can render an honest message ("you have used $20 of your $20 daily budget; ask the operator to raise it").

**Per-user spend is scoped to confirmed AND attempted extractions, not just succeeded.** A user who burns budget on a model run that returns a parse error still spent the tokens; the row already has `cost_estimated_usd` and that is what `SUM` reads. Failed-by-budget rows (where the budget itself blocked the call) keep their `cost_estimated_usd = 0` because the provider was never called. The math stays right without a special case.

**When both caps are set, the user cap is the inner one.** Check user first because it is cheaper to surface "your personal cap" than to surface "the system is full" if the user is themselves the cause. When system is hit and the user has plenty of personal headroom, the system message is correct. The order of the two SQL queries is independent (they can run in parallel) but the response chooses the user message when both are over.

**Per-user opt-in stays simple.** No per-user override in the database, no admin UI to set Alice's cap to twice Bob's. v1 is one number that applies to every user.

## Options considered

**Per-user only, drop the system cap.** Simpler in code (one query) but loses the operator's wallet ceiling: ten users at the per-user cap collectively spend ten times the cap. Rejected; the system cap is the existence-of-budget guarantee.

**Per-user in the database, configurable per user.** A `users.daily_budget_usd` column with a NULL fallback to env. Right for a SaaS. Wrong for v1 self-hosted because the audience does not have a UI to set it. Save for whenever an admin surface exists.

**Per-user check only in the worker, not at enqueue.** Cheaper at enqueue (no extra SQL), but the request would silently produce a job that the worker will fail. The user sees `pending` then `failed` and has to guess why. Symmetry with the existing system cap (which is checked at both points for exactly this reason) keeps the failure mode legible.

**Track per-user spend in Redis instead of querying Postgres.** Avoids the SQL hit per request. But adds a second source of truth, drift risk on worker crashes between provider-call and Redis-increment, and a TTL key per user. The Postgres scan over one day of one user's extractions is bounded and indexed; not a bottleneck at the volume self-hosted Vellum is designed for.

**Hourly buckets, sliding window, weekly cap.** All defensible, none load-bearing for the target audience. Daily UTC matches ADR-0011 and keeps the rule trivial; any of the others can stack on top in a future ADR if the data starts asking.

## Consequences

`BudgetService` grows one method (`spentTodayByUser(userId)`) and one constructor input (`perUserLimitUsd` resolved from env at module init). The check site at enqueue and in the worker calls both `withinSystemBudget()` and `withinUserBudget(userId)`; the throw type carries the new `scope` so the HTTP layer can serialise it.

The wire response gets one new field. Adding a field to a JSON body is backward-compatible; the existing `BudgetExceededError` -> 429 path keeps working for any client built before this change.

`docs/deploying.md` documents the new env var and the new `scope` field on the 429 response. The existing `EXTRACTION_DAILY_BUDGET_USD` row gets a one-line note that the system cap is still the global ceiling.

Three known limits, in order of how much they will hurt:

- **One per-user number, not per-user-and-per-day or per-tier.** A power user and a casual user share the same cap. A future ADR introduces per-row overrides if a real operator asks for them; until then the env var is the contract.
- **Mock extractions cost $0 and therefore never block.** Consistent with ADR-0011; called out here so a tester running mock-only does not wonder why their cap is not firing.
- **`scope: "user"` does not name which user.** The operator can correlate by reading audit logs (`extractions.created_by_id` filtered to today and ordered by created_at). The 429 body deliberately does not echo the user id back to the client; that would be an information leak if the response were ever logged centrally without auth scrubbing.
