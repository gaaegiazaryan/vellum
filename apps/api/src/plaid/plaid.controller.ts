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
import { PlaidService, type PlaidItemWithAccounts, type PlaidLinkToken } from './plaid.service.js';

const exchangeBodySchema = z.object({ publicToken: z.string().min(1) });

@Controller('plaid')
@UseGuards(AuthGuard)
export class PlaidController {
  constructor(private readonly plaid: PlaidService) {}

  @Post('link-token')
  @HttpCode(HttpStatus.OK)
  createLinkToken(@CurrentUser() user: AuthenticatedUser | undefined): Promise<PlaidLinkToken> {
    if (!user) throw new UnauthorizedException();
    return this.plaid.createLinkToken(user.id);
  }

  @Post('exchange')
  @HttpCode(HttpStatus.CREATED)
  async exchange(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Body() body: unknown,
  ): Promise<{ itemId: string }> {
    if (!user) throw new UnauthorizedException();
    const parsed = exchangeBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'validation_failed', issues: parsed.error.issues });
    }
    return this.plaid.exchange(user.id, parsed.data.publicToken);
  }

  @Get('items')
  list(
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<{ items: PlaidItemWithAccounts[] }> {
    if (!user) throw new UnauthorizedException();
    return this.plaid.listItems(user.id).then((items) => ({ items }));
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param('id') id: string,
  ): Promise<void> {
    if (!user) throw new UnauthorizedException();
    await this.plaid.removeItem(user.id, id);
  }
}
