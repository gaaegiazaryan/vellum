import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PlaidApi } from 'plaid';
import { CountryCode, Products } from 'plaid';
import { and, eq } from 'drizzle-orm';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { plaidAccounts, plaidItems } from '../db/schema/plaid.js';
import { TokenCipher } from './token-cipher.js';
import { PLAID_CLIENT_TOKEN } from './plaid-client.js';

export interface PlaidLinkToken {
  linkToken: string;
  expiration: string;
}

export interface PlaidItemWithAccounts {
  id: string;
  plaidItemId: string;
  institutionName: string | null;
  status: string;
  lastSyncAt: Date | null;
  createdAt: Date;
  accounts: Array<{
    id: string;
    plaidAccountId: string;
    name: string;
    officialName: string | null;
    type: string;
    subtype: string | null;
    mask: string | null;
    currency: string;
  }>;
}

@Injectable()
export class PlaidService {
  private readonly logger = new Logger(PlaidService.name);

  constructor(
    @Inject(PLAID_CLIENT_TOKEN) private readonly plaid: PlaidApi,
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  /**
   * Mints a short-lived Plaid Link token bound to the requesting user
   * via client_user_id. The web app hands this to the Link drop-in;
   * the drop-in returns a public_token which exchange() converts to
   * a long-lived access_token.
   */
  async createLinkToken(userId: string): Promise<PlaidLinkToken> {
    const response = await this.plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Vellum',
      language: 'en',
      country_codes: [CountryCode.Us],
      products: [Products.Transactions],
    });
    return {
      linkToken: response.data.link_token,
      expiration: response.data.expiration,
    };
  }

  /**
   * Exchanges the Link public_token for a long-lived access_token,
   * seals it via the TokenCipher, fetches the account list, and
   * persists plaid_items + plaid_accounts in one transaction. ADR-0018
   * defers the first-time transactions/sync to the sync worker.
   */
  async exchange(userId: string, publicToken: string): Promise<{ itemId: string }> {
    const exchangeRes = await this.plaid.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchangeRes.data.access_token;
    const plaidItemId = exchangeRes.data.item_id;
    const accountsRes = await this.plaid.accountsGet({ access_token: accessToken });
    const institutionId = accountsRes.data.item.institution_id ?? null;
    const institutionName = await this.lookupInstitutionName(institutionId);

    const sealed = this.cipher.seal(accessToken);

    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .insert(plaidItems)
        .values({
          userId,
          plaidItemId,
          accessTokenCipher: sealed.cipher,
          accessTokenIv: sealed.iv,
          institutionId,
          institutionName,
        })
        .returning({ id: plaidItems.id });
      if (!item) throw new Error('failed to insert plaid_items');
      await tx.insert(plaidAccounts).values(
        accountsRes.data.accounts.map((a) => ({
          plaidItemId: item.id,
          plaidAccountId: a.account_id,
          name: a.name,
          officialName: a.official_name ?? null,
          type: a.type,
          subtype: a.subtype ?? null,
          mask: a.mask ?? null,
          currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? 'USD',
          currentBalanceMinor: toMinor(a.balances.current),
        })),
      );
      return { itemId: item.id };
    });
  }

  async listItems(userId: string): Promise<PlaidItemWithAccounts[]> {
    const items = await this.db
      .select({
        id: plaidItems.id,
        plaidItemId: plaidItems.plaidItemId,
        institutionName: plaidItems.institutionName,
        status: plaidItems.status,
        lastSyncAt: plaidItems.lastSyncAt,
        createdAt: plaidItems.createdAt,
      })
      .from(plaidItems)
      .where(eq(plaidItems.userId, userId));
    if (items.length === 0) return [];
    const accountRows = await this.db
      .select({
        id: plaidAccounts.id,
        plaidItemId: plaidAccounts.plaidItemId,
        plaidAccountId: plaidAccounts.plaidAccountId,
        name: plaidAccounts.name,
        officialName: plaidAccounts.officialName,
        type: plaidAccounts.type,
        subtype: plaidAccounts.subtype,
        mask: plaidAccounts.mask,
        currency: plaidAccounts.currency,
      })
      .from(plaidAccounts);
    const byItem = new Map<string, PlaidItemWithAccounts['accounts']>();
    for (const a of accountRows) {
      const list = byItem.get(a.plaidItemId) ?? [];
      list.push({
        id: a.id,
        plaidAccountId: a.plaidAccountId,
        name: a.name,
        officialName: a.officialName,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        currency: a.currency,
      });
      byItem.set(a.plaidItemId, list);
    }
    return items.map((item) => ({ ...item, accounts: byItem.get(item.id) ?? [] }));
  }

  /**
   * Revokes the access_token at Plaid, then deletes the local item.
   * Cascade FK takes accounts and transactions down with it. If the
   * Plaid revoke fails the local row stays — the operator can retry,
   * and we log the failure rather than orphan a live token.
   */
  async removeItem(userId: string, plaidItemRowId: string): Promise<void> {
    const [row] = await this.db
      .select({
        accessTokenCipher: plaidItems.accessTokenCipher,
        accessTokenIv: plaidItems.accessTokenIv,
      })
      .from(plaidItems)
      .where(and(eq(plaidItems.id, plaidItemRowId), eq(plaidItems.userId, userId)));
    if (!row) {
      throw new NotFoundException('plaid item not found');
    }
    const accessToken = this.cipher.open({
      cipher: row.accessTokenCipher,
      iv: row.accessTokenIv,
    });
    await this.plaid.itemRemove({ access_token: accessToken });
    await this.db.delete(plaidItems).where(eq(plaidItems.id, plaidItemRowId));
  }

  private async lookupInstitutionName(institutionId: string | null): Promise<string | null> {
    if (!institutionId) return null;
    try {
      const res = await this.plaid.institutionsGetById({
        institution_id: institutionId,
        country_codes: [CountryCode.Us],
      });
      return res.data.institution.name;
    } catch (err) {
      // Institution lookup is a nice-to-have; a sandbox fixture may not
      // resolve. Don't fail the exchange just because we can't pretty
      // the name; the operator can fill it later.
      this.logger.warn(
        `institutionsGetById failed for ${institutionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

function toMinor(amount: number | null | undefined): bigint | null {
  if (amount === null || amount === undefined) return null;
  // Plaid returns major-unit floats. Round to nearest cent. A future
  // ADR can switch to per-currency scale; v1 sandbox is USD.
  return BigInt(Math.round(amount * 100));
}
