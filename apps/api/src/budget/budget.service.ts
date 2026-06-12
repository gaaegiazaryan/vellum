import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { BudgetExceededError } from '@vellum/extraction';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { extractions } from '../db/schema/extractions.js';

export const EXTRACTION_BUDGET_LIMIT_USD = Symbol('EXTRACTION_BUDGET_LIMIT_USD');
export const EXTRACTION_BUDGET_PER_USER_LIMIT_USD = Symbol('EXTRACTION_BUDGET_PER_USER_LIMIT_USD');

/**
 * Enforces the daily extraction spend cap from ADR-0011 (system-wide)
 * and ADR-0014 (per-user). Either cap is optional; null disables that
 * scope. Today is UTC midnight to UTC midnight; source of truth is
 * sum(cost_estimated_usd) over today's rows. Comparison happens in
 * scaled BigInt so float rounding does not leak into a money decision.
 */
@Injectable()
export class BudgetService {
  private readonly systemLimitScaled: bigint | null;
  private readonly userLimitScaled: bigint | null;

  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    @Inject(EXTRACTION_BUDGET_LIMIT_USD) systemLimitUsd: string | null,
    @Inject(EXTRACTION_BUDGET_PER_USER_LIMIT_USD) userLimitUsd: string | null,
  ) {
    this.systemLimitScaled = systemLimitUsd === null ? null : scaleDecimal(systemLimitUsd, 6);
    this.userLimitScaled = userLimitUsd === null ? null : scaleDecimal(userLimitUsd, 6);
  }

  isEnforced(): boolean {
    return this.systemLimitScaled !== null || this.userLimitScaled !== null;
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

  async todaySpendUsdByUser(userId: string): Promise<string> {
    const since = startOfTodayUtc();
    const rows = await this.db
      .select({
        total: sql<string>`COALESCE(sum(${extractions.costEstimatedUsd}), 0)::text`,
      })
      .from(extractions)
      .where(and(gte(extractions.createdAt, since), eq(extractions.createdById, userId)));
    return rows[0]?.total ?? '0';
  }

  /**
   * Throws BudgetExceededError when (today's spend + predictedAddUsd)
   * reaches or exceeds the relevant cap. When userId is provided and
   * the per-user cap is configured, the user scope is checked first so
   * the 429 surfaces the most actionable cause; the system cap covers
   * the case where many users together fill the wallet.
   *
   * predictedAddUsd closes the race where the cap had a few cents of
   * headroom and each in-flight job would tip it over. Callers pass
   * the provider's predictedMaxCostUsd() (ADR-0011 known limit #2).
   * Default '0' preserves the spent-only check used by the worker
   * re-check, where the provider call is the very next instruction.
   */
  async assertWithinBudget(userId?: string | null, predictedAddUsd: string = '0'): Promise<void> {
    const predictedScaled = scaleDecimal(predictedAddUsd, 6);
    if (userId && this.userLimitScaled !== null) {
      const spent = await this.todaySpendUsdByUser(userId);
      const spentScaled = scaleDecimal(spent, 6);
      if (spentScaled + predictedScaled >= this.userLimitScaled) {
        throw new BudgetExceededError(unscaleDecimal(this.userLimitScaled, 6), spent, 'user');
      }
    }
    if (this.systemLimitScaled !== null) {
      const spent = await this.todaySpendUsd();
      const spentScaled = scaleDecimal(spent, 6);
      if (spentScaled + predictedScaled >= this.systemLimitScaled) {
        throw new BudgetExceededError(unscaleDecimal(this.systemLimitScaled, 6), spent, 'system');
      }
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
