import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import {
  InvalidProviderResponseError,
  ProviderTimeoutError,
  UnreadableImageError,
} from '../errors.js';
import type {
  CostBreakdown,
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from '../provider.js';
import { receiptSchema, type Receipt } from '../receipt.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, USER_INSTRUCTION } from './anthropic-prompt.js';

/**
 * USD per million tokens. Source: openai pricing page as of 2026-06;
 * verify before pinning a production model. Historical extractions
 * pin to their captured CostBreakdown so editing this table is safe
 * across deploys.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-2024-11-20': { input: 2.5, output: 10 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
};

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  client?: OpenAI;
}

const DEFAULT_MODEL = 'gpt-4o-2024-11-20';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

const ALLOWED_MIME: ReadonlyArray<ExtractionInput['mimeType']> = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/**
 * Concrete provider against the OpenAI chat-completions vision API.
 * Shares the receipt schema, prompt, and CostBreakdown shape with
 * AnthropicProvider so the router can swap them at runtime without
 * downstream code changing (ADR-0015).
 *
 * Validation parity with AnthropicProvider: empty image, unsupported
 * mime, non-JSON response, and schema mismatch all surface as the
 * existing typed errors so the router can decide retryability the
 * same way regardless of which provider raised.
 */
export class OpenAIProvider implements ExtractionProvider {
  readonly name = 'openai';
  readonly model: string;

  private readonly client: OpenAI;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey && !opts.client) {
      throw new Error('OpenAIProvider requires either apiKey or client');
    }
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: this.timeoutMs });
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (input.imageBase64.length === 0) {
      throw new UnreadableImageError(input.mimeType, 'empty image payload');
    }
    if (!ALLOWED_MIME.includes(input.mimeType)) {
      throw new UnreadableImageError(input.mimeType, 'mime type not supported by the model');
    }

    const userText = buildUserText(input);
    const dataUrl = `data:${input.mimeType};base64,${input.imageBase64}`;

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: userText },
            ],
          },
        ],
      });
    } catch (err) {
      if (err instanceof Error && /timeout/i.test(err.message)) {
        throw new ProviderTimeoutError(this.name, this.timeoutMs);
      }
      throw new InvalidProviderResponseError(
        this.name,
        err instanceof Error ? err.message : String(err),
      );
    }

    const rawText = extractTextContent(response);
    const receipt = parseReceiptFromJson(this.name, rawText);
    const cost = estimateCost(
      this.model,
      response.usage?.prompt_tokens ?? 0,
      response.usage?.completion_tokens ?? 0,
    );

    return {
      receipt,
      confidence: estimateConfidence(response.choices[0]?.finish_reason),
      provider: this.name,
      model: this.model,
      cost,
      extractedAt: new Date(),
      rawResponseHash: createHash('sha256').update(rawText).digest('hex'),
    };
  }

  /**
   * Same shape as AnthropicProvider.predictedMaxCostUsd (ADR-0011
   * known limit #2): 2500 input tokens for an image + text prompt is
   * a conservative upper bound; output is the configured maxTokens.
   * Unknown model falls back to the most expensive priced row.
   */
  predictedMaxCostUsd(): string {
    const inputTokensEstimate = 2500;
    const rates = PRICING[this.model] ?? worstCaseRates();
    const usd =
      (inputTokensEstimate * rates.input) / 1_000_000 + (this.maxTokens * rates.output) / 1_000_000;
    return usd.toFixed(6);
  }
}

function buildUserText(input: ExtractionInput): string {
  const hints: string[] = [];
  if (input.context?.expectedCurrency) {
    hints.push(`The expected currency is ${input.context.expectedCurrency}.`);
  }
  if (input.context?.locale) {
    hints.push(`The locale is ${input.context.locale}.`);
  }
  if (input.context?.vendorHint) {
    hints.push(`The vendor is likely ${input.context.vendorHint}.`);
  }
  return [USER_INSTRUCTION, ...hints].join(' ');
}

function extractTextContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
  const text = response.choices[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new InvalidProviderResponseError('openai', 'response contained no text content');
  }
  return text;
}

function parseReceiptFromJson(provider: string, raw: string): Receipt {
  const trimmed = stripJsonFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new InvalidProviderResponseError(
      provider,
      `model returned non-JSON text: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = receiptSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidProviderResponseError(
      provider,
      `model JSON did not match receipt schema: ${result.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return result.data;
}

function stripJsonFence(s: string): string {
  // response_format: json_object should prevent fences, but the model
  // occasionally still wraps in ```json ... ```. Strip defensively.
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s.trim());
  return fenceMatch?.[1] ?? s;
}

function estimateConfidence(reason: string | null | undefined): number {
  // Project finish_reason into a 0..1 band, mirroring the Anthropic
  // confidence projection so confidence is comparable across providers.
  switch (reason) {
    case 'stop':
      return 0.9;
    case 'length':
      return 0.4;
    case 'content_filter':
      return 0.3;
    default:
      return 0.5;
  }
}

function worstCaseRates(): { input: number; output: number } {
  let worst = { input: 0, output: 0 };
  for (const r of Object.values(PRICING)) {
    if (r.input + r.output > worst.input + worst.output) worst = r;
  }
  return worst;
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const rates = PRICING[model];
  if (!rates) {
    return { inputTokens, outputTokens, estimatedUsd: '0' };
  }
  const usd = (inputTokens * rates.input) / 1_000_000 + (outputTokens * rates.output) / 1_000_000;
  return { inputTokens, outputTokens, estimatedUsd: usd.toFixed(6) };
}

export { PROMPT_VERSION };
