import { z } from 'zod';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const accountTypeSchema = z.enum(ACCOUNT_TYPES);

export const SIDES = ['DEBIT', 'CREDIT'] as const;
export type Side = (typeof SIDES)[number];
export const sideSchema = z.enum(SIDES);

export const accountSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  type: accountTypeSchema,
  parentId: z.string().min(1).nullable(),
});

export type Account = z.infer<typeof accountSchema>;

const NORMAL_BALANCE: Record<AccountType, Side> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
};

export function normalBalanceFor(type: AccountType): Side {
  return NORMAL_BALANCE[type];
}
