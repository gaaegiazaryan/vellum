import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, estimateCost } from './anthropic.js';
import { InvalidProviderResponseError, UnreadableImageError } from '../errors.js';

const SAMPLE_IMAGE = 'aGVsbG8td29ybGQtaW1hZ2UtcGF5bG9hZA==';

const validReceiptJson = JSON.stringify({
  vendor: { name: 'Blue Bottle' },
  occurredAt: '2026-05-19T08:00:00Z',
  currency: 'USD',
  subtotalMinor: '900',
  taxes: [{ name: 'tax', amountMinor: '79' }],
  totalMinor: '979',
  paymentMethod: 'card',
  lineItems: [{ description: 'cappuccino', quantity: 2, unitPriceMinor: '450', totalMinor: '900' }],
});

function fakeClient(opts: {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: Anthropic.Message['stop_reason'];
}): Anthropic {
  return {
    messages: {
      async create() {
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20251022',
          stop_reason: opts.stopReason ?? 'end_turn',
          stop_sequence: null,
          content: [{ type: 'text', text: opts.text, citations: null }],
          usage: {
            input_tokens: opts.inputTokens ?? 1200,
            output_tokens: opts.outputTokens ?? 350,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

function failingClient(message: string): Anthropic {
  return {
    messages: {
      async create() {
        throw new Error(message);
      },
    },
  } as unknown as Anthropic;
}

describe('AnthropicProvider.extract', () => {
  it('parses a valid JSON response into a Receipt', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: validReceiptJson }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt.vendor.name).toBe('Blue Bottle');
    expect(result.receipt.totalMinor).toBe('979');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5-20251022');
    expect(result.confidence).toBe(0.9);
    expect(result.cost.inputTokens).toBe(1200);
    expect(result.cost.outputTokens).toBe(350);
    expect(result.cost.estimatedUsd).toBe('0.008850');
    expect(result.rawResponseHash).toHaveLength(64);
  });

  it('strips a ```json fence around the model output', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: '```json\n' + validReceiptJson + '\n```' }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt.vendor.name).toBe('Blue Bottle');
  });

  it('throws UnreadableImageError on an empty image payload', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    await expect(provider.extract({ imageBase64: '', mimeType: 'image/png' })).rejects.toThrow(
      UnreadableImageError,
    );
  });

  it('throws UnreadableImageError on an unsupported mime type', async () => {
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    await expect(
      provider.extract({
        imageBase64: SAMPLE_IMAGE,
        mimeType: 'image/gif' as 'image/png',
      }),
    ).rejects.toThrow(UnreadableImageError);
  });

  it('rejects pdf at runtime (path not yet implemented)', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: validReceiptJson }),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'application/pdf' }),
    ).rejects.toThrow();
  });

  it('throws InvalidProviderResponseError when the model returns non-JSON', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: 'hello, here is your receipt!' }),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('throws InvalidProviderResponseError when the JSON does not match receiptSchema', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: JSON.stringify({ vendor: 'string-not-object' }) }),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('wraps unknown sdk errors as InvalidProviderResponseError', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: failingClient('rate limit exceeded'),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('returns lower confidence when the response was truncated by max_tokens', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: validReceiptJson, stopReason: 'max_tokens' }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.confidence).toBe(0.4);
  });
});

describe('estimateCost', () => {
  it('computes USD against the known model rate', () => {
    const c = estimateCost('claude-sonnet-4-5-20251022', 1_000_000, 1_000_000);
    expect(c.estimatedUsd).toBe('18.000000');
  });

  it('returns zero usd for an unknown model so callers can detect the gap', () => {
    const c = estimateCost('made-up-model', 1000, 500);
    expect(c.estimatedUsd).toBe('0');
  });

  it('handles small token counts with 6-digit precision', () => {
    const c = estimateCost('claude-sonnet-4-5-20251022', 1200, 350);
    expect(c.estimatedUsd).toBe('0.008850');
  });

  it('preserves model token counts as-is', () => {
    const c = estimateCost('claude-sonnet-4-5-20251022', 1200, 350);
    expect(c.inputTokens).toBe(1200);
    expect(c.outputTokens).toBe(350);
  });
});

describe('AnthropicProvider.predictedMaxCostUsd', () => {
  it('uses the configured model rates for the per-call upper bound', () => {
    const sonnet = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5-20251022',
    });
    // 2500 input * 3 / 1M + 2048 output * 15 / 1M = 0.007500 + 0.030720 = 0.038220
    expect(sonnet.predictedMaxCostUsd()).toBe('0.038220');
  });

  it('haiku predicts a smaller upper bound than sonnet', () => {
    const haiku = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-20251022' });
    const sonnet = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5-20251022',
    });
    expect(Number(haiku.predictedMaxCostUsd())).toBeLessThan(Number(sonnet.predictedMaxCostUsd()));
  });

  it('falls back to the most expensive priced model for unknown names', () => {
    const unknown = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-future-edition-2099',
    });
    // opus is the most expensive: 2500*15/1M + 2048*75/1M = 0.0375 + 0.1536 = 0.191100
    expect(unknown.predictedMaxCostUsd()).toBe('0.191100');
  });
});
