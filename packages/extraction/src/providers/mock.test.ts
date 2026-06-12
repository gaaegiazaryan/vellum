import { describe, it, expect } from 'vitest';
import { MockProvider } from './mock.js';
import { InvalidProviderResponseError, UnreadableImageError } from '../errors.js';
import { receiptSchema } from '../receipt.js';

const coffeeReceipt = receiptSchema.parse({
  vendor: { name: 'Blue Bottle' },
  occurredAt: '2026-05-19T08:00:00Z',
  currency: 'USD',
  subtotalMinor: '900',
  taxes: [{ name: 'tax', amountMinor: '79' }],
  totalMinor: '979',
  paymentMethod: 'card',
  lineItems: [{ description: 'cappuccino', quantity: 2, unitPriceMinor: '450', totalMinor: '900' }],
});

const SAMPLE_IMAGE = 'aGVsbG8td29ybGQtaW1hZ2UtcGF5bG9hZA==';

describe('MockProvider', () => {
  it('returns a staged receipt for a known image', async () => {
    const provider = new MockProvider([
      { imageBase64: SAMPLE_IMAGE, entry: { receipt: coffeeReceipt } },
    ]);
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt).toEqual(coffeeReceipt);
    expect(result.provider).toBe('mock');
    expect(result.model).toBe('mock-fixture');
    expect(result.confidence).toBe(1);
    expect(result.cost).toEqual({ inputTokens: 0, outputTokens: 0, estimatedUsd: '0' });
    expect(result.extractedAt).toBeInstanceOf(Date);
    expect(typeof result.rawResponseHash).toBe('string');
  });

  it('uses staged confidence and cost when provided', async () => {
    const provider = new MockProvider([
      {
        imageBase64: SAMPLE_IMAGE,
        entry: {
          receipt: coffeeReceipt,
          confidence: 0.82,
          cost: { inputTokens: 1200, outputTokens: 350, estimatedUsd: '0.0042' },
        },
      },
    ]);
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.confidence).toBe(0.82);
    expect(result.cost.estimatedUsd).toBe('0.0042');
    expect(result.cost.inputTokens).toBe(1200);
  });

  it('throws InvalidProviderResponseError on an unknown image', async () => {
    const provider = new MockProvider();
    await expect(
      provider.extract({ imageBase64: 'unknown-image-data', mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('throws UnreadableImageError on an empty payload', async () => {
    const provider = new MockProvider();
    await expect(provider.extract({ imageBase64: '', mimeType: 'image/png' })).rejects.toThrow(
      UnreadableImageError,
    );
  });

  it('can stage entries after construction', async () => {
    const provider = new MockProvider();
    provider.stage(SAMPLE_IMAGE, { receipt: coffeeReceipt });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt.vendor.name).toBe('Blue Bottle');
  });

  it('produces deterministic rawResponseHash for the same image bytes', async () => {
    const provider = new MockProvider();
    provider.stage(SAMPLE_IMAGE, { receipt: coffeeReceipt });
    const a = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    const b = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(a.rawResponseHash).toBe(b.rawResponseHash);
  });

  it('rawResponseHash differs across distinct images', async () => {
    const provider = new MockProvider();
    provider.stage(SAMPLE_IMAGE, { receipt: coffeeReceipt });
    provider.stage('different-image-bytes', { receipt: coffeeReceipt });
    const a = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    const b = await provider.extract({
      imageBase64: 'different-image-bytes',
      mimeType: 'image/png',
    });
    expect(a.rawResponseHash).not.toBe(b.rawResponseHash);
  });

  it('predictedMaxCostUsd is "0" so mock never blocks the budget', () => {
    expect(new MockProvider().predictedMaxCostUsd()).toBe('0');
  });
});
