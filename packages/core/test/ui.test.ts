import { describe, it, expect, vi } from 'vitest';
import { streamChat } from '../src/index';
import {
  toDeuzStreamResponse,
  toDeuzObjectStreamResponse,
  readDeuzStream,
  connectDeuzStream,
  resumeDeuzStreamResponse,
  negotiateDeuzStreamVersion,
  createInMemoryStreamStateStore,
  createDeuzStream,
  DEUZ_STREAM_VERSION,
  type DeuzUIPart,
} from '../src/ui';
import type { StreamObjectResult, StreamChatResult } from '../src/index';
import type { StreamPart } from '../src/types/stream';
import type { StandardSchemaV1 } from '../src/types/schema';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetch, mockFetchSequence } from './fixtures/sse';

/**
 * Near-zero-delay timer — keeps reconnect/poll tests fast without fake timers.
 * Uses a REAL 0ms macrotask (not a microtask) so poll loops never starve the
 * event loop's timers/IO while they spin.
 */
const instantClock = {
  setTimeout: (fn: () => void, _ms: number) => {
    const id = globalThis.setTimeout(fn, 0);
    return () => globalThis.clearTimeout(id);
  },
};

/** Manually-fed canonical stream (fullStream is all the serializer touches). */
function manualResult(): {
  result: StreamChatResult;
  push: (part: StreamPart) => void;
  end: () => void;
} {
  const queue: StreamPart[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  async function* iterate(): AsyncGenerator<StreamPart> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => (notify = resolve));
    }
  }
  const usage = Promise.resolve({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  });
  return {
    result: {
      fullStream: iterate(),
      textStream: (async function* () {})(),
      usage,
      finishReason: Promise.resolve('stop'),
    } as StreamChatResult,
    push: (part) => {
      queue.push(part);
      notify?.();
    },
    end: () => {
      done = true;
      notify?.();
    },
  };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const TOOL_CALL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'getWeather' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const FINAL = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Sunny in Paris.' },
    },
  },
  {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 6 },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

