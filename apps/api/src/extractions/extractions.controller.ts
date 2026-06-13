import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { BudgetExceededError } from '@vellum/extraction';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { BudgetService } from '../budget/budget.service.js';
import { Idempotent } from '../idempotency/idempotency.decorator.js';
import {
  ExtractionsService,
  type ConfirmExtractionResult,
  type ExtractionRow,
  type FallbackStats,
} from './extractions.service.js';

const createExtractionSchema = z.object({
  uploadId: z.string().uuid(),
});

const confirmExtractionSchema = z.object({
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
  description: z.string().trim().min(1).max(500).optional(),
  totalMinor: z
    .string()
    .regex(/^\d+$/, 'totalMinor must be a non-negative integer in minor units')
    .optional(),
  occurredAt: z.coerce.date().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
    .optional(),
});

@Controller('extractions')
@UseGuards(AuthGuard)
export class ExtractionsController {
  constructor(
    private readonly extractions: ExtractionsService,
    private readonly budget: BudgetService,
  ) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<ExtractionRow> {
    const parsed = createExtractionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'validation_failed',
        issues: parsed.error.issues,
      });
    }
    try {
      return await this.extractions.create({
        uploadId: parsed.data.uploadId,
        userId: user?.id ?? null,
      });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const resetAt = this.budget.nextResetAt();
        throw new HttpException(
          {
            error: 'budget_exceeded',
            scope: err.scope,
            limitUsd: err.limitUsd,
            spentUsd: err.accumulatedUsd,
            resetAt: resetAt.toISOString(),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }

  @Post(':id/confirm')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<ConfirmExtractionResult> {
    const parsed = confirmExtractionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'validation_failed',
        issues: parsed.error.issues,
      });
    }
    return this.extractions.confirm(id, parsed.data, user?.id ?? null);
  }

  @Get('fallback-stats')
  async fallbackStats(
    @Query('since') sinceRaw?: string,
    @Query('until') untilRaw?: string,
  ): Promise<FallbackStats> {
    // Default window: today UTC. Same UTC boundary the budget uses
    // (ADR-0011) so the two operator views read off the same axis.
    const now = new Date();
    const defaultSince = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const defaultUntil = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const since = parseIsoOr(sinceRaw, defaultSince, 'since');
    const until = parseIsoOr(untilRaw, defaultUntil, 'until');
    if (until.getTime() <= since.getTime()) {
      throw new BadRequestException({
        error: 'invalid_range',
        detail: 'until must be after since',
      });
    }
    return this.extractions.fallbackStats(since, until);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ExtractionRow> {
    const row = await this.extractions.findById(id);
    if (!row) throw new NotFoundException(`extraction ${id} not found`);
    return row;
  }
}

function parseIsoOr(raw: string | undefined, fallback: Date, name: string): Date {
  if (raw === undefined || raw === '') return fallback;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({ error: 'invalid_query', detail: `${name} is not an ISO date` });
  }
  return d;
}
