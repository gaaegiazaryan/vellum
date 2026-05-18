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
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../idempotency/idempotency.decorator.js';
import {
  JournalEntriesService,
  createJournalEntryInputSchema,
  type JournalEntryRow,
  type ListEntriesResult,
} from './journal-entries.service.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  accountId: z.string().uuid().optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
    .optional(),
});

@Controller('journal-entries')
@UseGuards(AuthGuard)
export class JournalEntriesController {
  constructor(private readonly entries: JournalEntriesService) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<JournalEntryRow> {
    const parsed = createJournalEntryInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    return this.entries.create(parsed.data, user?.id ?? null);
  }

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<ListEntriesResult> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    return this.entries.list(parsed.data);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<JournalEntryRow> {
    const row = await this.entries.findById(id);
    if (!row) throw new NotFoundException(`journal entry ${id} not found`);
    return row;
  }
}
