import { Module, type DynamicModule } from '@nestjs/common';
import {
  BudgetService,
  EXTRACTION_BUDGET_LIMIT_USD,
  EXTRACTION_BUDGET_PER_USER_LIMIT_USD,
} from './budget.service.js';
import { BudgetController } from './budget.controller.js';
import type { Env } from '../config/env.js';

@Module({})
export class BudgetModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: BudgetModule,
      global: true,
      controllers: [BudgetController],
      providers: [
        { provide: EXTRACTION_BUDGET_LIMIT_USD, useValue: env.EXTRACTION_DAILY_BUDGET_USD ?? null },
        {
          provide: EXTRACTION_BUDGET_PER_USER_LIMIT_USD,
          useValue: env.EXTRACTION_DAILY_BUDGET_PER_USER_USD ?? null,
        },
        BudgetService,
      ],
      exports: [BudgetService, EXTRACTION_BUDGET_LIMIT_USD, EXTRACTION_BUDGET_PER_USER_LIMIT_USD],
    };
  }
}
