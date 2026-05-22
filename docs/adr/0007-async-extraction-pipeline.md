# 0007. Async extraction pipeline

## Status

Accepted, 2026-05-22.

## Context

`POST /extractions` currently runs the vision model inside the request handler and blocks until the provider returns. That was the right shape to ship the loop (ADR-0005, ADR-0006) but it is the wrong shape to keep:

- A vision call takes seconds, sometimes tens of seconds on a large image. Holding an HTTP request open that long ties up a connection, trips proxy and load-balancer timeouts, and gives the user a spinner with no signal.
- Retries, rate limits, and provider outages have nowhere to live. A transient `ProviderTimeoutError` either fails the request outright or makes the user wait through a blocking retry.
- Cost control wants a choke point. A queue with bounded concurrency is where "cheap model first, expensive on retry" and per-day budget enforcement will eventually sit.

The schema already anticipated this: `extractions.status` has a `pending` value that the synchronous path never uses, and `docs/deploying.md` already lists Redis as required "for the BullMQ job queue". This ADR makes the design explicit before the code lands. It is also the project's standing instruction: AI calls do not belong in the request handler, they belong on a queue.

## Decision

**BullMQ on Redis is the queue.** It is the obvious fit for a Node stack, gives us retries with backoff, delayed jobs, and concurrency limits out of the box, and Redis is already a documented dependency. `REDIS_URL` configures the connection.

**`POST /extractions` enqueues and returns immediately.** The handler creates a `pending` extraction row, enqueues a job carrying the extraction id, and returns `202 Accepted` with the pending row. The model never runs in the request path. The id is the handle the client uses to find out what happened.

**The worker runs in-process for v1.** The same Node process that serves the API also hosts the BullMQ worker, started on module init. Single-node self-hosted deploys (the v1 target: freelancers, solo, small teams) get the async behaviour without operating a second deployable. The job processor is a thin function that loads the row plus the image bytes, runs the provider, and writes the terminal row, so extracting it into its own process later is a deployment change, not a code rewrite.

**Status delivery is polling for v1.** The client polls `GET /extractions/:id` until `status` leaves `pending`. Extractions finish in seconds, so a short poll interval is fine and costs nothing to build. The WebSocket push that `docs/deploying.md` anticipates is a real improvement at scale but premature now; it lands when polling visibly hurts.

**Dedupe happens before enqueue.** The request-hash check from the synchronous version moves ahead of the enqueue: if a terminal row (`succeeded` or `needs_review`) already exists for the hash, return it without enqueueing; if a `pending` row already exists for the hash, return that instead of enqueueing a duplicate. The job is keyed so the same extraction is not processed twice.

**Retries are bounded and error-aware, because each attempt costs money.** Transient failures (`ProviderTimeoutError`, network) are retried with exponential backoff, capped at a small number of attempts. Deterministic failures (`UnreadableImageError`, `InvalidProviderResponseError`) are not retried at all; retrying a receipt the model cannot read just spends money to fail again. The processor signals "do not retry" by throwing BullMQ's `UnrecoverableError`. When attempts are exhausted or a non-retryable error fires, the worker writes a `failed` row with the error code so the audit trail captures every attempt.

## Options considered

**Keep it synchronous, add a timeout.** Cap the request at N seconds and fail past it. Rejected: it does not solve retries or outages, it still holds the connection, and a slow-but-successful extraction becomes a user-visible failure.

**Separate worker process from day one.** A standalone worker deployable is the scale-out answer. Rejected for v1 as operational weight the target user does not need: a freelancer self-hosting Vellum should not run two processes to extract a coffee receipt. The processor is written to be lifted out when multi-replica throughput matters.

**WebSocket status from day one.** Push the status change to the browser over a socket. Rejected as premature: it needs the pub/sub fanout for multi-replica correctness and a socket lifecycle on the client, all to save a few seconds of polling on a job that finishes in a few seconds. Polling first, socket when it earns its keep.

**A different queue (pg-boss on Postgres, SQS, a cron table).** pg-boss avoids the Redis dependency by using Postgres, which is tempting. Rejected because Redis is already a planned dependency for pub/sub and rate limiting, BullMQ's retry/backoff/concurrency primitives are more mature, and putting the job queue on the same Postgres that holds the ledger couples queue load to the database we most want to keep calm.

## Consequences

The request path gets fast and predictable: `POST /extractions` is a row insert plus an enqueue, regardless of how slow or flaky the model is. The user gets an id immediately and a status that resolves in the background.

Redis becomes a hard runtime dependency for the API. Local development and tests need a Redis instance; the integration tests spin one up in a container alongside Postgres. A deploy without Redis is now a misconfiguration, not a degraded mode.

Failure handling has a home. Retries, backoff, and the retry/no-retry decision live in the worker, keyed off the existing error taxonomy from ADR-0005. The `failed` row with its error code is the durable record of what the model did, which is the audit trail the project calls for.

The cost choke point exists. Bounded worker concurrency caps how fast we can spend money on extraction, and the queue is where future budget enforcement and cheap-model-first routing attach without touching the request path.

Two things we accept as known limits:

- **In-process worker shares the API's resources.** A burst of extractions competes with request handling for CPU on a single-node deploy. The concurrency limit keeps this bounded; the separate-process upgrade is the answer when it stops being enough.
- **Polling is not instant.** The user sees the result on the next poll, not the millisecond it finishes. Acceptable for a seconds-long job; the WebSocket path removes it later.
