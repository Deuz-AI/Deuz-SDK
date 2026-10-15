import { describe, it, expect, vi } from 'vitest';
import { streamChat } from '../src/index';
import { createAnthropic } from '../src/anthropic';
import { createInMemorySessionStore, resumeDeuzChatResponse } from '../src/durable';
import {
  toDeuzStreamResponse,
  readDeuzStream,
  connectDeuzStream,
  createInMemoryDurableStreamStateStore,
  createInMemoryStreamStateStore,
  type DeuzUIPart,
  type DurableStreamStateStore,
} from '../src/ui';
import { createInMemoryLeaseProvider } from '../src/ops';
import type { JSONSchema } from '../src/types/schema';
import { bodyReader, manualResult, textPart } from './fixtures/manual-stream';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
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
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
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
      delta: { type: 'text_delta', text: 'Answer after the crash.' },
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

/** A model turn that calls `search` under `id`. */
const toolCall = (id: string) =>
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
        content_block: { type: 'tool_use', id, name: 'search' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
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

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  totalTokens: 0,
};

/** Real 0ms macrotask timer — fast polls without starving the event loop. */
const instantClock = {
  setTimeout: (fn: () => void, _ms: number) => {
    const id = globalThis.setTimeout(fn, 0);
    return () => globalThis.clearTimeout(id);
  },
};
/** Clock whose timers NEVER fire (the abandoned crashed pump stays inert). */
const deadTimerClock = {
  now: () => 1_700_000_000_000,
  setTimeout: (_fn: () => void, _ms: number) => () => {},
};

