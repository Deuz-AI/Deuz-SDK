/**
 * Durable observation: checkpoint.saved at every boundary, best-effort save
 * failures, suspension correlation, resume (same runId / new executionId /
 * loaded-before-started), load failures, cumulative vs per-leg usage.
 */
import { describe, it, expect } from 'vitest';
import { generateText } from '../src/index';
import {
  createInMemorySessionStore,
  resumeFromCheckpoint,
  resumeStreamFromCheckpoint,
} from '../src/durable';
import { createAnthropic } from '../src/anthropic';
import { createMemoryObserver } from '../src/observe';
import { sseResponse, sseEvents, mockFetchSequence } from './fixtures/sse';
import type { Clock, ObserveEvent, JSONSchema, SessionStore } from '../src/index';

type Ev<T extends ObserveEvent['type']> = Extract<ObserveEvent, { type: T }>;

function fastClock(): Clock {
  let now = 0;
  return {
    now: () => (now += 5),
    setTimeout: (fn, ms) => {
      if (ms < 60_000) {
        const id = setTimeout(fn, 0);
        return () => clearTimeout(id);
      }
      return () => {};
    },
  };
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const TOOL_CALL_STREAM = sseEvents([
  {
    event: 'message_start',
    data: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'guarded' },
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

const FINAL_STREAM = sseEvents([
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
    data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
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

describe('checkpoint.saved', () => {
  it('fires at every boundary with cumulative usage and 1-based boundary indices', async () => {
    const mem = createMemoryObserver();
    const store = createInMemorySessionStore();
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { guarded: { parameters: SCHEMA, execute: async () => 'result' } },
      maxSteps: 5,
      session: { store, runId: 'run-durable-1' },
      deps: { observer: mem, clock: fastClock() },
    });
    const saved = mem
      .events()
      .filter((e) => e.type === 'checkpoint.saved') as Ev<'checkpoint.saved'>[];
    expect(saved.map((s) => s.checkpointStatus)).toEqual(['running', 'completed']);
    expect(saved.map((s) => s.checkpointStepIndex)).toEqual([1, 2]);
    expect(saved.map((s) => s.stepId)).toEqual(['run-durable-1#1', 'run-durable-1#2']);
    // checkpoint usage is CUMULATIVE (durableUsage semantics)
    expect(saved[1]!.usage.totalTokens).toBe(41);
    // observation runId adopted the session runId
    expect(saved[0]!.runId).toBe('run-durable-1');
    const done = mem.events().at(-1) as Ev<'run.completed'>;
    expect(done.checkpointCount).toBe(2);
    expect(done.cumulativeUsage?.totalTokens).toBe(41);
  });

  it('a throwing store → checkpoint.failed{save, runContinued} and the run completes', async () => {
    const mem = createMemoryObserver();
    const store: SessionStore = {
      save: () => {
        throw new Error('disk full');
      },
      load: () => undefined,
    };
    const { fetch } = mockFetchSequence([
      () => sseResponse([TOOL_CALL_STREAM]),
      () => sseResponse([FINAL_STREAM]),
    ]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: { guarded: { parameters: SCHEMA, execute: async () => 'result' } },
      maxSteps: 5,
      session: { store, runId: 'run-flaky-store' },
      deps: { observer: mem, clock: fastClock() },
    });
    expect(res.text).toBe('ok'); // best-effort durability preserved
    const failed = mem
      .events()
      .filter((e) => e.type === 'checkpoint.failed') as Ev<'checkpoint.failed'>[];
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatchObject({ operation: 'save', runContinued: true });
    expect(failed[0]!.error.category).toBe('unknown');
    expect(mem.events().at(-1)!.type).toBe('run.completed');
  });
});

describe('suspension + resume correlation', () => {
  async function suspendRun(store: SessionStore, mem = createMemoryObserver()) {
    const { fetch } = mockFetchSequence([() => sseResponse([TOOL_CALL_STREAM])]);
    const res = await generateText({
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        guarded: { parameters: SCHEMA, needsApproval: true, execute: async () => 'result' },
      },
      maxSteps: 5,
      session: { store, runId: 'run-sus-1' },
      deps: { observer: mem, clock: fastClock() },
    });
    return { res, mem };
  }

  it('suspension: checkpoint.saved{suspended} then run.suspended with the checkpoint ref', async () => {
    const store = createInMemorySessionStore();
    const { mem } = await suspendRun(store);
    const types = mem.events().map((e) => e.type);
    expect(types.indexOf('checkpoint.saved')).toBeLessThan(types.indexOf('run.suspended'));
    const suspended = mem.events().at(-1) as Ev<'run.suspended'>;
    expect(suspended).toMatchObject({
      reason: 'approval',
      pendingApprovalCount: 1,
      checkpointStepId: 'run-sus-1#1',
      checkpointStepIndex: 1,
    });
  });

  it('buffered resume: checkpoint.loaded BEFORE run.started{resumed}, same runId, new executionId', async () => {
    const store = createInMemorySessionStore();
    const { mem: firstLeg } = await suspendRun(store);
    const firstExecution = firstLeg.events()[0]!.executionId;

    const mem = createMemoryObserver();
    const { fetch } = mockFetchSequence([() => sseResponse([FINAL_STREAM])]);
    await resumeFromCheckpoint(store, 'run-sus-1', {
      model: createAnthropic({ apiKey: 'k', fetch })('claude-opus-4-8'),
      tools: {
        guarded: { parameters: SCHEMA, needsApproval: true, execute: async () => 'result' },
      },
      maxSteps: 5,
      approvalResponses: [{ approvalId: 'toolu_1', approved: true }],
      deps: { observer: mem, clock: fastClock() },
    });
    const types = mem.events().map((e) => e.type);
    // §26: loaded precedes started; the approved tool settles before step 1
    expect(types[0]).toBe('checkpoint.loaded');
    expect(types[1]).toBe('run.started');
    expect(types.indexOf('approval.resolved')).toBeLessThan(types.indexOf('step.started'));
    const loaded = mem.events()[0] as Ev<'checkpoint.loaded'>;
    expect(loaded).toMatchObject({
      stepId: 'run-sus-1#1',
      checkpointStepIndex: 1,
      checkpointStatus: 'suspended',
      pendingApprovalCount: 1,
    });
    expect(loaded.checkpointAgeMs).toBeGreaterThanOrEqual(0);
    const started = mem.events()[1] as Ev<'run.started'>;
    expect(started).toMatchObject({
      resumed: true,
      resumeFromStepId: 'run-sus-1#1',
      resumeFromStepIndex: 1,
    });
    // correlation: same logical run, fresh execution leg
    expect(started.runId).toBe('run-sus-1');
    expect(started.executionId).not.toBe(firstExecution);
    // approval wait measured from checkpoint age
    const resolved = mem
      .events()
      .find((e) => e.type === 'approval.resolved') as Ev<'approval.resolved'>;
    expect(resolved.waitDurationMs).toBeGreaterThanOrEqual(0);
    // resumed leg completes
    expect(types.at(-1)).toBe('run.completed');
  });

  it('streaming resume load failure: checkpoint.failed{load} then run.failed — run.started never fires', async () => {
    const mem = createMemoryObserver();
    const store = createInMemorySessionStore();
    const result = resumeStreamFromCheckpoint(store, 'ghost-run', {
      model: createAnthropic({
        apiKey: 'k',
        fetch: (() => {
          throw new Error('never reached');
        }) as unknown as typeof fetch,
      })('claude-opus-4-8'),
      tools: { guarded: { parameters: SCHEMA, execute: async () => 'result' } },
      deps: { observer: mem, clock: fastClock() },
    });
    await expect(result.usage).rejects.toMatchObject({ code: 'checkpoint_not_found' });
    const types = mem.events().map((e) => e.type);
    expect(types).toEqual(['checkpoint.failed', 'run.failed']);
    const failed = mem.events()[0] as Ev<'checkpoint.failed'>;
    expect(failed).toMatchObject({
      operation: 'load',
      runContinued: false,
      checkpointRunId: 'ghost-run',
    });
    const runFailed = mem.events()[1] as Ev<'run.failed'>;
    expect(runFailed.error.category).toBe('checkpoint');
    expect(runFailed.error.code).toBe('checkpoint_not_found');
  });

  it('buffered resume load failure mirrors the same order and rethrows', async () => {
    const mem = createMemoryObserver();
    const store = createInMemorySessionStore();
    await expect(
      resumeFromCheckpoint(store, 'ghost-run', {
        model: createAnthropic({ apiKey: 'k' })('claude-opus-4-8'),
        deps: { observer: mem, clock: fastClock() },
      }),
    ).rejects.toMatchObject({ code: 'checkpoint_not_found' });
    expect(mem.events().map((e) => e.type)).toEqual(['checkpoint.failed', 'run.failed']);
  });
});
