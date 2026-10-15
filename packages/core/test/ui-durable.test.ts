/**
 * Durable mode of the UI stream serializers (2.4, preview, spec §3.4):
 * persist before publish. Frames are coalesced (20 ms or 16 KiB, whichever
 * first), a batch reaches the client only after it committed, and one
 * producer per stream is fenced by its lease token: a stale one stops, and
 * nothing it did not commit reaches its client. Time is a manual clock (never
 * vitest fake timers, which break MSW).
 */
import { describe, expect, it } from 'vitest';
import {
  createDeuzStream,
  createInMemoryDurableStreamStateStore,
  resumeDeuzStreamResponse,
  toDeuzAgentStreamResponse,
  toDeuzStreamResponse,
  type DurableStreamOptions,
  type DurableStreamStateStore,
  type StreamStateRecord,
} from '../src/ui';
import { createInMemoryLeaseProvider } from '../src/ops';
import { createMemoryObserver } from '../src/observe';
import type { AgentStream } from '../src/types/agent-run';
import type { Dependencies } from '../src/types/deps';
import type { LeaseProvider } from '../src/types/lease';
import { readAll, records } from './fixtures/durable-stream-store-conformance';
import { immediateClock, settleImmediate } from './fixtures/immediate-clock';
import { bodyReader, manualResult, sseFrames, textPart } from './fixtures/manual-stream';

const settle = () => settleImmediate();

// `ui.ts` loads the journal with `import()`; loading it here first keeps that
// to a few turns, so the journal opens within one `settle()`.
await import('../src/internal/durable-journal');

/**
 * Advances the clock. The first call also lets the durable journal open: it
 * waits until the lease was taken (`taken`, when the test can tell) or the
 * lease renewal, the journal's first timer, is on the clock, up to a moment
 * of real time.
 */
function driver(time: ReturnType<typeof immediateClock>, taken: () => boolean = () => false) {
  let opened = false;
  return async (ms: number): Promise<void> => {
    if (!opened) {
      opened = true;
      const until = performance.now() + 500;
      while (!taken() && time.pending() === 0 && performance.now() < until)
        await settleImmediate(1);
    }
    await time.advance(ms);
  };
}

/** A lease provider that counts the leases it granted. */
function counting(inner: LeaseProvider): LeaseProvider & { granted(): number } {
  let granted = 0;
  return {
    ...inner,
    async acquire(request) {
      const lease = await inner.acquire(request);
      if (lease) granted++;
      return lease;
    },
    renew: (lease, ttlMs, options) => inner.renew(lease, ttlMs, options),
    release: (lease) => inner.release(lease),
    signal: (key, signal) => inner.signal(key, signal),
    granted: () => granted,
  };
}

/** A durable store whose commits the test can hold, and that records every batch. */
function recordingStore(inner: DurableStreamStateStore = createInMemoryDurableStreamStateStore()) {
  const batches: StreamStateRecord[][] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const store: DurableStreamStateStore = {
    ...inner,
    durable: true,
    open: (streamId, token) => inner.open(streamId, token),
    async commit(batch) {
      batches.push(batch.records);
      if (gate) await gate;
      return inner.commit(batch);
    },
    append: (streamId, seq, part) => inner.append(streamId, seq, part),
    read: (streamId, fromSeq) => inner.read(streamId, fromSeq),
    lastSeq: (streamId) => inner.lastSeq(streamId),
    delete: (streamId) => inner.delete(streamId),
    prune: (options) => inner.prune(options),
  };
  return {
    store,
    batches,
    hold() {
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      gate = undefined;
      open?.();
    },
  };
}

function setup(
  overrides: {
    store?: DurableStreamStateStore;
    provider?: LeaseProvider;
    batch?: DurableStreamOptions['batch'];
    deps?: Dependencies;
    ttlMs?: number;
  } = {},
) {
  const time = immediateClock(1_000_000);
  const provider = counting(
    overrides.provider ?? createInMemoryLeaseProvider({ clock: time.clock }),
  );
  const store = overrides.store ?? createInMemoryDurableStreamStateStore();
  const durable: DurableStreamOptions = {
    store,
    lease: {
      provider,
      owner: 'producer-a',
      ...(overrides.ttlMs ? { ttlMs: overrides.ttlMs } : {}),
    },
    ...(overrides.batch ? { batch: overrides.batch } : {}),
    deps: { clock: time.clock, ...overrides.deps },
  };
  return { time, advance: driver(time, () => provider.granted() > 0), provider, store, durable };
}

