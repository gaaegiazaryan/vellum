import { describe, it, expect, vi } from 'vitest';
import {
  ProviderTimeoutError,
  InvalidProviderResponseError,
  UnreadableImageError,
  BudgetExceededError,
} from '@vellum/extraction';
import { MockProvider } from '@vellum/extraction/providers/mock';
import { receiptSchema } from '@vellum/extraction';
import type { ExtractionProvider, ExtractionResult, ExtractionInput } from '@vellum/extraction';
import { ProviderRouter } from './provider-router.js';

const SAMPLE_IMAGE = 'aGVsbG8td29ybGQtaW1hZ2UtcGF5bG9hZA==';
const sample = receiptSchema.parse({
  vendor: { name: 'Blue Bottle' },
  occurredAt: '2026-05-20T08:00:00Z',
  currency: 'USD',
  subtotalMinor: '900',
  taxes: [{ name: 'tax', amountMinor: '79' }],
  totalMinor: '979',
  paymentMethod: 'card',
  lineItems: [{ description: 'cappuccino', quantity: 2, unitPriceMinor: '450', totalMinor: '900' }],
});

function mockOfName(name: string, model = `${name}-fixture`): MockProvider {
  const m = new MockProvider();
  Object.defineProperty(m, 'name', { value: name });
  Object.defineProperty(m, 'model', { value: model });
  m.stage(SAMPLE_IMAGE, { receipt: sample });
  return m;
}

function throwingProvider(name: string, err: unknown): ExtractionProvider {
  return {
    name,
    model: `${name}-fixture`,
    async extract(): Promise<ExtractionResult> {
      throw err;
    },
    predictedMaxCostUsd: () => '0.10',
  };
}

function input(): ExtractionInput {
  return { imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' };
}

describe('ProviderRouter', () => {
  it('returns the primary result with null fallback fields on the happy path', async () => {
    const primary = mockOfName('primary');
    const secondary = mockOfName('secondary');
    const spy = vi.spyOn(secondary, 'extract');
    const router = new ProviderRouter(primary, secondary);
    const result = await router.extract(input());
    expect(result.provider).toBe('primary');
    expect(result.fallbackFromProvider).toBeNull();
    expect(result.fallbackReason).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to the secondary on ProviderTimeoutError and records the reason', async () => {
    const primary = throwingProvider('primary', new ProviderTimeoutError('primary', 1000));
    const secondary = mockOfName('secondary');
    const router = new ProviderRouter(primary, secondary);
    const result = await router.extract(input());
    expect(result.provider).toBe('secondary');
    expect(result.fallbackFromProvider).toBe('primary');
    expect(result.fallbackReason).toBe('ProviderTimeoutError');
  });

  it('falls back on InvalidProviderResponseError', async () => {
    const primary = throwingProvider(
      'primary',
      new InvalidProviderResponseError('primary', 'garbage'),
    );
    const secondary = mockOfName('secondary');
    const router = new ProviderRouter(primary, secondary);
    const result = await router.extract(input());
    expect(result.provider).toBe('secondary');
    expect(result.fallbackReason).toBe('InvalidProviderResponseError');
  });

  it('does not fall back on UnreadableImageError (the input is the problem)', async () => {
    const primary = throwingProvider(
      'primary',
      new UnreadableImageError('image/png', 'empty image payload'),
    );
    const secondary = mockOfName('secondary');
    const spy = vi.spyOn(secondary, 'extract');
    const router = new ProviderRouter(primary, secondary);
    await expect(router.extract(input())).rejects.toBeInstanceOf(UnreadableImageError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fall back on BudgetExceededError', async () => {
    const primary = throwingProvider('primary', new BudgetExceededError('5.00', '5.10', 'system'));
    const secondary = mockOfName('secondary');
    const spy = vi.spyOn(secondary, 'extract');
    const router = new ProviderRouter(primary, secondary);
    await expect(router.extract(input())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rethrows the primary error when no secondary is configured', async () => {
    const primary = throwingProvider('primary', new ProviderTimeoutError('primary', 1000));
    const router = new ProviderRouter(primary, null);
    await expect(router.extract(input())).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('predictedMaxCostUsd sums primary plus secondary', () => {
    const primary = throwingProvider('p', new Error());
    const secondary = throwingProvider('s', new Error());
    const router = new ProviderRouter(primary, secondary);
    // 0.10 + 0.10
    expect(router.predictedMaxCostUsd()).toBe('0.200000');
  });

  it('predictedMaxCostUsd is just the primary when no secondary', () => {
    const primary = throwingProvider('p', new Error());
    const router = new ProviderRouter(primary, null);
    expect(router.predictedMaxCostUsd()).toBe('0.100000');
  });
});
