# 0016. Error response envelope

## Status

Accepted, 2026-06-14.

## Context

The request-id correlation work (#104) added a `requestId` field to every error response body so a user reporting a 500 can quote a token the operator can grep out of the log stream. That change was structural; it now applies to every controller that throws an `HttpException`, including ones that already had their own per-route body shape (`budget_exceeded`, `validation_failed`, `not_confirmable`, and so on).

This ADR settles the contract before more endpoints land. Three questions worth fixing in writing now:

- What is the wire shape clients can rely on?
- Where is the line between "the wire body" and "internal detail that stays in the log"?
- How does the envelope coexist with the existing per-route bodies without forcing every client to special-case the change?

## Decision

**Every non-2xx response is a JSON object with at least `requestId`.** The id always reflects the same value pino logged on the request, the same value the `X-Request-Id` response header carries, and the same value the caller can supply via the request `X-Request-Id` header. Clients that build retry / support flows around the api are entitled to assume `requestId` is present on every error.

**HttpException bodies are merged with `requestId`, not replaced.** A controller that throws `new BadRequestException({ error: 'validation_failed', issues: [...] })` produces a wire body of `{ error: 'validation_failed', issues: [...], requestId: '...' }`. Existing per-route discriminator fields keep their meaning; clients written before #104 keep working because the addition is purely additive.

**Unhandled errors collapse to a single shape:** `{ statusCode: 500, error: 'internal_error', message: 'internal server error', requestId }`. The exception's real class, message, and stack go to the log under the same `requestId`, never to the wire. This is a deliberate information-leak guard: a NestJS controller method that throws `new TypeError("Cannot read properties of undefined (reading 'apiKey')")` would otherwise hand the caller a hint about internal module names and code shape. The 500 stays opaque.

**`error` is the discriminator, `message` is human-readable, `statusCode` is informational only.** Clients should switch on `error` plus the HTTP status code, not on `message`. The set of `error` slugs is documented per route, lives in commit history, and changes via a numbered ADR; the message string is allowed to drift between deploys for prose reasons (i18n later, clarity now).

**One exception filter, registered globally via `APP_FILTER`.** No per-controller overrides. A 500 from anywhere is the same 500. A 4xx from anywhere has `requestId` merged at the same site. Routing this through Nest's filter pipeline rather than per-controller try/catch keeps the discipline central; the existing `BudgetExceededError -> 429` translation in `ExtractionsController.create` is allowed because it converts a domain error into an `HttpException`, which then runs through the global filter.

## Options considered

**A flat envelope around every body.** `{ data?: ..., error?: { code, message, requestId } }`. RFC-7807 problem-details is a related shape. Rejected for v1: the api already returned per-route bodies for the happy path (no wrapper), and a wrapping envelope would force every client to unwrap, including the web app that consumes the same shapes server-side. The cost of an additive change is much smaller than the cost of breaking every existing consumer.

**Put `requestId` only on 5xx.** Saves three bytes on every 4xx body. Rejected because the most common debugging cycle for a self-hosted operator is "a user got a 400, why?" - the 400 is exactly where the support thread needs the correlation token. Symmetry across all error codes also makes the rule trivial to remember.

**Echo the failing exception's class name on the wire.** Clients could discriminate on a structured field, no string matching. Rejected because it pulls internal symbol names into the contract; a refactor that renames `BudgetExceededError` to something else becomes a breaking change for callers. The HTTP status plus the explicit `error` slug already does the discrimination.

**Use Nest's default `HttpException` body wrapping.** Easier, no filter. Rejected because (a) the default 500 body returns `"Internal server error"` as a string and `requestId` cannot be inserted by configuration, (b) without the filter we cannot guarantee the `X-Request-Id` response header on error paths, (c) the merge-not-replace semantic for existing route bodies is not Nest's default.

**Surface validation issues in a separate top-level key.** Most validation routes throw `BadRequestException({ error: 'validation_failed', issues: [...] })` today. A grand unifier would normalize that to `{ error, validation: { issues } }`. Rejected because the existing shape is one PR away from where the web app reads it; the rule "merge requestId in, do not normalize" keeps the migration cost at zero.

## Consequences

`RequestIdExceptionFilter` is the single place this contract is enforced. Any new controller endpoint inherits it for free; the test in `request-id.integration.test.ts` exercises the merge semantic for both `HttpException` and unhandled-error paths, so a regression that drops `requestId` from one branch is a CI failure.

The next public-facing piece of api documentation (an OpenAPI spec, a separate `errors.md`, or a JSON schema) can describe the envelope in one paragraph and then list the per-route `error` slugs without restating that `requestId` is present everywhere.

Three known limits, in order of how much they will hurt:

- **`message` is allowed to drift.** A client that started matching on the prose ("the receipt total is not a positive amount") instead of the slug (`non_positive_total`) will break on the first wording change. The ADR is explicit so a code reviewer can call this out; the rule is not enforced in code.
- **No structured stack reference even on 500.** The caller cannot ask for a stack trace; only the operator can. This is by design (no information leak) but means cross-org tickets need the operator to pull the line. The `requestId` is the bridge.
- **The envelope does not carry retry hints uniformly.** `BudgetExceededError -> 429` returns `resetAt`, the rate-limit middleware (when it lands) will return `retryAfter`. The set of retry hints is per-route, not per-envelope. A future ADR consolidates if the surface grows beyond two.