const frameText = (seq: number, part: unknown) => `id: ${seq}\ndata: ${JSON.stringify(part)}\n\n`;

describe('durable mode: persist before publish', () => {
  it('sends a frame only after the batch that holds it committed', async () => {
    const recording = recordingStore();
    const { advance, durable } = setup({ store: recording.store });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    let arrived = false;
    const first = body.more().then(() => (arrived = true));
    recording.hold();
    manual.push(textPart('a'));
    await settle();
    expect(recording.batches).toHaveLength(0);
    await advance(20);
    expect(recording.batches).toHaveLength(1);
    // Committing, not committed: nothing on the wire yet.
    expect(arrived).toBe(false);
    recording.release();
    await first;
    await body.until('"a"');
    expect(body.text()).toBe(
      frameText(0, { type: 'start', messageId: 'm' }) +
        frameText(1, { type: 'text-delta', text: 'a' }),
    );
    manual.end();
    await advance(20);
    await body.rest();
  });

  it('coalesces the frames of 20 ms into one commit', async () => {
    const recording = recordingStore();
    const { advance, durable } = setup({ store: recording.store });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    for (const text of ['a', 'b', 'c', 'd', 'e']) manual.push(textPart(text));
    await settle();
    await advance(19);
    expect(recording.batches).toHaveLength(0);
    await advance(1);
    expect(recording.batches.map((batch) => batch.map((record) => record.seq))).toEqual([
      [0, 1, 2, 3, 4, 5],
    ]);
    manual.end();
    await advance(20);
    await body.rest();
    // The sentinel went in its own, last batch.
    expect(recording.batches.at(-1)).toEqual([{ seq: 6, part: { type: 'done' } }]);
  });

  it('flushes at 16 KiB without waiting for the window', async () => {
    const recording = recordingStore();
    const { advance, durable } = setup({ store: recording.store });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('x'.repeat(9_000)));
    await settle();
    expect(recording.batches).toHaveLength(0);
    manual.push(textPart('y'.repeat(9_000)));
    await settle();
    expect(recording.batches).toHaveLength(1);
    expect(recording.batches[0]!.map((record) => record.seq)).toEqual([0, 1, 2]);
    manual.end();
    await advance(20);
    await body.rest();
  });

  it('honours its batch options', async () => {
    const recording = recordingStore();
    const { advance, durable } = setup({
      store: recording.store,
      batch: { maxDelayMs: 5, maxBytes: 1_000_000 },
    });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await settle();
    await advance(5);
    expect(recording.batches).toHaveLength(1);
    manual.end();
    await advance(5);
    await body.rest();
  });

  it('keeps one commit in flight: what arrives meanwhile goes in the next batch, in order', async () => {
    const recording = recordingStore();
    const { advance, durable, store } = setup({ store: recording.store });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await settle();
    recording.hold();
    await advance(20);
    expect(recording.batches).toHaveLength(1);
    manual.push(textPart('b'));
    manual.push(textPart('c'));
    await settle();
    await advance(20);
    // The window closed while the first commit was still out: no second commit yet.
    expect(recording.batches).toHaveLength(1);
    recording.release();
    await settle();
    expect(recording.batches.map((batch) => batch.map((record) => record.seq))).toEqual([
      [0, 1],
      [2, 3],
    ]);
    manual.end();
    await advance(20);
    const frames = sseFrames(await body.rest());
    expect(frames.map((frame) => frame.id)).toEqual(['0', '1', '2', '3', '4']);
    // The wire is the journal, frame for frame.
    const journal = await readAll(store, 's');
    expect(frames.slice(0, -1).map((frame) => frame.data)).toEqual(
      journal.slice(0, -1).map((record) => JSON.stringify(record.part)),
    );
    expect(frames.at(-1)!.data).toBe('[DONE]');
    expect(journal.at(-1)).toEqual({ seq: 4, part: { type: 'done' } });
  });

  it('keeps committing after the client left', async () => {
    const { advance, durable, store } = setup();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await advance(20);
    await body.cancel();
    manual.push(textPart('b'));
    manual.end();
    await advance(20);
    await settle();
    expect((await readAll(store, 's')).map((record) => record.part.type)).toEqual([
      'start',
      'text-delta',
      'text-delta',
      'done',
    ]);
  });

  it('carries transient parts in order without journaling them', async () => {
    const { advance, durable, store } = setup();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { durable, streamId: 's', messageId: 'm' });
    const body = bodyReader(writer.response);
    manual.push(textPart('a'));
    await settle();
    writer.writeData('progress', { pct: 50 }, { transient: true });
    await settle();
    manual.push(textPart('b'));
    await settle();
    manual.end();
    await advance(20);
    await advance(20);
    const frames = sseFrames(await body.rest());
    expect(
      frames.map((frame) => [
        frame.id,
        JSON.parse(frame.data === '[DONE]' ? '"done"' : frame.data).type ?? 'done',
      ]),
    ).toEqual([
      ['0', 'start'],
      ['1', 'text-delta'],
      [undefined, 'data-progress'],
      ['2', 'text-delta'],
      ['3', 'done'],
    ]);
    expect((await readAll(store, 's')).map((record) => record.part.type)).toEqual([
      'start',
      'text-delta',
      'text-delta',
      'done',
    ]);
  });

  it('continues a stored stream after its last seq, without a new start', async () => {
    const { advance, durable, store } = setup();
    await store.commit({
      streamId: 's',
      token: 0,
      records: records(0, [{ type: 'start', messageId: 'm' }, { type: 'done' }]),
    });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    manual.push(textPart('next leg'));
    manual.end();
    const body = bodyReader(response);
    await advance(20);
    await advance(20);
    expect(await body.rest()).toBe(
      frameText(2, { type: 'text-delta', text: 'next leg' }) + 'id: 3\ndata: [DONE]\n\n',
    );
    // A replay from the start gets both legs once, in order.
    const replay = await resumeDeuzStreamResponse(store, 's').text();
    expect(sseFrames(replay).map((frame) => frame.id)).toEqual(['0', '2', '3']);
  });

  it('numbers without id: lines for a wire v1 client, while the journal keeps its seqs', async () => {
    const { advance, durable, store } = setup();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
      wireVersion: 'v1',
    });
    manual.push(textPart('a'));
    manual.end();
    const body = bodyReader(response);
    await advance(20);
    await advance(20);
    expect(sseFrames(await body.rest()).every((frame) => frame.id === undefined)).toBe(true);
    expect(await store.lastSeq('s')).toBe(2);
  });
});

