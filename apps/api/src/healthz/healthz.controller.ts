import { Controller, Get } from '@nestjs/common';

export interface HealthzResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

@Controller('healthz')
export class HealthzController {
  @Get()
  healthz(): HealthzResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
