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
import { AuthGuard } from '../auth/auth.guard.js';
import { Idempotent } from '../idempotency/idempotency.decorator.js';
import {
  AccountsService,
  createAccountSchema,
  type AccountBalance,
  type AccountRow,
  type CreateAccountInput,
} from './accounts.service.js';

@Controller('accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<AccountRow> {
    const parsed = createAccountSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    const input: CreateAccountInput = parsed.data;
    return this.accounts.create(input);
  }

  @Get()
  async list(): Promise<{ accounts: AccountRow[] }> {
    const rows = await this.accounts.findAll();
    return { accounts: rows };
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<AccountRow> {
    const row = await this.accounts.findById(id);
    if (!row) throw new NotFoundException(`account ${id} not found`);
    return row;
  }

  @Get(':id/balance')
  async balance(@Param('id') id: string): Promise<AccountBalance> {
    return this.accounts.getBalance(id);
  }
}
