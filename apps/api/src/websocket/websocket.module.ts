import { Module, type DynamicModule } from '@nestjs/common';
import { ExtractionEventsService } from './extraction-events.service.js';
import { ExtractionStatusGateway } from './extraction-status.gateway.js';

/**
 * Owns the Socket.IO gateway and the Redis pub/sub service that
 * carries extraction status events across api replicas (ADR-0012).
 * Global so ExtractionsService can inject ExtractionEventsService
 * from anywhere without re-registering.
 */
@Module({})
export class WebsocketModule {
  static forRoot(): DynamicModule {
    return {
      module: WebsocketModule,
      global: true,
      providers: [ExtractionEventsService, ExtractionStatusGateway],
      exports: [ExtractionEventsService],
    };
  }
}
