import { Module, type DynamicModule } from '@nestjs/common';
import { MockProvider } from '@vellum/extraction/providers/mock';
import { AnthropicProvider } from '@vellum/extraction/providers/anthropic';
import type { ExtractionProvider } from '@vellum/extraction';
import { ExtractionsController } from './extractions.controller.js';
import { ExtractionsService, EXTRACTION_PROVIDER } from './extractions.service.js';
import { UploadsModule } from '../uploads/uploads.module.js';
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
    return {
      module: ExtractionsModule,
      imports: [UploadsModule.forRoot(env)],
      controllers: [ExtractionsController],
      providers: [
        { provide: EXTRACTION_PROVIDER, useValue: pickProvider(env) },
        ExtractionsService,
      ],
      exports: [ExtractionsService, EXTRACTION_PROVIDER],
    };
  }
}

function pickProvider(env: Env): ExtractionProvider {
  if (env.EXTRACTION_PROVIDER === 'anthropic') {
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY ?? '' });
  }
  return new MockProvider();
}