describe('durable mode: one producer, fenced', () => {
  it('stops a producer a newer one fenced off: nothing uncommitted reaches its client', async () => {
    const observer = createMemoryObserver();
    const { advance, durable, store } = setup({ deps: { observer } });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('committed'));
    await advance(20);
    // A newer producer opened the stream (its lease token is higher).
    expect(await store.open('s', 7)).toEqual({ status: 'opened', lastSeq: 1 });
    manual.push(textPart('never sent'));
    await advance(20);
    const raw = await body.rest();
    expect(raw).toContain(JSON.stringify({ type: 'text-delta', text: 'committed' }));
    expect(raw).not.toContain('never sent');
    expect(raw).not.toContain('[DONE]');
    expect(sseFrames(raw).at(-1)).toEqual({
      data: JSON.stringify({
        type: 'error',
        message: 'Durable stream: a newer producer took over this stream.',
      }),
    });
    // The producer stopped reading its source.
    manual.push(textPart('more'));
    await settle();
    expect(manual.returned()).toBe(true);
    expect((await readAll(store, 's')).map((record) => record.seq)).toEqual([0, 1]);
    const fenced = observer
      .events()
      .filter(
        (event) => event.type === 'operation.completed' && event.operation === 'deuz.stream.fenced',
      );
    expect(fenced).toHaveLength(1);
    expect(fenced[0]).toMatchObject({
      subsystem: 'stream',
      attributes: { 'deuz.stream.fencing_token': 7 },
    });
  });

  it('refuses to start while another producer holds the lease', async () => {
    const { durable, provider, store } = setup();
    expect(
      await provider.acquire({ key: 'stream:s', owner: 'producer-b', ttlMs: 30_000 }),
    ).toBeTruthy();
    const errors: unknown[] = [];
    const manual = manualResult();
    // A lazy source (a resumed run, a `streamChat`) starts on its first read.
    let reads = 0;
    const source = manual.result.fullStream;
    const result = {
      ...manual.result,
      fullStream: {
        [Symbol.asyncIterator]() {
          reads++;
          return source[Symbol.asyncIterator]();
        },
      },
    };
    const response = toDeuzStreamResponse(result, {
      durable,
      streamId: 's',
      messageId: 'm',
      onStoreError: (error) => errors.push(error),
    });
    manual.push(textPart('a'));
    expect(await response.text()).toBe(
      `data: ${JSON.stringify({ type: 'error', message: 'Durable stream: another producer holds this stream.' })}\n\n`,
    );
    expect(await store.lastSeq('s')).toBeUndefined();
    expect(errors).toEqual([]);
    await settle();
    // The refused producer never read its source, so a lazy run never started.
    expect(reads).toBe(0);
  });

  it('fails closed when the lease is lost, and stops committing', async () => {
    const time = immediateClock(1_000_000);
    const inner = createInMemoryLeaseProvider({ clock: time.clock });
    let renewals = 0;
    const provider: LeaseProvider = {
      ...inner,
      acquire: (request) => inner.acquire(request),
      renew: async () => {
        renewals++;
        return { held: false };
      },
      release: (lease) => inner.release(lease),
      signal: (key, signal) => inner.signal(key, signal),
    };
    const recording = recordingStore();
    const durable: DurableStreamOptions = {
      store: recording.store,
      lease: { provider, ttlMs: 300 },
      deps: { clock: time.clock },
    };
    const advance = driver(time);
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await advance(20);
    expect(recording.batches).toHaveLength(1);
    await advance(100);
    expect(renewals).toBe(1);
    manual.push(textPart('b'));
    await advance(20);
    const raw = await body.rest();
    expect(raw).toContain('this producer lost its lease');
    expect(raw).not.toContain('[DONE]');
    expect(recording.batches).toHaveLength(1);
  });

  it('renews the lease while the stream runs, and releases it at the end', async () => {
    const { advance, time, durable, provider } = setup({ ttlMs: 300 });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    for (let step = 0; step < 10; step++) {
      manual.push(textPart(`t${step}`));
      await advance(100);
    }
    // A thousand ms on a 300 ms lease: still held, so nobody else gets it.
    expect(await provider.acquire({ key: 'stream:s', owner: 'b', ttlMs: 300 })).toBeUndefined();
    manual.end();
    await advance(20);
    expect(await body.rest()).toContain('[DONE]');
    await settle();
    expect(await provider.acquire({ key: 'stream:s', owner: 'b', ttlMs: 300 })).toMatchObject({
      token: 2,
    });
    expect(time.pending()).toBe(0);
  });

  it('fails closed on a store error and hands the error to onStoreError only', async () => {
    const inner = createInMemoryDurableStreamStateStore();
    const store: DurableStreamStateStore = {
      ...inner,
      commit: async () => {
        throw new Error('postgres://user:hunter2@db down');
      },
    };
    const { advance, durable } = setup({ store });
    const errors: unknown[] = [];
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
      onStoreError: (error) => errors.push(error),
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await advance(20);
    const raw = await body.rest();
    expect(raw).toBe(
      `data: ${JSON.stringify({ type: 'error', message: 'Durable stream: the stream store failed.' })}\n\n`,
    );
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('hunter2');
  });

  it('fails closed when the stored log moved past the producer', async () => {
    const { advance, durable, store } = setup();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    await advance(20);
    await store.append('s', 2, { type: 'text-delta', text: 'foreign' });
    manual.push(textPart('b'));
    await advance(20);
    const raw = await body.rest();
    expect(raw).toContain('the stored stream moved past this producer');
    expect(raw).not.toContain('"b"');
  });

  it('keeps a refused agent leg off the journal and takes no lease', async () => {
    const { durable, store, provider } = setup();
    const result = {
      status: 'failed',
      runId: 'r1',
      error: { name: 'AgentRunBusyError', message: 'another executor holds the run' },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      },
      modelSteps: 0,
    };
    const stream = {
      events: (async function* () {
        yield { type: 'result', result };
      })(),
      result: Promise.resolve(result),
    } as unknown as AgentStream<unknown>;
    const raw = await toDeuzAgentStreamResponse(stream, {
      durable,
      streamId: 'r1',
      runId: 'r1',
      messageId: 'm',
    }).text();
    expect(sseFrames(raw).every((frame) => frame.id === undefined)).toBe(true);
    expect(raw).toContain('another executor holds the run');
    expect(await store.lastSeq('r1')).toBeUndefined();
    expect(await provider.acquire({ key: 'stream:r1', owner: 'b', ttlMs: 1_000 })).toMatchObject({
      token: 1,
    });
  });
});

