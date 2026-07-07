import { describe, it, expect, vi } from 'vitest';
import { generateText, streamChat } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
  CheckpointNotFoundError,
} from '../src/durable';
import type { AgentCheckpoint, SessionStore } from '../src/types/session';
import type { StreamPart } from '../src/types/stream';
import type { Logger } from '../src/types/deps';
import { createAnthropic } from '../src/anthropic';
import type { JSONSchema } from '../src/types/schema';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

/** Anthropic turn calling getWeather({city:"Paris"}). Usage 10 in / 5 out. */
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

/** Anthropic final text turn. Usage 20 in / 6 out. */
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

function model(fetch: typeof globalThis.fetch) {
  return createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8');
}

/** Wrap a store to record every save (checkpoint snapshots in order). */
function recordingStore(): { store: SessionStore; saves: AgentCheckpoint[] } {
  const inner = createInMemorySessionStore();
  const saves: AgentCheckpoint[] = [];
  const store: SessionStore = {
    save: (cp) => {
      saves.push(cp);
      return inner.save(cp);
    },
    load: (id) => inner.load(id),
    delete: (id) => inner.delete!(id),
    list: () => inner.list!(),
  };
  return { store, saves };
}

describe('createInMemorySessionStore', () => {
  it('save/load/delete/list round-trip, latest save wins per runId', async () => {
    const store = createInMemorySessionStore();
    const base: AgentCheckpoint = {
      version: 1,
      runId: 'r1',
      stepId: 'r1#1',
      stepIndex: 1,
      status: 'running',
      messages: [{ role: 'user', content: 'hi' }],
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 3,
      },
      createdAt: 42,
    };
    await store.save(base);
    await store.save({ ...base, stepIndex: 2, stepId: 'r1#2' });
    const loaded = await store.load('r1');
    expect(loaded?.stepIndex).toBe(2);
    expect(await store.list!()).toEqual(['r1']);
    await store.delete!('r1');
    expect(await store.load('r1')).toBeUndefined();
  });
});

describe('durable checkpoints — buffered loop (generateText)', () => {
  it('saves a running checkpoint at each tool-step boundary and a completed one at the end', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({ temp: 22 }) } },
      maxSteps: 5,
      session: { store, runId: 'run-1' },
    });

    expect(res.text).toBe('Sunny in Paris.');
    expect(res.runId).toBe('run-1');

    expect(saves.map((s) => [s.stepIndex, s.status])).toEqual([
      [1, 'running'],
      [2, 'completed'],
    ]);
    const done = saves.at(-1)!;
    expect(done.runId).toBe('run-1');
    expect(done.stepId).toBe('run-1#2');
    expect(done.version).toBe(1);
    // Cumulative usage: step1 15 + step2 26.
    expect(done.usage.totalTokens).toBe(41);
    // Completed checkpoint history ends with the FINAL assistant message.
    const last = done.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('Sunny in Paris.');
    // Running checkpoint (after step 1) ends with the tool-result turn.
    expect(saves[0]!.messages.at(-1)!.role).toBe('tool');
  });

  it('generates a runId via deps.generateId when none is given', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    let n = 0;
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({}) } },
      maxSteps: 5,
      session: { store },
      deps: { generateId: () => `gen-${n++}` },
    });
    expect(res.runId).toBe('gen-0');
    expect(saves[0]!.runId).toBe('gen-0');
  });

  it('suspends on a client-mode approval break: status suspended + pendingApprovals persisted', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true },
      },
      maxSteps: 5,
      session: { store, runId: 'run-s' },
    });

    expect(res.pendingApprovals).toHaveLength(1);
    expect(res.runId).toBe('run-s');
    const cp = saves.at(-1)!;
    expect(cp.status).toBe('suspended');
    expect(cp.stepIndex).toBe(1);
    expect(cp.pendingApprovals).toEqual([
      {
        approvalId: 'toolu_1',
        toolCallId: 'toolu_1',
        toolName: 'getWeather',
        input: { city: 'Paris' },
      },
    ]);
    // History ends on the assistant turn — the tool_use is unanswered.
    expect(cp.messages.at(-1)!.role).toBe('assistant');
  });

  it('a throwing store logs an error and never kills the run', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (m) => {
        errors.push(m);
      },
    };
    const store: SessionStore = {
      save: () => {
        throw new Error('disk full');
      },
      load: () => undefined,
      delete: () => {},
    };
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({}) } },
      maxSteps: 5,
      session: { store, runId: 'run-x' },
      deps: { logger },
    });
    expect(res.text).toBe('Sunny in Paris.');
    expect(errors.some((m) => m.includes('checkpoint save failed'))).toBe(true);
  });

  it('single-turn calls (no tools) do not checkpoint and carry no runId', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    const res = await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'hi' }],
      session: { store, runId: 'run-n' },
    });
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.runId).toBeUndefined();
    expect(saves).toHaveLength(0);
  });
});