describe('durable × resumable — the unbreakable chatbot (D5)', () => {
  it('F5 mid-tool-loop: replay + checkpoint continuation = one gapless stream (E2E golden)', async () => {
    const sessionStore = createInMemorySessionStore();
    const streamStateStore = createInMemoryStreamStateStore();
    const tools = { search: { parameters: SCHEMA, execute: vi.fn(async () => 'found') } };

    // --- Leg 1: step 1 completes (checkpoint saved), step 2's model call
    // HANGS, then the process "dies" (we abandon the pump; timers never fire).
    const hung = new Promise<Response>(() => {});
    const leg1 = mockFetchSequence([() => sseResponse([TOOL_CALL]), () => hung as never]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools,
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-1' },
      deps: { clock: deadTimerClock },
    });
    const live = toDeuzStreamResponse(result1, {
      store: streamStateStore,
      streamId: 'run-1',
      messageId: 'm1',
    });
    // The client reads a few frames, then refreshes (connection cancelled).
    const reader = live.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    // Give the serializer a beat to journal step 1's parts into the store.
    await new Promise((r) => setTimeout(r, 20));
    const journaled: number[] = [];
    for await (const r of streamStateStore.read('run-1')) journaled.push(r.seq);
    expect(journaled.length).toBeGreaterThan(2);
    const clientCursor = 1; // the refreshed tab only SAW seq 0..1

    // --- The resume endpoint: probe finds silence (dead process), continues
    // the run from the checkpoint, and pipes the new leg through the same log.
    const leg2 = mockFetchSequence([() => sseResponse([FINAL])]);
    const resumed = resumeDeuzChatResponse({
      sessionStore,
      streamStateStore,
      runId: 'run-1',
      streamId: 'run-1',
      lastEventId: String(clientCursor),
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
        tools,
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    });

    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(resumed)) parts.push(p);

    // The continuation actually re-drove the model (leg 2 fetch used)...
    expect(leg2.calls.length).toBeGreaterThan(0);
    // ...and the client view completes the turn: replayed step-1 remainder
    // (tool activity it missed) + the continuation's answer.
    const kinds = parts.map((p) => p.type);
    expect(kinds).toContain('tool-call');
    const text = parts
      .filter((p): p is Extract<DeuzUIPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('Answer after the crash.');
    expect(kinds.at(-1)).toBe('finish');

    // Wire discipline: monotonic gapless seq ids continuing past the crash.
    const raw = await resumeDeuzChatResponse({
      sessionStore,
      streamStateStore,
      runId: 'run-1',
      streamId: 'run-1',
      lastEventId: null,
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
        tools,
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    }).text();
    const ids = [...raw.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i)); // 0..n, no gaps, no duplicates
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // The log now carries the leg-2 terminal sentinel → replays are stable.
    const finalRecords: string[] = [];
    for await (const r of streamStateStore.read('run-1')) finalRecords.push(r.part.type);
    expect(finalRecords.at(-1)).toBe('done');
  });

  it('a still-live producer is tailed, never re-driven (no duplicate model call)', async () => {
    const sessionStore = createInMemorySessionStore();
    const streamStateStore = createInMemoryStreamStateStore();
    // A completed stream sits in the log (producer finished normally).
    streamStateStore.append('s1', 0, { type: 'start', messageId: 'm1' });
    streamStateStore.append('s1', 1, { type: 'text-delta', text: 'done already' });
    streamStateStore.append('s1', 2, {
      type: 'finish',
      finishReason: 'stop',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
    });
    streamStateStore.append('s1', 3, { type: 'done' });

    const spyFetch = vi.fn();
    const res = resumeDeuzChatResponse({
      sessionStore,
      streamStateStore,
      runId: 's1',
      streamId: 's1',
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: spyFetch as never })('claude-opus-4-8'),
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    });
    const parts: DeuzUIPart[] = [];
    for await (const p of readDeuzStream(res)) parts.push(p);
    expect(parts.map((p) => p.type)).toEqual(['start', 'text-delta', 'finish']);
    expect(spyFetch).not.toHaveBeenCalled(); // no continuation leg
  });

  it('connectDeuzStream over the resume endpoint survives the crash transparently', async () => {
    const sessionStore = createInMemorySessionStore();
    const streamStateStore = createInMemoryStreamStateStore();
    const tools = { search: { parameters: SCHEMA, execute: vi.fn(async () => 'found') } };

    const hung = new Promise<Response>(() => {});
    const leg1 = mockFetchSequence([() => sseResponse([TOOL_CALL]), () => hung as never]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools,
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-2' },
      deps: { clock: deadTimerClock },
    });
    const live = toDeuzStreamResponse(result1, { store: streamStateStore, streamId: 'run-2' });
    const reader = live.body!.getReader();
    await reader.read();
    await reader.cancel(); // crash
    await new Promise((r) => setTimeout(r, 20));

    const leg2 = mockFetchSequence([() => sseResponse([FINAL])]);
    const parts: DeuzUIPart[] = [];
    for await (const p of connectDeuzStream(
      (ctx) =>
        resumeDeuzChatResponse({
          sessionStore,
          streamStateStore,
          runId: 'run-2',
          streamId: 'run-2',
          lastEventId: ctx.lastEventId ?? null,
          call: {
            model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
            tools,
          },
          liveProbeMs: 10,
          pollIntervalMs: 2,
          clock: instantClock,
        }),
      { clock: instantClock },
    )) {
      parts.push(p);
    }
    const text = parts
      .filter((p): p is Extract<DeuzUIPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('Answer after the crash.');
    expect(parts.at(-1)!.type).toBe('finish');
  });
});

