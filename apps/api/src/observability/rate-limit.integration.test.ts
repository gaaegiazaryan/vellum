import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, Module } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyRateLimit from '@fastify/rate-limit';

@Controller('probe')
class ProbeController {
  @Get()
  ok(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Rate limit (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // Match the production registration in main.ts but use a small
    // cap so the test never makes the boring 600 requests just to
    // see the limit fire. The behaviour (429 + headers + retry-after)
    // is the same regardless of the magnitude.
    await app.register(fastifyRateLimit, {
      global: true,
      max: 3,
      timeWindow: '1 minute',
      addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true,
      },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the first calls through with x-ratelimit headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(Number(res.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
  });

  it('returns 429 once the bucket is exhausted, with Retry-After and reset headers', async () => {
    // The previous test already used one slot; finish the remaining
    // budget to drive the bucket to zero, then expect 429.
    let last = await app.inject({ method: 'GET', url: '/probe' });
    while (last.statusCode === 200) {
      last = await app.inject({ method: 'GET', url: '/probe' });
    }
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    expect(last.headers['x-ratelimit-reset']).toBeDefined();
  });
});