describe('durable mode: telemetry and configuration', () => {
  it('reports each commit as a deuz.stream.batch span with counts and latency, never content', async () => {
    const observer = createMemoryObserver();
    const { advance, durable } = setup({ deps: { observer } });
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable,
      streamId: 's',
      messageId: 'm',
    });
    manual.push(textPart('secret words'));
    manual.end();
    const body = bodyReader(response);
    await advance(20);
    await advance(20);
    await body.rest();
    const spans = observer
      .events()
      .filter(
        (event) =>
          (event.type === 'operation.started' || event.type === 'operation.completed') &&
          event.operation === 'deuz.stream.batch',
      ) as { type: string; attributes?: Record<string, unknown> }[];
    const started = spans.filter((event) => event.type === 'operation.started');
    const completed = spans.filter((event) => event.type === 'operation.completed');
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(completed).toHaveLength(started.length);
    // Counts when the commit starts, its latency when it answers.
    // start, the text and the sentinel: the source ended within the window.
    expect(started[0]!.attributes).toEqual({
      'deuz.stream.batch_frames': 3,
      'deuz.stream.batch_bytes': expect.any(Number),
    });
    expect(Object.keys(completed[0]!.attributes ?? {})).toEqual(['deuz.stream.commit_ms']);
    expect(JSON.stringify(observer.events())).not.toContain('secret words');
  });

  it('throws configuration errors when the response is built', () => {
    const { durable } = setup();
    const manual = manualResult();
    expect(() => toDeuzStreamResponse(manual.result, { durable })).toThrow(/streamId/);
    expect(() =>
      toDeuzStreamResponse(manual.result, {
        durable,
        streamId: 's',
        store: createInMemoryDurableStreamStateStore(),
      }),
    ).toThrow(/durable\.store/);
    expect(() =>
      toDeuzStreamResponse(manual.result, {
        durable: { ...durable, lease: { ...durable.lease, ttlMs: 2 } },
        streamId: 's',
      }),
    ).toThrow(/ttlMs/);
    expect(() =>
      toDeuzStreamResponse(manual.result, {
        durable: { ...durable, batch: { maxBytes: 0 } },
        streamId: 's',
      }),
    ).toThrow(/maxBytes/);
    expect(() =>
      toDeuzStreamResponse(manual.result, {
        durable: { ...durable, store: {} as never },
        streamId: 's',
      }),
    ).toThrow(/DurableStreamStateStore/);
  });
});

