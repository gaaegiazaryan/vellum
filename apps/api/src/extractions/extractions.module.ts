import { Module, type DynamicModule } from '@nestjs/common';
import { MockProvider } from '@vellum/extraction/providers/mock';
import { AnthropicProvider } from '@vellum/extraction/providers/anthropic';
import { OpenAIProvider } from '@vellum/extraction/providers/openai';
import type { ExtractionProvider } from '@vellum/extraction';
import { ExtractionsController } from './extractions.controller.js';
import {
  ExtractionsService,
  EXTRACTION_PROVIDER,
  CONFIDENCE_REVIEW_THRESHOLD_TOKEN,
  DEFAULT_CONFIDENCE_REVIEW_THRESHOLD,
} from './extractions.service.js';
import { ExtractionWorker } from './extraction.worker.js';
import { ProviderRouter } from './provider-router.js';
import type { Env } from '../config/env.js';

type ProviderName = NonNullable<Env['EXTRACTION_FALLBACK_PROVIDER']>;

/**
 * Provider selection driven by env.
 *
 * EXTRACTION_PROVIDER=anthropic uses the real Anthropic Claude vision
 * API (needs ANTHROPIC_API_KEY). EXTRACTION_PROVIDER=openai uses the
 * GPT-4o vision path (needs OPENAI_API_KEY). The env schema already
 * enforces the key requirement so reaching this function with the
 * wrong combination would be a programmer error.
 *
 * EXTRACTION_PROVIDER=mock is the default. Useful in tests, local
 * dev without an api key, and demo deploys that intentionally stub
 * the AI.
 *
 * When EXTRACTION_FALLBACK_PROVIDER is set to a different provider,
 * the runtime provider is a ProviderRouter that wraps the primary
 * and falls back once on retryable infrastructure errors (ADR-0015).
 */
@Module({})
export class ExtractionsModule {
  static forRoot(env: Env): DynamicModule {
    // UploadsModule and QueueModule are imported once in AppModule and
    // declared global there, so this module does not re-import them.
    // Re-importing them here would call their forRoot twice, each
    // returning a fresh storage / queue instance, which Nest cannot
    // dedupe by structural hash and Fastify rejects on duplicate routes.
    return {
      module: ExtractionsModule,
      controllers: [ExtractionsController],
      providers: [
        { provide: EXTRACTION_PROVIDER, useValue: pickProvider(env) },
        {
          provide: CONFIDENCE_REVIEW_THRESHOLD_TOKEN,
          useValue:
            env.EXTRACTION_CONFIDENCE_REVIEW_THRESHOLD ?? DEFAULT_CONFIDENCE_REVIEW_THRESHOLD,
        },
        ExtractionsService,
        ExtractionWorker,
      ],
      exports: [ExtractionsService, EXTRACTION_PROVIDER, CONFIDENCE_REVIEW_THRESHOLD_TOKEN],
    };
  }
}

function pickProvider(env: Env): ExtractionProvider {
  const primary = instantiate(env.EXTRACTION_PROVIDER, env);
  const fallback = env.EXTRACTION_FALLBACK_PROVIDER
    ? instantiate(env.EXTRACTION_FALLBACK_PROVIDER, env)
    : null;
  return fallback ? new ProviderRouter(primary, fallback) : primary;
}

function instantiate(name: ProviderName, env: Env): ExtractionProvider {
  if (name === 'anthropic') return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY ?? '' });
  if (name === 'openai') return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY ?? '' });
  return new MockProvider();
}
