import { Module, type DynamicModule } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Env } from '../config/env.js';
import { createRedisConnection } from '../queue/queue.module.js';
import { PlaidController } from './plaid.controller.js';
import { PlaidService } from './plaid.service.js';
import { PLAID_CLIENT_TOKEN, createPlaidClient } from './plaid-client.js';
import { PLAID_SYNC_QUEUE, PLAID_SYNC_QUEUE_NAME } from './plaid-sync.queue.js';
import { PlaidSyncService } from './plaid-sync.service.js';
import { PlaidSyncWorker } from './plaid-sync.worker.js';
import { TokenCipher } from './token-cipher.js';

@Module({})
export class PlaidModule {
  /**
   * When PLAID_ENABLED=false the module registers nothing: no
   * controllers, no providers, no worker. Routes return 404 instead
   * of a Plaid-not-configured 500. The env refine() guarantees the
   * three credential fields are set whenever PLAID_ENABLED=true, so
   * the non-null assertions below are sound.
   *
   * The sync queue uses its own Redis connection (BullMQ's guidance:
   * worker and queue on separate connections) and the cron registers
   * a repeatable job on boot. The exchange path enqueues a first-time
   * sync-item directly so a fresh link does not wait for the cron.
   */
  static forRoot(env: Env): DynamicModule {
    if (!env.PLAID_ENABLED) {
      return { module: PlaidModule };
    }
    return {
      module: PlaidModule,
      controllers: [PlaidController],
      providers: [
        TokenCipher,
        PlaidService,
        PlaidSyncService,
        PlaidSyncWorker,
        {
          provide: PLAID_CLIENT_TOKEN,
          useFactory: () =>
            createPlaidClient({
              PLAID_CLIENT_ID: env.PLAID_CLIENT_ID!,
              PLAID_SECRET: env.PLAID_SECRET!,
              PLAID_ENV: env.PLAID_ENV!,
            }),
        },
        {
          provide: PLAID_SYNC_QUEUE,
          useFactory: () => {
            const connection = createRedisConnection(env.REDIS_URL);
            return new Queue(PLAID_SYNC_QUEUE_NAME, { connection });
          },
        },
      ],
      exports: [PlaidService, PlaidSyncService, TokenCipher],
    };
  }
}