describe('Deuz UI wire', () => {
  it('serializes a plain stream and round-trips via readDeuzStream', async () => {
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const response = toDeuzStreamResponse(result, { messageId: 'm1' });

    expect(response.headers.get('x-deuz-stream')).toBe('v2');
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);

    expect(parts[0]).toEqual({ type: 'start', messageId: 'm1' });
    expect(parts.at(-1)?.type).toBe('finish');
    const text = parts
      .filter((p): p is Extract<typeof p, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toBe('Sunny in Paris.');
  });

  it('emits tool-call + tool-result UI parts across an agentic stream', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });
    const response = toDeuzStreamResponse(result);

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);

    const types = parts.map((p) => p.type);
    expect(types).toContain('step-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-call');
    expect(types).toContain('tool-result');
    expect(types.at(-1)).toBe('finish');

    const call = parts.find(
      (p): p is Extract<typeof p, { type: 'tool-call' }> => p.type === 'tool-call',
    );
    expect(call).toMatchObject({ toolName: 'getWeather', input: { city: 'Paris' } });
  });

  it('serializes tool-approval-request parts; unknown parts pass through the reader', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true },
      },
      maxSteps: 5,
    });
    const response = toDeuzStreamResponse(result);

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);

    const approval = parts.find(
      (p): p is Extract<typeof p, { type: 'tool-approval-request' }> =>
        p.type === 'tool-approval-request',
    );
    expect(approval).toEqual({
      type: 'tool-approval-request',
      approvalId: 'toolu_1',
      toolCallId: 'toolu_1',
      toolName: 'getWeather',
      input: { city: 'Paris' },
    });
    expect(weather).not.toHaveBeenCalled();

    // Open read side: a client→server tool-approval-response line (or any
    // unknown part) passes through readDeuzStream untouched.
    const sse = [
      'data: {"type":"tool-approval-response","approvalId":"toolu_1","approved":true}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const raw = new Response(new Blob([sse]).stream(), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const passthrough = [];
    for await (const p of readDeuzStream(raw)) passthrough.push(p);
    expect(passthrough).toEqual([
      { type: 'tool-approval-response', approvalId: 'toolu_1', approved: true },
    ]);
  });

  it('serializes a compaction part through the wire (explicit case, not dropped)', async () => {
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'task' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'r '.repeat(50) },
            { type: 'text', text: 'a' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'r '.repeat(50) },
            { type: 'text', text: 'b' },
          ],
        },
        { role: 'user', content: 'go' },
      ],
      tools: { getWeather: { parameters: SCHEMA, execute: vi.fn(async () => ({ temp: 1 })) } },
      compaction: { threshold: 0, keepRecentSteps: 1, layers: ['prune-reasoning'] },
    });
    const response = toDeuzStreamResponse(result);
    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);
    const compaction = parts.find(
      (p): p is Extract<typeof p, { type: 'compaction' }> => p.type === 'compaction',
    );
    expect(compaction).toMatchObject({ type: 'compaction', layer: 'prune-reasoning' });
    expect(compaction!.tokensBefore).toBeGreaterThan(compaction!.tokensAfter);
  });

  it('recursively frames a sub-agent part through the wire', async () => {
    // A raw canonical sub-agent part (as agentTool would emit) round-trips with
    // its inner part re-framed, not dropped.
    const canonical = [
      'data: {"type":"start","messageId":"m"}\n\n',
      'data: {"type":"sub-agent","agentPath":["researcher"],"part":{"type":"text-delta","text":"hi"}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const raw = new Response(new Blob([canonical]).stream(), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const parts = [];
    for await (const p of readDeuzStream(raw)) parts.push(p);
    const sub = parts.find(
      (p): p is Extract<typeof p, { type: 'sub-agent' }> => p.type === 'sub-agent',
    );
    expect(sub).toEqual({
      type: 'sub-agent',
      agentPath: ['researcher'],
      part: { type: 'text-delta', text: 'hi' },
    });
  });

  it('toDeuzObjectStreamResponse emits start/object-delta/finish and [DONE]', async () => {
    async function* partials(): AsyncGenerator<{ city?: string }> {
      yield { city: 'Par' };
      yield { city: 'Paris' };
    }
    const fake: StreamObjectResult<{ city: string }> = {
      partialObjectStream: partials(),
      object: Promise.resolve({ city: 'Paris' }),
      usage: Promise.resolve({
        inputTokens: 8,
        outputTokens: 4,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 12,
      }),
      finishReason: Promise.resolve('stop'),
    };
    const res = toDeuzObjectStreamResponse(fake, { messageId: 'm1' });
    expect(res.headers.get('x-deuz-stream')).toBe('v2');
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const parts = [];
    for await (const p of readDeuzStream(res)) parts.push(p);
    expect(parts[0]).toEqual({ type: 'start', messageId: 'm1' });
    expect(
      parts
        .filter((p): p is Extract<typeof p, { type: 'object-delta' }> => p.type === 'object-delta')
        .map((p) => p.object),
    ).toEqual([{ city: 'Par' }, { city: 'Paris' }]);
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  });

  it('toDeuzObjectStreamResponse surfaces failures as a redacted error part', async () => {
    async function* boom(): AsyncGenerator<unknown> {
      throw new Error('bad sk-ant-SECRETxyz1234567');
      yield undefined; // unreachable — keeps the generator shape
    }
    const rejected = Promise.reject(new Error('x'));
    rejected.catch(() => {});
    const fake = {
      partialObjectStream: boom(),
      object: rejected,
      usage: rejected,
      finishReason: rejected,
    } as unknown as StreamObjectResult<unknown>;
    const parts = [];
    for await (const p of readDeuzStream(toDeuzObjectStreamResponse(fake))) parts.push(p);
    const err = parts.find((p): p is Extract<typeof p, { type: 'error' }> => p.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('SECRETxyz');
  });

  it('redacts secrets in the error part', async () => {
    const errStream = sseEvents([
      {
        event: 'error',
        data: {
          type: 'error',
          error: { type: 'api_error', message: 'boom sk-ant-SECRETxyz1234567' },
        },
      },
    ]);
    const { fetch } = mockFetch(() => sseResponse([errStream]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const response = toDeuzStreamResponse(result);

    const parts = [];
    for await (const p of readDeuzStream(response)) parts.push(p);
    const err = parts.find((p): p is Extract<typeof p, { type: 'error' }> => p.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).not.toContain('SECRETxyz');
  });
});

describe('Deuz UI wire v2 (resumable)', () => {
  const textPart = (text: string): StreamPart => ({ type: 'text-delta', text });

  it('emits monotonic SSE id lines by default and negotiates v1 byte-identically', async () => {
    const make = () => {
      const { fetch } = mockFetch(() => sseResponse([FINAL]));
      return streamChat({
        model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
        messages: [{ role: 'user', content: 'hi' }],
      });
    };

    const v2 = await toDeuzStreamResponse(make(), { messageId: 'm1' }).text();
    const ids = [...v2.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(2); // start + deltas + finish + [DONE]
    expect(ids).toEqual(ids.map((_, i) => i)); // 0..n monotonic, no gaps
    expect(v2.endsWith(`id: ${ids.length - 1}\ndata: [DONE]\n\n`)).toBe(true);

    // Explicit v1 request → the exact pre-1.7 wire (no id lines).
    const v1 = await toDeuzStreamResponse(make(), {
      messageId: 'm1',
      wireVersion: negotiateDeuzStreamVersion(new Headers({ 'x-deuz-stream': 'v1' })),
    }).text();
    expect(v1).not.toContain('id: ');
    expect(v1).toBe(v2.replace(/^id: \d+\n/gm, ''));

    expect(DEUZ_STREAM_VERSION).toBe('v2');
    expect(negotiateDeuzStreamVersion(undefined)).toBe('v2');
    expect(negotiateDeuzStreamVersion('v1')).toBe('v1');
    expect(negotiateDeuzStreamVersion(new Headers())).toBe('v2');
  });

  it('captures every event (plus terminal sentinel) into the StreamStateStore', async () => {
    const store = createInMemoryStreamStateStore();
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const wire = await toDeuzStreamResponse(result, {
      messageId: 'm1',
      store,
      streamId: 's1',
    }).text();

    const records = [];
    for await (const r of store.read('s1')) records.push(r);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    expect(records[0]!.part).toEqual({ type: 'start', messageId: 'm1' });
    expect(records.at(-1)!.part).toEqual({ type: 'done' });
    expect(records.at(-2)!.part).toMatchObject({ type: 'finish' });
    // The stored log and the live wire agree event-for-event.
    const wireDataLines = wire.split('\n').filter((l) => l.startsWith('data: ')).length;
    expect(records.length).toBe(wireDataLines); // parts + [DONE]↔done sentinel
  });

  it('replays from Last-Event-ID with no gaps and no duplicates (break-point golden)', async () => {
    const store = createInMemoryStreamStateStore();
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Full run happened server-side; the client only RECEIVED events 0..1
    // before its connection dropped.
    const full = await toDeuzStreamResponse(result, {
      messageId: 'm1',
      store,
      streamId: 's1',
    }).text();
    const allParts = full
      .split('\n')
      .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice('data: '.length)) as DeuzUIPart);

    const resumed = resumeDeuzStreamResponse(store, 's1', {
      lastEventId: '1',
      pollIntervalMs: 1,
      idleTimeoutMs: 5,
      clock: instantClock,
    });
    expect(resumed.headers.get('x-deuz-stream')).toBe('v2');
    const tail: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(resumed)) tail.push(p);

    // events 0..1 (already delivered) + tail == the exact full sequence
    expect([...allParts.slice(0, 2), ...tail]).toEqual(allParts);
    const raw = await resumeDeuzStreamResponse(store, 's1', {
      lastEventId: '1',
      clock: instantClock,
    }).text();
    expect(raw).toMatch(/^id: 2\n/m); // ids continue the original numbering
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('lets a second client follow a still-live stream (multi-client)', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const live = toDeuzStreamResponse(manual.result, {
      messageId: 'm1',
      store,
      streamId: 's1',
    });
    const clientA = (async () => {
      const parts: DeuzUIPart[] = [];
      for await (const p of readDeuzStream(live)) parts.push(p);
      return parts;
    })();

    manual.push(textPart('Hel'));
    // Second client attaches from scratch while the stream is mid-flight.
    const clientB = (async () => {
      const parts: DeuzUIPart[] = [];
      const res = resumeDeuzStreamResponse(store, 's1', {
        pollIntervalMs: 1,
        idleTimeoutMs: 2_000,
        clock: instantClock,
      });
      for await (const p of readDeuzStream(res)) parts.push(p);
      return parts;
    })();

    await new Promise((r) => setTimeout(r, 5));
    manual.push(textPart('lo'));
    manual.push({
      type: 'finish',
      finishReason: 'stop',
      usage: await manual.result.usage,
    });
    manual.end();

    const [a, b] = await Promise.all([clientA, clientB]);
    expect(a).toEqual(b); // the follower saw the identical gapless sequence
    expect(b.map((p) => p.type)).toEqual(['start', 'text-delta', 'text-delta', 'finish']);
  });

  it('connectDeuzStream reconnects with Last-Event-ID and deduplicates overlap', async () => {
    const seen: Array<string | undefined> = [];
    const first = sseEvents([
      { id: 0, data: { type: 'start', messageId: 'm1' } },
      { id: 1, data: { type: 'text-delta', text: 'Hel' } },
      { id: 2, data: { type: 'text-delta', text: 'lo' } },
      // connection dies here — no [DONE]
    ]);
    const second = sseEvents([
      { id: 2, data: { type: 'text-delta', text: 'lo' } }, // replayed overlap
      { id: 3, data: { type: 'text-delta', text: '!' } },
      { id: 4, data: '[DONE]' },
    ]);
    const responses = [first, second];
    const source = (ctx: { lastEventId?: string }) => {
      seen.push(ctx.lastEventId);
      return sseResponse([responses.shift() ?? second]);
    };

    const parts: DeuzUIPart[] = [];
    for await (const p of connectDeuzStream(source, { clock: instantClock })) parts.push(p);

    expect(seen).toEqual([undefined, '2']);
    expect(parts).toEqual([
      { type: 'start', messageId: 'm1' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'text-delta', text: '!' },
    ]);
  });

  it('connectDeuzStream gives up after maxReconnects consecutive dead connections', async () => {
    let calls = 0;
    const source = () => {
      calls++;
      return sseResponse([sseEvents([])]); // opens, delivers nothing, ends
    };
    await expect(async () => {
      for await (const _ of connectDeuzStream(source, {
        maxReconnects: 2,
        clock: instantClock,
      })) {
        void _;
      }
    }).rejects.toThrow(/ended before \[DONE\]/);
    expect(calls).toBe(3); // initial + 2 reconnects
  });

  it('resume of a store with no terminal sentinel closes after the idle timeout', async () => {
    const store = createInMemoryStreamStateStore();
    store.append('s1', 0, { type: 'start', messageId: 'm1' });
    store.append('s1', 1, { type: 'text-delta', text: 'partial' });
    const res = resumeDeuzStreamResponse(store, 's1', {
      pollIntervalMs: 1,
      idleTimeoutMs: 3,
      clock: instantClock,
    });
    const raw = await res.text();
    expect(raw).toContain('"partial"');
    expect(raw).not.toContain('[DONE]'); // closed as a drop → clients may retry
  });

  it('continues seq numbering (and skips the start part) when the store already has records', async () => {
    const store = createInMemoryStreamStateStore();
    store.append('s1', 0, { type: 'start', messageId: 'm1' });
    store.append('s1', 1, { type: 'text-delta', text: 'first leg' });

    const manual = manualResult();
    const res = toDeuzStreamResponse(manual.result, { store, streamId: 's1', messageId: 'm1' });
    manual.push(textPart('second leg'));
    manual.end();
    const raw = await res.text();

    expect(raw).not.toContain('"type":"start"'); // no duplicate start on resume
    expect(raw).toMatch(/^id: 2\n/m);
    const records = [];
    for await (const r of store.read('s1')) records.push(r);
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(records[2]!.part).toEqual({ type: 'text-delta', text: 'second leg' });
    expect(records[3]!.part).toEqual({ type: 'done' });
  });

  it('object streams are resumable too (stored UI parts replay verbatim)', async () => {
    const store = createInMemoryStreamStateStore();
    async function* partials(): AsyncGenerator<{ city?: string }> {
      yield { city: 'Par' };
      yield { city: 'Paris' };
    }
    const fake: StreamObjectResult<{ city: string }> = {
      partialObjectStream: partials(),
      object: Promise.resolve({ city: 'Paris' }),
      usage: Promise.resolve({
        inputTokens: 8,
        outputTokens: 4,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 12,
      }),
      finishReason: Promise.resolve('stop'),
    };
    await toDeuzObjectStreamResponse(fake, { messageId: 'm1', store, streamId: 'obj1' }).text();

    const replay: DeuzUIPart[] = [];
    const res = resumeDeuzStreamResponse(store, 'obj1', {
      lastEventId: '0',
      pollIntervalMs: 1,
      idleTimeoutMs: 5,
      clock: instantClock,
    });
    for await (const p of readDeuzStream(res)) replay.push(p);
    expect(replay.map((p) => p.type)).toEqual(['object-delta', 'object-delta', 'finish']);
    expect(replay[1]).toEqual({ type: 'object-delta', object: { city: 'Paris' } });
  });

  it('keeps recording to the store after the client disconnects (refresh mid-generation)', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const live = toDeuzStreamResponse(manual.result, { store, streamId: 's1', messageId: 'm1' });

    const reader = live.body!.getReader();
    manual.push(textPart('Hel'));
    await reader.read(); // start
    await reader.read(); // Hel
    await reader.cancel(); // the user hit refresh

    manual.push(textPart('lo'));
    manual.push({ type: 'finish', finishReason: 'stop', usage: await manual.result.usage });
    manual.end();

    // The producer keeps draining into the store; wait for the sentinel.
    let records: Array<{ seq: number; part: { type: string } }> = [];
    for (let i = 0; i < 100 && records.at(-1)?.part.type !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 5));
      records = [];
      for await (const r of store.read('s1')) records.push(r);
    }
    expect(records.map((r) => r.part.type)).toEqual([
      'start',
      'text-delta',
      'text-delta',
      'finish',
      'done',
    ]);

    // …and the refreshed client resumes right where it stopped.
    const tail: DeuzUIPart[] = [];
    const res = resumeDeuzStreamResponse(store, 's1', {
      lastEventId: '1',
      pollIntervalMs: 1,
      idleTimeoutMs: 100,
      clock: instantClock,
    });
    for await (const p of readDeuzStream(res)) tail.push(p);
    expect(tail.map((p) => p.type)).toEqual(['text-delta', 'finish']);
    expect(tail[0]).toEqual({ type: 'text-delta', text: 'lo' });
  });

  it('replays through intermediate leg sentinels (continued runs stay reachable)', async () => {
    const store = createInMemoryStreamStateStore();
    // Leg 1 completes (suspension/error legs write the same sentinel shape).
    const leg1 = manualResult();
    const res1 = toDeuzStreamResponse(leg1.result, { store, streamId: 's1', messageId: 'm1' });
    leg1.push(textPart('leg1'));
    leg1.end();
    await res1.text();
    // Leg 2 continues the SAME streamId (durable resume / approval round-trip).
    const leg2 = manualResult();
    const res2 = toDeuzStreamResponse(leg2.result, { store, streamId: 's1' });
    leg2.push(textPart('leg2'));
    leg2.end();
    await res2.text();

    // A client that stopped at leg 1's [DONE] (seq 2) sees leg 2.
    const cont: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(
      resumeDeuzStreamResponse(store, 's1', {
        lastEventId: '2',
        pollIntervalMs: 1,
        idleTimeoutMs: 100,
        clock: instantClock,
      }),
    )) {
      cont.push(p);
    }
    expect(cont).toEqual([{ type: 'text-delta', text: 'leg2' }]);

    // A from-scratch replay sails through the boundary sentinel: both legs'
    // parts, exactly one [DONE] (at the final sentinel).
    const full = await resumeDeuzStreamResponse(store, 's1', {
      pollIntervalMs: 1,
      idleTimeoutMs: 100,
      clock: instantClock,
    }).text();
    expect(full.match(/\[DONE\]/g)).toHaveLength(1);
    expect(full).toContain('"leg1"');
    expect(full).toContain('"leg2"');
  });

  it('a caught-up cursor on a completed stream gets [DONE] immediately (no idle hang)', async () => {
    const store = createInMemoryStreamStateStore();
    store.append('s1', 0, { type: 'start', messageId: 'm1' });
    store.append('s1', 1, { type: 'text-delta', text: 'hi' });
    store.append('s1', 2, { type: 'done' });
    // Generous timeout on purpose: the fast path must answer without waiting.
    const raw = await resumeDeuzStreamResponse(store, 's1', {
      lastEventId: '2',
      idleTimeoutMs: 60_000,
    }).text();
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(raw).not.toContain('"hi"'); // nothing re-delivered
  });

  it('treats an empty Last-Event-ID as "no cursor", replaying from the start part', async () => {
    const store = createInMemoryStreamStateStore();
    store.append('s1', 0, { type: 'start', messageId: 'm1' });
    store.append('s1', 1, { type: 'done' });
    const raw = await resumeDeuzStreamResponse(store, 's1', {
      lastEventId: '', // header sent with an empty value — Number('') === 0 trap
      pollIntervalMs: 1,
      idleTimeoutMs: 100,
      clock: instantClock,
    }).text();
    expect(raw).toContain('"type":"start"');
  });

  it('does not advance the cursor past a truncated frame (clean EOF mid-frame)', async () => {
    const seen: Array<string | undefined> = [];
    // Frame id:2 is cut mid-JSON and the connection ends with a clean FIN.
    const first =
      sseEvents([
        { id: 0, data: { type: 'start', messageId: 'm1' } },
        { id: 1, data: { type: 'text-delta', text: 'A' } },
      ]) + 'id: 2\ndata: {"type":"text-de';
    const second = sseEvents([
      { id: 2, data: { type: 'text-delta', text: 'B' } },
      { id: 3, data: '[DONE]' },
    ]);
    const responses = [first, second];
    const source = (ctx: { lastEventId?: string }) => {
      seen.push(ctx.lastEventId);
      return sseResponse([responses.shift() ?? second]);
    };
    const parts: DeuzUIPart[] = [];
    for await (const p of connectDeuzStream(source, { clock: instantClock })) parts.push(p);
    expect(seen).toEqual([undefined, '1']); // NOT '2' — the lost frame gets replayed
    expect(parts.map((p) => (p.type === 'text-delta' ? p.text : p.type))).toEqual([
      'start',
      'A',
      'B',
    ]);
  });

  it('refuses to blind-reconnect to an id-less (v1) stream instead of duplicating parts', async () => {
    const v1Body = 'data: {"type":"text-delta","text":"Hello"}\n\n'; // no ids, no [DONE]
    await expect(async () => {
      for await (const _ of connectDeuzStream(() => sseResponse([v1Body]), {
        clock: instantClock,
      })) {
        void _;
      }
    }).rejects.toThrow(/no event ids/);
  });

  it('a failing store degrades the response, never kills it', async () => {
    const storeErrors: unknown[] = [];
    const broken = {
      append() {
        throw new Error('redis down');
      },
      async *read(): AsyncGenerator<never> {
        throw new Error('redis down');
      },
      lastSeq() {
        throw new Error('redis down');
      },
    };
    const manual = manualResult();
    const res = toDeuzStreamResponse(manual.result, {
      store: broken,
      streamId: 's1',
      messageId: 'm1',
      onStoreError: (e) => storeErrors.push(e),
    });
    manual.push(textPart('still streaming'));
    manual.end();
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(res)) parts.push(p);
    expect(parts.map((p) => p.type)).toEqual(['start', 'text-delta']);
    expect(storeErrors.length).toBeGreaterThan(0);

    // Resume against the same broken store: redacted error part, no hang.
    const raw = await resumeDeuzStreamResponse(broken, 's1', { clock: instantClock }).text();
    expect(raw).toContain('"type":"error"');
    expect(raw).not.toContain('[DONE]');
  });

  it('onCursor exposes the resume cursor for cross-reload persistence', async () => {
    const cursors: string[] = [];
    const body = sseEvents([
      { id: 0, data: { type: 'start', messageId: 'm1' } },
      { id: 1, data: { type: 'text-delta', text: 'x' } },
      { id: 2, data: '[DONE]' },
    ]);
    for await (const _ of connectDeuzStream(() => sseResponse([body]), {
      clock: instantClock,
      onCursor: (id) => cursors.push(id),
    })) {
      void _;
    }
    expect(cursors).toEqual(['0', '1']);
  });

  it('in-memory store evicts least-recently-appended streams beyond maxStreams', async () => {
    const store = createInMemoryStreamStateStore({ maxStreams: 2 });
    store.append('a', 0, { type: 'done' });
    store.append('b', 0, { type: 'done' });
    store.append('a', 1, { type: 'done' }); // refresh 'a'
    store.append('c', 0, { type: 'done' }); // evicts 'b'
    expect(await store.lastSeq('a')).toBe(1);
    expect(await store.lastSeq('b')).toBeUndefined();
    expect(await store.lastSeq('c')).toBe(0);
  });
});

