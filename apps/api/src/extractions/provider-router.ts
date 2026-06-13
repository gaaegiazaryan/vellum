import { ProviderTimeoutError, InvalidProviderResponseError } from '@vellum/extraction';
import type { ExtractionInput, ExtractionProvider, ExtractionResult } from '@vellum/extraction';

/**
 * Primary-with-fallback wrapper per ADR-0015. Calls the primary
 * provider; if it throws a retryable infrastructure error, calls the
 * secondary once. Non-retryable errors (image / schema / budget) are
 * final on the primary attempt because the input itself is the
 * problem and a second provider will fail the same way.
 *
 * Exposes the primary as `name` and `model` so existing audit columns
 * keep their meaning when the happy path runs. The fallback case
 * surfaces the actual response producer through the ExtractionResult
 * (which carries its own provider/model) plus the new fallback fields
 * on the row.
 */
export interface RoutedExtractionResult extends ExtractionResult {
  fallbackFromProvider: string | null;
  fallbackReason: string | null;
}

export class ProviderRouter implements ExtractionProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly primary: ExtractionProvider,
    private readonly secondary: ExtractionProvider | null,
  ) {
    this.name = primary.name;
    this.model = primary.model;
  }

  async extract(input: ExtractionInput): Promise<RoutedExtractionResult> {
    try {
      const result = await this.primary.extract(input);
      return { ...result, fallbackFromProvider: null, fallbackReason: null };
    } catch (err) {
      if (!this.secondary || !isRetryableInfraError(err)) {
        throw err;
      }
      const fallbackReason = err instanceof Error ? err.name : 'UnknownError';
      const result = await this.secondary.extract(input);
      return {
        ...result,
        fallbackFromProvider: this.primary.name,
        fallbackReason,
      };
    }
  }

  /**
   * Worst-case across both providers. The cap should not be tipped
   * silently by the fallback path (ADR-0015 + ADR-0011 limit #2).
   */
  predictedMaxCostUsd(): string {
    const a = Number(this.primary.predictedMaxCostUsd());
    const b = this.secondary ? Number(this.secondary.predictedMaxCostUsd()) : 0;
    return (a + b).toFixed(6);
  }
}

function isRetryableInfraError(err: unknown): boolean {
  return err instanceof ProviderTimeoutError || err instanceof InvalidProviderResponseError;
}
