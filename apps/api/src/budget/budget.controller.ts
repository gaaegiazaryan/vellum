import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { BudgetService } from './budget.service.js';

export interface BudgetTodayResponse {
  spentUsd: string;
  spentByMeUsd: string;
  resetAt: string;
}

/**
 * Read-only view of today's extraction spend. Surfaces the same UTC
 * window the budget enforcer uses, so the operator can answer "how
 * close are we to the cap?" without having to scroll the extractions
 * page.
 *
 * The two spend fields cover both questions a user actually asks:
 * the system total (what is the wallet doing today?) and the
 * requesting user's own total (am I about to be 429'd by my per-user
 * cap?). The per-cap limits themselves are not echoed back here
 * because they live in env and the operator already knows what they
 * set; if the env-vs-spent comparison matters to a tool, the limit
 * surfaces in the 429 response when it actually fires.
 */
@Controller('budget')
@UseGuards(AuthGuard)
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get('today')
  async today(@CurrentUser() user: AuthenticatedUser | undefined): Promise<BudgetTodayResponse> {
    if (!user) throw new UnauthorizedException();
    const [spentUsd, spentByMeUsd] = await Promise.all([
      this.budget.todaySpendUsd(),
      this.budget.todaySpendUsdByUser(user.id),
    ]);
    return {
      spentUsd,
      spentByMeUsd,
      resetAt: this.budget.nextResetAt().toISOString(),
    };
  }
}
