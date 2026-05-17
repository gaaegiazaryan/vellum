import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { encode } from '@auth/core/jwt';
import { AUTH_SECRET_TOKEN, AuthGuard, type AuthenticatedUser } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import { COOKIE_NAMES } from './cookie-token.js';

const SECRET = 'test-secret-thirty-two-characters-long-aaaa';

@Controller('me')
class MeController {
  @Get()
  @UseGuards(AuthGuard)
  whoami(@CurrentUser() user: AuthenticatedUser | undefined): {
    user: AuthenticatedUser | undefined;
  } {
    return { user };
  }
}

@Module({
  controllers: [MeController],
  providers: [{ provide: AUTH_SECRET_TOKEN, useValue: SECRET }, AuthGuard],
})
class TestModule {}

async function makeSessionCookie(
  payload: Record<string, unknown>,
  salt: (typeof COOKIE_NAMES)[number] = 'authjs.session-token',
): Promise<string> {
  const token = await encode({
    token: payload,
    secret: SECRET,
    salt,
    maxAge: 24 * 60 * 60,
  });
  return `${salt}=${token}`;
}

describe('AuthGuard (integration)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns 401 when no session cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the cookie is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: 'authjs.session-token=this-is-not-a-real-jwe' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the cookie is signed with the wrong secret', async () => {
    const badToken = await encode({
      token: { sub: 'usr_1' },
      secret: 'wrong-secret-thirty-two-chars-aaaa',
      salt: 'authjs.session-token',
      maxAge: 60,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie: `authjs.session-token=${badToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid cookie and attaches the user to req.user', async () => {
    const cookie = await makeSessionCookie({
      sub: 'usr_42',
      email: 'gurgen@example.com',
      name: 'Gurgen',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: { id: 'usr_42', email: 'gurgen@example.com', name: 'Gurgen' },
    });
  });

  it('accepts the production __Secure- cookie name with its own salt', async () => {
    const cookie = await makeSessionCookie({ sub: 'usr_99' }, '__Secure-authjs.session-token');
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: AuthenticatedUser };
    expect(body.user.id).toBe('usr_99');
  });

  it('returns 401 when sub is missing from the token', async () => {
    const cookie = await makeSessionCookie({ email: 'no-sub@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
