# 0012. WebSocket-pushed extraction status

## Status

Accepted, 2026-06-04.

## Context

The review page at `/app/extractions/[id]` lands a user on a `pending` row whenever the extraction was enqueued faster than the worker drained it (the common case for the async pipeline from ADR-0007). The page handles the wait with a small client component (`AutoRefresh`) that calls `router.refresh()` on a 2-second interval until the row leaves `pending`. The polling works and is cheap to operate on day one; the cost shape gets worse fast as the project grows:

- Every viewer of every pending extraction adds two requests per second to the api. With one user this is invisible. With a single team running ten receipts through review at once, the api is fielding twenty wasted hits per second.
- The api has to repeat the full `/extractions/:id` handler (Auth guard, DB read, serialisation) for every poll, including when the row has not changed. The DB load is small but real, and the noise drowns out actual traffic when staring at request logs.
- The user experiences latency anywhere between zero and the polling interval. A 200 ms model response feels like 1.6 s of staring at "Extracting..." because the poll has not fired yet.

The async ADR (ADR-0007) flagged WebSocket-pushed status as the deferred follow-up. The infrastructure to do it cleanly is already in place: BullMQ runs on Redis, and the Redis client we already construct (`createRedisConnection` in `apps/api/src/queue/queue.module.ts`) speaks pub/sub. We just have not plumbed the event source to a delivery channel the browser can hold open.

## Decision

**A NestJS WebSocket gateway under `@nestjs/platform-socket.io`.** Socket.IO is the canonical Nest WebSocket transport, ships reconnection and room semantics out of the box, and works through reverse proxies that some users would otherwise have to configure for raw WebSockets. The cost is a couple of extra dependencies on the api; Socket.IO is small relative to NestJS and well-supported.

**One room per extraction.** A client that lands on `/app/extractions/[id]` sends `subscribe-extraction` with the id, the gateway joins the socket to a room named after the id, and only events for that id reach that socket. No global broadcast, no fan-out to clients that should not see another user's receipt.

**Redis pub/sub for cross-replica delivery.** The worker that processes an extraction publishes a small `ExtractionStatusEvent` to a Redis channel (one channel for all extractions, payload carries the id and the new status). Every api replica's gateway subscribes to the channel and routes the event into the matching room. The reason for the Redis hop is that the worker and the gateway are not guaranteed to be in the same process: a deploy can scale the api horizontally, and the worker might end up on a different replica than the client's WebSocket. Routing through Redis lets any worker reach any connected client.

**Same auth as HTTP.** The gateway's connection hook reads the same `authjs.session-token` cookie the rest of the api trusts (ADR-0003). A failed token check refuses the handshake. There is no separate WebSocket secret, no per-channel token, no "open for everyone" mode.

**Polling stays as a fallback.** The web side connects the WebSocket on mount and keeps the existing `AutoRefresh` running with a longer interval (10 s instead of 2 s) only when the socket is disconnected. The user never gets stuck in "Extracting..." because a reverse proxy ate the upgrade request; they just see status changes slightly later than they would over WebSocket.

## Options considered

**Server-Sent Events (SSE).** One-way push, simpler protocol, no Socket.IO baggage. The Nest ecosystem support is thinner (`@Sse()` on a route handler works, but session-aware auth and connection lifecycle plumbing is shallower), and proxies in the wild handle SSE less consistently than WebSocket through CloudFlare-style edges. Rejected because the simplicity buys nothing when we already need Redis pub/sub for the source side; the gateway adds a few hundred lines and that is the bulk of the work either way.

**Long polling.** Lowest infrastructure cost (no protocol change), still keeps the polling shape with a longer hold. Rejected because it still creates a connection per poll cycle and does not actually fix the chattiness for the user-visible latency case.

**PostgreSQL `LISTEN`/`NOTIFY`.** Avoids the Redis hop entirely. The worker calls `NOTIFY extraction_status, '<id>:<status>'` after each update, the gateway listens. Rejected because each Nest replica would need its own dedicated long-held PG connection just for the listen, and the existing `postgres-js` pool does not have a sane shape for `LISTEN`. Adding a side-band PG client gives us a second source of truth on connections and conflicts with the goal of one source of truth per dependency. Redis pub/sub does not need any of that.

**A per-extraction Redis channel instead of one shared channel.** Tighter isolation, but every gateway would have to dynamically subscribe and unsubscribe per client, which is a steady stream of churn against Redis for no practical benefit. One channel plus in-process routing is the standard Socket.IO pattern.

**Skip WebSocket entirely, lean on push notifications or a job-status endpoint with `If-Modified-Since`.** Wrong layer; the user is staring at the page right now, not waiting for an email.

## Consequences

A reviewer who lands on a pending row sees the status flip the moment the worker finishes, instead of waiting up to two seconds. The api stops serving useless 200 OK polls; the request log for `/extractions/:id` quiets down by an order of magnitude in active review. The worker publishes one event per status change, which is one Redis `PUBLISH` per extraction.

The api gains two npm dependencies (`@nestjs/websockets`, `@nestjs/platform-socket.io`) and one new gateway module. The worker grows one publish call. The web app gains `socket.io-client` and a small subscribe hook on the review page. None of the existing endpoints change shape, and the polling fallback keeps the page working everywhere the WebSocket cannot reach.

Three known limits, in order of how much they will hurt:

- **The polling fallback is not free.** Every WebSocket connection that fails to upgrade keeps the 10 s poller running. A user on a misbehaving proxy is still cheaper than the current 2 s default for everyone, but it is not zero. Acceptable; the alternative is "WebSocket only" and a worse UX on flaky networks.
- **One channel for all extraction events.** A noisy day's worth of events is a few thousand publishes, well below any Redis pub/sub limit, but the gateway has to route in-process. If extraction volume ever justifies it, splitting to per-user or per-tenant channels is a small change.
- **No replay on reconnect.** If the WebSocket drops while the worker emits the event, the client misses the push and falls back to the next poll. We do not buffer events anywhere. Acceptable for v1; the worst case is the status arrives 10 s late, which is the polling baseline.
