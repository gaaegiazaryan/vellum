import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { QUEUE_REDIS_URL, createRedisConnection } from '../queue/queue.module.js';

const CHANNEL = 'extraction-status';

export interface ExtractionStatusEvent {
  extractionId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  at: string;
}

type Listener = (e: ExtractionStatusEvent) => void;

/**
 * Cross-replica fanout for extraction status changes (ADR-0012). The
 * worker that runs the provider publishes here; every api replica
 * subscribes here. The gateway turns subscribed events into Socket.IO
 * room emits. Redis pub/sub is the only transport that does not
 * require workers and gateways to share a process.
 */
@Injectable()
export class ExtractionEventsService implements OnModuleInit, OnModuleDestroy {
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private listeners: Listener[] = [];
  private readonly logger = new Logger(ExtractionEventsService.name);

  constructor(@Inject(QUEUE_REDIS_URL) private readonly redisUrl: string) {}

  async onModuleInit(): Promise<void> {
    this.pub = createRedisConnection(this.redisUrl);
    this.sub = createRedisConnection(this.redisUrl);
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_channel, raw) => {
      let parsed: ExtractionStatusEvent;
      try {
        parsed = JSON.parse(raw) as ExtractionStatusEvent;
      } catch {
        this.logger.warn(`dropped malformed status event: ${raw.slice(0, 80)}`);
        return;
      }
      for (const l of this.listeners) l(parsed);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub?.quit().catch(() => {});
    await this.pub?.quit().catch(() => {});
  }

  async publish(event: ExtractionStatusEvent): Promise<void> {
    if (!this.pub) throw new Error('ExtractionEventsService not initialised');
    await this.pub.publish(CHANNEL, JSON.stringify(event));
  }

  onEvent(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export { CHANNEL as EXTRACTION_STATUS_CHANNEL };
