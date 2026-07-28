import { describe, it, expect, vi } from 'vitest';
import { agentTool, streamChat } from '../src/index';
import {
  toDeuzStreamResponse,
  toDeuzObjectStreamResponse,
  toDeuzTextStreamResponse,
  readDeuzStream,
  connectDeuzStream,
  resumeDeuzStreamResponse,
  negotiateDeuzStreamVersion,
  createInMemoryStreamStateStore,
  createDeuzStream,
  DEUZ_STREAM_VERSION,
  type DeuzUIPart,
} from '../src/ui';
import {
  applyUIPart,
  assistantMessageFromTurn,
  canonicalFromUI,
  createAssistantTurn,
  sealAssistantTurn,
  type AssistantTurnState,
} from '../src/chat';
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

  it('yields exactly one error part for a failed response (500 error page, 401)', async () => {
    // A route that 500s returns an HTML error page: no `data:` lines at all.
    // Pre-1.9 the generator ended silently → an EMPTY assistant bubble.
    const html = '<!doctype html><html><body>Internal Server Error</body></html>';
    const failed = new Response(html, {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-type': 'text/html' },
    });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(failed)) parts.push(p);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('error');
    const message = (parts[0] as Extract<DeuzUIPart, { type: 'error' }>).message;
    expect(message).toContain('500');
    expect(message).toContain('Internal Server Error');
    expect(message).not.toContain('<html>'); // the body is never echoed

    const unauthorized = new Response('{"error":"bad key sk-ant-SECRETxyz1234567"}', {
      status: 401,
      statusText: 'Unauthorized',
    });
    const authParts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(unauthorized)) authParts.push(p);
    expect(authParts).toHaveLength(1);
    expect(authParts[0]).toEqual({
      type: 'error',
      message: 'Deuz stream request failed (status 401 Unauthorized).',
    });
  });

  it('onHttpError:"ignore" restores the pre-1.9 silence; an ok response is untouched', async () => {
    const failed = new Response('boom', { status: 429, statusText: 'Too Many Requests' });
    const silent: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(failed, { onHttpError: 'ignore' })) silent.push(p);
    expect(silent).toEqual([]);

    // A 200 stream behaves exactly as before, with or without the option.
    const body = 'data: {"type":"text-delta","text":"hi"}\n\ndata: [DONE]\n\n';
    const okParts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(sseResponse([body]), { onHttpError: 'error-part' })) {
      okParts.push(p);
    }
    expect(okParts).toEqual([{ type: 'text-delta', text: 'hi' }]);
  });

  it('redacts a secret-looking statusText on a failed response (P0)', async () => {
    // statusText is server-supplied — the only echoed string, so it goes
    // through redactString like every other outbound message.
    const failed = new Response(null, { status: 502, statusText: 'sk-ant-SECRETxyz1234567' });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(failed)) parts.push(p);
    const message = (parts[0] as Extract<DeuzUIPart, { type: 'error' }>).message;
    expect(message).not.toContain('SECRETxyz');
    expect(message).toContain('502');
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

  it('round-trips a canonical verify part on v2 and drops it on a negotiated v1', async () => {
    const verify = {
      type: 'verify',
      stepIndex: 0,
      attempt: 1,
      ok: false,
      willRetry: true,
      feedback: 'be more precise',
    } as const;

    const v2 = manualResult();
    const v2Response = toDeuzStreamResponse(v2.result, { messageId: 'm1' });
    v2.push(verify);
    v2.push({ type: 'text-delta', text: 'kept' });
    v2.end();
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(v2Response)) parts.push(p);
    expect(parts.find((p) => p.type === 'verify')).toEqual(verify);

    // Optional `feedback` is omitted, not sent as undefined.
    const passing = manualResult();
    const passingResponse = toDeuzStreamResponse(passing.result, { messageId: 'm1' });
    passing.push({ type: 'verify', stepIndex: 1, attempt: 0, ok: true, willRetry: false });
    passing.end();
    const passingParts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(passingResponse)) passingParts.push(p);
    expect(passingParts.find((p) => p.type === 'verify')).toEqual({
      type: 'verify',
      stepIndex: 1,
      attempt: 0,
      ok: true,
      willRetry: false,
    });

    // v2-only: a negotiated-v1 client keeps byte-identical output.
    const v1 = manualResult();
    const v1Response = toDeuzStreamResponse(v1.result, { messageId: 'm1', wireVersion: 'v1' });
    v1.push(verify);
    v1.push({ type: 'text-delta', text: 'kept' });
    v1.end();
    const raw = await v1Response.text();
    expect(raw).not.toContain('verify');
    expect(raw).not.toContain('be more precise');
    expect(raw).toContain('"kept"');
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

describe('toDeuzTextStreamResponse (frameless text/plain)', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  };

  /** A StreamChatResult whose fullStream is an arbitrary generator. */
  function fromSource(source: AsyncIterable<StreamPart>): StreamChatResult {
    return {
      fullStream: source,
      textStream: (async function* () {})(),
      usage: Promise.resolve(ZERO_USAGE),
      finishReason: Promise.resolve('stop'),
    } as StreamChatResult;
  }

  it('serves text/plain with no SSE framing; the body equals the concatenated textStream', async () => {
    // Two identical golden replays: one read as `textStream`, one as the
    // frameless Response — the bytes must match exactly.
    const a = mockFetch(() => sseResponse([FINAL]));
    const b = mockFetch(() => sseResponse([FINAL]));
    const model = (fetch: typeof globalThis.fetch) =>
      createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');

    const viaTextStream = streamChat({
      model: model(a.fetch),
      messages: [{ role: 'user', content: 'hi' }],
    });
    let expected = '';
    for await (const chunk of viaTextStream.textStream) expected += chunk;

    const response = toDeuzTextStreamResponse(
      streamChat({ model: model(b.fetch), messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-deuz-stream')).toBeNull();

    const body = await response.text();
    expect(body).toBe(expected);
    expect(body).toBe('Sunny in Paris.');
    // No framing whatsoever: no `data:` lines, no `id:` lines, no [DONE], no
    // blank-line event separators.
    expect(body).not.toContain('data:');
    expect(body).not.toContain('id:');
    expect(body).not.toContain('[DONE]');
    expect(body).not.toContain('\n\n');
  });

  it('honors extra headers and keeps text/plain overridable only explicitly', async () => {
    const manual = manualResult();
    const response = toDeuzTextStreamResponse(manual.result, {
      headers: { 'x-custom': 'yes' },
    });
    manual.end();
    expect(response.headers.get('x-custom')).toBe('yes');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('');
  });

  it('interleaves reasoning deltas only when includeReasoning is set', async () => {
    const withReasoning = manualResult();
    const on = toDeuzTextStreamResponse(withReasoning.result, { includeReasoning: true });
    withReasoning.push({ type: 'reasoning-delta', text: 'let me think. ' });
    withReasoning.push({ type: 'text-delta', text: 'Paris.' });
    withReasoning.push({ type: 'reasoning-delta', text: 'OPAQUE', encrypted: true });
    withReasoning.end();
    // Encrypted reasoning is an opaque provider payload — never display text.
    expect(await on.text()).toBe('let me think. Paris.');

    const plain = manualResult();
    const off = toDeuzTextStreamResponse(plain.result);
    plain.push({ type: 'reasoning-delta', text: 'let me think. ' });
    plain.push({ type: 'text-delta', text: 'Paris.' });
    plain.end();
    expect(await off.text()).toBe('Paris.');
  });

  it('drops a mid-stream error part instead of injecting it into the text', async () => {
    const manual = manualResult();
    const response = toDeuzTextStreamResponse(manual.result);
    manual.push({ type: 'text-delta', text: 'partial answer' });
    manual.push({ type: 'error', error: new Error('upstream exploded') });
    manual.push({ type: 'text-delta', text: ' tail' });
    manual.end();

    const body = await response.text();
    // Truncation-only signalling: the error never becomes indistinguishable
    // model output. Deltas that still arrive after it are ordinary text.
    expect(body).toBe('partial answer tail');
    expect(body).not.toContain('exploded');
    expect(body).not.toContain('Error');
  });

  it('closes the body without throwing when the source itself throws', async () => {
    async function* boom(): AsyncGenerator<StreamPart> {
      yield { type: 'text-delta', text: 'partial answer' };
      throw new Error('transport died');
    }
    const response = toDeuzTextStreamResponse(fromSource(boom()));
    // Neither the constructor nor the drain rejects (G2).
    await expect(response.text()).resolves.toBe('partial answer');
  });

  it('survives a client disconnect: no throw, no hang, and the source still drains', async () => {
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => (resolveDrained = resolve));
    let released = false;
    async function* source(): AsyncGenerator<StreamPart> {
      try {
        yield { type: 'text-delta', text: 'first' };
        yield { type: 'text-delta', text: 'second' };
      } finally {
        released = true;
        resolveDrained();
      }
    }
    const response = toDeuzTextStreamResponse(fromSource(source()));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first');

    await expect(reader.cancel()).resolves.toBeUndefined();
    // The run must still reach its terminal boundary after the reader left
    // (onFinish / persistence / checkpoints depend on the drain).
    await drained;
    expect(released).toBe(true);
  });
});

// ===================================================================
// 3.7b (1.9) — addressable + transient data parts, denial on the wire
// ===================================================================
describe('Deuz UI wire — addressable data parts and denial (1.9)', () => {
  /** Local copy: the P3 block's schema is scoped to its own describe. */
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

  const records = async (
    store: ReturnType<typeof createInMemoryStreamStateStore>,
    streamId: string,
  ): Promise<Array<{ seq: number; part: unknown }>> => {
    const out: Array<{ seq: number; part: unknown }> = [];
    for await (const r of store.read(streamId)) out.push(r);
    return out;
  };

  const replay = (
    store: ReturnType<typeof createInMemoryStreamStateStore>,
    streamId: string,
  ): Promise<string> =>
    resumeDeuzStreamResponse(store, streamId, {
      pollIntervalMs: 1,
      idleTimeoutMs: 100,
      clock: instantClock,
    }).text();

  it('emits TWO frames when the same (name, id) is re-written, both carrying the id', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { store, streamId: 's1', messageId: 'm1' });

    // The archetypal live status widget — one logical entry, three states.
    writer.writeData('status', { label: 'searching…' }, { id: 'search' });
    writer.writeData('status', { label: 'found 12 results' }, { id: 'search' });
    writer.writeData('plain', { n: 1 }); // no id → 1.7/1.8 append-only, unchanged
    manual.push({ type: 'text-delta', text: 'ok' });
    manual.end();

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(writer.response)) parts.push(p);

    // Reconciliation is the CLIENT's job: the wire preserves BOTH intermediate
    // states (a live client already past the first must not have it rewritten
    // under a seq it holds) and the id that addresses them.
    expect(parts.filter((p) => p.type === 'data-status')).toEqual([
      { type: 'data-status', id: 'search', payload: { label: 'searching…' } },
      { type: 'data-status', id: 'search', payload: { label: 'found 12 results' } },
    ]);
    // An id-less write is byte-for-byte what 1.8 emitted: no `id` key at all.
    const plain = parts.find((p) => p.type === 'data-plain');
    expect(plain && Object.keys(plain)).toEqual(['type', 'payload']);

    // Journaled like every other part → a replay rebuilds the same two frames.
    const raw = await replay(store, 's1');
    expect([...raw.matchAll(/"id":"search"/g)]).toHaveLength(2);
  });

  it('emits a transient part on the wire but never journals it (and keeps it off-seq)', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { store, streamId: 's1', messageId: 'm1' });

    writer.writeData('progress', { pct: 10 }, { id: 'p', transient: true });
    writer.writeData('chart', { series: [1] });
    manual.push({ type: 'text-delta', text: 'done' });
    manual.end();

    const wire = await writer.response.text();
    expect(wire).toContain('"type":"data-progress"'); // the live client sees it
    expect(wire).toContain('"type":"data-chart"');

    // Off-seq: the transient frame carries NO `id:` line, so the id space stays
    // gapless and 1:1 with the journal. A transient can therefore never become
    // a client's resume cursor, and a continued leg (which numbers from
    // `lastStoredSeq + 1`) can never reuse a seq the client already committed.
    const ids = [...wire.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i));
    const stored = await records(store, 's1');
    expect(stored.map((r) => r.seq)).toEqual(stored.map((_, i) => i)); // no hole
    // The wire carries exactly ONE frame more than the log: the ping.
    const wireDataLines = wire.split('\n').filter((l) => l.startsWith('data: ')).length;
    expect(wireDataLines).toBe(stored.length + 1);

    // Absent from the journal → absent from a replayed/persisted stream.
    expect(JSON.stringify(stored)).not.toContain('data-progress');
    expect(JSON.stringify(stored)).toContain('data-chart');
    const raw = await replay(store, 's1');
    expect(raw).not.toContain('data-progress');
    expect(raw).toContain('data-chart');
  });

  it('never advances a client resume cursor over a transient frame', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, { store, streamId: 's1', messageId: 'm1' });
    writer.writeData('progress', { pct: 10 }, { transient: true });
    writer.writeData('chart', { series: [1] });
    manual.push({ type: 'text-delta', text: 'done' });
    manual.end();

    const cursors: string[] = [];
    const parts: DeuzUIPart[] = [];
    for await (const p of connectDeuzStream(() => writer.response, {
      clock: instantClock,
      generateId: () => 'fixed',
      onCursor: (id) => cursors.push(id),
    })) {
      parts.push(p);
    }

    expect(parts.some((p) => p.type === 'data-progress')).toBe(true); // still delivered
    // `parseSSE`'s id is sticky (SSE spec), so the id-less transient frame
    // reports the PREVIOUS seq: the cursor REPEATS instead of advancing. A
    // reconnect therefore resumes at the last DURABLE part — the ping can never
    // shadow a journaled record, which is the resume bug this design avoids.
    expect(cursors).toEqual([...cursors].sort((a, b) => Number(a) - Number(b))); // monotonic
    expect(new Set(cursors).size).toBe(cursors.length - 1); // exactly one repeat
    const stored = await records(store, 's1');
    expect(Math.max(...cursors.map(Number))).toBe(stored.length - 2); // last seq before `done`
  });

  it('keeps the id and the transience through dataSchemas validation', async () => {
    const store = createInMemoryStreamStateStore();
    const manual = manualResult();
    const writer = createDeuzStream(manual.result, {
      messageId: 'm1',
      store,
      streamId: 's1',
      dataSchemas: { metric: numberSchema },
    });
    writer.writeData('metric', { a: 1 }, { id: 'm', transient: true });
    writer.writeData('metric', { a: 2 }, { id: 'm' });
    writer.writeData('metric', { a: 'NaN' }, { id: 'm', transient: true }); // invalid
    manual.end();

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(writer.response)) parts.push(p);
    expect(parts.filter((p) => p.type === 'data-metric')).toEqual([
      { type: 'data-metric', id: 'm', payload: { a: 1 } },
      { type: 'data-metric', id: 'm', payload: { a: 2 } },
    ]);
    // A validation failure is a diagnostic, not a ping: it is journaled even
    // though the write that produced it was transient.
    const stored = JSON.stringify(await records(store, 's1'));
    expect(stored).toContain('failed validation');
    expect(stored).toContain('"payload":{"a":2}');
    expect(stored).not.toContain('"payload":{"a":1}');
  });

  it('forwards an approval denial (denied + deniedReason) to the client', async () => {
    const manual = manualResult();
    const response = toDeuzStreamResponse(manual.result, { messageId: 'm1' });
    manual.push({
      type: 'tool-state',
      toolCallId: 't1',
      toolName: 'deleteRepo',
      state: 'error',
      denied: true,
      deniedReason: 'user rejected: sk-ant-abcdefghijklmnop1234',
    });
    manual.push({ type: 'tool-state', toolCallId: 't2', toolName: 'getWeather', state: 'error' });
    manual.end();

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(response)) parts.push(p);
    const states = parts.filter(
      (p): p is Extract<DeuzUIPart, { type: 'tool-state' }> => p.type === 'tool-state',
    );
    // Denial reaches the client, so the last frame of the approval flow reads
    // "denied" instead of "deleteRepo failed". P0: the reason is redacted — it
    // can be echoed from the client's own verdict string.
    expect(states[0]).toEqual({
      type: 'tool-state',
      toolCallId: 't1',
      toolName: 'deleteRepo',
      state: 'error',
      denied: true,
      deniedReason: 'user rejected: ****1234',
    });
    // A plain tool failure is untouched: no denial keys invented.
    expect(states[1] && Object.keys(states[1])).toEqual([
      'type',
      'toolCallId',
      'toolName',
      'state',
    ]);
  });

  it('keeps the v1↔v2 byte relationship; a payload id is not an SSE id line', async () => {
    const drive = async (wireVersion: 'v1' | 'v2', withV2Only: boolean): Promise<string> => {
      const manual = manualResult();
      const writer = createDeuzStream(manual.result, { messageId: 'm1', wireVersion });
      if (withV2Only) {
        // A deliberately hostile id: it mimics the `id: <seq>` SSE line that the
        // v1 golden strips out of the v2 bytes.
        writer.writeData('status', { label: 'ranking…' }, { id: '7' });
        manual.push({
          type: 'tool-state',
          toolCallId: 't1',
          state: 'error',
          denied: true,
          deniedReason: 'nope',
        });
      }
      manual.push({ type: 'text-delta', text: 'kept' });
      manual.end();
      return writer.response.text();
    };

    // The 1.7 golden still holds for the v1-safe subset.
    expect(await drive('v1', false)).toBe((await drive('v2', false)).replace(/^id: \d+\n/gm, ''));

    // Both 1.9 fields ride wholly-v2-only carriers, so v1 loses the carrier —
    // no per-field stripping rule was needed.
    const v1 = await drive('v1', true);
    expect(v1).not.toContain('data-status');
    expect(v1).not.toContain('denied');
    expect(v1).not.toContain('id: ');
    expect(v1).toContain('"kept"');

    // On v2 the payload id survives the strip: `^id: \d+\n` is anchored and can
    // never reach inside a `data:` line.
    const v2 = await drive('v2', true);
    expect(v2).toContain('"id":"7"');
    expect(v2.replace(/^id: \d+\n/gm, '')).toContain('"id":"7"');
    expect(v2).toContain('"deniedReason":"nope"');
  });
});

