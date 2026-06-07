import { describe, it, expect } from 'vitest';
import { HealthzController } from './healthz.controller.js';

describe('HealthzController', () => {
  const controller = new HealthzController();

  it('reports ok status', () => {
    expect(controller.healthz().status).toBe('ok');
  });

  it('reports a non-negative integer uptime in seconds', () => {
    const { uptimeSeconds } = controller.healthz();
    expect(Number.isInteger(uptimeSeconds)).toBe(true);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an ISO-8601 timestamp', () => {
    const { timestamp } = controller.healthz();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });

  it('reports a string version (default 0.0.0 when not set)', () => {
    const { version } = controller.healthz();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });

  it('reports commitSha as string or null', () => {
    const { commitSha } = controller.healthz();
    expect(commitSha === null || typeof commitSha === 'string').toBe(true);
  });
});
