import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DATABASE_TOKEN, type Db } from '../db/database.module.js';
import { accounts } from '../db/schema/ledger.js';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;

export const createAccountSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().uuid().nullable().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  parentId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class AccountsService {
  constructor(@Inject(DATABASE_TOKEN) private readonly db: Db) {}

  async create(input: CreateAccountInput): Promise<AccountRow> {
    if (input.parentId) {
      const parent = await this.findById(input.parentId);
      if (!parent) {
        throw new NotFoundException(`parent account ${input.parentId} does not exist`);
      }
    }

    try {
      const [row] = await this.db
        .insert(accounts)
        .values({
          code: input.code,
          name: input.name,
          type: input.type,
          parentId: input.parentId ?? null,
        })
        .returning();
      if (!row) throw new Error('insert returned no row');
      return row as AccountRow;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`account code ${JSON.stringify(input.code)} already exists`);
      }
      throw err;
    }
  }

  async findAll(): Promise<AccountRow[]> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(sql`${accounts.archivedAt} is null`)
      .orderBy(asc(accounts.code));
    return rows as AccountRow[];
  }

  async findById(id: string): Promise<AccountRow | null> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return (rows[0] as AccountRow | undefined) ?? null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
