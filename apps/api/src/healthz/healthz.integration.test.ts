import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HealthzModule } from './healthz.module.js';

describe('GET /healthz (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthzModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with the expected payload shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; uptimeSeconds: number; timestamp: string };
    expect(body.status).toBe('ok');
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('returns JSON content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });

  it('returns 404 for an unknown route', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });
});
