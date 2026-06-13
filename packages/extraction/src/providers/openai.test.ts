import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { OpenAIProvider, estimateCost } from './openai.js';
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
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'];
}): OpenAI {
  return {
    chat: {
      completions: {
        async create() {
          return {
            id: 'chatcmpl_1',
            object: 'chat.completion',
            created: 1718000000,
            model: 'gpt-4o-2024-11-20',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: opts.text, refusal: null },
                logprobs: null,
                finish_reason: opts.finishReason ?? 'stop',
              },
            ],
            usage: {
              prompt_tokens: opts.promptTokens ?? 1200,
              completion_tokens: opts.completionTokens ?? 350,
              total_tokens: (opts.promptTokens ?? 1200) + (opts.completionTokens ?? 350),
            },
          } as OpenAI.Chat.Completions.ChatCompletion;
        },
      },
    },
  } as unknown as OpenAI;
}

function failingClient(message: string): OpenAI {
  return {
    chat: {
      completions: {
        async create() {
          throw new Error(message);
        },
      },
    },
  } as unknown as OpenAI;
}

describe('OpenAIProvider.extract', () => {
  it('parses a valid JSON response into a Receipt', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: validReceiptJson }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt.vendor.name).toBe('Blue Bottle');
    expect(result.receipt.totalMinor).toBe('979');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-2024-11-20');
    expect(result.confidence).toBe(0.9);
    expect(result.cost.inputTokens).toBe(1200);
    expect(result.cost.outputTokens).toBe(350);
    expect(result.cost.estimatedUsd).toBe('0.006500');
    expect(result.rawResponseHash).toHaveLength(64);
  });

  it('strips a ```json fence when the model includes one', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: '```json\n' + validReceiptJson + '\n```' }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.receipt.vendor.name).toBe('Blue Bottle');
  });

  it('throws UnreadableImageError on empty payload', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    await expect(provider.extract({ imageBase64: '', mimeType: 'image/png' })).rejects.toThrow(
      UnreadableImageError,
    );
  });

  it('throws UnreadableImageError on an unsupported mime type', async () => {
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    await expect(
      provider.extract({
        imageBase64: SAMPLE_IMAGE,
        mimeType: 'image/gif' as 'image/png',
      }),
    ).rejects.toThrow(UnreadableImageError);
  });

  it('throws InvalidProviderResponseError on non-JSON content', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: 'sure, here is your receipt!' }),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('throws InvalidProviderResponseError when JSON does not match receiptSchema', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: JSON.stringify({ vendor: 'string-not-object' }) }),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('wraps generic sdk errors as InvalidProviderResponseError', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: failingClient('rate limit exceeded'),
    });
    await expect(
      provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' }),
    ).rejects.toThrow(InvalidProviderResponseError);
  });

  it('returns lower confidence when finish_reason is length (truncated)', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      client: fakeClient({ text: validReceiptJson, finishReason: 'length' }),
    });
    const result = await provider.extract({ imageBase64: SAMPLE_IMAGE, mimeType: 'image/png' });
    expect(result.confidence).toBe(0.4);
  });
});

describe('OpenAIProvider.estimateCost', () => {
  it('computes against the gpt-4o rate', () => {
    const c = estimateCost('gpt-4o-2024-11-20', 1_000_000, 1_000_000);
    expect(c.estimatedUsd).toBe('12.500000');
  });

  it('falls back to 0 USD on an unknown model', () => {
    const c = estimateCost('made-up-model', 1000, 500);
    expect(c.estimatedUsd).toBe('0');
  });
});

describe('OpenAIProvider.predictedMaxCostUsd', () => {
  it('mirrors AnthropicProvider shape with gpt-4o rates', () => {
    // 2500 input * 2.5 / 1M + 2048 output * 10 / 1M = 0.006250 + 0.020480 = 0.026730
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-2024-11-20' });
    expect(p.predictedMaxCostUsd()).toBe('0.026730');
  });

  it('gpt-4o-mini predicts a smaller upper bound than gpt-4o', () => {
    const mini = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini-2024-07-18' });
    const big = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-2024-11-20' });
    expect(Number(mini.predictedMaxCostUsd())).toBeLessThan(Number(big.predictedMaxCostUsd()));
  });

  it('falls back to the most expensive priced model for unknown names', () => {
    const u = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-future-edition-2099' });
    // gpt-4o is the most expensive priced row: 2500*2.5/1M + 2048*10/1M = 0.026730
    expect(u.predictedMaxCostUsd()).toBe('0.026730');
  });
});
