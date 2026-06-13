import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, BadRequestException, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RequestIdExceptionFilter } from './request-id-filter.js';
import { genRequestId } from './request-id.js';

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { status: string } {
    return { status: 'ok' };
  }

  @Get('boom')
  boom(): never {
    throw new BadRequestException({ error: 'broken', detail: 'on purpose' });
  }

  @Get('crash')
  crash(): never {
    throw new Error('synthetic crash');
  }
}

@Module({
  controllers: [ProbeController],
  providers: [{ provide: APP_FILTER, useClass: RequestIdExceptionFilter }],
})
class ProbeModule {}

describe('Request id propagation (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ genReqId: genRequestId }),
    );
    await app.init();
    const fastify = app.getHttpAdapter().getInstance();
    fastify.addHook('onSend', async (req, reply) => {
      if (!reply.getHeader('x-request-id')) {
        reply.header('X-Request-Id', String(req.id ?? ''));
      }
    });
    await fastify.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes a generated request id on the response header for a happy path', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('echoes a caller-supplied X-Request-Id verbatim', async () => {
    const id = 'caller-id-abc123';
    const res = await app.inject({
      method: 'GET',
      url: '/probe/ok',
      headers: { 'x-request-id': id },
    });
    expect(res.headers['x-request-id']).toBe(id);
  });

  it('includes the request id in HttpException response bodies', async () => {
    const id = 'caller-id-for-boom';
    const res = await app.inject({
      method: 'GET',
      url: '/probe/boom',
      headers: { 'x-request-id': id },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; requestId: string };
    expect(body.error).toBe('broken');
    expect(body.requestId).toBe(id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it('returns 500 with a request id when an unhandled error escapes the handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/crash' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { error: string; message: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.message).not.toContain('synthetic crash');
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
