import type { Receipt } from './receipt.js';

/**
 * Image bytes plus the metadata the provider needs to interpret them.
 * Pre-alpha takes a base64 string because that is what comes out of
 * file inputs in the browser and is easy to forward through a server
 * action. A streaming or Buffer-based variant is on the table when we
 * wire the receipt-upload endpoint.
 */
export interface ExtractionInput {
  imageBase64: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
  context?: ExtractionContext;
}

/**
 * Hints we hand the provider to improve accuracy. The provider is free
 * to ignore these; they are not enforced post-extraction.
 */
export interface ExtractionContext {
  expectedCurrency?: string;
  locale?: string;
  vendorHint?: string;
}

/**
 * What every provider returns. The receipt is the canonical shape from
 * receiptSchema; everything else is metadata the audit log persists.
 *
 * confidence is the provider's self-reported 0..1 score. Different
 * providers calibrate differently; we store as-is and the application
 * decides thresholds.
 *
 * rawResponseHash lets us tie an extraction back to the underlying
 * model response without persisting the response itself. We hash to
 * a fixed length so the audit log row stays small; the raw response
 * is stored separately (object storage, later) under the same hash.
 */
export interface ExtractionResult {
  receipt: Receipt;
  confidence: number;
  provider: string;
  model: string;
  cost: CostBreakdown;
  extractedAt: Date;
  rawResponseHash?: string;
}

/**
 * Per-call cost. Tokens are model-native counts; estimatedUsd is
 * computed at the provider layer using a per-model rate table. We
 * keep both so a future rate change can be replayed against historical
 * token counts.
 *
 * estimatedUsd is a string decimal (not a number) for the same reason
 * Money is bigint elsewhere: floating point and money disagree, and we
 * accumulate these across thousands of calls.
 */
export interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: string;
}

/**
 * The contract every concrete provider implements. Kept small on
 * purpose: routing, retries, fallback are the application's job, not
 * the provider's. A provider extracts a single receipt or throws an
 * ExtractionError.
 */
export interface ExtractionProvider {
  readonly name: string;
  readonly model: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;

  /**
   * Worst-case per-call cost the provider can incur in USD, returned as
   * a non-negative decimal string. The budget check at enqueue uses this
   * to refuse the call when (already-spent + predicted) would breach the
   * cap, closing the race where the cap had a few cents of headroom and
   * each in-flight job would tip it over (ADR-0011 known limit #2).
   *
   * Implementations should return a deliberately conservative number
   * for a vision call (image input plus max output tokens). The mock
   * provider returns "0".
   */
  predictedMaxCostUsd(): string;
}
