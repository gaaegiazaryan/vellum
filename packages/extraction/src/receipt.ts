import { z } from 'zod';
import { lineItemSchema } from './line-item.js';

/**
 * The structured shape we expect a vision LLM to return for a receipt
 * or invoice. Designed to be stable across model versions: providers
 * may add fields in their raw response, but our schema fixes the
 * contract.
 *
 * Money is minor units as a string. The subtotal/tax/total relationship
 * is NOT enforced by the schema — vision models routinely miscount and
 * we want to surface the disagreement rather than reject it. Downstream
 * code can check `subtotal + tax === total` and flag the receipt for
 * human review when it does not.
 *
 * Currency is the same 3-letter ISO 4217 code we use everywhere.
 */
export const receiptTaxSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rate: z.number().finite().nonnegative().optional(),
  amountMinor: z
    .string()
    .regex(/^\d+$/, 'tax amountMinor must be a non-negative integer in minor units'),
});

export type ReceiptTax = z.infer<typeof receiptTaxSchema>;

export const receiptSchema = z.object({
  vendor: z.object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).optional(),
    taxId: z.string().trim().max(120).optional(),
  }),
  occurredAt: z.coerce.date(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
  subtotalMinor: z
    .string()
    .regex(/^\d+$/, 'subtotalMinor must be a non-negative integer in minor units'),
  taxes: z.array(receiptTaxSchema).default([]),
  totalMinor: z.string().regex(/^\d+$/, 'totalMinor must be a non-negative integer in minor units'),
  paymentMethod: z.enum(['cash', 'card', 'transfer', 'check', 'other']).optional(),
  lineItems: z.array(lineItemSchema).min(1, 'a receipt must have at least one line item'),
  rawNotes: z.string().trim().max(2000).optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;

/**
 * Sum of `subtotalMinor + taxes.amountMinor` should equal `totalMinor`.
 * Vision models miscount. This helper returns the mismatch in minor
 * units; callers decide whether to accept, surface for review, or
 * reject based on confidence + magnitude.
 */
export function receiptTotalMismatch(receipt: Receipt): bigint {
  let computed = BigInt(receipt.subtotalMinor);
  for (const tax of receipt.taxes) {
    computed += BigInt(tax.amountMinor);
  }
  return computed - BigInt(receipt.totalMinor);
}
