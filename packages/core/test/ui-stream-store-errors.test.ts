/**
 * H1 and H2 (2.4, spec §1.4): how the legacy resumable stream treats a
 * `StreamStateStore` that fails.
 *
 * - H1: when the stored last seq cannot be read, 2.3 numbered the leg from 0
 *   and journaled it over the frames already stored. Now the leg is not
 *   journaled at all (no record, no `id:` lines), `onStoreError` hears it and
 *   the client gets a `stream-store-error` warning.
 * - H2: appends stay fire-and-forget (the wire never waits for the store),
 *   but a failed append is no longer silent by default: the client gets the
 *   same warning, `onStoreError` hears it once, and the leg stops journaling,
 *   so the log never holds a hole a replay would skip silently.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryStreamStateStore,
  readDeuzStream,
  toDeuzStreamResponse,
  type DeuzUIPart,
  type StreamStateRecord,
  type StreamStateStore,
} from '../src/ui';
import { manualResult, sseFrames, textPart } from './fixtures/manual-stream';

const WARNING = {
  type: 'warning',
  warning: {
    type: 'stream-store-error',
    message: 'The stream store failed: this response is not journaled and cannot be resumed.',
  },
};

async function collect(response: Response): Promise<DeuzUIPart[]> {
  const parts: DeuzUIPart[] = [];
  for await (const part of readDeuzStream(response)) parts.push(part);
  return parts;
}

describe('H1: the stored last seq cannot be read', () => {
  it('does not restart at seq 0 over stored frames: the leg is not journaled', async () => {
    const inner = createInMemoryStreamStateStore();
    for (const [seq, part] of [
      [0, { type: 'start', messageId: 'earlier' }],
      [1, { type: 'text-delta', text: 'stored' }],
      [2, { type: 'done' }],
    ] as [number, StreamStateRecord['part']][])
      inner.append('s', seq, part);
    const appended: number[] = [];
    const store: StreamStateStore = {
      append: (streamId, seq, part) => {
        appended.push(seq);
        inner.append(streamId, seq, part);
      },
      read: (streamId, fromSeq) => inner.read(streamId, fromSeq),
      lastSeq: () => {
        throw new Error('lastSeq down');
      },
    };
    const errors: unknown[] = [];
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      messageId: 'm1',
      onStoreError: (error) => errors.push(error),
    });
    manual.push(textPart('live'));
    manual.end();
    const raw = await response.text();
    const frames = sseFrames(raw);
    // No `id:` line anywhere: the client gets no cursor into a journal it is not in.
    expect(frames.every((frame) => frame.id === undefined)).toBe(true);
    expect(frames.map((frame) => frame.data)).toEqual([
      JSON.stringify({ type: 'start', messageId: 'm1' }),
      JSON.stringify(WARNING),
      JSON.stringify({ type: 'text-delta', text: 'live' }),
      '[DONE]',
    ]);
    expect(appended).toEqual([]);
    const stored: StreamStateRecord[] = [];
    for await (const record of inner.read('s')) stored.push(record);
    expect(stored.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(stored[1]!.part).toEqual({ type: 'text-delta', text: 'stored' });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('lastSeq down');
  });

  it('treats a store without lastSeq whose read fails the same way', async () => {
    let appends = 0;
    const store: StreamStateStore = {
      append: () => {
        appends++;
      },
      async *read(): AsyncGenerator<never> {
        throw new Error('read down');
      },
    };
    const errors: unknown[] = [];
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      messageId: 'm1',
      onStoreError: (error) => errors.push(error),
    });
    manual.end();
    expect((await collect(response)).map((part) => part.type)).toEqual(['start', 'warning']);
    expect(appends).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('survives an onStoreError that throws', async () => {
    const store: StreamStateStore = {
      append: () => {},
      read: async function* () {},
      lastSeq: () => Promise.reject(new Error('down')),
    };
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      onStoreError: () => {
        throw new Error('observer bug');
      },
    });
    manual.push(textPart('x'));
    manual.end();
    expect((await collect(response)).map((part) => part.type)).toEqual([
      'start',
      'warning',
      'text-delta',
    ]);
  });
});

describe('H2: a store write fails', () => {
  it('reports a stream-store-error warning, calls onStoreError once and stops journaling the leg', async () => {
    const inner = createInMemoryStreamStateStore();
    const attempted: number[] = [];
    const store: StreamStateStore = {
      append: async (streamId, seq, part) => {
        attempted.push(seq);
        if (seq === 1) throw new Error('write down');
        inner.append(streamId, seq, part);
      },
      read: (streamId, fromSeq) => inner.read(streamId, fromSeq),
      lastSeq: (streamId) => inner.lastSeq(streamId),
    };
    const errors: unknown[] = [];
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      messageId: 'm1',
      onStoreError: (error) => errors.push(error),
    });
    manual.push(textPart('a'));
    manual.push(textPart('b'));
    manual.push(textPart('c'));
    manual.end();
    const frames = sseFrames(await response.text());
    // Every frame still reaches the client with its id; the warning has none.
    const numbered = frames.filter((frame) => frame.id !== undefined);
    expect(numbered.map((frame) => frame.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(numbered.at(-1)!.data).toBe('[DONE]');
    const warnings = frames.filter((frame) => frame.id === undefined);
    expect(warnings.map((frame) => frame.data)).toEqual([JSON.stringify(WARNING)]);
    // The first failure ends the journal: no later append is attempted, so no hole.
    expect(attempted).toEqual([0, 1]);
    expect(inner.lastSeq('s')).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('write down');
  });

  it('never makes the wire wait for the store', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store: StreamStateStore = {
      append: () => gate,
      read: async function* () {},
      lastSeq: () => undefined,
    };
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, { store, streamId: 's', messageId: 'm' });
    manual.push(textPart('fast'));
    manual.end();
    // readDeuzStream returns at [DONE], while every append is still pending.
    expect((await collect(response)).map((part) => part.type)).toEqual(['start', 'text-delta']);
    release();
  });

  it('sends no warning part to a wire v1 client', async () => {
    const store: StreamStateStore = {
      append: () => {
        throw new Error('write down');
      },
      read: async function* () {},
      lastSeq: () => undefined,
    };
    const errors: unknown[] = [];
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      messageId: 'm',
      wireVersion: 'v1',
      onStoreError: (error) => errors.push(error),
    });
    manual.push(textPart('a'));
    manual.end();
    const raw = await response.text();
    expect(raw).toBe(
      `data: ${JSON.stringify({ type: 'start', messageId: 'm' })}\n\n` +
        `data: ${JSON.stringify({ type: 'text-delta', text: 'a' })}\n\n` +
        'data: [DONE]\n\n',
    );
    expect(errors).toHaveLength(1);
  });
});

describe('a healthy store', () => {
  it('keeps the 2.3 wire byte for byte', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, {
      store,
      streamId: 's',
      messageId: 'm',
    });
    manual.push(textPart('a'));
    manual.end();
    expect(await response.text()).toBe(
      `id: 0\ndata: ${JSON.stringify({ type: 'start', messageId: 'm' })}\n\n` +
        `id: 1\ndata: ${JSON.stringify({ type: 'text-delta', text: 'a' })}\n\n` +
        'id: 2\ndata: [DONE]\n\n',
    );
    expect(store.lastSeq('s')).toBe(2);
  });
});
