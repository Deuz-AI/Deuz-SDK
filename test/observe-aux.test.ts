/**
 * Auxiliary subsystem observation (P1): image + midjourney operation.* events.
 */
import { describe, it, expect } from 'vitest';
import { generateImage, createImageProvider } from '../src/image';
import { submitImagine } from '../src/midjourney';
import { createMemoryObserver } from '../src/observe';
import type { Clock, ObserveEvent } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

function fixedClock(): Clock {
  let now = 0;
  return { now: () => (now += 7), setTimeout: (fn) => (fn(), () => {}) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('image observation', () => {
  it('generateImage emits operation.started/completed with counts and timing', async () => {
    const mem = createMemoryObserver();
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ url: 'https://img/1' }, { url: 'https://img/2' }] })) as typeof fetch;
    await generateImage({
      model: createImageProvider({ apiKey: 'sk-test', fetch: fetchImpl })('gpt-image-1'),
      prompt: 'a lighthouse',
      n: 2,
      deps: { observer: mem, clock: fixedClock() },
    });
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual(['operation.started', 'operation.completed']);
    const started = mem.events()[0] as Ev<'operation.started'>;
    expect(started).toMatchObject({
      subsystem: 'image',
      operation: 'image.generate',
      itemCount: 2,
    });
    const completed = mem.events()[1] as Ev<'operation.completed'>;
    expect(completed.resultCount).toBe(2);
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    expect(completed.spanId).toBe(started.spanId);
  });

  it('a failing request emits operation.failed and rethrows', async () => {
    const mem = createMemoryObserver();
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: 'rate limited' } }, 429)) as typeof fetch;
    await expect(
      generateImage({
        model: createImageProvider({ apiKey: 'sk-test', fetch: fetchImpl })('gpt-image-1'),
        prompt: 'a lighthouse',
        deps: { observer: mem, clock: fixedClock() },
      }),
    ).rejects.toThrow();
    const failed = mem.events().at(-1) as Ev<'operation.failed'>;
    expect(failed).toMatchObject({ subsystem: 'image', operation: 'image.generate' });
    expect(failed.error.category).toBe('rate-limit');
  });

  it('no observer → zero events, behavior unchanged (fast path)', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ url: 'https://img/1' }] })) as typeof fetch;
    const res = await generateImage({
      model: createImageProvider({ apiKey: 'sk-test', fetch: fetchImpl })('gpt-image-1'),
      prompt: 'a lighthouse',
    });
    expect(res.images).toHaveLength(1);
  });
});

describe('midjourney observation', () => {
  it('submitImagine emits operation events on the midjourney subsystem', async () => {
    const mem = createMemoryObserver();
    const fetchImpl = (async () =>
      jsonResponse({ code: 1, result: 'task-1', description: 'ok' })) as typeof fetch;
    await submitImagine({
      apiKey: 'sk-test',
      baseURL: 'https://relay.example',
      fetch: fetchImpl,
      prompt: 'a lighthouse --v 6',
      deps: { observer: mem, clock: fixedClock() },
    });
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual(['operation.started', 'operation.completed']);
    expect((mem.events()[0] as Ev<'operation.started'>).operation).toBe(
      'midjourney.submit-imagine',
    );
  });
});
