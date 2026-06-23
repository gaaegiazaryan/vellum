import { Module, type DynamicModule } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { PlaidController } from './plaid.controller.js';
import { PlaidService } from './plaid.service.js';
import { PLAID_CLIENT_TOKEN, createPlaidClient } from './plaid-client.js';
import { TokenCipher } from './token-cipher.js';

@Module({})
export class PlaidModule {
  /**
   * When PLAID_ENABLED=false the module registers nothing: no
   * controllers, no providers. Routes return 404 instead of a
   * Plaid-not-configured 500. The env refine() guarantees the three
   * credential fields are set whenever PLAID_ENABLED=true, so the
   * non-null assertions below are sound.
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
        {
          provide: PLAID_CLIENT_TOKEN,
          useFactory: () =>
            createPlaidClient({
              PLAID_CLIENT_ID: env.PLAID_CLIENT_ID!,
              PLAID_SECRET: env.PLAID_SECRET!,
              PLAID_ENV: env.PLAID_ENV!,
            }),
        },
      ],
      exports: [PlaidService, TokenCipher],
    };
  }
}
