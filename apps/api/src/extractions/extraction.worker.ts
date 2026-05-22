import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  EXTRACTION_QUEUE_NAME,
  QUEUE_REDIS_URL,
  createRedisConnection,
  type ExtractionJobData,
} from '../queue/queue.module.js';
import { ExtractionsService, isRetryableExtractionError } from './extractions.service.js';

const WORKER_CONCURRENCY = 4;

/**
 * Drains the extraction queue in-process (ADR-0007). On boot it opens
 * its own redis connection (BullMQ wants the worker on a separate
 * connection from the queue) and starts a Worker. The processor calls
 * ExtractionsService.runExtraction and applies the retry policy:
 * deterministic failures throw UnrecoverableError so BullMQ does not
 * retry, transient ones rethrow so BullMQ retries until attempts run
 * out. The failed row is written when the worker gives up.
 */
@Injectable()
export class ExtractionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtractionWorker.name);
  private connection?: Redis;
  private worker?: Worker<ExtractionJobData>;

  constructor(
    @Inject(QUEUE_REDIS_URL) private readonly redisUrl: string,
    private readonly extractions: ExtractionsService,
  ) {}

  onModuleInit(): void {
    this.connection = createRedisConnection(this.redisUrl);
    this.worker = new Worker<ExtractionJobData>(EXTRACTION_QUEUE_NAME, (job) => this.process(job), {
      connection: this.connection,
      concurrency: WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => {
      this.logger.warn(`extraction job ${job?.id ?? '?'} failed: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job<ExtractionJobData>): Promise<void> {
    const { extractionId } = job.data;
    try {
      await this.extractions.runExtraction(extractionId);
    } catch (err) {
      const retryable = isRetryableExtractionError(err);
      const attempts = job.opts.attempts ?? 1;
      const lastAttempt = job.attemptsMade + 1 >= attempts;
      if (!retryable || lastAttempt) {
        await this.extractions.recordFailure(extractionId, err);
      }
      if (!retryable) {
        throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }
}