describe('durable mode: the lease across legs', () => {
  /** One leg over `store`: a text part, then the end of the source. */
  const leg = (
    store: DurableStreamStateStore,
    provider: LeaseProvider,
    text: string,
    extra: Partial<DurableStreamOptions> = {},
  ) => {
    const manual = manualResult();
    manual.push(textPart(text));
    manual.end();
    return toDeuzStreamResponse(manual.result, {
      streamId: 's',
      messageId: 'm',
      durable: { store, lease: { provider }, batch: { maxDelayMs: 0 }, ...extra },
    });
  };
  const texts = async (store: DurableStreamStateStore) =>
    (await readAll(store, 's'))
      .map((record) => record.part)
      .filter((part) => part.type === 'text-delta')
      .map((part) => (part as { text: string }).text);

  it('goes on after a lease prune reset the token below the stream fence', async () => {
    const store = createInMemoryDurableStreamStateStore();
    const provider = createInMemoryLeaseProvider();
    expect(await leg(store, provider, 'one').text()).toContain('[DONE]');
    expect(await leg(store, provider, 'two').text()).toContain('[DONE]');
    // The documented daily retention: the released key goes, its token starts again at 1.
    expect(await provider.prune!(Date.now() - 86_400_000)).toBe(1);
    expect(await leg(store, provider, 'three').text()).toContain('[DONE]');
    expect(await leg(store, provider, 'four').text()).toContain('[DONE]');
    expect(await texts(store)).toEqual(['one', 'two', 'three', 'four']);
    expect((await readAll(store, 's')).map((record) => record.seq)).toEqual(
      // start, then a text and a sentinel per leg: one gapless log.
      Array.from({ length: 9 }, (_, n) => n),
    );
  });

  it('fences a stale producer off when a new one took over its pruned lease', async () => {
    const time = immediateClock(1_000_000);
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemoryDurableStreamStateStore();
    // Two legs ended: the stream's fence is token 2.
    for (const text of ['one', 'two']) {
      const body = bodyReader(leg(store, provider, text, { deps: { clock: time.clock } }));
      await driver(time)(20);
      expect(await body.rest()).toContain('[DONE]');
    }
    // Producer A (token 3) runs, then is cut off from the lease provider.
    let cutOff = false;
    const aProvider: LeaseProvider = {
      ...provider,
      acquire: (request) => provider.acquire(request),
      renew: async (lease, ttlMs, options) => {
        if (cutOff) throw new Error('lease provider unreachable');
        return provider.renew(lease, ttlMs, options);
      },
      release: (lease) => provider.release(lease),
      signal: (key, signal) => provider.signal(key, signal),
    };
    const sourceA = manualResult();
    const a = bodyReader(
      toDeuzStreamResponse(sourceA.result, {
        streamId: 's',
        messageId: 'm',
        durable: {
          store,
          lease: { provider: aProvider, owner: 'a', ttlMs: 300 },
          deps: { clock: time.clock },
        },
      }),
    );
    sourceA.push(textPart('a1'));
    await driver(time)(20);
    await a.until('"a1"');
    cutOff = true;
    // A's lease expires and the host's retention prunes it: the key starts again at token 1.
    await time.advance(1_000);
    expect(await provider.prune!(time.clock.now())).toBe(1);
    // Producer B takes the key at token 1, below the stream's fence (3), and goes on above it.
    const sourceB = manualResult();
    const b = bodyReader(
      toDeuzStreamResponse(sourceB.result, {
        streamId: 's',
        messageId: 'm',
        durable: {
          store,
          lease: { provider, owner: 'b', ttlMs: 300 },
          deps: { clock: time.clock },
        },
      }),
    );
    sourceB.push(textPart('b1'));
    await driver(time)(20);
    await b.until('"b1"');
    // A's next commit is refused: nothing it did not commit reaches its client.
    sourceA.push(textPart('stale-a2'));
    await time.advance(20);
    const rawA = await a.rest();
    expect(rawA).not.toContain('stale-a2');
    expect(rawA).toContain('a newer producer took over this stream');
    sourceB.end();
    await time.advance(20);
    expect(await b.rest()).toContain('[DONE]');
    expect(await texts(store)).toEqual(['one', 'two', 'a1', 'b1']);
  });

  it('still refuses a producer whose lease changed hands before it opened the stream', async () => {
    const time = immediateClock(1_000_000);
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const inner = createInMemoryDurableStreamStateStore();
    let letOpen: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (letOpen = resolve));
    let opening = false;
    const store: DurableStreamStateStore = {
      ...inner,
      async open(streamId, token) {
        opening = true;
        await gate;
        return inner.open(streamId, token);
      },
    };
    const manual = manualResult();
    const text = toDeuzStreamResponse(manual.result, {
      streamId: 's',
      messageId: 'm',
      durable: {
        store,
        lease: { provider, owner: 'a', ttlMs: 300 },
        deps: { clock: time.clock },
      },
    }).text();
    await driver(time, () => opening)(0);
    // A pauses past its lease; B takes the key (token 2) and opens the stream.
    await time.advance(1_000);
    expect(await provider.acquire({ key: 'stream:s', owner: 'b', ttlMs: 30_000 })).toMatchObject({
      token: 2,
    });
    expect(await inner.open('s', 2)).toEqual({ status: 'opened', lastSeq: -1 });
    letOpen!();
    expect(await text).toBe(
      `data: ${JSON.stringify({ type: 'error', message: 'Durable stream: a newer producer took over this stream.' })}\n\n`,
    );
    // The stream keeps B's fence.
    expect(await inner.open('s', 2)).toEqual({ status: 'opened', lastSeq: -1 });
    expect(await inner.commit({ streamId: 's', token: 2, records: [] })).toEqual({
      status: 'committed',
      lastSeq: -1,
    });
  });
});

