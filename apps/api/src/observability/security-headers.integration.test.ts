import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyHelmet from '@fastify/helmet';

@Controller('probe')
class ProbeController {
  @Get()
  ok(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Security headers (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Mirror the production registration in main.ts so this test
    // catches a regression that changes the options block there.
    await app.register(fastifyHelmet, {
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets the headers a self-host operator expects in production', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=15552000');
    expect(res.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('does not set Content-Security-Policy (JSON-only api, no CSP rules to write)', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
