import { createHash } from 'node:crypto';
import { InvalidProviderResponseError, UnreadableImageError } from '../errors.js';
import type {
  CostBreakdown,
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from '../provider.js';
import type { Receipt } from '../receipt.js';

export interface MockProviderEntry {
  receipt: Receipt;
  confidence?: number;
  cost?: CostBreakdown;
}

/**
 * Test-only provider. Keyed by the SHA-256 of the input image bytes
 * so callers can pre-stage a fixed response for a known image.
 *
 * Used in:
 * - Unit tests that exercise downstream code without API costs
 * - Local dev where you want a deterministic response
 * - Demo deploys where the AI is intentionally a stub
 *
 * Not exported from the package root by default to avoid accidental
 * production use; import directly from `@vellum/extraction/providers/mock`.
 */
export class MockProvider implements ExtractionProvider {
  readonly name = 'mock';
  readonly model = 'mock-fixture';

  private readonly entries: Map<string, MockProviderEntry>;
  private readonly defaultCost: CostBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: '0',
  };

  constructor(fixtures: Array<{ imageBase64: string; entry: MockProviderEntry }> = []) {
    this.entries = new Map(fixtures.map((f) => [hash(f.imageBase64), f.entry]));
  }

  /**
   * Stage a response for a future call. Useful when tests need to
   * arrange the provider after construction.
   */
  stage(imageBase64: string, entry: MockProviderEntry): void {
    this.entries.set(hash(imageBase64), entry);
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (input.imageBase64.length === 0) {
      throw new UnreadableImageError(input.mimeType, 'empty image payload');
    }
    const key = hash(input.imageBase64);
    const entry = this.entries.get(key);
    if (!entry) {
      throw new InvalidProviderResponseError(
        this.name,
        `no fixture staged for image hash ${key.slice(0, 12)}...`,
      );
    }
    return {
      receipt: entry.receipt,
      confidence: entry.confidence ?? 1,
      provider: this.name,
      model: this.model,
      cost: entry.cost ?? this.defaultCost,
      extractedAt: new Date(),
      rawResponseHash: key,
    };
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