describe('durable mode: the end of a leg', () => {
  it('gives the lease back and stops renewing when the producer rejects', async () => {
    const time = immediateClock(1_000_000);
    const provider = createInMemoryLeaseProvider({ clock: time.clock });
    const store = createInMemoryDurableStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, {
      streamId: 's',
      messageId: 'm',
      durable: {
        store,
        lease: { provider, owner: 'a', ttlMs: 300 },
        deps: { clock: time.clock },
      },
    });
    const body = writer.response.text().catch((error: unknown) => String(error));
    await driver(time)(0);
    // JSON.stringify throws inside send: produce rejects.
    writer.writeData('x', { n: 1n });
    manual.push(textPart('hello'));
    manual.end();
    await time.advance(50);
    expect(await body).toContain('BigInt');
    await time.advance(3_000); // ten lease lifetimes
    expect(time.pending()).toBe(0);
    expect(await provider.acquire({ key: 'stream:s', owner: 'b', ttlMs: 300 })).toBeDefined();
    // What was committed stays; the leg wrote no `done`, as a legacy leg that throws.
    const parts = (await readAll(store, 's')).map((record) => record.part.type);
    expect(parts[0]).toBe('start');
    expect(parts).not.toContain('done');
  });
});

describe('durable mode: handing the stream to the next leg', () => {
  it('gives the lease back before the client reads [DONE], so the next leg can start at once', async () => {
    const store = createInMemoryDurableStreamStateStore();
    const inner = createInMemoryLeaseProvider();
    const provider: LeaseProvider = {
      acquire: (request) => inner.acquire(request),
      renew: (lease, ttlMs, options) => inner.renew(lease, ttlMs, options),
      signal: (key, signal) => inner.signal(key, signal),
      async release(lease) {
        await new Promise((resolve) => setTimeout(resolve, 5)); // one provider round trip
        await inner.release(lease);
      },
    };
    const run = (text: string) => {
      const manual = manualResult();
      manual.push(textPart(text));
      manual.end();
      return toDeuzStreamResponse(manual.result, {
        streamId: 's',
        messageId: 'm',
        durable: { store, lease: { provider }, batch: { maxDelayMs: 0 } },
      });
    };
    const reader = run('one').body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('[DONE]')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('[DONE]');
    expect(await run('two').text()).toContain('[DONE]');
  });

  it('sends what it committed while ending before the error of a failed last commit', async () => {
    const recording = recordingStore();
    const { advance, durable } = setup({ store: recording.store, batch: { maxBytes: 1 } });
    const store: DurableStreamStateStore = {
      ...recording.store,
      async commit(batch) {
        // The batch with the sentinel fails; the ones before it go through.
        if (batch.records.some((record) => record.part.type === 'done'))
          throw new Error('store down');
        return recording.store.commit(batch);
      },
    };
    recording.hold();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      durable: { ...durable, store },
      streamId: 's',
      messageId: 'm',
    });
    const body = bodyReader(response);
    manual.push(textPart('a'));
    manual.end();
    // The leg ends while its first batch (the start frame) is still committing.
    await advance(0);
    expect(recording.batches).toHaveLength(1);
    recording.release();
    const raw = await body.rest();
    expect(raw).toBe(
      frameText(0, { type: 'start', messageId: 'm' }) +
        `data: ${JSON.stringify({ type: 'error', message: 'Durable stream: the stream store failed.' })}\n\n`,
    );
  });
});
