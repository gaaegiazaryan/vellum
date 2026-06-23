import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PlaidApi } from 'plaid';
import { eq, isNull, lt, or } from 'drizzle-orm';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { bankTransactions, plaidAccounts, plaidItems } from '../db/schema/plaid.js';
import { TokenCipher } from './token-cipher.js';
import { PLAID_CLIENT_TOKEN } from './plaid-client.js';
import { SYNC_FRESHNESS_WINDOW_MS } from './plaid-sync.queue.js';

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  datetime: string | null;
  authorized_date: string | null;
  authorized_datetime: string | null;
  name: string;
  merchant_name: string | null;
}

interface SyncSummary {
  added: number;
  modified: number;
  removed: number;
  finalCursor: string;
  paged: number;
}

/**
 * Cursor-based transactions/sync for one Plaid item (ADR-0018).
 *
 * Plaid's /transactions/sync is the supported delta endpoint: each call
 * returns added/modified/removed sets since the stored cursor, and a
 * fresh next_cursor. We loop until has_more is false so a single tick
 * drains the whole backlog (Plaid pages at 500 transactions). All
 * writes for one page commit in a single tx along with the new cursor;
 * an interruption between pages just resumes from the persisted cursor
 * on the next tick.
 */
@Injectable()
export class PlaidSyncService {
  private readonly logger = new Logger(PlaidSyncService.name);

  constructor(
    @Inject(PLAID_CLIENT_TOKEN) private readonly plaid: PlaidApi,
    @Inject(DATABASE_TOKEN) private readonly db: Db,
    private readonly cipher: TokenCipher,
  ) {}

  async syncItem(plaidItemRowId: string): Promise<SyncSummary> {
    const [item] = await this.db
      .select({
        id: plaidItems.id,
        accessTokenCipher: plaidItems.accessTokenCipher,
        accessTokenIv: plaidItems.accessTokenIv,
        cursor: plaidItems.lastSyncCursor,
      })
      .from(plaidItems)
      .where(eq(plaidItems.id, plaidItemRowId));
    if (!item) {
      throw new Error(`plaid item ${plaidItemRowId} not found`);
    }
    const accessToken = this.cipher.open({
      cipher: item.accessTokenCipher,
      iv: item.accessTokenIv,
    });
    const accountIdByPlaidAccountId = await this.loadAccountIdMap(plaidItemRowId);

    let cursor = item.cursor ?? '';
    let added = 0;
    let modified = 0;
    let removed = 0;
    let paged = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await this.plaid.transactionsSync({ access_token: accessToken, cursor });
      paged += 1;
      const page = res.data;
      await this.db.transaction(async (tx) => {
        if (page.added.length > 0) {
          await tx
            .insert(bankTransactions)
            .values(
              page.added
                .map((t) => toRow(t as PlaidTransaction, accountIdByPlaidAccountId))
                .filter((r): r is NonNullable<typeof r> => r !== null),
            )
            .onConflictDoNothing({ target: bankTransactions.plaidTransactionId });
        }
        if (page.modified.length > 0) {
          for (const t of page.modified as PlaidTransaction[]) {
            const row = toRow(t, accountIdByPlaidAccountId);
            if (!row) continue;
            await tx
              .update(bankTransactions)
              .set({
                occurredAt: row.occurredAt,
                amountMinor: row.amountMinor,
                currency: row.currency,
                merchantName: row.merchantName,
                description: row.description,
                raw: row.raw,
              })
              .where(eq(bankTransactions.plaidTransactionId, row.plaidTransactionId));
          }
        }
        if (page.removed.length > 0) {
          for (const r of page.removed) {
            await tx
              .delete(bankTransactions)
              .where(eq(bankTransactions.plaidTransactionId, r.transaction_id));
          }
        }
        await tx
          .update(plaidItems)
          .set({ lastSyncCursor: page.next_cursor, lastSyncAt: new Date() })
          .where(eq(plaidItems.id, plaidItemRowId));
      });
      added += page.added.length;
      modified += page.modified.length;
      removed += page.removed.length;
      cursor = page.next_cursor;
      hasMore = page.has_more;
    }
    this.logger.log(
      `plaid item ${plaidItemRowId}: added=${added} modified=${modified} removed=${removed} pages=${paged}`,
    );
    return { added, modified, removed, finalCursor: cursor, paged };
  }

  /**
   * Items due for a tick: last_sync_at is null (never synced) or older
   * than the freshness window. Returned newest-first so a hot operator
   * dashboard does not block on a stale long-tail.
   */
  async dueItems(now: Date = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - SYNC_FRESHNESS_WINDOW_MS);
    const rows = await this.db
      .select({ id: plaidItems.id })
      .from(plaidItems)
      .where(or(isNull(plaidItems.lastSyncAt), lt(plaidItems.lastSyncAt, cutoff)));
    return rows.map((r) => r.id);
  }

  private async loadAccountIdMap(plaidItemRowId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ id: plaidAccounts.id, plaidAccountId: plaidAccounts.plaidAccountId })
      .from(plaidAccounts)
      .where(eq(plaidAccounts.plaidItemId, plaidItemRowId));
    return new Map(rows.map((r) => [r.plaidAccountId, r.id]));
  }
}

function toRow(t: PlaidTransaction, accountIdByPlaidAccountId: Map<string, string>) {
  const accountRowId = accountIdByPlaidAccountId.get(t.account_id);
  if (!accountRowId) {
    // Plaid sometimes emits a transaction for an account it has not
    // announced in /accounts/get yet. Skipping is correct; the next
    // exchange or a future /accounts/get refresh will reconcile.
    return null;
  }
  const occurredAt = parseOccurredAt(t);
  // Plaid's amount sign: positive = outflow (debit from the account).
  // We store the absolute value; the matching ADR derives direction
  // from the sign in raw_jsonb so we do not lose information.
  const amountMinor = BigInt(Math.round(Math.abs(t.amount) * 100));
  return {
    plaidAccountId: accountRowId,
    plaidTransactionId: t.transaction_id,
    occurredAt,
    amountMinor,
    currency: t.iso_currency_code ?? t.unofficial_currency_code ?? 'USD',
    merchantName: t.merchant_name,
    description: t.name,
    raw: t as unknown as object,
  };
}

function parseOccurredAt(t: PlaidTransaction): Date {
  // datetime is most precise; authorized_datetime is next; date is the
  // floor. All are ISO-8601 (date is YYYY-MM-DD). Plaid sandbox returns
  // date only in most cases.
  const iso = t.datetime ?? t.authorized_datetime ?? t.date;
  return new Date(iso);
}
