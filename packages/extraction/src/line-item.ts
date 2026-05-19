import { z } from 'zod';

/**
 * A single line on a receipt or invoice. Money fields are minor units
 * (string) so we never bottle bigint into a number; the calling code
 * round-trips through @vellum/core's Money when it needs arithmetic.
 *
 * Quantity is a decimal because real receipts have "2.5 kg" or "1.25 hours".
 * It is not a fraction or bigint because we never sum quantities across
 * lines into a single value the way we sum amounts.
 *
 * Category is intentionally a free string at the extraction layer; the
 * application maps it to a chart-of-accounts code through a separate
 * categorisation step (Day 8+).
 */
export const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().finite().positive().default(1),
  unitPriceMinor: z
    .string()
    .regex(/^\d+$/, 'unitPriceMinor must be a non-negative integer in minor units'),
  totalMinor: z.string().regex(/^\d+$/, 'totalMinor must be a non-negative integer in minor units'),
  category: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(500).optional(),
});

export type LineItem = z.infer<typeof lineItemSchema>;