describe('durable × resumable over a DurableStreamStateStore (2.4)', () => {
  const texts = async (store: DurableStreamStateStore, streamId: string) => {
    const parts: string[] = [];
    for await (const record of store.read(streamId))
      parts.push(
        record.part.type === 'text-delta'
          ? (record.part as { text: string }).text
          : record.part.type,
      );
    return parts;
  };

  it('a durable continuation leg never writes over a quiet durable producer', async () => {
    const sessionStore = createInMemorySessionStore();
    const store = createInMemoryDurableStreamStateStore();
    const provider = createInMemoryLeaseProvider();
    const durable = (owner: string) => ({
      store,
      lease: { provider, owner },
      batch: { maxDelayMs: 0 },
    });
    // Producer A commits and sends seqs 0..2, then goes quiet (a long tool call).
    const sourceA = manualResult();
    const a = bodyReader(
      toDeuzStreamResponse(sourceA.result, {
        durable: durable('a'),
        streamId: 'run-3',
        messageId: 'm',
      }),
    );
    sourceA.push(textPart('a1'));
    sourceA.push(textPart('a2'));
    await a.until('"a2"');
    // A's run has a checkpoint, so a leg that started would load it and call the model.
    await sessionStore.save({
      version: 1,
      runId: 'run-3',
      stepId: 'run-3#1',
      stepIndex: 1,
      status: 'running',
      messages: [
        { role: 'user', content: 'find x' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'x' } }],
        },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'toolu_1', result: 'found' }] },
      ],
      usage: ZERO_USAGE,
      createdAt: 0,
    });
    const checkpoint = JSON.stringify(await sessionStore.load('run-3'));

    // The client reconnects; the probe hears silence and starts a continuation leg.
    const spyFetch = vi.fn();
    const resumed = await resumeDeuzChatResponse({
      sessionStore,
      streamStateStore: store,
      durable: durable('resumer'),
      runId: 'run-3',
      streamId: 'run-3',
      lastEventId: '2',
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: spyFetch as never })('claude-opus-4-8'),
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    }).text();
    // A still holds the lease: the leg is refused, and writes nothing.
    expect(resumed).toContain('Durable stream: another producer holds this stream.');
    expect(await texts(store, 'run-3')).toEqual(['start', 'a1', 'a2']);

    // A goes on: its committed frames are the log, gapless.
    sourceA.push(textPart('a3'));
    sourceA.end();
    const rawA = await a.rest();
    expect(rawA).toContain('"a3"');
    expect(rawA).toContain('[DONE]');
    expect(await texts(store, 'run-3')).toEqual(['start', 'a1', 'a2', 'a3', 'done']);
    expect(spyFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(await sessionStore.load('run-3'))).toBe(checkpoint);
  });

  it('a refused continuation leg never re-drives the run: no model call, no tool, no checkpoint', async () => {
    const sessionStore = createInMemorySessionStore();
    const store = createInMemoryDurableStreamStateStore();
    const provider = createInMemoryLeaseProvider();
    // Producer A: step 1's tool completes (checkpointed); step 2's tool runs long (A alive, quiet).
    const executeA = vi.fn(async () =>
      executeA.mock.calls.length === 1 ? 'found-1' : new Promise<string>(() => {}),
    );
    const leg1 = mockFetchSequence([
      () => sseResponse([toolCall('toolu_1')]),
      () => sseResponse([toolCall('toolu_2')]),
    ]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools: { search: { parameters: SCHEMA, execute: executeA } },
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-7' },
    });
    const live = bodyReader(
      toDeuzStreamResponse(result1, {
        durable: { store, lease: { provider, owner: 'a' }, batch: { maxDelayMs: 0 } },
        streamId: 'run-7',
        messageId: 'm1',
      }),
    );
    await live.until('toolu_2');
    while (executeA.mock.calls.length < 2) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    expect(leg1.calls.length).toBe(2);
    const before = JSON.stringify(await sessionStore.load('run-7'));
    expect(before).toContain('toolu_1');

    // The resumer's model would ask for the same tool again, as A's step 2 did.
    const leg2 = mockFetchSequence([
      () => sseResponse([toolCall('toolu_B')]),
      () => new Promise<Response>(() => {}) as never,
    ]);
    const executeB = vi.fn(async () => 'found-by-B');
    const text = await resumeDeuzChatResponse({
      sessionStore,
      streamStateStore: store,
      durable: { store, lease: { provider, owner: 'resumer' } },
      runId: 'run-7',
      streamId: 'run-7',
      lastEventId: '1',
      call: {
        model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
        tools: { search: { parameters: SCHEMA, execute: executeB } },
      },
      liveProbeMs: 10,
      pollIntervalMs: 2,
      clock: instantClock,
    }).text();
    expect(text).toContain('Durable stream: another producer holds this stream.');
    await new Promise((r) => setTimeout(r, 100));
    expect(leg2.calls.length).toBe(0);
    expect(executeB).not.toHaveBeenCalled();
    expect(JSON.stringify(await sessionStore.load('run-7'))).toBe(before);
  });

  it('continues a crashed durable producer once its lease lapsed, gapless and durable', async () => {
    const sessionStore = createInMemorySessionStore();
    const store = createInMemoryDurableStreamStateStore();
    let providerNow = 1_700_000_000_000;
    const provider = createInMemoryLeaseProvider({
      clock: { now: () => providerNow, setTimeout: instantClock.setTimeout },
    });
    const tools = { search: { parameters: SCHEMA, execute: vi.fn(async () => 'found') } };

    // Leg 1, durable: step 1 completes, step 2's model call hangs, the process dies
    // (its timers never fire, so its lease is never renewed nor released).
    const hung = new Promise<Response>(() => {});
    const leg1 = mockFetchSequence([() => sseResponse([TOOL_CALL]), () => hung as never]);
    const result1 = streamChat({
      model: createAnthropic({ apiKey: 'k', fetch: leg1.fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'find x' }],
      tools,
      maxSteps: 5,
      session: { store: sessionStore, runId: 'run-4' },
      deps: { clock: deadTimerClock },
    });
    const live = toDeuzStreamResponse(result1, {
      durable: {
        store,
        lease: { provider, owner: 'a', ttlMs: 300 },
        // Every frame commits at once: the dead clock fires no coalescing window.
        batch: { maxBytes: 1 },
        deps: { clock: deadTimerClock },
      },
      streamId: 'run-4',
      messageId: 'm1',
    });
    const reader = live.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    const committed: number[] = [];
    for await (const record of store.read('run-4')) committed.push(record.seq);
    expect(committed.length).toBeGreaterThan(2);
    providerNow += 1_000; // the dead producer's lease lapses

    const leg2 = mockFetchSequence([() => sseResponse([FINAL])]);
    const resume = (lastEventId: string | null) =>
      resumeDeuzChatResponse({
        sessionStore,
        streamStateStore: store,
        durable: { store, lease: { provider, owner: 'resumer' } },
        runId: 'run-4',
        streamId: 'run-4',
        lastEventId,
        call: {
          model: createAnthropic({ apiKey: 'k', fetch: leg2.fetch })('claude-opus-4-8'),
          tools,
        },
        liveProbeMs: 10,
        pollIntervalMs: 2,
        clock: instantClock,
      });
    const parts: DeuzUIPart[] = [];
    for await (const part of readDeuzStream(resume('1'))) parts.push(part);
    expect(leg2.calls.length).toBeGreaterThan(0);
    const text = parts
      .filter((p): p is Extract<DeuzUIPart, { type: 'text-delta' }> => p.type === 'text-delta')
      .map((p) => p.text)
      .join('');
    expect(text).toContain('Answer after the crash.');
    // A replay of the whole log: gapless ids past the crash, ended by the leg's sentinel.
    const raw = await resume(null).text();
    const ids = [...raw.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(ids.map((_, i) => i));
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // The leg gave its lease back.
    expect(await provider.acquire({ key: 'stream:run-4', owner: 'next', ttlMs: 300 })).toBeTruthy();
  });

  it('refuses a durable store other than the stream state store', () => {
    const store = createInMemoryDurableStreamStateStore();
    expect(() =>
      resumeDeuzChatResponse({
        sessionStore: createInMemorySessionStore(),
        streamStateStore: store,
        durable: {
          store: createInMemoryDurableStreamStateStore(),
          lease: { provider: createInMemoryLeaseProvider() },
        },
        runId: 'r',
        streamId: 'r',
        call: { model: createAnthropic({ apiKey: 'k' })('claude-opus-4-8') },
      }),
    ).toThrow(/durable\.store/);
  });
});