describe('durable checkpoints — streaming loop (streamChat)', () => {
  it('checkpoints step boundaries and exposes runId synchronously', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL]),
      () => sseResponse([FINAL]),
    ]);
    const result = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({ temp: 22 }) } },
      maxSteps: 5,
      session: { store, runId: 'run-st' },
    });
    expect(result.runId).toBe('run-st'); // synchronous, before consumption
    let text = '';
    for await (const t of result.textStream) text += t;
    expect(text).toBe('Sunny in Paris.');
    expect(saves.map((s) => [s.stepIndex, s.status])).toEqual([
      [1, 'running'],
      [2, 'completed'],
    ]);
    expect(saves.at(-1)!.usage.totalTokens).toBe(41);
  });

  it('suspends on approval break with a suspended checkpoint', async () => {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    const result = streamChat({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true },
      },
      maxSteps: 5,
      session: { store, runId: 'run-ss' },
    });
    const types: StreamPart['type'][] = [];
    for await (const part of result.fullStream) types.push(part.type);
    expect(types).toContain('tool-approval-request');
    const cp = saves.at(-1)!;
    expect(cp.status).toBe('suspended');
    expect(cp.pendingApprovals).toHaveLength(1);
  });
});

describe('resumeFromCheckpoint', () => {
  async function suspendedRun() {
    const { store, saves } = recordingStore();
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    await generateText({
      model: model(fetch),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true },
      },
      maxSteps: 5,
      session: { store, runId: 'run-r' },
    });
    return { store, saves };
  }

  it('resumes a suspended run: approved verdict executes the tool and completes', async () => {
    const { store, saves } = await suspendedRun();
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    const res = await resumeFromCheckpoint(store, 'run-r', {
      model: model(fetch),
      tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });

    expect(weather).toHaveBeenCalledTimes(1);
    expect(res.text).toBe('Sunny in Paris.');
    expect(res.runId).toBe('run-r');
    // The resumed request answered the pending tool_use (Anthropic 400 guard).
    const body = String(calls[0]!.init!.body);
    expect(body).toContain('tool_result');
    expect(body).toContain('toolu_1');

    // Final checkpoint: cumulative across BOTH legs (15 + 26), monotonic stepIndex.
    const done = saves.at(-1)!;
    expect(done.status).toBe('completed');
    expect(done.usage.totalTokens).toBe(41);
    expect(done.stepIndex).toBe(2);
    expect(done.stepId).toBe('run-r#2');
  });

  it('resuming a suspended run WITHOUT verdicts denies pending gated calls (safe side)', async () => {
    const { store } = await suspendedRun();
    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch, calls } = mockFetchSequence([() => sseResponse([FINAL])]);
    const res = await resumeFromCheckpoint(store, 'run-r', {
      model: model(fetch),
      tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
      maxSteps: 5,
    });
    expect(weather).not.toHaveBeenCalled();
    expect(res.text).toBe('Sunny in Paris.');
    expect(String(calls[0]!.init!.body)).toContain('Tool call denied.');
  });

  it('prepareStep sees cross-leg step indices on a buffered resume leg (loop symmetry)', async () => {
    const { store } = await suspendedRun();
    const seen: number[] = [];
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await resumeFromCheckpoint(store, 'run-r', {
      model: model(fetch),
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true } },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
      prepareStep: (ctx) => {
        seen.push(ctx.stepIndex);
        return undefined;
      },
    });
    // Leg 1 saved boundary 1 — the resume leg continues at 1 (same as the
    // streaming loop's step-start indices), not back at 0.
    expect(seen).toEqual([1]);
  });

  it('does not mutate the stored checkpoint history (immutability across legs)', async () => {
    const { store } = await suspendedRun();
    const before = (await store.load('run-r'))!;
    const beforeLen = before.messages.length;
    const beforeJson = JSON.stringify(before.messages);
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await resumeFromCheckpoint(store, 'run-r', {
      model: model(fetch),
      tools: { getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true } },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    expect(before.messages).toHaveLength(beforeLen);
    expect(JSON.stringify(before.messages)).toBe(beforeJson);
  });

  it('throws CheckpointNotFoundError for an unknown runId', async () => {
    const store = createInMemorySessionStore();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    await expect(
      resumeFromCheckpoint(store, 'nope', { model: model(fetch), maxSteps: 5 }),
    ).rejects.toBeInstanceOf(CheckpointNotFoundError);
  });
});

