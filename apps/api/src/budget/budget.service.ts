import { Inject, Injectable } from '@nestjs/common';
import { gte, sql } from 'drizzle-orm';
import { BudgetExceededError } from '@vellum/extraction';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { extractions } from '../db/schema/extractions.js';

export const EXTRACTION_BUDGET_LIMIT_USD = Symbol('EXTRACTION_BUDGET_LIMIT_USD');

/**
 * Enforces the daily extraction spend cap from ADR-0011. The cap is a
 * non-negative decimal string in USD; when null, no enforcement runs
 * and existing behaviour stays unchanged. Today is UTC midnight to UTC
 * midnight; the source of truth is sum(cost_estimated_usd) over today's
 * rows. Comparison happens in scaled BigInt so float rounding does not
 * leak into a money decision.
 */
@Injectable()
export class BudgetService {
  private readonly limitScaled: bigint | null;

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(EXTRACTION_BUDGET_LIMIT_USD) limitUsd: string | null,
  ) {
    this.limitScaled = limitUsd === null ? null : scaleDecimal(limitUsd, 6);
  }

  isEnforced(): boolean {
    return this.limitScaled !== null;
  }

  async todaySpendUsd(): Promise<string> {
    const since = startOfTodayUtc();
    const rows = await this.db
      .select({
        total: sql<string>`COALESCE(sum(${extractions.costEstimatedUsd}), 0)::text`,
      })
      .from(extractions)
      .where(gte(extractions.createdAt, since));
    return rows[0]?.total ?? '0';
  }

  /**
   * Throws BudgetExceededError when today's already-recorded spend
   * reaches or exceeds the cap. Callers (POST /extractions, the
   * worker before provider.extract) both fail fast on this path.
   */
  async assertWithinBudget(): Promise<void> {
    if (this.limitScaled === null) return;
    const spent = await this.todaySpendUsd();
    const spentScaled = scaleDecimal(spent, 6);
    if (spentScaled >= this.limitScaled) {
      throw new BudgetExceededError(unscaleDecimal(this.limitScaled, 6), spent);
    }
  }

  nextResetAt(): Date {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  }
}

function startOfTodayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function scaleDecimal(s: string, scale: number): bigint {
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return BigInt(whole ?? '0') * 10n ** BigInt(scale) + BigInt(padded);
}

function unscaleDecimal(n: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale);
  const whole = n / factor;
  const frac = n % factor;
  if (frac === 0n) return whole.toString();
  return `${whole.toString()}.${frac.toString().padStart(scale, '0').replace(/0+$/, '')}`;
}