// ===================================================================
// 1.9 WIRING PASS — the three canonical parts that reached `toUIPart`'s
// `default: return undefined` and died there, plus the reducer channels they
// now fold into. Before this block: `warning` and `false-finish` never crossed
// the wire at all, and a `sub-agent` frame crossed it but `applyUIPart` had no
// case, so an `agentTool` run was INVISIBLE in every useChat UI.
// ===================================================================
describe('Deuz UI wire — sub-agent, warning and false-finish wiring (1.9)', () => {
  const ZERO_USAGE = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    totalTokens: 0,
  };

  /**
   * Serialize a hand-fed canonical stream through the REAL serializer and read
   * it back both ways. Two identical drives, because a `Response` body can only
   * be consumed once: one parsed into UI parts, one kept as raw bytes for the
   * v1↔v2 golden.
   */
  async function roundTrip(
    parts: StreamPart[],
    options: { wireVersion?: 'v1' | 'v2' } = {},
  ): Promise<{ ui: DeuzUIPart[]; raw: string }> {
    const drive = (): Response => {
      const manual = manualResult();
      const response = toDeuzStreamResponse(manual.result, {
        messageId: 'm1',
        ...(options.wireVersion ? { wireVersion: options.wireVersion } : {}),
      });
      for (const part of parts) manual.push(part);
      manual.end();
      return response;
    };
    const ui: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(drive())) ui.push(part);
    return { ui, raw: await drive().text() };
  }

  /** Fold a whole UI part sequence through the core reducer, as useChat does. */
  function fold(parts: DeuzUIPart[]): AssistantTurnState {
    let turn = createAssistantTurn('turn-1');
    for (const part of parts) turn = applyUIPart(turn, part);
    return turn;
  }

  /** Serialize a real `StreamChatResult` and read it back (the useChat path). */
  async function drainWire(result: StreamChatResult): Promise<DeuzUIPart[]> {
    const parts: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(toDeuzStreamResponse(result, { messageId: 'm1' }))) {
      parts.push(part);
    }
    return parts;
  }

  /** An Anthropic tool_use turn (the agentTool call the parent makes). */
  const toolUseSse = (toolName: string, id: string, argsJson: string): string =>
    sseEvents([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id, name: toolName },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: argsJson },
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

  /** An Anthropic text turn. */
  const textSse = (text: string): string =>
    sseEvents([
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
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
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

  it('round-trips a sub-agent frame and surfaces it WITHOUT misattributing its text', async () => {
    const { ui } = await roundTrip([
      { type: 'step-start', stepIndex: 0 },
      { type: 'text-delta', text: 'Delegating. ' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'researcher',
        input: { prompt: 'find papers' },
      },
      // The child's whole stream is forwarded live, single-wrapped.
      {
        type: 'sub-agent',
        agentPath: ['researcher'],
        part: { type: 'text-delta', text: 'searching arxiv' },
      },
      {
        type: 'sub-agent',
        agentPath: ['researcher'],
        part: { type: 'text-delta', text: '… done.' },
      },
      {
        type: 'sub-agent',
        agentPath: ['researcher'],
        part: { type: 'tool-call', toolCallId: 'child-1', toolName: 'search', input: { q: 'rag' } },
      },
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'researcher',
        output: '3 papers.',
      },
      { type: 'text-delta', text: 'Here they are.' },
      { type: 'finish', finishReason: 'stop', usage: ZERO_USAGE },
    ]);

    // The wire carries the frame with its path and the inner part re-framed.
    const frames = ui.filter(
      (p): p is Extract<DeuzUIPart, { type: 'sub-agent' }> => p.type === 'sub-agent',
    );
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({
      type: 'sub-agent',
      agentPath: ['researcher'],
      part: { type: 'text-delta', text: 'searching arxiv' },
    });

    const turn = fold(ui);
    // SURFACED: one frame per agentPath, holding the child's OWN turn — folded
    // by the same reducer, so its text is coalesced and its tool card is there.
    expect(turn.subAgents).toHaveLength(1);
    const frame = turn.subAgents![0]!;
    expect(frame.agentPath).toEqual(['researcher']);
    expect(frame.turn.message.content).toBe('searching arxiv… done.');
    expect(frame.turn.message.toolCalls).toEqual([
      { toolCallId: 'child-1', toolName: 'search', input: { q: 'rag' }, state: 'call' },
    ]);
    expect(frame.turn.message.parts?.map((p) => p.type)).toEqual(['text', 'tool']);
    // The interleave is recoverable: the frame opened right after the parent's
    // ordered elements that existed at the handoff (step-start, text, tool card).
    expect(frame.afterPart).toBe(3);

    // NOT MISATTRIBUTED: the parent's flat 1.8 projection is only the parent's
    // own words, its ordered `parts` gained no sub-agent element, and its
    // `toolCalls` never learned about the child's call.
    expect(turn.message.content).toBe('Delegating. Here they are.');
    expect(turn.message.content).not.toContain('searching arxiv');
    expect(turn.message.parts?.map((p) => p.type)).toEqual(['step-start', 'text', 'tool', 'text']);
    expect(turn.message.toolCalls?.map((c) => c.toolCallId)).toEqual(['call-1']);
    // …and therefore the canonical projection cannot claim the child's tool_use.
    // A `tool_use` with no matching `tool_result` is exactly what 400s the next
    // request, so this is a correctness guard, not only an attribution one.
    const canonical = JSON.stringify(canonicalFromUI([turn.message]));
    expect(JSON.stringify(assistantMessageFromTurn(turn))).not.toContain('child-1');
    expect(canonical).not.toContain('child-1');
    expect(canonical).not.toContain('searching arxiv');
    // What DOES belong to the parent: the agentTool call and the answer it
    // returned, as that call's own tool_result.
    expect(canonical).toContain('"id":"call-1"');
    expect(canonical).toContain('"toolUseId":"call-1"');
  });

  it('surfaces a REAL agentTool run through the wire into the turn (not a hand-pushed part)', async () => {
    // END-TO-END: a real `agentTool` delegation, forwarded live by
    // `inference/agent-tool.ts`, serialized by `toDeuzStreamResponse` and folded
    // by `applyUIPart`. Before this pass the wire carried these frames and the
    // reducer dropped every one of them, so the delegated run was invisible.
    const { fetch } = mockFetchSequence([
      () => sseResponse([toolUseSse('worker', 'call_w', '{"prompt":"go"}')]), // parent step 0
      () => sseResponse([textSse('sub answer')]), // the sub-agent's own turn
      () => sseResponse([textSse('parent answer')]), // parent step 1
    ]);
    const anthropic = createAnthropic({ apiKey: 'k', fetch });
    const result = streamChat({
      model: anthropic('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'delegate' }],
      tools: {
        worker: agentTool({
          name: 'worker',
          description: 'Does the research',
          model: anthropic('claude-haiku-4-5'),
        }),
      },
      maxSteps: 5,
    });

    const ui = await drainWire(result);
    expect(ui.some((p) => p.type === 'sub-agent')).toBe(true);

    const turn = fold(ui);
    expect(turn.subAgents?.map((f) => f.agentPath)).toEqual([['worker']]);
    const child = turn.subAgents![0]!;
    expect(child.turn.message.content).toBe('sub answer');
    // The child's own terminal `finish` rode the frame too, so its turn state is
    // as complete as the parent's — and its tail is sealed.
    expect(child.turn.finishReason).toBe('stop');
    expect(child.turn.message.parts?.at(-1)).toMatchObject({ type: 'text', state: 'done' });
    // `afterPart` is meaningful against a REAL stream, not only a hand-fed one:
    // it is the parent's element count AT THE HANDOFF, so the element just
    // before it is the `tool` card for the agentTool call — and the parent's own
    // later elements (its step-1 boundary and answer) sit AFTER the frame,
    // exactly where they happened.
    const parentParts = turn.message.parts!;
    expect(child.afterPart).toBe(2);
    expect(parentParts.at(child.afterPart - 1)).toEqual({ type: 'tool', toolCallId: 'call_w' });
    expect(parentParts.slice(child.afterPart).map((p) => p.type)).toEqual(['step-start', 'text']);

    // The parent bubble stays the parent's own words; the child's text is NOT in
    // it, and the canonical projection carries the agentTool call, not the
    // child's internals.
    expect(turn.message.content).toBe('parent answer');
    expect(turn.message.content).not.toContain('sub answer');
    expect(turn.message.toolCalls?.map((c) => c.toolName)).toEqual(['worker']);
  });

  it('keeps a 2nd-level sub-agent (agentPath.length === 2) as its own frame', async () => {
    const { ui } = await roundTrip([
      { type: 'sub-agent', agentPath: ['researcher'], part: { type: 'text-delta', text: 'top' } },
      // Single-wrapped by contract: depth rides the PATH, never a nested frame.
      {
        type: 'sub-agent',
        agentPath: ['researcher', 'coder'],
        part: { type: 'text-delta', text: 'deep' },
      },
      {
        type: 'sub-agent',
        agentPath: ['researcher', 'coder'],
        part: { type: 'reasoning-delta', text: 'thinking' },
      },
    ]);
    expect(ui.some((p) => p.type === 'sub-agent' && p.agentPath.length === 2)).toBe(true);

    const turn = fold(ui);
    expect(turn.subAgents?.map((f) => f.agentPath)).toEqual([
      ['researcher'],
      ['researcher', 'coder'],
    ]);
    const deep = turn.subAgents![1]!;
    expect(deep.turn.message.content).toBe('deep');
    expect(deep.turn.message.reasoning).toBe('thinking');
    // Depth-1 and depth-2 frames never bleed into each other.
    expect(turn.subAgents![0]!.turn.message.content).toBe('top');
    expect(turn.message.content).toBe('');
  });

  it('seals a sub-agent frame at the parent turn ends (finish and abort)', async () => {
    const streaming: DeuzUIPart[] = [
      { type: 'sub-agent', agentPath: ['researcher'], part: { type: 'text-delta', text: 'half' } },
    ];
    const open = fold(streaming);
    expect(open.subAgents![0]!.turn.message.parts?.[0]).toMatchObject({ state: 'streaming' });

    // The wire's terminal part seals the child too — nothing more can arrive
    // for a delegated run once the run that delegated to it is over.
    const finished = applyUIPart(open, {
      type: 'finish',
      finishReason: 'stop',
      usage: ZERO_USAGE,
    });
    expect(finished.subAgents![0]!.turn.message.parts?.[0]).toMatchObject({ state: 'done' });

    // A binding-owned boundary (user abort) does the same, and stays idempotent.
    const sealed = sealAssistantTurn(open);
    expect(sealed.subAgents![0]!.turn.message.parts?.[0]).toMatchObject({ state: 'done' });
    expect(sealAssistantTurn(sealed)).toBe(sealed);
  });

  it('round-trips warning parts (redacted) into the turn warnings channel', async () => {
    const { ui } = await roundTrip([
      {
        type: 'warning',
        warning: {
          type: 'unsupported-setting',
          setting: 'topP',
          message: 'topP is not supported.',
        },
      },
      {
        type: 'warning',
        // P0: a message is BUILT from caller input, so it is redacted like every
        // other string this wire emits.
        warning: { type: 'other', message: 'key sk-ant-SECRETxyz1234567 was ignored' },
      },
      { type: 'text-delta', text: 'answer' },
      { type: 'finish', finishReason: 'stop', usage: ZERO_USAGE },
    ]);

    const warnings = ui.filter(
      (p): p is Extract<DeuzUIPart, { type: 'warning' }> => p.type === 'warning',
    );
    expect(warnings[0]).toEqual({
      type: 'warning',
      warning: { type: 'unsupported-setting', setting: 'topP', message: 'topP is not supported.' },
    });
    expect(warnings[1]!.warning.message).not.toContain('SECRETxyz');
    expect(warnings[1]!.warning.message).toContain('****4567');
    // No `setting` key invented when the canonical part had none.
    expect(Object.keys(warnings[1]!.warning)).toEqual(['type', 'message']);

    const turn = fold(ui);
    expect(turn.warnings).toEqual([
      { type: 'unsupported-setting', setting: 'topP', message: 'topP is not supported.' },
      { type: 'other', message: 'key ****4567 was ignored' },
    ]);
    // A warning is NOT an error and never text: it changes neither.
    expect(turn.error).toBeUndefined();
    expect(turn.message.content).toBe('answer');
  });

  it('round-trips false-finish parts into the turn falseFinishes channel', async () => {
    const { ui } = await roundTrip([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      { type: 'text-delta', text: 'more work' },
      { type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: false },
      { type: 'finish', finishReason: 'stop', usage: ZERO_USAGE },
    ]);
    expect(ui.filter((p) => p.type === 'false-finish')).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      { type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: false },
    ]);

    const turn = fold(ui);
    expect(turn.falseFinishes).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
      { type: 'false-finish', stepIndex: 1, attempt: 1, willRetry: false },
    ]);
    // The guard's budget was spent on the last one — the run stopped anyway.
    expect(turn.falseFinishes!.at(-1)!.willRetry).toBe(false);
  });

  it('carries a REAL run’s warning from streamChat to the turn (not a hand-pushed part)', async () => {
    // END-TO-END, no hand-fed stream: an unknown slug makes the registry serve
    // the conservative fallback row and record an `unknown-model` warning, the
    // pump emits it as a canonical part, `toUIPart` frames it, and the reducer
    // folds it. If any link in that chain is missing, `warnings` is dead API.
    const { fetch } = mockFetch(() => sseResponse([FINAL]));
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-definitely-not-a-real-slug'),
      messages: [{ role: 'user', content: 'hi' }],
    });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(toDeuzStreamResponse(result, { messageId: 'm1' }))) {
      parts.push(p);
    }
    const warnings = parts.filter(
      (p): p is Extract<DeuzUIPart, { type: 'warning' }> => p.type === 'warning',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning.type).toBe('unknown-model');
    expect(warnings[0]!.warning.message).toContain('claude-definitely-not-a-real-slug');

    const turn = fold(parts);
    expect(turn.warnings?.map((w) => w.type)).toEqual(['unknown-model']);
    // And the run itself was a perfectly normal success — a warning degrades
    // nothing on the wire it rides.
    expect(turn.message.content).toBe('Sunny in Paris.');
    expect(turn.finishReason).toBe('stop');
    expect(turn.error).toBeUndefined();
  });

  it('carries a REAL false-finish rejection from the loop to the turn', async () => {
    // END-TO-END: `doneWhen` refuses the first natural completion, the streaming
    // loop emits the canonical `false-finish` part before re-driving, the wire
    // frames it and the reducer records it. Nothing else in the chain existed
    // for this part until this pass — `toUIPart` dropped it on the floor.
    const { fetch } = mockFetchSequence([
      () => sseResponse([textSse('half done')]),
      () => sseResponse([textSse('DONE for real')]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'do the work' }],
      doneWhen: ({ text }) => text.includes('DONE'),
      falseFinishGuard: { maxRetries: 2 },
      maxSteps: 5,
    });

    const ui = await drainWire(result);
    const rejections = ui.filter(
      (p): p is Extract<DeuzUIPart, { type: 'false-finish' }> => p.type === 'false-finish',
    );
    expect(rejections).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
    ]);

    const turn = fold(ui);
    expect(turn.falseFinishes).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
    ]);
    // The re-drive worked, so the turn is a success that also records the
    // rejection it went through.
    expect(turn.message.content).toContain('DONE for real');
    expect(turn.error).toBeUndefined();
  });

  it('withholds warning and false-finish from a negotiated-v1 client, byte-identically', async () => {
    const v2Only: StreamPart[] = [
      {
        type: 'warning',
        warning: {
          type: 'clamped-setting',
          setting: 'maxOutputTokens',
          message: 'clamped to 8192',
        },
      },
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
    ];
    const safe: StreamPart[] = [
      { type: 'text-delta', text: 'kept' },
      { type: 'finish', finishReason: 'stop', usage: ZERO_USAGE },
    ];

    // The 1.7 golden still holds for the v1-safe subset: v1 IS v2 minus ids.
    const safeV1 = await roundTrip(safe, { wireVersion: 'v1' });
    const safeV2 = await roundTrip(safe, { wireVersion: 'v2' });
    expect(safeV1.raw).toBe(safeV2.raw.replace(/^id: \d+\n/gm, ''));

    const v1 = await roundTrip([...v2Only, ...safe], { wireVersion: 'v1' });
    expect(v1.raw).not.toContain('warning');
    expect(v1.raw).not.toContain('false-finish');
    expect(v1.raw).not.toContain('clamped');
    expect(v1.raw).not.toContain('id: ');
    expect(v1.raw).toContain('"kept"');
    // Dropped WHOLE, so the v1 id space stays gapless: the same v1 bytes as if
    // the two parts had never been emitted.
    expect(v1.raw).toBe(safeV1.raw);

    const v2 = await roundTrip([...v2Only, ...safe], { wireVersion: 'v2' });
    expect(v2.raw).toContain('"type":"warning"');
    expect(v2.raw).toContain('"type":"false-finish"');
    const ids = [...v2.raw.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i));
  });

  it('withholds them inside a sub-agent frame too (the recursive v1 rule)', async () => {
    const v1 = await roundTrip(
      [
        {
          type: 'sub-agent',
          agentPath: ['researcher'],
          part: { type: 'warning', warning: { type: 'other', message: 'child notice' } },
        },
        {
          type: 'sub-agent',
          agentPath: ['researcher'],
          part: { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: false },
        },
        {
          type: 'sub-agent',
          agentPath: ['researcher'],
          part: { type: 'text-delta', text: 'child text' },
        },
      ],
      { wireVersion: 'v1' },
    );
    expect(v1.raw).not.toContain('child notice');
    expect(v1.raw).not.toContain('false-finish');
    expect(v1.raw).toContain('child text'); // a v1-safe inner part is untouched
  });

  it('renders a DENIED tool distinguishably from a thrown one, wire → reducer', async () => {
    const { ui } = await roundTrip([
      { type: 'tool-call', toolCallId: 'd1', toolName: 'deleteRepo', input: { repo: 'x' } },
      { type: 'tool-call', toolCallId: 'e1', toolName: 'getWeather', input: { city: 'Paris' } },
      // The approval flow's last frame: refused by a human, not a crash.
      {
        type: 'tool-state',
        toolCallId: 'd1',
        toolName: 'deleteRepo',
        state: 'error',
        denied: true,
        deniedReason: 'declined by you',
      },
      {
        type: 'tool-result',
        toolCallId: 'd1',
        toolName: 'deleteRepo',
        output: 'denied',
        isError: true,
      },
      // A genuinely thrown tool: same terminal state, no denial qualifier.
      { type: 'tool-state', toolCallId: 'e1', toolName: 'getWeather', state: 'error' },
      {
        type: 'tool-result',
        toolCallId: 'e1',
        toolName: 'getWeather',
        output: 'boom',
        isError: true,
      },
      { type: 'finish', finishReason: 'stop', usage: ZERO_USAGE },
    ]);

    const turn = fold(ui);
    const [denied, thrown] = turn.message.toolCalls!;
    expect(denied).toMatchObject({
      toolCallId: 'd1',
      runState: 'error',
      isError: true,
      denied: true,
      deniedReason: 'declined by you',
    });
    // The distinguishing bit: a thrown tool gains NO denial keys at all, so a UI
    // can render "declined by you" for one and a red error for the other.
    expect(thrown!.denied).toBeUndefined();
    expect(thrown!.deniedReason).toBeUndefined();
    expect(thrown).toMatchObject({ toolCallId: 'e1', runState: 'error', isError: true });
  });

  it('carries a REAL approval DENIAL to the turn as denied, not as a plain failure', async () => {
    // END-TO-END: a server-mode `approveToolCall` that refuses. The loop marks
    // the terminal tool-state, the wire forwards the qualifier, and the reducer
    // puts it on the call — which is what lets a UI say "declined" instead of
    // painting the red error a thrown tool gets.
    const execute = vi.fn(async () => ({ temp: 22 }));
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([textSse('understood, skipping')]),
    ]);
    const result = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute, needsApproval: true } },
      approveToolCall: () => false, // deny
      maxSteps: 5,
    });

    const ui = await drainWire(result);
    expect(execute).not.toHaveBeenCalled();
    const states = ui.filter(
      (p): p is Extract<DeuzUIPart, { type: 'tool-state' }> => p.type === 'tool-state',
    );
    const denialFrame = states.find((s) => s.denied === true);
    expect(denialFrame).toMatchObject({ toolCallId: 'toolu_1', state: 'error', denied: true });

    const turn = fold(ui);
    const call = turn.message.toolCalls!.find((c) => c.toolCallId === 'toolu_1')!;
    expect(call.denied).toBe(true);
    expect(call.runState).toBe('error');
    // The model still got its is_error tool_result (the loop's self-healing
    // contract is untouched) — denial only changes what the UI is told.
    expect(call.isError).toBe(true);
    expect(turn.message.content).toBe('understood, skipping');
  });

  it('applyUIPart never throws on a malformed part of any new kind', () => {
    /** An adversarially deep `sub-agent` chain (built iteratively, never recursively). */
    const deeplyNestedFrame = (depth: number): unknown => {
      let payload: unknown = { type: 'text-delta', text: 'bottom' };
      for (let i = 0; i < depth; i++) {
        payload = { type: 'sub-agent', agentPath: [`a${i}`], part: payload };
      }
      return payload;
    };
    const hostile: unknown[] = [
      // warning
      { type: 'warning' },
      { type: 'warning', warning: null },
      { type: 'warning', warning: 'nope' },
      { type: 'warning', warning: { message: 42 } },
      { type: 'warning', warning: { type: 7, setting: 9, message: 'kept' } },
      // false-finish
      { type: 'false-finish' },
      { type: 'false-finish', stepIndex: '0', attempt: null, willRetry: 'yes' },
      { type: 'false-finish', stepIndex: Number.NaN, attempt: Infinity, willRetry: true },
      // sub-agent
      { type: 'sub-agent' },
      { type: 'sub-agent', agentPath: [], part: { type: 'text-delta', text: 'x' } },
      { type: 'sub-agent', agentPath: 'researcher', part: { type: 'text-delta', text: 'x' } },
      { type: 'sub-agent', agentPath: [1, 2], part: { type: 'text-delta', text: 'x' } },
      { type: 'sub-agent', agentPath: ['a'], part: null },
      { type: 'sub-agent', agentPath: ['a'], part: 'text' },
      { type: 'sub-agent', agentPath: ['a'], part: { text: 'no type' } },
      { type: 'sub-agent', agentPath: ['a'], part: { type: 'made-up-part', x: 1 } },
      { type: 'sub-agent', agentPath: ['a'], part: { type: 'warning', warning: undefined } },
      // A NESTED frame: forbidden by the wire contract (depth rides agentPath),
      // and refusing it is what bounds the reducer's recursion at one level.
      // Nested a thousand deep it would otherwise be a stack overflow — i.e. a
      // throw — out of a reducer that is TOTAL by contract.
      {
        type: 'sub-agent',
        agentPath: ['a'],
        part: { type: 'sub-agent', agentPath: ['b'], part: { type: 'text-delta', text: 'deep' } },
      },
      deeplyNestedFrame(2000),
    ];
    let turn = createAssistantTurn('t');
    for (const part of hostile) {
      expect(() => {
        turn = applyUIPart(turn, part as DeuzUIPart);
      }).not.toThrow();
    }
    // Only the two well-formed-enough payloads recorded anything, and every
    // field is the type it is declared as.
    expect(turn.warnings).toEqual([{ type: 'other', message: 'kept' }]);
    // All three false-finish pushes land — that a rejection HAPPENED is the
    // signal, so a junk counter takes a neutral 0 instead of losing the entry.
    expect(turn.falseFinishes).toEqual([
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: false },
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: false },
      { type: 'false-finish', stepIndex: 0, attempt: 0, willRetry: true },
    ]);
    // A junk path or a junk inner part is DROPPED, never folded into the parent
    // (misattribution is worse than a gap) — one frame, from the `['a']` pushes
    // whose inner part was at least shaped like a part.
    expect(turn.subAgents?.map((f) => f.agentPath)).toEqual([['a']]);
    expect(turn.message.content).toBe('');
    expect(turn.message.parts).toBeUndefined();
  });
});
