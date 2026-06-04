import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  ExtractionEventsService,
  type ExtractionStatusEvent,
} from './extraction-events.service.js';

/**
 * Two instances of the service against the same Redis bear out the
 * cross-replica fanout shape ADR-0012 promises: publish on one, the
 * other receives. Subscriber-side filtering and listener cleanup
 * are checked alongside.
 */
describe('ExtractionEventsService (integration)', () => {
  let redis: StartedTestContainer;
  let redisUrl: string;
  let publisher: ExtractionEventsService;
  let subscriber: ExtractionEventsService;

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    publisher = new ExtractionEventsService(redisUrl);
    subscriber = new ExtractionEventsService(redisUrl);
    await publisher.onModuleInit();
    await subscriber.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await publisher?.onModuleDestroy();
    await subscriber?.onModuleDestroy();
    await redis?.stop();
  });

  async function captureNext(svc: ExtractionEventsService): Promise<ExtractionStatusEvent> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        unsubscribe();
        reject(new Error('no event received within 2s'));
      }, 2000);
      const unsubscribe = svc.onEvent((e) => {
        clearTimeout(t);
        unsubscribe();
        resolve(e);
      });
    });
  }

  it('delivers a published event to a separate subscriber', async () => {
    const wait = captureNext(subscriber);
    await publisher.publish({
      extractionId: 'ext_1',
      status: 'succeeded',
      at: new Date().toISOString(),
    });
    const received = await wait;
    expect(received.extractionId).toBe('ext_1');
    expect(received.status).toBe('succeeded');
  });

  it('delivers to every listener attached on the same service', async () => {
    const seenA: ExtractionStatusEvent[] = [];
    const seenB: ExtractionStatusEvent[] = [];
    const stopA = subscriber.onEvent((e) => seenA.push(e));
    const stopB = subscriber.onEvent((e) => seenB.push(e));

    await publisher.publish({ extractionId: 'ext_2', status: 'needs_review', at: 'now' });
    await new Promise((r) => setTimeout(r, 100));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    stopA();
    stopB();
  });

  it('stops calling a listener after its unsubscribe runs', async () => {
    const seen: ExtractionStatusEvent[] = [];
    const stop = subscriber.onEvent((e) => seen.push(e));
    await publisher.publish({ extractionId: 'ext_3', status: 'failed', at: 'now' });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    await publisher.publish({ extractionId: 'ext_4', status: 'succeeded', at: 'now' });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.map((e) => e.extractionId)).toEqual(['ext_3']);
  });

  it('drops malformed JSON without throwing', async () => {
    // Push raw garbage to the channel; subscriber's parse-and-skip
    // should not surface an error or kill the connection.
    const { default: postgres } = await import('postgres'); // unused, just keep import shape
    void postgres;
    // Smuggle a raw publish through the underlying publisher Redis
    // client to bypass the typed signature.
    const internal = (
      publisher as unknown as { pub: { publish: (c: string, m: string) => Promise<number> } }
    ).pub;
    await internal.publish('extraction-status', 'not-json{');
    const seen: ExtractionStatusEvent[] = [];
    subscriber.onEvent((e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 150));
    // good event still delivered after the bad one
    await publisher.publish({ extractionId: 'ext_5', status: 'succeeded', at: 'now' });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.some((e) => e.extractionId === 'ext_5')).toBe(true);
  });
});
