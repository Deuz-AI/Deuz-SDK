import { describe, expect, it } from 'vitest';
import { parseSSE } from '../src/internal/sse';

function byteStream(input: string, chunkSizes: number[] = [1]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(input);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      let index = 0;
      while (offset < bytes.length) {
        const size = chunkSizes[index % chunkSizes.length] ?? 1;
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
        index += 1;
      }
      controller.close();
    },
  });
}

describe('SSE protocol contract', () => {
  it('parses BOM, all legal line endings, comments, multiline data, and an EOF tail', async () => {
    const wire =
      '\uFEFFevent: alpha\rdata: one\rdata: two\r\r' +
      ': keep-alive\r\n\r\n' +
      'data: café 🎉\n\n' +
      'event: tail\ndata: no-final-delimiter';

    const events = [];
    for await (const event of parseSSE(byteStream(wire))) events.push(event);

    expect(events).toEqual([
      { event: 'alpha', data: 'one\ntwo' },
      { event: undefined, data: 'café 🎉' },
      { event: 'tail', data: 'no-final-delimiter' },
    ]);
  });

  it('surfaces id: lines with spec-correct stickiness (wire v2 resume cursor)', async () => {
    const wire =
      'data: before-any-id\n\n' +
      'id: 0\ndata: zero\n\n' +
      'data: sticky-still-zero\n\n' +
      'id: 7\ndata: seven\n\n' +
      'id: bad\0null\ndata: null-id-ignored\n\n';

    const events = [];
    for await (const event of parseSSE(byteStream(wire))) events.push(event);

    expect(events).toEqual([
      { event: undefined, data: 'before-any-id' },
      { event: undefined, data: 'zero', id: '0' },
      { event: undefined, data: 'sticky-still-zero', id: '0' },
      { event: undefined, data: 'seven', id: '7' },
      { event: undefined, data: 'null-id-ignored', id: '7' }, // NULL id ignored per spec
    ]);
  });

  it('is invariant to arbitrary transport chunk boundaries', async () => {
    const wire = 'event: message\r\ndata: {"text":"déjà"}\r\n\r\n';
    const partitions = [[1], [2, 3, 5, 7], [wire.length]];
    const results = [];

    for (const sizes of partitions) {
      const events = [];
      for await (const event of parseSSE(byteStream(wire, sizes))) events.push(event);
      results.push(events);
    }

    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual([{ event: 'message', data: '{"text":"déjà"}' }]);
  });

  it('cancels the underlying reader when a consumer stops early', async () => {
    let cancelled = false;
    const bytes = new TextEncoder().encode('data: first\n\ndata: never-read\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const event of parseSSE(stream)) {
      expect(event.data).toBe('first');
      break;
    }

    expect(cancelled).toBe(true);
  });
});
