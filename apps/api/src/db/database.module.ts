import { Module, type DynamicModule, type OnModuleDestroy, Inject } from '@nestjs/common';
import { createDb, type Db, type DbHandle } from './client.js';
import type { Env } from '../config/env.js';

export const DATABASE_TOKEN = Symbol('DATABASE_TOKEN');
export const DB_HANDLE_TOKEN = Symbol('DB_HANDLE_TOKEN');

@Module({})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_HANDLE_TOKEN) private readonly handle: DbHandle) {}

  async onModuleDestroy(): Promise<void> {
    await this.handle.close();
  }

  static forRoot(env: Env): DynamicModule {
    const handle = createDb(env.DATABASE_URL);
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DB_HANDLE_TOKEN, useValue: handle },
        { provide: DATABASE_TOKEN, useValue: handle.db },
      ],
      exports: [DATABASE_TOKEN],
    };
  }
}

export type { Db };