describe('Deuz UI wire — typed data parts, tool state, citations (P3)', () => {
  const numberSchema: StandardSchemaV1<unknown, { a: number }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { a?: unknown }).a === 'number'
          ? { value: value as { a: number } }
          : { issues: [{ message: 'a must be a number' }] },
    },
  };

  it('writeData injects data-{name} parts into the live stream (journaled + replayable)', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { store, streamId: 's1', messageId: 'm1' });

    manual.push({ type: 'text-delta', text: 'Hel' });
    writer.writeData('chart', { series: [1, 2, 3] });
    manual.push({ type: 'text-delta', text: 'lo' });
    manual.end();

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(writer.response)) parts.push(p);
    const chart = parts.find((p) => p.type === 'data-chart');
    expect(chart).toEqual({ type: 'data-chart', payload: { series: [1, 2, 3] } });
    expect(parts.map((p) => p.type)).toContain('text-delta');

    // Journaled with its seq → replays like every other part.
    const replay = await resumeDeuzStreamResponse(store, 's1', {
      pollIntervalMs: 1,
      idleTimeoutMs: 100,
      clock: instantClock,
    }).text();
    expect(replay).toContain('"type":"data-chart"');
  });

  it('validates data parts against dataSchemas while streaming (opt-in)', async () => {
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, {
      messageId: 'm1',
      dataSchemas: { metric: numberSchema },
    });
    writer.writeData('metric', { a: 42 }); // valid
    writer.writeData('metric', { a: 'NaN' }); // invalid → dropped + error part
    writer.writeData('free', { anything: true }); // no schema → passthrough
    manual.end();

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(writer.response)) parts.push(p);
    expect(parts.filter((p) => p.type === 'data-metric')).toEqual([
      { type: 'data-metric', payload: { a: 42 } },
    ]);
    expect(parts.find((p) => p.type === 'data-free')).toBeDefined();
    const err = parts.find((p): p is Extract<DeuzUIPart, { type: 'error' }> => p.type === 'error');
    expect(err?.message).toContain("data part 'metric' failed validation");
  });

  it('drops v2-only parts for a negotiated-v1 client (data/tool-state/citation)', async () => {
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { messageId: 'm1', wireVersion: 'v1' });
    writer.writeData('chart', { x: 1 });
    manual.push({ type: 'citation', id: 'c1', snippet: 'quoted' });
    manual.push({ type: 'tool-state', toolCallId: 't1', state: 'executing' });
    manual.push({ type: 'text-delta', text: 'kept' });
    manual.end();

    const raw = await writer.response.text();
    expect(raw).not.toContain('data-chart');
    expect(raw).not.toContain('citation');
    expect(raw).not.toContain('tool-state');
    expect(raw).toContain('"kept"');
    expect(raw).not.toContain('id: '); // still byte-shaped like v1
  });

  it('emits the tool state machine across an executed tool call', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather } },
      maxSteps: 5,
    });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(toDeuzStreamResponse(result))) parts.push(p);

    const states = parts
      .filter((p): p is Extract<DeuzUIPart, { type: 'tool-state' }> => p.type === 'tool-state')
      .map((p) => p.state);
    expect(states).toEqual(['input-streaming', 'input-complete', 'executing', 'complete']);
    // Transitions bracket the actual tool parts in order.
    const ordered = parts.map((p) => (p.type === 'tool-state' ? `state:${p.state}` : p.type));
    expect(ordered.indexOf('state:input-complete')).toBeGreaterThan(
      ordered.indexOf('tool-call') - 2,
    );
    expect(ordered.indexOf('state:complete')).toBeGreaterThan(ordered.indexOf('tool-result'));
  });

  it('emits awaiting-approval for gated calls (client-mode approval)', async () => {
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
      maxSteps: 5,
    });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(toDeuzStreamResponse(result))) parts.push(p);

    const states = parts
      .filter((p): p is Extract<DeuzUIPart, { type: 'tool-state' }> => p.type === 'tool-state')
      .map((p) => p.state);
    expect(states).toEqual(['input-streaming', 'input-complete', 'awaiting-approval']);
    expect(weather).not.toHaveBeenCalled();
    // The approval request itself still follows the state transition.
    const ordered = parts.map((p) => (p.type === 'tool-state' ? `state:${p.state}` : p.type));
    expect(ordered.indexOf('tool-approval-request')).toBeGreaterThan(
      ordered.indexOf('state:awaiting-approval'),
    );
  });
});

describe('review fixes (T2-T5 adversarial pass)', () => {
  it('v1 filter drops v2-only parts nested inside sub-agent frames too', async () => {
    const manual = manualResult();
    const res = toDeuzStreamResponse(manual.result, { messageId: 'm1', wireVersion: 'v1' });
    manual.push({
      type: 'sub-agent',
      agentPath: ['researcher'],
      part: { type: 'tool-state', toolCallId: 't1', state: 'executing' },
    });
    manual.push({
      type: 'sub-agent',
      agentPath: ['researcher'],
      part: { type: 'text-delta', text: 'kept sub-agent text' },
    });
    manual.end();
    const raw = await res.text();
    expect(raw).not.toContain('tool-state'); // nested v2-only dropped
    expect(raw).toContain('kept sub-agent text'); // plain sub-agent parts intact
  });
});
