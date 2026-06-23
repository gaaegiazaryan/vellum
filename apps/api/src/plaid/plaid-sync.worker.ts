import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_REDIS_URL, createRedisConnection } from '../queue/queue.module.js';
import {
  PLAID_SYNC_QUEUE,
  PLAID_SYNC_QUEUE_NAME,
  SYNC_TICK_INTERVAL_MS,
  type PlaidSyncJobData,
} from './plaid-sync.queue.js';
import { PlaidSyncService } from './plaid-sync.service.js';

const WORKER_CONCURRENCY = 2;
const TICK_JOB_ID = 'plaid-sync-tick';

/**
 * Two job names share one queue:
 *   - 'tick' is a repeatable cron (every 15 minutes). The handler
 *     enumerates due items via PlaidSyncService.dueItems and enqueues
 *     one 'sync-item' per row.
 *   - 'sync-item' calls PlaidSyncService.syncItem for one item.
 *
 * A single repeatable job key (TICK_JOB_ID) keeps the cron idempotent
 * across deploys; BullMQ refuses to register a second copy with the
 * same key. The exchange endpoint enqueues a 'sync-item' directly so a
 * freshly-linked item does not wait up to 15 minutes for its first
 * transactions to land.
 */
@Injectable()
export class PlaidSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaidSyncWorker.name);
  private connection?: Redis;
  private worker?: Worker<PlaidSyncJobData>;

  constructor(
    @Inject(QUEUE_REDIS_URL) private readonly redisUrl: string,
    @Inject(PLAID_SYNC_QUEUE) private readonly queue: Queue<PlaidSyncJobData>,
    private readonly sync: PlaidSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = createRedisConnection(this.redisUrl);
    this.worker = new Worker<PlaidSyncJobData>(PLAID_SYNC_QUEUE_NAME, (job) => this.process(job), {
      connection: this.connection,
      concurrency: WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`plaid-sync job ${job?.id ?? '?'} failed: ${err.message}`);
    });
    await this.queue.add(
      'tick',
      { kind: 'tick' },
      {
        repeat: { every: SYNC_TICK_INTERVAL_MS },
        jobId: TICK_JOB_ID,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job<PlaidSyncJobData>): Promise<void> {
    const data = job.data;
    if (data.kind === 'tick') {
      const dueIds = await this.sync.dueItems();
      this.logger.log(`tick: ${dueIds.length} due items`);
      if (dueIds.length === 0) return;
      await this.queue.addBulk(
        dueIds.map((id) => ({
          name: 'sync-item',
          data: { kind: 'sync-item', plaidItemRowId: id } as PlaidSyncJobData,
        })),
      );
      return;
    }
    await this.sync.syncItem(data.plaidItemRowId);
  }
}
