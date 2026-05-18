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
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Idempotent } from '../idempotency/idempotency.decorator.js';
import {
  JournalEntriesService,
  createJournalEntryInputSchema,
  type JournalEntryRow,
} from './journal-entries.service.js';

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

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<JournalEntryRow> {
    const row = await this.entries.findById(id);
    if (!row) throw new NotFoundException(`journal entry ${id} not found`);
    return row;
  }
}
