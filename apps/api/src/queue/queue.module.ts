import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

export const EXTRACTION_QUEUE_NAME = 'extraction';

export const EXTRACTION_QUEUE = Symbol('EXTRACTION_QUEUE');
export const QUEUE_REDIS_URL = Symbol('QUEUE_REDIS_URL');
const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

export interface ExtractionJobData {
  extractionId: string;
}

/**
 * BullMQ requires maxRetriesPerRequest: null on connections used by
 * blocking commands. We construct the connection ourselves (ioredis
 * takes the redis:// url directly; BullMQ's connection options do not),
 * so we own closing it.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

@Injectable()
class QueueCleanup implements OnModuleDestroy {
  constructor(
    @Inject(EXTRACTION_QUEUE) private readonly queue: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

/**
 * Owns the extraction job queue. The worker that drains it lives in
 * ExtractionsModule because it needs ExtractionsService; this module
 * just hands out the Queue to enqueue onto and the redis url so the
 * worker can open its own (separate, per BullMQ guidance) connection.
 */
@Module({})
export class QueueModule {
  static forRoot(env: Env): DynamicModule {
    const connection = createRedisConnection(env.REDIS_URL);
    const queue = new Queue(EXTRACTION_QUEUE_NAME, { connection });
    return {
      module: QueueModule,
      providers: [
        { provide: EXTRACTION_QUEUE, useValue: queue },
        { provide: QUEUE_CONNECTION, useValue: connection },
        { provide: QUEUE_REDIS_URL, useValue: env.REDIS_URL },
        QueueCleanup,
      ],
      exports: [EXTRACTION_QUEUE, QUEUE_REDIS_URL],
    };
  }
}
