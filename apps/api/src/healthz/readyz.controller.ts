import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { QUEUE_CONNECTION } from '../queue/queue.module.js';

export type DependencyStatus = 'up' | 'down';

export interface ReadyzResponse {
  status: 'ready' | 'degraded';
  database: DependencyStatus;
  redis: DependencyStatus;
  timestamp: string;
}

const CHECK_TIMEOUT_MS = 2000;

/**
 * Liveness vs readiness split (kube-style): /healthz says the process
 * is up, /readyz says it can actually serve traffic. A request handler
 * needs both Postgres (every read/write) and Redis (BullMQ enqueue,
 * idempotency keys, pub/sub) to do useful work, so both go in the
 * readiness signal.
 *
 * Returns 503 on any dependency failure so the orchestrator can route
 * traffic away while keeping the container running (the process is
 * still healthy; the database came back is just a separate event).
 *
 * Each probe is wrapped in a small timeout so a hanging dependency
 * cannot make /readyz itself hang and starve the load balancer's
 * probe budget.
 */
@Controller('readyz')
export class ReadyzController {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(QUEUE_CONNECTION) private readonly redis: Redis,
  ) {}

  @Get()
  async readyz(): Promise<ReadyzResponse> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const ok = database === 'up' && redis === 'up';
    const body: ReadyzResponse = {
      status: ok ? 'ready' : 'degraded',
      database,
      redis,
      timestamp: new Date().toISOString(),
    };
    if (!ok) {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    try {
      await withTimeout(Promise.resolve(this.db.execute(sql`select 1`)), CHECK_TIMEOUT_MS);
      return 'up';
    } catch (err) {
      console.error('readyz: database probe failed', err);
      return 'down';
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
      return 'up';
    } catch (err) {
      console.error('readyz: redis probe failed', err);
      return 'down';
    }
  }
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