describe('resumeStreamFromCheckpoint', () => {
  it('resumes streaming: settle tool-result precedes, step indices continue from the checkpoint', async () => {
    const { store, saves } = recordingStore();
    const { fetch: f1 } = mockFetchSequence([() => sseResponse([TOOL_CALL])]);
    await generateText({
      model: model(f1),
      messages: [{ role: 'user', content: 'weather?' }],
      tools: {
        getWeather: { parameters: SCHEMA, execute: async () => ({}), needsApproval: true },
      },
      maxSteps: 5,
      session: { store, runId: 'run-sr' },
    });

    const weather = vi.fn(async () => ({ temp: 22 }));
    const { fetch: f2 } = mockFetchSequence([() => sseResponse([FINAL])]);
    const result = resumeStreamFromCheckpoint(store, 'run-sr', {
      model: model(f2),
      tools: { getWeather: { parameters: SCHEMA, execute: weather, needsApproval: true } },
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      maxSteps: 5,
    });
    expect(result.runId).toBe('run-sr');

    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);

    const types = parts.map((p) => p.type);
    // Settled approval surfaces as a tool-result BEFORE the first step of the leg.
    expect(types.indexOf('tool-result')).toBeLessThan(types.indexOf('step-start'));
    const stepStart = parts.find((p) => p.type === 'step-start');
    expect(stepStart).toMatchObject({ stepIndex: 1 }); // leg 1 completed step 0
    expect(weather).toHaveBeenCalledTimes(1);
    expect(saves.at(-1)!.status).toBe('completed');
    expect(saves.at(-1)!.usage.totalTokens).toBe(41);
  });

  it('surfaces an unknown runId as an error part, never a synchronous throw (G2)', async () => {
    const store = createInMemorySessionStore();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL])]);
    const result = resumeStreamFromCheckpoint(store, 'nope', { model: model(fetch), maxSteps: 5 });
    const parts: StreamPart[] = [];
    for await (const part of result.fullStream) parts.push(part);
    const err = parts.find((p) => p.type === 'error');
    expect(err && 'error' in err && err.error).toBeInstanceOf(CheckpointNotFoundError);
    await expect(result.usage).rejects.toBeInstanceOf(CheckpointNotFoundError);
  });
});

describe('checkpoint serialization codec', () => {
  it('round-trips binary image parts through JSON (Uint8Array-safe)', () => {
    const cp: AgentCheckpoint = {
      version: 1,
      runId: 'r-bin',
      stepId: 'r-bin#1',
      stepIndex: 1,
      status: 'running',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', image: new Uint8Array([1, 2, 250, 255]), mediaType: 'image/png' },
          ],
        },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      createdAt: 7,
    };
    const json = serializeCheckpoint(cp);
    expect(typeof json).toBe('string');
    const back = deserializeCheckpoint(json);
    expect(back.runId).toBe('r-bin');
    const img = (back.messages[0]!.content as { type: string; image?: unknown }[])[1]!;
    expect(img.image).toBeInstanceOf(Uint8Array);
    expect([...(img.image as Uint8Array)]).toEqual([1, 2, 250, 255]);
  });

  it('round-trips Node Buffer parts as real Uint8Arrays (toJSON preemption guard)', () => {
    const cp: AgentCheckpoint = {
      version: 1,
      runId: 'r-buf',
      stepId: 'r-buf#1',
      stepIndex: 1,
      status: 'running',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: Buffer.from([9, 8, 250, 255]), mediaType: 'image/png' },
          ],
        },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      createdAt: 7,
    };
    const json = serializeCheckpoint(cp);
    // Buffer#toJSON must NOT have preempted the codec's tag.
    expect(json).not.toContain('"type":"Buffer"');
    const back = deserializeCheckpoint(json);
    const img = (back.messages[0]!.content as { type: string; image?: unknown }[])[0]!;
    expect(img.image).toBeInstanceOf(Uint8Array);
    expect([...(img.image as Uint8Array)]).toEqual([9, 8, 250, 255]);
  });

  it('user data that merely resembles the reserved tag passes through un-converted', () => {
    const lookalike = { $deuzBytes: '***not-base64***' };
    const cp: AgentCheckpoint = {
      version: 1,
      runId: 'r-tag',
      stepId: 'r-tag#1',
      stepIndex: 1,
      status: 'suspended',
      messages: [{ role: 'user', content: 'hi' }],
      pendingApprovals: [
        { approvalId: 'a1', toolCallId: 'a1', toolName: 'writeFile', input: lookalike },
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 2,
      },
      createdAt: 7,
    };
    // Neither a throw out of resume, nor a surprise Uint8Array — plain data.
    const back = deserializeCheckpoint(serializeCheckpoint(cp));
    expect(back.pendingApprovals?.[0]?.input).toEqual(lookalike);
  });
});
