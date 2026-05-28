import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle smoke test. Builds dist/main.js with esbuild, boots it as a
 * real Node process against real Postgres and Redis, and asserts a
 * GET /healthz round-trip. This is the only place where bundle-only
 * regressions surface - bootstrap.db.test.ts exercises the TS source
 * through Test.createTestingModule, which does not catch problems
 * that show up only in the bundled output (the obvious one being a
 * missing emitDecoratorMetadata emission, which silently breaks
 * Nest DI for every class with type-based constructor injection).
 */
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => res(port));
      } else {
        rej(new Error('failed to pick a port'));
      }
    });
  });
}

async function runBuild(): Promise<void> {
  await new Promise<void>((res, rej) => {
    const p = spawn('node', ['build.mjs'], { cwd: apiDir, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`build exited with code ${code}`))));
    p.on('error', rej);
  });
}

describe('bundled api smoke (integration)', () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedTestContainer | undefined;
  let child: ChildProcess | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    await runBuild();

    postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('vellum_test')
      .withUsername('vellum')
      .withPassword('vellum')
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    const port = await pickPort();
    baseUrl = `http://127.0.0.1:${port}`;

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    Object.assign(childEnv, {
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      AUTH_SECRET: 'a'.repeat(32),
      NODE_ENV: 'production',
      EXTRACTION_PROVIDER: 'mock',
      STORAGE_DRIVER: 'filesystem',
      PORT: String(port),
    });

    const c = spawn('node', ['dist/main.js'], {
      cwd: apiDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    // Pass child output to the test runner so a failure shows what
    // the bundle actually said while booting.
    c.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    c.stderr?.on('data', (d: Buffer) => process.stderr.write(d));

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const r = await fetch(`${baseUrl}/healthz`);
        if (r.ok) break;
      } catch {
        // not ready yet
      }
      if (Date.now() > deadline) {
        throw new Error('bundle did not respond on /healthz within 30s');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 180_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((res) => child!.once('exit', () => res()));
    }
    await redis?.stop();
    await postgres?.stop();
  });

  it('serves /healthz from the bundled api with the expected shape', async () => {
    const r = await fetch(`${baseUrl}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; uptimeSeconds: number };
    expect(body.status).toBe('ok');
    expect(Number.isFinite(body.uptimeSeconds)).toBe(true);
  });
});
