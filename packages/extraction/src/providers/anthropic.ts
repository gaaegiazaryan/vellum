import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
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
 * Per-million-token rates for the models we use. Editing this table
 * is the right move when prices change; historical extractions stay
 * pinned to their captured cost via the stored CostBreakdown.
 *
 * Numbers in USD per million tokens. Source: anthropic pricing page
 * as of 2026-05; verify before pinning a production model.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20251022': { input: 3, output: 15 },
  'claude-haiku-4-20251022': { input: 0.8, output: 4 },
  'claude-opus-4-20251022': { input: 15, output: 75 },
};

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  client?: Anthropic;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20251022';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

const ALLOWED_MIME: ReadonlyArray<ExtractionInput['mimeType']> = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
];

/**
 * Concrete provider against Anthropic's vision API. Uses the
 * messages.create endpoint with a base64-encoded image block plus a
 * text instruction. Parses the model's JSON output and validates
 * against receiptSchema before returning.
 *
 * Cost is computed from the response's usage.input_tokens and
 * usage.output_tokens against the PRICING table. estimatedUsd is
 * returned as a decimal string with 6 significant digits, which is
 * enough resolution for individual calls and accumulates cleanly.
 */
export class AnthropicProvider implements ExtractionProvider {
  readonly name = 'anthropic';
  readonly model: string;

  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey && !opts.client) {
      throw new Error('AnthropicProvider requires either apiKey or client');
    }
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: this.timeoutMs });
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (input.imageBase64.length === 0) {
      throw new UnreadableImageError(input.mimeType, 'empty image payload');
    }
    if (!ALLOWED_MIME.includes(input.mimeType)) {
      throw new UnreadableImageError(input.mimeType, 'mime type not supported by the model');
    }

    const userText = buildUserText(input);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [imageBlockFor(input), { type: 'text', text: userText }],
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
      response.usage.input_tokens,
      response.usage.output_tokens,
    );

    return {
      receipt,
      confidence: estimateConfidence(response.stop_reason),
      provider: this.name,
      model: this.model,
      cost,
      extractedAt: new Date(),
      rawResponseHash: createHash('sha256').update(rawText).digest('hex'),
    };
  }

  /**
   * Conservative upper bound for one extract call: an image-bearing
   * vision prompt rarely exceeds ~2500 input tokens (image + text), and
   * the response is capped at maxTokens by construction. When the model
   * is unknown to PRICING (operator pinned a name we have not priced),
   * fall back to the most expensive priced row so the predicted budget
   * bite cannot understate the real cost.
   */
  predictedMaxCostUsd(): string {
    const inputTokensEstimate = 2500;
    const rates = PRICING[this.model] ?? worstCaseRates();
    const usd =
      (inputTokensEstimate * rates.input) / 1_000_000 + (this.maxTokens * rates.output) / 1_000_000;
    return usd.toFixed(6);
  }
}

function worstCaseRates(): { input: number; output: number } {
  let worst = { input: 0, output: 0 };
  for (const r of Object.values(PRICING)) {
    if (r.input + r.output > worst.input + worst.output) worst = r;
  }
  return worst;
}

function imageBlockFor(input: ExtractionInput): Anthropic.ImageBlockParam {
  if (input.mimeType === 'application/pdf') {
    // pdf goes through a different content block on the SDK; for v1 we
    // accept only png/jpeg/webp at runtime and reject pdf upstream. The
    // mime check above already rejects with UnreadableImageError, so
    // this branch is defensive and should never execute.
    throw new UnreadableImageError(input.mimeType, 'pdf path not yet implemented');
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: input.mimeType,
      data: input.imageBase64,
    },
  };
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

function extractTextContent(response: Anthropic.Message): string {
  const block = response.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new InvalidProviderResponseError('anthropic', 'response contained no text block');
  }
  return block.text;
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
  // Models sometimes ignore "no markdown fence" and wrap JSON in
  // ```json ... ```. Strip the fence if present so the rest of the
  // pipeline does not have to know about the inconsistency.
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s.trim());
  return fenceMatch?.[1] ?? s;
}

function estimateConfidence(stopReason: Anthropic.Message['stop_reason']): number {
  // The model does not return a true confidence score, so we project
  // its stop_reason into a 0..1 band. end_turn = normal completion
  // implies the model believes its answer; max_tokens = truncated;
  // tool_use / refusal = low.
  switch (stopReason) {
    case 'end_turn':
      return 0.9;
    case 'stop_sequence':
      return 0.85;
    case 'max_tokens':
      return 0.4;
    default:
      return 0.5;
  }
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const rates = PRICING[model];
  if (!rates) {
    return {
      inputTokens,
      outputTokens,
      estimatedUsd: '0',
    };
  }
  const usd = (inputTokens * rates.input) / 1_000_000 + (outputTokens * rates.output) / 1_000_000;
  return {
    inputTokens,
    outputTokens,
    estimatedUsd: usd.toFixed(6),
  };
}

export { PROMPT_VERSION };
