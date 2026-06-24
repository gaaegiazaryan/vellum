import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { MatchingService, type BankSuggestion, type EntrySuggestion } from './matching.service.js';

const pairBodySchema = z.object({
  journalEntryId: z.string().min(1),
  bankTransactionId: z.string().min(1),
});

const suggestForReceiptBodySchema = z.object({
  totalMinor: z.string().regex(/^\d+$/, 'totalMinor must be a non-negative integer string'),
  occurredAt: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  vendorName: z.string().nullable().optional(),
});

@Controller('matching')
@UseGuards(AuthGuard)
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Get('suggest-for-entry/:journalEntryId')
  suggestForEntry(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('journalEntryId') journalEntryId: string,
  ): Promise<{ suggestions: BankSuggestion[] }> {
    if (!user) throw new UnauthorizedException();
    return this.matching
      .suggestForEntry(user.id, journalEntryId)
      .then((suggestions) => ({ suggestions }));
  }

  @Post('suggest-for-receipt')
  @HttpCode(HttpStatus.OK)
  async suggestForReceipt(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ): Promise<{ suggestions: BankSuggestion[] }> {
    if (!user) throw new UnauthorizedException();
    const parsed = suggestForReceiptBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const suggestions = await this.matching.suggestForReceipt(user.id, {
      totalMinor: BigInt(parsed.data.totalMinor),
      occurredAt: new Date(parsed.data.occurredAt),
      currency: parsed.data.currency,
      vendorName: parsed.data.vendorName ?? null,
    });
    return { suggestions };
  }

  @Get('suggest-for-bank/:bankTransactionId')
  suggestForBank(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('bankTransactionId') bankTransactionId: string,
  ): Promise<{ suggestions: EntrySuggestion[] }> {
    if (!user) throw new UnauthorizedException();
    return this.matching
      .suggestForBank(user.id, bankTransactionId)
      .then((suggestions) => ({ suggestions }));
  }

  @Post('pair')
  @HttpCode(HttpStatus.NO_CONTENT)
  async pair(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    if (!user) throw new UnauthorizedException();
    const parsed = pairBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    await this.matching.pair(user.id, parsed.data.journalEntryId, parsed.data.bankTransactionId);
  }

  @Delete('pair/:bankTransactionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unpair(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('bankTransactionId') bankTransactionId: string,
  ): Promise<void> {
    if (!user) throw new UnauthorizedException();
    await this.matching.unpair(user.id, bankTransactionId);
  }
}
