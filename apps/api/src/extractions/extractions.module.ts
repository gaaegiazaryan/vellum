import { Module, type DynamicModule } from '@nestjs/common';
import { MockProvider } from '@vellum/extraction/providers/mock';
import { AnthropicProvider } from '@vellum/extraction/providers/anthropic';
import type { ExtractionProvider } from '@vellum/extraction';
import { ExtractionsController } from './extractions.controller.js';
import {
  ExtractionsService,
  EXTRACTION_PROVIDER,
  CONFIDENCE_REVIEW_THRESHOLD_TOKEN,
  DEFAULT_CONFIDENCE_REVIEW_THRESHOLD,
} from './extractions.service.js';
import { ExtractionWorker } from './extraction.worker.js';
import type { Env } from '../config/env.js';

/**
 * Provider selection driven by env.
 *
 * EXTRACTION_PROVIDER=anthropic + a valid ANTHROPIC_API_KEY uses the
 * real Anthropic Claude vision API. The env schema already enforces
 * that combination, so reaching the `anthropic` branch here without
 * a key would be a programmer error.
 *
 * EXTRACTION_PROVIDER=mock is the default. Useful in tests, local
 * dev without an api key, and demo deploys that intentionally stub
 * the AI.
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
  if (env.EXTRACTION_PROVIDER === 'anthropic') {
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY ?? '' });
  }
  return new MockProvider();
}
