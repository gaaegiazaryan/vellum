import { Controller, Get } from '@nestjs/common';

export interface HealthzResponse {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
  version: string;
  commitSha: string | null;
}

// Resolved once at module load. process.env is set by the runtime before
// the controller is instantiated, so this is stable for the process lifetime.
const VERSION = process.env.npm_package_version ?? '0.0.0';
const COMMIT_SHA = process.env.GIT_SHA?.trim() || null;

@Controller('healthz')
export class HealthzController {
  @Get()
  healthz(): HealthzResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      version: VERSION,
      commitSha: COMMIT_SHA,
    };
  }
}
