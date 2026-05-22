import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../idempotency/idempotency.decorator.js';
import {
  ExtractionsService,
  type ConfirmExtractionResult,
  type ExtractionRow,
} from './extractions.service.js';

const createExtractionSchema = z.object({
  uploadId: z.string().uuid(),
});

const confirmExtractionSchema = z.object({
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
  description: z.string().trim().min(1).max(500).optional(),
});

@Controller('extractions')
@UseGuards(AuthGuard)
export class ExtractionsController {
  constructor(private readonly extractions: ExtractionsService) {}

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
    return this.extractions.create({
      uploadId: parsed.data.uploadId,
      userId: user?.id ?? null,
    });
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

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ExtractionRow> {
    const row = await this.extractions.findById(id);
    if (!row) throw new NotFoundException(`extraction ${id} not found`);
    return row;
  }
}
